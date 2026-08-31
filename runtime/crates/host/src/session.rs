use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use pi_code_mode_runtime::SessionStore;
use tokio::sync::Mutex;

use crate::cell::CellHandle;
use crate::limits::MAX_STORE_BYTES;

pub struct HostSession {
    pub cells: Mutex<HashMap<String, CellHandle>>,
    pub store: SessionStore,
    active_cells: AtomicUsize,
}

impl HostSession {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cells: Mutex::new(HashMap::new()),
            store: SessionStore::new(MAX_STORE_BYTES),
            active_cells: AtomicUsize::new(0),
        })
    }

    pub fn reserve_cell(&self, maximum: usize) -> bool {
        self.active_cells
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < maximum).then_some(value + 1)
            })
            .is_ok()
    }

    pub fn release_cell(&self) {
        self.active_cells.fetch_sub(1, Ordering::AcqRel);
    }
}
