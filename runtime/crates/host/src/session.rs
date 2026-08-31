use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use pi_code_mode_runtime::SessionStore;
use tokio::sync::Mutex;

use crate::cell::CellHandle;
use crate::limits::MAX_STORE_BYTES;

#[derive(Default)]
struct CellRegistry {
    cells: HashMap<String, CellHandle>,
    pending_terminations: HashSet<String>,
}

pub enum InsertCellResult {
    Inserted,
    Cancelled,
    Duplicate,
}

pub struct HostSession {
    registry: Mutex<CellRegistry>,
    pub store: SessionStore,
    active_cells: AtomicUsize,
}

impl HostSession {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            registry: Mutex::new(CellRegistry::default()),
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

    pub async fn insert_cell(&self, id: String, cell: CellHandle) -> InsertCellResult {
        let mut registry = self.registry.lock().await;
        if registry.pending_terminations.remove(&id) {
            return InsertCellResult::Cancelled;
        }
        if registry.cells.contains_key(&id) {
            return InsertCellResult::Duplicate;
        }
        registry.cells.insert(id, cell);
        InsertCellResult::Inserted
    }

    pub async fn find_cell(&self, id: &str) -> Option<CellHandle> {
        self.registry.lock().await.cells.get(id).cloned()
    }

    pub async fn request_termination(&self, id: &str) -> Option<CellHandle> {
        let mut registry = self.registry.lock().await;
        let cell = registry.cells.get(id).cloned();
        if cell.is_none() {
            registry.pending_terminations.insert(id.to_owned());
        }
        cell
    }

    pub async fn remove_cell(&self, id: &str) -> Option<CellHandle> {
        self.registry.lock().await.cells.remove(id)
    }

    pub async fn take_cells(&self) -> HashMap<String, CellHandle> {
        let mut registry = self.registry.lock().await;
        registry.pending_terminations.clear();
        std::mem::take(&mut registry.cells)
    }
}
