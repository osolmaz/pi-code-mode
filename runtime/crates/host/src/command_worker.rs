use std::fs::File;
use std::io::{Read, Write};
use std::process::{Command, ExitStatus, Stdio};

use anyhow::{Context, bail};
use rustix::fd::OwnedFd;
use rustix::pty::{OpenptFlags, grantpt, ioctl_tiocgptpeer, openpt, unlockpt};
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

struct PseudoTerminal {
    controller: OwnedFd,
    user: OwnedFd,
}

pub fn run() -> anyhow::Result<()> {
    let config = read_config()?;
    validate_config(&config)?;
    let pty = config.tty.then(open_pseudo_terminal).transpose()?;
    sandbox::apply_command_sandbox(&config.workspace, &config.scratch)?;

    let command = restricted_command(&config);
    let status = if let Some(pty) = pty {
        run_with_pseudo_terminal(command, pty)?
    } else {
        let mut command = command;
        command
            .status()
            .context("failed to run sandboxed command")?
    };
    std::process::exit(status.code().unwrap_or(128));
}

fn restricted_command(config: &CommandConfig) -> Command {
    let mut command = Command::new("/usr/bin/prlimit");
    command.args([
        format!("--cpu={}", config.cpu_limit_seconds),
        format!("--as={}", config.memory_limit_bytes),
        format!("--fsize={}", config.file_size_limit_bytes),
        format!("--nofile={}", config.open_file_limit),
        format!("--nproc={}", config.process_limit),
        "--".to_owned(),
        "/bin/bash".to_owned(),
        "--noprofile".to_owned(),
        "--norc".to_owned(),
        "-lc".to_owned(),
        config.command.clone(),
    ]);
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
    command
}

fn open_pseudo_terminal() -> anyhow::Result<PseudoTerminal> {
    let flags = OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC;
    let controller = openpt(flags).context("failed to open PTY controller")?;
    grantpt(&controller).context("failed to grant PTY access")?;
    unlockpt(&controller).context("failed to unlock PTY")?;
    let user = ioctl_tiocgptpeer(&controller, flags).context("failed to open PTY user device")?;
    Ok(PseudoTerminal { controller, user })
}

fn run_with_pseudo_terminal(
    mut command: Command,
    pty: PseudoTerminal,
) -> anyhow::Result<ExitStatus> {
    let child_input = File::from(rustix::io::dup(&pty.user).context("failed to copy PTY input")?);
    let child_output = File::from(rustix::io::dup(&pty.user).context("failed to copy PTY output")?);
    let child_error = File::from(pty.user);
    command
        .stdin(Stdio::from(child_input))
        .stdout(Stdio::from(child_output))
        .stderr(Stdio::from(child_error));

    let mut child = command
        .spawn()
        .context("failed to run sandboxed PTY command")?;
    drop(command);
    let mut controller_writer =
        File::from(rustix::io::dup(&pty.controller).context("failed to copy PTY controller")?);
    let mut controller_reader = File::from(pty.controller);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let _ = std::io::copy(&mut stdin.lock(), &mut controller_writer);
    });

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match controller_reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                stdout
                    .write_all(&buffer[..read])
                    .context("failed to relay PTY output")?;
                stdout.flush().context("failed to flush PTY output")?;
            }
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => return Err(error).context("failed to read PTY output"),
        }
    }
    child.wait().context("failed to wait for PTY command")
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
