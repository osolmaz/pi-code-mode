use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use deno_core::{CancelFuture, CancelHandle, OpState, op2};
use deno_error::JsErrorBox;
use tokio::sync::{Semaphore, mpsc, oneshot};

use crate::output::OutputBuffer;
use crate::store::SessionStore;
use crate::types::{RuntimeLimits, SharedToolInvoker, ToolInvocation, YieldRequest};

pub(crate) struct TimerEntry {
    cancel: Rc<CancelHandle>,
    delay: Duration,
}

pub struct RuntimeState {
    pub allowed_tools: Arc<HashSet<String>>,
    pub invoker: SharedToolInvoker,
    pub output: OutputBuffer,
    pub store: SessionStore,
    pub limits: RuntimeLimits,
    pub tool_calls: Arc<AtomicU32>,
    pub total_tool_result_bytes: Arc<AtomicUsize>,
    pub next_call_id: Arc<AtomicU64>,
    pub(crate) timers: Rc<RefCell<HashMap<u32, TimerEntry>>>,
    pub tool_slots: Arc<Semaphore>,
    pub yield_tx: mpsc::UnboundedSender<YieldRequest>,
}

#[op2]
#[serde]
async fn op_tool_invoke(
    state: Rc<RefCell<OpState>>,
    #[string] name: String,
    #[serde] input: serde_json::Value,
) -> Result<serde_json::Value, JsErrorBox> {
    let (allowed, invoker, limits, tool_calls, total_result_bytes, next_call_id, tool_slots) = {
        let state = state.borrow();
        let runtime = state.borrow::<RuntimeState>();
        (
            runtime.allowed_tools.contains(&name),
            Arc::clone(&runtime.invoker),
            runtime.limits.clone(),
            Arc::clone(&runtime.tool_calls),
            Arc::clone(&runtime.total_tool_result_bytes),
            Arc::clone(&runtime.next_call_id),
            Arc::clone(&runtime.tool_slots),
        )
    };
    if !allowed {
        return Err(JsErrorBox::generic(format!("tool is not allowed: {name}")));
    }
    let input_bytes = serde_json::to_vec(&input)
        .map_err(|error| JsErrorBox::generic(format!("tool input is not JSON-safe: {error}")))?
        .len();
    if input_bytes > limits.max_tool_input_bytes {
        return Err(JsErrorBox::generic(
            "tool input exceeds the configured limit",
        ));
    }
    let call_number = tool_calls.fetch_add(1, Ordering::AcqRel).saturating_add(1);
    if call_number > limits.max_tool_calls {
        return Err(JsErrorBox::generic("tool call limit exceeded"));
    }
    let permit = tool_slots
        .acquire_owned()
        .await
        .map_err(|_| JsErrorBox::generic("tool execution is shutting down"))?;
    let call_id = format!("call:{}", next_call_id.fetch_add(1, Ordering::Relaxed));
    let result = invoker
        .invoke(ToolInvocation {
            call_id,
            tool: name,
            input,
        })
        .await
        .map_err(JsErrorBox::generic)?;
    drop(permit);
    let result_bytes = serde_json::to_vec(&result)
        .map_err(|error| JsErrorBox::generic(format!("tool result is not JSON-safe: {error}")))?
        .len();
    if result_bytes > limits.max_tool_result_bytes {
        return Err(JsErrorBox::generic(
            "tool result exceeds the per-call limit",
        ));
    }
    let total = total_result_bytes
        .fetch_add(result_bytes, Ordering::AcqRel)
        .saturating_add(result_bytes);
    if total > limits.max_total_tool_result_bytes {
        return Err(JsErrorBox::generic("total tool result limit exceeded"));
    }
    Ok(result)
}

#[op2(fast)]
fn op_emit_text(state: &mut OpState, #[string] text: String) {
    state.borrow::<RuntimeState>().output.text(text);
}

#[op2(fast)]
fn op_notify(state: &mut OpState, #[string] message: String) {
    state.borrow::<RuntimeState>().output.notification(message);
}

#[op2]
fn op_store(
    state: &mut OpState,
    #[string] key: String,
    #[serde] value: serde_json::Value,
) -> Result<(), JsErrorBox> {
    let runtime = state.borrow::<RuntimeState>();
    runtime
        .store
        .put(key, value, runtime.limits.max_store_bytes)
        .map_err(JsErrorBox::generic)
}

#[op2]
#[serde]
fn op_load(state: &mut OpState, #[string] key: &str) -> Result<serde_json::Value, JsErrorBox> {
    state
        .borrow::<RuntimeState>()
        .store
        .get(key)
        .map_err(JsErrorBox::generic)
}

#[op2]
async fn op_yield_control(state: Rc<RefCell<OpState>>) -> Result<(), JsErrorBox> {
    let yield_tx = {
        let state = state.borrow();
        state.borrow::<RuntimeState>().yield_tx.clone()
    };
    let (resume, receiver) = oneshot::channel();
    yield_tx
        .send(YieldRequest { resume })
        .map_err(|_| JsErrorBox::generic("cell is shutting down"))?;
    receiver
        .await
        .map_err(|_| JsErrorBox::generic("cell was terminated"))
}

#[op2(fast)]
fn op_exit() -> Result<(), JsErrorBox> {
    Err(JsErrorBox::generic("__PI_CODE_MODE_EXIT__"))
}

#[op2(fast)]
fn op_timer_start(state: &mut OpState, id: u32, delay_ms: f64) -> Result<(), JsErrorBox> {
    let runtime = state.borrow::<RuntimeState>();
    if !delay_ms.is_finite() {
        return Err(JsErrorBox::generic("timer delay must be finite"));
    }
    let delay_ms = delay_ms.max(0.0).round();
    let maximum_delay_ms =
        Duration::from_millis(runtime.limits.max_timer_ms).as_secs_f64() * 1000.0;
    if delay_ms > maximum_delay_ms {
        return Err(JsErrorBox::generic(
            "timer delay exceeds the configured limit",
        ));
    }
    let mut timers = runtime.timers.borrow_mut();
    if timers.len() >= runtime.limits.max_timers as usize {
        return Err(JsErrorBox::generic("active timer limit exceeded"));
    }
    if timers.contains_key(&id) {
        return Err(JsErrorBox::generic("timer id is already active"));
    }
    timers.insert(
        id,
        TimerEntry {
            cancel: CancelHandle::new_rc(),
            delay: Duration::from_secs_f64(delay_ms / 1000.0),
        },
    );
    Ok(())
}

#[op2]
async fn op_sleep(state: Rc<RefCell<OpState>>, id: u32) -> bool {
    let timers = {
        let state = state.borrow();
        Rc::clone(&state.borrow::<RuntimeState>().timers)
    };
    let Some((cancel, delay)) = timers
        .borrow()
        .get(&id)
        .map(|entry| (Rc::clone(&entry.cancel), entry.delay))
    else {
        return false;
    };
    let completed = tokio::time::sleep(delay).or_cancel(cancel).await.is_ok();
    timers.borrow_mut().remove(&id);
    completed
}

#[op2(fast)]
fn op_timer_cancel(state: &mut OpState, id: u32) -> bool {
    let timer = state
        .borrow::<RuntimeState>()
        .timers
        .borrow_mut()
        .remove(&id);
    if let Some(timer) = timer {
        timer.cancel.cancel();
        true
    } else {
        false
    }
}

deno_core::extension!(
    code_mode_runtime,
    ops = [
        op_tool_invoke,
        op_emit_text,
        op_notify,
        op_store,
        op_load,
        op_yield_control,
        op_exit,
        op_timer_start,
        op_sleep,
        op_timer_cancel,
    ],
);
