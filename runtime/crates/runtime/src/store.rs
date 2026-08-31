use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct SessionStore {
    inner: Arc<Mutex<BTreeMap<String, Value>>>,
    max_bytes: usize,
}

impl SessionStore {
    #[must_use]
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(BTreeMap::new())),
            max_bytes,
        }
    }

    pub fn put(&self, key: String, value: Value, execution_max_bytes: usize) -> Result<(), String> {
        if key.is_empty() || key.len() > 256 {
            return Err("store key must contain 1 to 256 bytes".to_owned());
        }
        let mut values = self.inner.lock().map_err(|_| "store is unavailable")?;
        let old = values.insert(key.clone(), value);
        let size = serde_json::to_vec(&*values)
            .map_err(|error| format!("store value is not JSON-safe: {error}"))?
            .len();
        if size > self.max_bytes.min(execution_max_bytes) {
            if let Some(old) = old {
                values.insert(key, old);
            } else {
                values.remove(&key);
            }
            return Err("session store limit exceeded".to_owned());
        }
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<Value, String> {
        let values = self.inner.lock().map_err(|_| "store is unavailable")?;
        Ok(values.get(key).cloned().unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::SessionStore;

    #[test]
    fn rejects_values_over_the_total_limit() {
        let store = SessionStore::new(8);
        assert!(store.put("long".to_owned(), json!("value"), 8).is_err());
        assert_eq!(store.get("long").expect("read store"), json!(null));
    }

    #[test]
    fn applies_the_execution_limit_below_the_session_limit() {
        let store = SessionStore::new(1_024);
        assert!(store.put("long".to_owned(), json!("value"), 8).is_err());
        assert_eq!(store.get("long").expect("read store"), json!(null));
    }
}
