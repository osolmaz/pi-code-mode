use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use pi_code_mode_protocol::validation::{validate_exec, validate_wait};
use pi_code_mode_protocol::{
    CellExecParams, CellStatus, CellTerminateParams, CellWaitParams, ClientHello, Envelope,
    ErrorCode, FrameError, HOST_NAME, HostCapabilities, HostHello, HostInfo, MAX_FRAME_BYTES,
    PROTOCOL_VERSION, ProtocolError, Request, Response, SessionCloseParams, SessionOpened,
    ToolDefinition, ToolKind, write_frame,
};
use pi_code_mode_runtime::{OutputBuffer, RuntimeTool, SharedToolInvoker};
use serde::de::DeserializeOwned;
use serde_json::{Value, json, to_value};
use tokio::sync::{Mutex, mpsc, watch};
use uuid::Uuid;

use crate::cell::{CellHandle, CellSpawnConfig, ObserveOptions, spawn_cell};
use crate::delegate::{PendingCalls, ProtocolDelegate, resolve_response};
use crate::limits::{runtime_limits, validate_observation};
use crate::session::{HostSession, InsertCellResult};

const MAX_ACTIVE_CELLS_PER_SESSION: usize = 4;
const MAX_ACTIVE_CELLS_PER_HOST: usize = 8;

pub struct ServerState {
    hello_complete: AtomicBool,
    sessions: Mutex<HashMap<String, Arc<HostSession>>>,
    outbound: mpsc::UnboundedSender<Envelope>,
    pending: PendingCalls,
    next_request_id: Arc<AtomicU64>,
    active_cells: AtomicUsize,
    shutdown: watch::Sender<bool>,
}

impl ServerState {
    fn new(outbound: mpsc::UnboundedSender<Envelope>, shutdown: watch::Sender<bool>) -> Arc<Self> {
        Arc::new(Self {
            hello_complete: AtomicBool::new(false),
            sessions: Mutex::new(HashMap::new()),
            outbound,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: Arc::new(AtomicU64::new(1)),
            active_cells: AtomicUsize::new(0),
            shutdown,
        })
    }

    fn reserve_host_cell(&self) -> bool {
        self.active_cells
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < MAX_ACTIVE_CELLS_PER_HOST).then_some(value + 1)
            })
            .is_ok()
    }

    fn release_host_cell(&self) {
        self.active_cells.fetch_sub(1, Ordering::AcqRel);
    }

    async fn require_session(&self, session_id: &str) -> Result<Arc<HostSession>, ProtocolError> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| ProtocolError::new(ErrorCode::SessionExpired, "session was not found"))
    }

    async fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().await);
        for session in sessions.into_values() {
            close_session_cells(self, &session).await;
        }
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for sender in pending.into_values() {
            let _ = sender.send(Err(ProtocolError::new(
                ErrorCode::RuntimeCrashed,
                "host is shutting down",
            )));
        }
    }
}

pub async fn run() -> anyhow::Result<()> {
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Envelope>();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let state = ServerState::new(outbound_tx, shutdown_tx);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outbound_rx.recv().await {
            write_frame(&mut stdout, &message).await?;
        }
        Ok::<(), FrameError>(())
    });

    let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel();
    thread::Builder::new()
        .name("pi-code-mode-protocol-reader".to_owned())
        .spawn(move || read_stdin(&incoming_tx))?;
    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_ok() && *shutdown_rx.borrow() {
                    break;
                }
            }
            incoming = incoming_rx.recv() => {
                match incoming {
                    Some(Ok(Envelope::Request(request))) => {
                        let task_state = Arc::clone(&state);
                        tokio::spawn(async move { process_request(task_state, request).await; });
                    }
                    Some(Ok(Envelope::Response(response))) => {
                        if let Err(error) = resolve_response(&state.pending, response).await {
                            let _ = state.outbound.send(Envelope::Event(pi_code_mode_protocol::Event {
                                method: "host/warning".to_owned(),
                                params: json!({"message": error.message}),
                            }));
                        }
                    }
                    Some(Ok(Envelope::Event(_))) => {}
                    None | Some(Err(FrameError::EndOfStream)) => break,
                    Some(Err(error)) => {
                        let _ = state.outbound.send(Envelope::Event(pi_code_mode_protocol::Event {
                            method: "host/fatal".to_owned(),
                            params: json!({"message": error.to_string()}),
                        }));
                        break;
                    }
                }
            }
        }
    }

    state.close_all().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    writer.abort();
    let _ = writer.await;
    Ok(())
}

fn read_stdin(sender: &mpsc::UnboundedSender<Result<Envelope, FrameError>>) {
    let mut stdin = std::io::stdin().lock();
    loop {
        let mut length = [0_u8; 4];
        match stdin.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                let _ = sender.send(Err(FrameError::EndOfStream));
                return;
            }
            Err(error) => {
                let _ = sender.send(Err(FrameError::Io(error)));
                return;
            }
        }
        let length = u32::from_le_bytes(length) as usize;
        if length > MAX_FRAME_BYTES {
            let _ = sender.send(Err(FrameError::FrameTooLarge));
            return;
        }
        let mut payload = vec![0_u8; length];
        if let Err(error) = stdin.read_exact(&mut payload) {
            let _ = sender.send(Err(FrameError::Io(error)));
            return;
        }
        match serde_json::from_slice(&payload) {
            Ok(envelope) => {
                if sender.send(Ok(envelope)).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(Err(FrameError::InvalidJson(error)));
                return;
            }
        }
    }
}

async fn process_request(state: Arc<ServerState>, request: Request) {
    let request_id = request.id.clone();
    let should_shutdown = request.method == "host/shutdown";
    let result = dispatch(&state, request).await;
    let response = match result {
        Ok(value) => Response::success(request_id, value),
        Err(error) => Response::failure(request_id, error),
    };
    let _ = state.outbound.send(Envelope::Response(response));
    if should_shutdown {
        let _ = state.shutdown.send(true);
    }
}

async fn dispatch(state: &Arc<ServerState>, request: Request) -> Result<Value, ProtocolError> {
    if request.method == "client/hello" {
        return client_hello(state, request.params);
    }
    if !state.hello_complete.load(Ordering::Acquire) {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolError,
            "client/hello must be the first request",
        ));
    }
    match request.method.as_str() {
        "session/open" => open_session(state).await,
        "session/close" => close_session(state, request.params).await,
        "cell/exec" => exec_cell(state, request.params).await,
        "cell/wait" => wait_cell(state, request.params).await,
        "cell/terminate" => terminate_cell(state, request.params).await,
        "host/shutdown" => Ok(json!({"shuttingDown": true})),
        _ => Err(ProtocolError::new(
            ErrorCode::ProtocolError,
            format!("unknown protocol method: {}", request.method),
        )),
    }
}

fn client_hello(state: &ServerState, params: Value) -> Result<Value, ProtocolError> {
    if state.hello_complete.swap(true, Ordering::AcqRel) {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolError,
            "client/hello was already completed",
        ));
    }
    let hello: ClientHello = parse_params(params)?;
    if !hello.protocol_versions.contains(&PROTOCOL_VERSION) {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolError,
            "no supported protocol version",
        ));
    }
    encode(HostHello {
        protocol_version: PROTOCOL_VERSION,
        host: HostInfo {
            name: HOST_NAME.to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            runtime: "deno_core".to_owned(),
            v8: pi_code_mode_runtime::v8_version().to_owned(),
        },
        capabilities: HostCapabilities {
            wait: true,
            images: false,
            notifications: true,
            session_store: true,
        },
    })
}

async fn open_session(state: &ServerState) -> Result<Value, ProtocolError> {
    let id = Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .await
        .insert(id.clone(), HostSession::new());
    encode(SessionOpened { session_id: id })
}

async fn close_session(state: &ServerState, params: Value) -> Result<Value, ProtocolError> {
    let params: SessionCloseParams = parse_params(params)?;
    let Some(session) = state.sessions.lock().await.remove(&params.session_id) else {
        return Ok(json!({"closed": false}));
    };
    close_session_cells(state, &session).await;
    Ok(json!({"closed": true}))
}

async fn close_session_cells(state: &ServerState, session: &HostSession) {
    for cell in session.take_cells().await.into_values() {
        cell.terminate();
        release_cell(state, session, &cell);
    }
}

async fn exec_cell(state: &Arc<ServerState>, params: Value) -> Result<Value, ProtocolError> {
    let params: CellExecParams = parse_params(params)?;
    validate_exec(&params)?;
    let limits = runtime_limits(&params.options)?;
    let session = state.require_session(&params.session_id).await?;
    if !session.reserve_cell(MAX_ACTIVE_CELLS_PER_SESSION) {
        return Err(ProtocolError::new(
            ErrorCode::RuntimeUnavailable,
            "session active-cell limit reached",
        ));
    }
    if !state.reserve_host_cell() {
        session.release_cell();
        return Err(ProtocolError::new(
            ErrorCode::RuntimeUnavailable,
            "host active-cell limit reached",
        ));
    }

    let cell_id = params.cell_id.clone();
    let delegate: SharedToolInvoker = Arc::new(ProtocolDelegate::new(
        params.session_id.clone(),
        cell_id.clone(),
        params.parent_tool_call_id,
        state.outbound.clone(),
        Arc::clone(&state.pending),
        Arc::clone(&state.next_request_id),
    ));
    let tools = match runtime_tools(&params.tools) {
        Ok(tools) => tools,
        Err(error) => {
            release_reserved(state, &session);
            return Err(error);
        }
    };
    let spawn = CellSpawnConfig {
        id: cell_id.clone(),
        source: params.source,
        tools,
        limits,
        invoker: delegate,
        output: OutputBuffer::new(params.options.max_output_bytes),
        store: session.store.clone(),
        wall_time_ms: params.options.wall_time_ms,
    };
    let cell = match tokio::task::spawn_blocking(move || spawn_cell(spawn)).await {
        Ok(Ok(cell)) => cell,
        Ok(Err(error)) => {
            release_reserved(state, &session);
            return Err(error);
        }
        Err(error) => {
            release_reserved(state, &session);
            return Err(ProtocolError::new(
                ErrorCode::RuntimeCrashed,
                format!("cell startup task failed: {error}"),
            ));
        }
    };
    match session.insert_cell(cell_id.clone(), cell.clone()).await {
        InsertCellResult::Inserted => {}
        InsertCellResult::Cancelled => {
            let result = cell
                .observe(ObserveOptions {
                    yield_time_ms: 0,
                    max_output_bytes: params.options.max_output_bytes,
                    terminate: true,
                })
                .await;
            release_cell(state, &session, &cell);
            return encode(result?);
        }
        InsertCellResult::Duplicate => {
            cell.terminate();
            release_reserved(state, &session);
            return Err(ProtocolError::new(
                ErrorCode::InvalidInput,
                "cell id is already in use",
            ));
        }
    }
    let result = cell
        .observe(ObserveOptions {
            yield_time_ms: params.options.yield_time_ms,
            max_output_bytes: params.options.max_output_bytes,
            terminate: false,
        })
        .await?;
    release_terminal(state, &session, &cell_id, &cell, result.status).await;
    encode(result)
}

async fn wait_cell(state: &Arc<ServerState>, params: Value) -> Result<Value, ProtocolError> {
    let params: CellWaitParams = parse_params(params)?;
    validate_wait(&params)?;
    validate_observation(params.yield_time_ms, params.max_output_bytes)?;
    let session = state.require_session(&params.session_id).await?;
    let cell = find_cell(&session, &params.cell_id).await?;
    let result = cell
        .observe(ObserveOptions {
            yield_time_ms: params.yield_time_ms,
            max_output_bytes: params.max_output_bytes,
            terminate: params.terminate,
        })
        .await?;
    release_terminal(state, &session, &params.cell_id, &cell, result.status).await;
    encode(result)
}

async fn terminate_cell(state: &Arc<ServerState>, params: Value) -> Result<Value, ProtocolError> {
    let params: CellTerminateParams = parse_params(params)?;
    let session = state.require_session(&params.session_id).await?;
    if let Some(cell) = session.request_termination(&params.cell_id).await {
        cell.terminate();
        return Ok(json!({"terminating": true}));
    }
    Ok(json!({"pending": true}))
}

async fn find_cell(session: &HostSession, cell_id: &str) -> Result<CellHandle, ProtocolError> {
    session
        .find_cell(cell_id)
        .await
        .ok_or_else(|| ProtocolError::new(ErrorCode::CellNotFound, "cell was not found"))
}

async fn release_terminal(
    state: &ServerState,
    session: &HostSession,
    cell_id: &str,
    cell: &CellHandle,
    status: CellStatus,
) {
    if status != CellStatus::Waiting {
        session.remove_cell(cell_id).await;
        release_cell(state, session, cell);
    }
}

fn release_cell(state: &ServerState, session: &HostSession, cell: &CellHandle) {
    if cell.release_active_slot() {
        session.release_cell();
        state.release_host_cell();
    }
}

fn release_reserved(state: &ServerState, session: &HostSession) {
    session.release_cell();
    state.release_host_cell();
}

fn runtime_tools(tools: &[ToolDefinition]) -> Result<Vec<RuntimeTool>, ProtocolError> {
    if tools
        .iter()
        .any(|tool| !matches!(tool.kind, ToolKind::Function | ToolKind::Freeform))
    {
        return Err(ProtocolError::new(
            ErrorCode::InvalidInput,
            "unsupported nested tool kind",
        ));
    }
    Ok(tools
        .iter()
        .map(|tool| RuntimeTool {
            name: tool.code_mode_name.clone(),
            description: tool.description.clone(),
            deferred: tool.deferred,
        })
        .collect())
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, ProtocolError> {
    serde_json::from_value(params).map_err(|error| {
        ProtocolError::new(
            ErrorCode::InvalidInput,
            format!("invalid parameters: {error}"),
        )
    })
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, ProtocolError> {
    to_value(value).map_err(|error| {
        ProtocolError::new(
            ErrorCode::InternalError,
            format!("could not encode protocol response: {error}"),
        )
    })
}
