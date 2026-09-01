use std::collections::HashSet;

use crate::{CellExecParams, CellWaitParams, ErrorCode, ProtocolError};

const MAX_ID_BYTES: usize = 256;

pub fn validate_exec(params: &CellExecParams) -> Result<(), ProtocolError> {
    validate_id(&params.session_id, "sessionId")?;
    validate_id(&params.cell_id, "cellId")?;
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
    let mut ids = HashSet::new();
    let mut paths: HashSet<String> = HashSet::new();
    for tool in &params.tools {
        validate_id(&tool.id, "tool id")?;
        if !ids.insert(tool.id.as_str()) {
            return Err(ProtocolError::new(
                ErrorCode::InvalidInput,
                "Code Mode tool ids must be unique",
            ));
        }
        if tool.sdk_path.is_empty() {
            return Err(ProtocolError::new(
                ErrorCode::InvalidInput,
                "Code Mode tool paths must not be empty",
            ));
        }
        for segment in &tool.sdk_path {
            validate_path_segment(segment)?;
        }
        let path = tool.sdk_path.join(".");
        if paths.iter().any(|existing| {
            existing == &path
                || existing.starts_with(&format!("{path}."))
                || path.starts_with(&format!("{existing}."))
        }) {
            return Err(ProtocolError::new(
                ErrorCode::InvalidInput,
                "Code Mode tool paths must not collide",
            ));
        }
        paths.insert(path);
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

fn validate_path_segment(value: &str) -> Result<(), ProtocolError> {
    let mut chars = value.chars();
    let first = chars.next();
    let valid = matches!(first, Some('_' | '$' | 'a'..='z' | 'A'..='Z'))
        && chars.all(|character| {
            character == '_' || character == '$' || character.is_ascii_alphanumeric()
        })
        && !matches!(value, "__proto__" | "constructor" | "prototype");
    if !valid {
        return Err(ProtocolError::new(
            ErrorCode::InvalidInput,
            "Code Mode tool path segment is invalid",
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
