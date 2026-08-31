mod cell;
mod delegate;
mod limits;
mod server;
mod session;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(error) = server::run().await {
        eprintln!("pi-code-mode-host: {error:#}");
        std::process::exit(1);
    }
}
