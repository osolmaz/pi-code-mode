use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::future::BoxFuture;
use pi_code_mode_protocol::{Envelope, ErrorCode, ProtocolError, Request, ToolInvokeParams};
use pi_code_mode_runtime::{InvocationFuture, ToolInvocation, ToolInvoker};
use serde_json::{Value, to_value};
use tokio::sync::{Mutex, mpsc, oneshot};

pub type PendingCalls = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, ProtocolError>>>>>;

#[derive(Clone)]
pub struct ProtocolDelegate {
    session_id: String,
    cell_id: String,
    parent_tool_call_id: String,
    outbound: mpsc::UnboundedSender<Envelope>,
    pending: PendingCalls,
    next_request_id: Arc<AtomicU64>,
}

impl ProtocolDelegate {
    #[must_use]
    pub fn new(
        session_id: String,
        cell_id: String,
        parent_tool_call_id: String,
        outbound: mpsc::UnboundedSender<Envelope>,
        pending: PendingCalls,
        next_request_id: Arc<AtomicU64>,
    ) -> Self {
        Self {
            session_id,
            cell_id,
            parent_tool_call_id,
            outbound,
            pending,
            next_request_id,
        }
    }

    async fn invoke_inner(&self, invocation: ToolInvocation) -> Result<Value, String> {
        let request_id = format!("h:{}", self.next_request_id.fetch_add(1, Ordering::Relaxed));
        let params = ToolInvokeParams {
            session_id: self.session_id.clone(),
            cell_id: self.cell_id.clone(),
            parent_tool_call_id: self.parent_tool_call_id.clone(),
            call_id: invocation.call_id,
            tool: invocation.tool,
            input: invocation.input,
        };
        let params = to_value(params).map_err(|error| error.to_string())?;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), sender);
        let sent = self.outbound.send(Envelope::Request(Request {
            id: request_id.clone(),
            method: "tool/invoke".to_owned(),
            params,
        }));
        if sent.is_err() {
            self.pending.lock().await.remove(&request_id);
            return Err("tool broker connection is closed".to_owned());
        }
        match receiver.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error.message),
            Err(_) => Err("tool broker request was cancelled".to_owned()),
        }
    }
}

impl ToolInvoker for ProtocolDelegate {
    fn invoke(&self, invocation: ToolInvocation) -> InvocationFuture {
        let delegate = self.clone();
        Box::pin(async move { delegate.invoke_inner(invocation).await }) as BoxFuture<'static, _>
    }
}

pub async fn resolve_response(
    pending: &PendingCalls,
    response: pi_code_mode_protocol::Response,
) -> Result<(), ProtocolError> {
    let Some(sender) = pending.lock().await.remove(&response.id) else {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolError,
            "response refers to an unknown host request",
        ));
    };
    let value = match (response.result, response.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => Err(ProtocolError::new(
            ErrorCode::ProtocolError,
            "response must contain exactly one result or error",
        )),
    };
    let _ = sender.send(value);
    Ok(())
}
