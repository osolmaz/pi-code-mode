use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;

#[derive(Clone, Debug)]
pub struct RuntimeLimits {
    pub max_heap_bytes: usize,
    pub max_output_bytes: usize,
    pub max_tool_calls: u32,
    pub max_concurrent_tool_calls: u32,
    pub max_tool_input_bytes: usize,
    pub max_tool_result_bytes: usize,
    pub max_total_tool_result_bytes: usize,
    pub max_store_bytes: usize,
    pub max_timer_ms: u64,
    pub max_timers: u32,
    pub cpu_limit_ms: u64,
}

#[derive(Clone, Debug)]
pub struct RuntimeTool {
    pub id: String,
    pub sdk_path: Vec<String>,
    pub description: String,
    pub deferred: bool,
}

#[derive(Clone, Debug)]
pub struct ToolInvocation {
    pub call_id: String,
    pub tool: String,
    pub input: Value,
}

pub type InvocationFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;

pub trait ToolInvoker: Send + Sync + 'static {
    fn invoke(&self, invocation: ToolInvocation) -> InvocationFuture;
}

pub type SharedToolInvoker = Arc<dyn ToolInvoker>;

pub struct YieldRequest {
    pub resume: oneshot::Sender<()>,
}
