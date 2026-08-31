use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeOutput {
    Text { text: String },
    Notification { message: String },
}

#[derive(Clone, Debug, Default)]
pub struct OutputSnapshot {
    pub items: Vec<RuntimeOutput>,
    pub next_sequence: u64,
    pub truncated: bool,
    pub total_bytes: usize,
}

#[derive(Debug)]
struct Entry {
    sequence: u64,
    output: RuntimeOutput,
}

#[derive(Debug, Default)]
struct Inner {
    entries: Vec<Entry>,
    next_sequence: u64,
    total_bytes: usize,
    truncated: bool,
}

#[derive(Clone, Debug)]
pub struct OutputBuffer {
    inner: Arc<Mutex<Inner>>,
    max_bytes: usize,
}

impl OutputBuffer {
    #[must_use]
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            max_bytes,
        }
    }

    pub fn text(&self, value: String) {
        self.push(value, false);
    }

    pub fn notification(&self, value: String) {
        self.push(value, true);
    }

    fn push(&self, value: String, notification: bool) {
        let mut inner = self.inner.lock().expect("output lock poisoned");
        if inner.total_bytes >= self.max_bytes {
            inner.truncated = true;
            return;
        }
        let remaining = self.max_bytes - inner.total_bytes;
        let (value, truncated) = truncate_utf8(value, remaining);
        if truncated {
            inner.truncated = true;
        }
        if value.is_empty() {
            return;
        }
        let output = if notification {
            RuntimeOutput::Notification { message: value }
        } else {
            RuntimeOutput::Text { text: value }
        };
        let bytes = output_bytes(&output);
        let sequence = inner.next_sequence;
        inner.next_sequence = inner.next_sequence.saturating_add(1);
        inner.total_bytes = inner.total_bytes.saturating_add(bytes);
        inner.entries.push(Entry { sequence, output });
    }

    #[must_use]
    pub fn snapshot(&self, from_sequence: u64, max_bytes: usize) -> OutputSnapshot {
        let inner = self.inner.lock().expect("output lock poisoned");
        let mut bytes = 0_usize;
        let mut items = Vec::new();
        let mut next_sequence = from_sequence;
        let mut truncated = inner.truncated;
        for entry in inner
            .entries
            .iter()
            .filter(|entry| entry.sequence >= from_sequence)
        {
            let entry_bytes = output_bytes(&entry.output);
            if bytes.saturating_add(entry_bytes) > max_bytes {
                truncated = true;
                break;
            }
            bytes = bytes.saturating_add(entry_bytes);
            items.push(entry.output.clone());
            next_sequence = entry.sequence.saturating_add(1);
        }
        OutputSnapshot {
            items,
            next_sequence,
            truncated,
            total_bytes: inner.total_bytes,
        }
    }
}

fn output_bytes(output: &RuntimeOutput) -> usize {
    match output {
        RuntimeOutput::Text { text } => text.len(),
        RuntimeOutput::Notification { message } => message.len(),
    }
}

fn truncate_utf8(value: String, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    (value[..end].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::{OutputBuffer, RuntimeOutput};

    #[test]
    fn truncates_at_utf8_boundary() {
        let output = OutputBuffer::new(3);
        output.text("éé".to_owned());
        let snapshot = output.snapshot(0, 100);
        assert!(snapshot.truncated);
        assert!(matches!(
            snapshot.items.as_slice(),
            [RuntimeOutput::Text { text }] if text == "é"
        ));
    }

    #[test]
    fn skips_outputs_that_cannot_fit_one_code_point() {
        let output = OutputBuffer::new(1);
        for _ in 0..1_000 {
            output.text("😀".to_owned());
            output.text(String::new());
        }
        let snapshot = output.snapshot(0, 100);
        assert!(snapshot.truncated);
        assert!(snapshot.items.is_empty());
        assert_eq!(snapshot.total_bytes, 0);
    }
}
