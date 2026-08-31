use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use deno_core::v8;

#[derive(Debug, Default)]
struct State {
    deadline: Option<Instant>,
    generation: u64,
    stopped: bool,
}

pub struct CpuWatchdog {
    shared: Arc<(Mutex<State>, Condvar)>,
    tripped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CpuWatchdog {
    #[must_use]
    pub fn new(handle: v8::IsolateHandle) -> Self {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let tripped = Arc::new(AtomicBool::new(false));
        let thread_shared = Arc::clone(&shared);
        let thread_tripped = Arc::clone(&tripped);
        let thread = thread::Builder::new()
            .name("pi-code-mode-watchdog".to_owned())
            .spawn(move || watch(&thread_shared, &thread_tripped, &handle))
            .expect("create Code Mode CPU watchdog");
        Self {
            shared,
            tripped,
            thread: Some(thread),
        }
    }

    #[must_use]
    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Acquire)
    }

    pub fn arm(&self, duration: Duration) {
        let (lock, signal) = &*self.shared;
        let mut state = lock.lock().expect("watchdog lock poisoned");
        state.generation = state.generation.wrapping_add(1);
        state.deadline = Some(Instant::now() + duration);
        signal.notify_one();
    }

    pub fn disarm(&self) {
        let (lock, signal) = &*self.shared;
        let mut state = lock.lock().expect("watchdog lock poisoned");
        state.generation = state.generation.wrapping_add(1);
        state.deadline = None;
        signal.notify_one();
    }
}

impl Drop for CpuWatchdog {
    fn drop(&mut self) {
        let (lock, signal) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.stopped = true;
            state.deadline = None;
            signal.notify_one();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn watch(
    shared: &Arc<(Mutex<State>, Condvar)>,
    tripped: &Arc<AtomicBool>,
    handle: &v8::IsolateHandle,
) {
    let (lock, signal) = &**shared;
    let mut state = lock.lock().expect("watchdog lock poisoned");
    loop {
        if state.stopped {
            return;
        }
        let Some(deadline) = state.deadline else {
            state = signal.wait(state).expect("watchdog lock poisoned");
            continue;
        };
        let generation = state.generation;
        let now = Instant::now();
        if now >= deadline {
            state.deadline = None;
            drop(state);
            tripped.store(true, Ordering::Release);
            let _ = handle.terminate_execution();
            state = lock.lock().expect("watchdog lock poisoned");
            continue;
        }
        let timeout = deadline.saturating_duration_since(now);
        let (next, result) = signal
            .wait_timeout(state, timeout)
            .expect("watchdog lock poisoned");
        state = next;
        if result.timed_out() && state.generation == generation && state.deadline == Some(deadline)
        {
            state.deadline = None;
            drop(state);
            tripped.store(true, Ordering::Release);
            let _ = handle.terminate_execution();
            state = lock.lock().expect("watchdog lock poisoned");
        }
    }
}
