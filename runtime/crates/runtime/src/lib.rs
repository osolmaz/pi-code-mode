mod bootstrap;
mod ops;
mod output;
mod store;
mod types;
mod watchdog;

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use deno_core::error::CoreError;
use deno_core::v8;
use deno_core::{JsRuntime, PollEventLoopOptions, RuntimeOptions};
use futures::FutureExt;
use thiserror::Error;
use tokio::sync::{Semaphore, mpsc};

pub use output::{OutputBuffer, OutputSnapshot, RuntimeOutput};
pub use store::SessionStore;
pub use types::{
    InvocationFuture, RuntimeLimits, RuntimeTool, SharedToolInvoker, ToolInvocation, ToolInvoker,
    YieldRequest,
};
pub type TerminateHandle = v8::IsolateHandle;

use bootstrap::{bootstrap_source, program_source};
use ops::RuntimeState;
use watchdog::CpuWatchdog;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("JavaScript initialization failed: {0}")]
    Initialization(String),
    #[error("JavaScript execution failed: {0}")]
    Execution(String),
    #[error("JavaScript CPU limit exceeded")]
    CpuLimit,
    #[error("JavaScript heap limit exceeded")]
    MemoryLimit,
    #[error("JavaScript event loop stopped before the program completed")]
    PendingPromise,
}

pub struct RuntimeConfig {
    pub source: String,
    pub tools: Vec<RuntimeTool>,
    pub limits: RuntimeLimits,
    pub invoker: SharedToolInvoker,
    pub output: OutputBuffer,
    pub store: SessionStore,
    pub yield_tx: mpsc::UnboundedSender<YieldRequest>,
}

pub struct RuntimeExecution {
    runtime: JsRuntime,
    completion: Pin<Box<dyn Future<Output = Result<(), String>>>>,
    watchdog: CpuWatchdog,
    cpu_limit: Duration,
    memory_limit_hit: Arc<AtomicBool>,
    tool_calls: Arc<AtomicU32>,
    output: OutputBuffer,
    terminate_handle: v8::IsolateHandle,
}

impl Unpin for RuntimeExecution {}

impl RuntimeExecution {
    pub fn new(config: RuntimeConfig) -> Result<Self, RuntimeError> {
        let create_params =
            v8::Isolate::create_params().heap_limits(0, config.limits.max_heap_bytes);
        let mut runtime = JsRuntime::new(RuntimeOptions {
            create_params: Some(create_params),
            extensions: vec![ops::code_mode_runtime::init()],
            ..RuntimeOptions::default()
        });
        let terminate_handle = runtime.v8_isolate().thread_safe_handle();
        let watchdog = CpuWatchdog::new(terminate_handle.clone());
        let memory_limit_hit = Arc::new(AtomicBool::new(false));
        let memory_flag = Arc::clone(&memory_limit_hit);
        let heap_handle = terminate_handle.clone();
        runtime.add_near_heap_limit_callback(move |current_limit, _initial_limit| {
            memory_flag.store(true, Ordering::Release);
            let _ = heap_handle.terminate_execution();
            current_limit.saturating_mul(2)
        });

        let tool_calls = Arc::new(AtomicU32::new(0));
        let allowed_tools = config
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<HashSet<_>>();
        if allowed_tools.len() != config.tools.len() {
            return Err(RuntimeError::Initialization(
                "tool names must be unique".to_owned(),
            ));
        }
        runtime.op_state().borrow_mut().put(RuntimeState {
            allowed_tools: Arc::new(allowed_tools),
            invoker: config.invoker,
            output: config.output.clone(),
            store: config.store,
            limits: config.limits.clone(),
            tool_calls: Arc::clone(&tool_calls),
            total_tool_result_bytes: Arc::new(AtomicUsize::new(0)),
            next_call_id: Arc::new(AtomicU64::new(1)),
            active_timers: Arc::new(AtomicU32::new(0)),
            tool_slots: Arc::new(Semaphore::new(
                config.limits.max_concurrent_tool_calls as usize,
            )),
            yield_tx: config.yield_tx,
        });

        let cpu_limit = Duration::from_millis(config.limits.cpu_limit_ms);
        watchdog.arm(cpu_limit);
        let bootstrap = bootstrap_source(&config.tools)
            .map_err(|error| RuntimeError::Initialization(error.to_string()))?;
        let initialized = runtime.execute_script("pi-code-mode:bootstrap", bootstrap);
        watchdog.disarm();
        initialized.map_err(|error| RuntimeError::Initialization(error.to_string()))?;

        watchdog.arm(cpu_limit);
        let promise =
            runtime.execute_script("pi-code-mode:program", program_source(&config.source));
        watchdog.disarm();
        let promise = promise.map_err(|error| {
            classify_start_error(&watchdog, &memory_limit_hit, error.to_string())
        })?;
        let completion = runtime
            .resolve(promise)
            .map(|result| result.map(|_| ()).map_err(|error| error.to_string()));

        Ok(Self {
            runtime,
            completion: Box::pin(completion),
            watchdog,
            cpu_limit,
            memory_limit_hit,
            tool_calls,
            output: config.output,
            terminate_handle,
        })
    }

    #[must_use]
    pub fn terminate_handle(&self) -> TerminateHandle {
        self.terminate_handle.clone()
    }

    #[must_use]
    pub fn output(&self) -> OutputBuffer {
        self.output.clone()
    }

    #[must_use]
    pub fn tool_calls(&self) -> u32 {
        self.tool_calls.load(Ordering::Acquire)
    }

    fn classify_error(&self, message: String) -> RuntimeError {
        if self.memory_limit_hit.load(Ordering::Acquire) {
            RuntimeError::MemoryLimit
        } else if self.watchdog.tripped() {
            RuntimeError::CpuLimit
        } else if message.contains("__PI_CODE_MODE_EXIT__") {
            RuntimeError::Execution("__PI_CODE_MODE_EXIT__".to_owned())
        } else {
            RuntimeError::Execution(message)
        }
    }
}

impl Future for RuntimeExecution {
    type Output = Result<(), RuntimeError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if let Poll::Ready(result) = this.completion.as_mut().poll(context) {
            return Poll::Ready(match result {
                Ok(()) => Ok(()),
                Err(message) if message.contains("__PI_CODE_MODE_EXIT__") => Ok(()),
                Err(message) => Err(this.classify_error(message)),
            });
        }

        this.watchdog.arm(this.cpu_limit);
        let event_loop = this
            .runtime
            .poll_event_loop(context, PollEventLoopOptions::default());
        this.watchdog.disarm();

        if let Poll::Ready(result) = event_loop {
            if let Err(error) = result {
                return Poll::Ready(Err(this.classify_error(error.to_string())));
            }
            if let Poll::Ready(result) = this.completion.as_mut().poll(context) {
                return Poll::Ready(match result {
                    Ok(()) => Ok(()),
                    Err(message) if message.contains("__PI_CODE_MODE_EXIT__") => Ok(()),
                    Err(message) => Err(this.classify_error(message)),
                });
            }
            return Poll::Ready(Err(RuntimeError::PendingPromise));
        }
        Poll::Pending
    }
}

fn classify_start_error(
    watchdog: &CpuWatchdog,
    memory_limit_hit: &AtomicBool,
    message: String,
) -> RuntimeError {
    if memory_limit_hit.load(Ordering::Acquire) {
        RuntimeError::MemoryLimit
    } else if watchdog.tripped() {
        RuntimeError::CpuLimit
    } else {
        RuntimeError::Initialization(message)
    }
}

#[must_use]
pub fn v8_version() -> &'static str {
    v8::V8::get_version()
}

#[allow(dead_code)]
fn _assert_core_error_send(_: CoreError) {}
