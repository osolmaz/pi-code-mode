use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc as std_mpsc};
use std::thread;
use std::time::{Duration, Instant};

use pi_code_mode_protocol::{
    CellResult, CellStatus, ErrorCode, ExecutionStats, OutputItem, ProtocolError,
};
use pi_code_mode_runtime::{
    OutputBuffer, RuntimeConfig, RuntimeError, RuntimeExecution, RuntimeLimits, RuntimeOutput,
    RuntimeTool, SessionStore, SharedToolInvoker, TerminateHandle, YieldRequest,
};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep, sleep_until};

#[derive(Clone, Debug)]
pub struct ObserveOptions {
    pub yield_time_ms: u64,
    pub max_output_bytes: usize,
    pub terminate: bool,
}

struct Observer {
    options: ObserveOptions,
    sender: oneshot::Sender<CellResult>,
}

enum CellCommand {
    Observe(Observer),
    Terminate,
}

#[derive(Clone)]
pub struct CellHandle {
    commands: mpsc::UnboundedSender<CellCommand>,
    terminate_handle: TerminateHandle,
    observing: Arc<AtomicBool>,
    counted: Arc<AtomicBool>,
    termination_requested: Arc<AtomicBool>,
}

impl CellHandle {
    pub async fn observe(&self, options: ObserveOptions) -> Result<CellResult, ProtocolError> {
        if options.terminate {
            self.termination_requested.store(true, Ordering::Release);
            let _ = self.terminate_handle.terminate_execution();
        }
        if self
            .observing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(ProtocolError::new(
                ErrorCode::WaitAlreadyActive,
                "another wait is already active for this cell",
            ));
        }
        let (sender, receiver) = oneshot::channel();
        let sent = self
            .commands
            .send(CellCommand::Observe(Observer { options, sender }));
        if sent.is_err() {
            self.observing.store(false, Ordering::Release);
            return Err(ProtocolError::new(
                ErrorCode::CellExpired,
                "cell is no longer available",
            ));
        }
        let result = receiver.await.map_err(|_| {
            ProtocolError::new(
                ErrorCode::RuntimeCrashed,
                "cell runtime stopped unexpectedly",
            )
        });
        self.observing.store(false, Ordering::Release);
        result
    }

    #[must_use]
    pub fn release_active_slot(&self) -> bool {
        self.counted.swap(false, Ordering::AcqRel)
    }

    pub fn terminate(&self) {
        self.termination_requested.store(true, Ordering::Release);
        let _ = self.terminate_handle.terminate_execution();
        let _ = self.commands.send(CellCommand::Terminate);
    }
}

pub struct CellSpawnConfig {
    pub id: String,
    pub source: String,
    pub tools: Vec<RuntimeTool>,
    pub limits: RuntimeLimits,
    pub invoker: SharedToolInvoker,
    pub output: OutputBuffer,
    pub store: SessionStore,
    pub wall_time_ms: u64,
}

pub fn spawn_cell(config: CellSpawnConfig) -> Result<CellHandle, ProtocolError> {
    let id = config.id.clone();
    let observing = Arc::new(AtomicBool::new(false));
    let counted = Arc::new(AtomicBool::new(true));
    let termination_requested = Arc::new(AtomicBool::new(false));
    let actor_termination_requested = Arc::clone(&termination_requested);
    let (commands, command_rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    thread::Builder::new()
        .name(format!("pi-code-mode-cell-{id}"))
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            run_cell_thread(config, command_rx, ready_tx, actor_termination_requested);
        })
        .map_err(|error| {
            ProtocolError::new(
                ErrorCode::RuntimeUnavailable,
                format!("could not start cell runtime: {error}"),
            )
        })?;
    let terminate_handle = ready_rx.recv().map_err(|_| {
        ProtocolError::new(
            ErrorCode::RuntimeCrashed,
            "cell runtime stopped during startup",
        )
    })??;
    Ok(CellHandle {
        commands,
        terminate_handle,
        observing,
        counted,
        termination_requested,
    })
}

fn run_cell_thread(
    config: CellSpawnConfig,
    command_rx: mpsc::UnboundedReceiver<CellCommand>,
    ready: std_mpsc::SyncSender<Result<TerminateHandle, ProtocolError>>,
    termination_requested: Arc<AtomicBool>,
) {
    let tokio = match tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(ProtocolError::new(
                ErrorCode::RuntimeUnavailable,
                format!("could not create cell event loop: {error}"),
            )));
            return;
        }
    };
    tokio.block_on(async move {
        let (yield_tx, yield_rx) = mpsc::unbounded_channel::<YieldRequest>();
        let execution = RuntimeExecution::new(RuntimeConfig {
            source: config.source,
            tools: config.tools,
            limits: config.limits,
            invoker: config.invoker,
            output: config.output,
            store: config.store,
            yield_tx,
        });
        let execution = match execution {
            Ok(execution) => execution,
            Err(error) => {
                let _ = ready.send(Err(runtime_protocol_error(&error)));
                return;
            }
        };
        let _ = ready.send(Ok(execution.terminate_handle()));
        run_actor(
            config.id,
            execution,
            command_rx,
            yield_rx,
            config.wall_time_ms,
            termination_requested,
        )
        .await;
    });
}

#[derive(Clone, Debug)]
enum TerminalState {
    Completed,
    Failed(String),
    Terminated,
}

#[allow(clippy::too_many_lines)]
async fn run_actor(
    cell_id: String,
    execution: RuntimeExecution,
    mut commands: mpsc::UnboundedReceiver<CellCommand>,
    mut yields: mpsc::UnboundedReceiver<YieldRequest>,
    wall_time_ms: u64,
    termination_requested: Arc<AtomicBool>,
) {
    let started = Instant::now();
    let wall_deadline = tokio::time::Instant::now() + Duration::from_millis(wall_time_ms);
    let mut wall_timer = Box::pin(sleep_until(wall_deadline));
    let mut execution = Box::pin(execution);
    let mut terminal: Option<TerminalState> = None;
    let mut delivered_sequence = 0_u64;
    let mut suspended_yield: Option<oneshot::Sender<()>> = None;

    let (mut observer, mut observer_timer) = match commands.recv().await {
        Some(CellCommand::Observe(initial)) if !initial.options.terminate => {
            let delay = Duration::from_millis(initial.options.yield_time_ms);
            (Some(initial), Some(Box::pin(sleep(delay))))
        }
        Some(CellCommand::Observe(initial)) => {
            let state = TerminalState::Terminated;
            deliver(
                initial,
                &cell_id,
                &state,
                execution.as_ref().get_ref(),
                &mut delivered_sequence,
                started,
            );
            return;
        }
        Some(CellCommand::Terminate) | None => {
            let _ = execution.terminate_handle().terminate_execution();
            return;
        }
    };

    loop {
        if let Some(state) = terminal.as_ref() {
            let Some(command) = commands.recv().await else {
                return;
            };
            match command {
                CellCommand::Observe(observer) => {
                    deliver(
                        observer,
                        &cell_id,
                        state,
                        execution.as_ref().get_ref(),
                        &mut delivered_sequence,
                        started,
                    );
                }
                CellCommand::Terminate => return,
            }
            continue;
        }

        tokio::select! {
            result = execution.as_mut() => {
                terminal = Some(match result {
                    Ok(()) => TerminalState::Completed,
                    Err(_) if termination_requested.load(Ordering::Acquire) => TerminalState::Terminated,
                    Err(error) => TerminalState::Failed(error.to_string()),
                });
                if let (Some(observer), Some(state)) = (observer.take(), terminal.as_ref()) {
                    deliver(observer, &cell_id, state, execution.as_ref().get_ref(), &mut delivered_sequence, started);
                }
                observer_timer = None;
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    let _ = execution.terminate_handle().terminate_execution();
                    return;
                };
                match command {
                    CellCommand::Terminate => {
                        let _ = execution.terminate_handle().terminate_execution();
                        terminal = Some(TerminalState::Terminated);
                        if let (Some(observer), Some(state)) = (observer.take(), terminal.as_ref()) {
                            deliver(observer, &cell_id, state, execution.as_ref().get_ref(), &mut delivered_sequence, started);
                        }
                        observer_timer = None;
                    }
                    CellCommand::Observe(next) => {
                        if next.options.terminate {
                            let _ = execution.terminate_handle().terminate_execution();
                            terminal = Some(TerminalState::Terminated);
                            if let Some(state) = terminal.as_ref() {
                                deliver(next, &cell_id, state, execution.as_ref().get_ref(), &mut delivered_sequence, started);
                            }
                        } else {
                            if let Some(resume) = suspended_yield.take() {
                                let _ = resume.send(());
                            }
                            let delay = Duration::from_millis(next.options.yield_time_ms);
                            observer_timer = Some(Box::pin(sleep(delay)));
                            observer = Some(next);
                        }
                    }
                }
            }
            request = yields.recv() => {
                let Some(request) = request else { continue; };
                suspended_yield = Some(request.resume);
                if let Some(observer) = observer.take() {
                    let waiting = TerminalState::Failed(String::new());
                    deliver_waiting(observer, &cell_id, execution.as_ref().get_ref(), &mut delivered_sequence, started, &waiting);
                    observer_timer = None;
                }
            }
            () = async {
                match observer_timer.as_mut() {
                    Some(timer) => timer.as_mut().await,
                    None => pending::<()>().await,
                }
            } => {
                if let Some(observer) = observer.take() {
                    let waiting = TerminalState::Failed(String::new());
                    deliver_waiting(observer, &cell_id, execution.as_ref().get_ref(), &mut delivered_sequence, started, &waiting);
                }
                observer_timer = None;
            }
            () = wall_timer.as_mut() => {
                let _ = execution.terminate_handle().terminate_execution();
                terminal = Some(TerminalState::Failed("JavaScript wall-time limit exceeded".to_owned()));
                if let (Some(observer), Some(state)) = (observer.take(), terminal.as_ref()) {
                    deliver(observer, &cell_id, state, execution.as_ref().get_ref(), &mut delivered_sequence, started);
                }
                observer_timer = None;
            }
        }
    }
}

fn deliver_waiting(
    observer: Observer,
    cell_id: &str,
    execution: &RuntimeExecution,
    delivered_sequence: &mut u64,
    started: Instant,
    _placeholder: &TerminalState,
) {
    let result = build_result(
        cell_id,
        CellStatus::Waiting,
        None,
        observer.options.max_output_bytes,
        execution,
        delivered_sequence,
        started,
    );
    let _ = observer.sender.send(result);
}

fn deliver(
    observer: Observer,
    cell_id: &str,
    state: &TerminalState,
    execution: &RuntimeExecution,
    delivered_sequence: &mut u64,
    started: Instant,
) {
    let (status, error) = match state {
        TerminalState::Completed => (CellStatus::Completed, None),
        TerminalState::Failed(error) => (CellStatus::Failed, Some(error.clone())),
        TerminalState::Terminated => (CellStatus::Terminated, None),
    };
    let result = build_result(
        cell_id,
        status,
        error,
        observer.options.max_output_bytes,
        execution,
        delivered_sequence,
        started,
    );
    let _ = observer.sender.send(result);
}

fn build_result(
    cell_id: &str,
    status: CellStatus,
    error: Option<String>,
    max_output_bytes: usize,
    execution: &RuntimeExecution,
    delivered_sequence: &mut u64,
    started: Instant,
) -> CellResult {
    let snapshot = execution
        .output()
        .snapshot(*delivered_sequence, max_output_bytes);
    *delivered_sequence = snapshot.next_sequence;
    let output = snapshot
        .items
        .into_iter()
        .map(|item| match item {
            RuntimeOutput::Text { text } => OutputItem::Text { text },
            RuntimeOutput::Notification { message } => OutputItem::Notification { message },
        })
        .collect();
    CellResult {
        status,
        cell_id: cell_id.to_owned(),
        output,
        truncated: snapshot.truncated,
        stats: ExecutionStats {
            tool_calls: execution.tool_calls(),
            output_bytes: snapshot.total_bytes,
            wall_time_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        },
        error,
    }
}

fn runtime_protocol_error(error: &RuntimeError) -> ProtocolError {
    let code = match error {
        RuntimeError::CpuLimit => ErrorCode::CpuLimitExceeded,
        RuntimeError::MemoryLimit => ErrorCode::MemoryLimitExceeded,
        RuntimeError::Initialization(_)
        | RuntimeError::Execution(_)
        | RuntimeError::PendingPromise => ErrorCode::ExecutionFailed,
    };
    ProtocolError::new(code, error.to_string())
}
