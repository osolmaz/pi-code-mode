mod cell;
mod command_worker;
mod delegate;
mod limits;
mod sandbox;
mod server;
mod session;

fn run() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--command-worker") {
        return command_worker::run();
    }
    sandbox::apply_landlock()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_io()
        .enable_time()
        .build()?;
    sandbox::apply_seccomp()?;
    runtime.block_on(server::run())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("pi-code-mode-host: {error:#}");
        std::process::exit(1);
    }
}
