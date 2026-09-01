use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Envelope {
    Request(Request),
    Response(Response),
    Event(Event),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Response {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

impl Response {
    #[must_use]
    pub fn success(id: String, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    #[must_use]
    pub fn failure(id: String, error: ProtocolError) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Event {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

impl ProtocolError {
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    ProtocolError,
    RuntimeUnavailable,
    RuntimeCrashed,
    ExecutionFailed,
    ExecutionTerminated,
    Aborted,
    CpuLimitExceeded,
    WallTimeExceeded,
    MemoryLimitExceeded,
    StackLimitExceeded,
    SourceLimitExceeded,
    ToolCallLimitExceeded,
    OutputLimitExceeded,
    SessionExpired,
    CellExpired,
    CellNotFound,
    CellScopeMismatch,
    WaitAlreadyActive,
    ToolNotAllowed,
    ToolInputInvalid,
    ToolFailed,
    InternalError,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol_versions: Vec<u32>,
    pub client: PeerInfo,
    pub capabilities: ClientCapabilities,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHello {
    pub protocol_version: u32,
    pub host: HostInfo,
    pub capabilities: HostCapabilities,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PeerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HostInfo {
    pub name: String,
    pub version: String,
    pub runtime: String,
    pub v8: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    pub images: bool,
    pub notifications: bool,
    pub session_store: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    pub wait: bool,
    pub images: bool,
    pub notifications: bool,
    pub session_store: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenParams {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpened {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseParams {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellExecParams {
    pub session_id: String,
    pub cell_id: String,
    pub parent_tool_call_id: String,
    pub source: String,
    pub tools: Vec<ToolDefinition>,
    pub options: ExecutionOptions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellWaitParams {
    pub session_id: String,
    pub cell_id: String,
    pub yield_time_ms: u64,
    pub max_output_bytes: usize,
    pub terminate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellTerminateParams {
    pub session_id: String,
    pub cell_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOptions {
    pub yield_time_ms: u64,
    pub max_output_bytes: usize,
    pub max_source_bytes: usize,
    pub max_heap_bytes: usize,
    pub max_tool_calls: u32,
    pub max_concurrent_tool_calls: u32,
    pub max_tool_input_bytes: usize,
    pub max_tool_result_bytes: usize,
    pub max_total_tool_result_bytes: usize,
    pub max_store_bytes: usize,
    pub max_timer_ms: u64,
    pub max_timers: u32,
    pub cpu_limit_ms: u64,
    pub wall_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub id: String,
    pub sdk_path: Vec<String>,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
    pub kind: ToolKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(default)]
    pub deferred: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Function,
    Freeform,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvokeParams {
    pub session_id: String,
    pub cell_id: String,
    pub parent_tool_call_id: String,
    pub call_id: String,
    pub tool: String,
    pub input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellResult {
    pub status: CellStatus,
    pub cell_id: String,
    pub output: Vec<OutputItem>,
    pub truncated: bool,
    pub stats: ExecutionStats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CellStatus {
    Completed,
    Failed,
    Waiting,
    Terminated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutputItem {
    Text { text: String },
    Notification { message: String },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionStats {
    pub tool_calls: u32,
    pub output_bytes: usize,
    pub wall_time_ms: u64,
}
