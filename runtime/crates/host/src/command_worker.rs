use std::io::Read;
use std::process::Command;

use anyhow::{Context, bail};
use serde::Deserialize;

use crate::sandbox;

const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandConfig {
    command: String,
    cwd: String,
    workspace: String,
    scratch: String,
    tty: bool,
    cpu_limit_seconds: u64,
    memory_limit_bytes: u64,
    file_size_limit_bytes: u64,
    open_file_limit: u64,
    process_limit: u64,
}

pub fn run() -> anyhow::Result<()> {
    let config = read_config()?;
    validate_config(&config)?;
    sandbox::apply_command_sandbox(&config.workspace, &config.scratch)?;

    let mut command = Command::new("/usr/bin/prlimit");
    command.args([
        format!("--cpu={}", config.cpu_limit_seconds),
        format!("--as={}", config.memory_limit_bytes),
        format!("--fsize={}", config.file_size_limit_bytes),
        format!("--nofile={}", config.open_file_limit),
        format!("--nproc={}", config.process_limit),
        "--".to_owned(),
    ]);
    if config.tty {
        command.args(["/usr/bin/script", "-qefc", &config.command, "/dev/null"]);
    } else {
        command.args(["/bin/bash", "--noprofile", "--norc", "-lc", &config.command]);
    }
    command
        .current_dir(&config.cwd)
        .env_clear()
        .env("HOME", &config.scratch)
        .env("TMPDIR", &config.scratch)
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("SHELL", "/bin/bash")
        .env("TERM", if config.tty { "xterm-256color" } else { "dumb" });
    let status = command
        .status()
        .context("failed to run sandboxed command")?;
    std::process::exit(status.code().unwrap_or(128));
}

fn read_config() -> anyhow::Result<CommandConfig> {
    let stdin = std::io::stdin();
    let mut bytes = Vec::new();
    let mut terminated = false;
    for byte in stdin.lock().bytes() {
        let byte = byte.context("failed to read command-worker configuration")?;
        if byte == b'\n' {
            terminated = true;
            break;
        }
        if bytes.len() >= MAX_CONFIG_BYTES {
            bail!("command-worker configuration is too large");
        }
        bytes.push(byte);
    }
    if !terminated {
        bail!("command-worker configuration is not newline terminated");
    }
    serde_json::from_slice(&bytes).context("invalid command-worker configuration")
}

fn validate_config(config: &CommandConfig) -> anyhow::Result<()> {
    if config.command.is_empty() {
        bail!("command must not be empty");
    }
    let workspace = std::fs::canonicalize(&config.workspace).context("invalid workspace path")?;
    let scratch = std::fs::canonicalize(&config.scratch).context("invalid scratch path")?;
    let cwd = std::fs::canonicalize(&config.cwd).context("invalid command working directory")?;
    if !cwd.starts_with(&workspace) && !cwd.starts_with(&scratch) {
        bail!("command working directory is outside the sandbox");
    }
    Ok(())
}
