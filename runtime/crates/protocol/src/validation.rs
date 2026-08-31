use std::collections::HashSet;

use crate::{CellExecParams, CellWaitParams, ErrorCode, ProtocolError};

const MAX_ID_BYTES: usize = 256;

pub fn validate_exec(params: &CellExecParams) -> Result<(), ProtocolError> {
    validate_id(&params.session_id, "sessionId")?;
    validate_id(&params.parent_tool_call_id, "parentToolCallId")?;
    if params.source.is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidInput,
            "program source is empty",
        ));
    }
    if params.source.len() > params.options.max_source_bytes {
        return Err(ProtocolError::new(
            ErrorCode::SourceLimitExceeded,
            "program source exceeds the configured limit",
        ));
    }
    let mut names = HashSet::new();
    for tool in &params.tools {
        validate_id(&tool.name, "tool name")?;
        validate_id(&tool.code_mode_name, "Code Mode tool name")?;
        if !names.insert(tool.code_mode_name.as_str()) {
            return Err(ProtocolError::new(
                ErrorCode::InvalidInput,
                "Code Mode tool names must be unique",
            ));
        }
    }
    Ok(())
}

pub fn validate_wait(params: &CellWaitParams) -> Result<(), ProtocolError> {
    validate_id(&params.session_id, "sessionId")?;
    validate_id(&params.cell_id, "cellId")?;
    if params.max_output_bytes == 0 {
        return Err(ProtocolError::new(
            ErrorCode::InvalidInput,
            "maxOutputBytes must be positive",
        ));
    }
    Ok(())
}

pub fn validate_id(value: &str, name: &str) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidInput,
            format!("{name} is invalid"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_id;

    #[test]
    fn rejects_empty_ids() {
        assert!(validate_id("", "id").is_err());
    }

    #[test]
    fn accepts_bounded_ids() {
        assert!(validate_id("session-1", "id").is_ok());
    }
}
