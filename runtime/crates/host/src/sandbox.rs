use anyhow::{Context, bail};

#[cfg(target_os = "linux")]
use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, path_beneath_rules,
};
#[cfg(target_os = "linux")]
use seccompiler::{BpfProgram, SeccompAction, SeccompFilter};

#[cfg(target_os = "linux")]
pub fn apply_landlock() -> anyhow::Result<()> {
    let abi = ABI::V4;
    let status = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .context("failed to select Landlock filesystem rights")?
        .handle_access(AccessNet::from_all(abi))
        .context("failed to select Landlock network rights")?
        .create()
        .context("failed to create the Landlock ruleset")?
        .set_compatibility(CompatLevel::HardRequirement)
        .restrict_self()
        .context("failed to apply the Landlock ruleset")?;

    if status.ruleset != RulesetStatus::FullyEnforced || !status.no_new_privs {
        bail!("the Linux Landlock sandbox was not fully enforced: {status:?}");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_seccomp_denials(denied: impl IntoIterator<Item = i64>) -> anyhow::Result<()> {
    let rules = denied
        .into_iter()
        .map(|syscall| (syscall, vec![]))
        .collect();
    let architecture = std::env::consts::ARCH
        .try_into()
        .context("unsupported seccomp architecture")?;
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        architecture,
    )
    .context("failed to define the seccomp filter")?;
    let program: BpfProgram = filter
        .try_into()
        .context("failed to compile the seccomp filter")?;
    seccompiler::apply_filter_all_threads(&program).context("failed to apply the seccomp filter")
}

#[cfg(target_os = "linux")]
pub fn apply_seccomp() -> anyhow::Result<()> {
    apply_seccomp_denials([
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_userfaultfd,
        libc::SYS_io_uring_setup,
    ])
}

#[cfg(target_os = "linux")]
pub fn apply_command_sandbox(workspace: &str, scratch: &str) -> anyhow::Result<()> {
    let abi = ABI::V4;
    let read_paths = [
        "/bin",
        "/usr",
        "/lib",
        "/lib64",
        "/etc/alternatives",
        "/etc/ld.so.cache",
        "/dev/null",
        "/dev/urandom",
        "/dev/zero",
    ]
    .into_iter()
    .filter(|path| std::path::Path::new(path).exists());
    // Landlock's read set includes EXECUTE, READ_FILE, and READ_DIR.
    // This lets the worker start allowlisted binaries without granting filesystem writes.
    let command_read_access = AccessFs::from_read(abi);
    let write_paths = [
        workspace,
        scratch,
        "/dev/null",
        "/dev/ptmx",
        "/dev/pts",
        "/dev/tty",
    ]
    .into_iter()
    .filter(|path| std::path::Path::new(path).exists());
    let status = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .context("failed to select command filesystem rights")?
        .handle_access(AccessNet::from_all(abi))
        .context("failed to select command network rights")?
        .create()
        .context("failed to create the command ruleset")?
        .add_rules(path_beneath_rules(read_paths, command_read_access))
        .context("failed to add command read rules")?
        .add_rules(path_beneath_rules(write_paths, AccessFs::from_all(abi)))
        .context("failed to add command write rules")?
        .set_compatibility(CompatLevel::HardRequirement)
        .restrict_self()
        .context("failed to apply the command Landlock ruleset")?;
    if status.ruleset != RulesetStatus::FullyEnforced || !status.no_new_privs {
        bail!("the command Landlock sandbox was not fully enforced: {status:?}");
    }
    apply_seccomp_denials([
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_userfaultfd,
        libc::SYS_io_uring_setup,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_setns,
        libc::SYS_unshare,
    ])
}

#[cfg(not(target_os = "linux"))]
pub fn apply_landlock() -> anyhow::Result<()> {
    bail!("Code Mode process isolation is implemented only for Linux")
}

#[cfg(not(target_os = "linux"))]
pub fn apply_seccomp() -> anyhow::Result<()> {
    bail!("Code Mode process isolation is implemented only for Linux")
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::fs::File;
    use std::io::ErrorKind;
    use std::net::TcpStream;
    use std::process::Command;

    const CHILD_ENV: &str = "PI_CODE_MODE_SANDBOX_TEST_CHILD";

    #[test]
    fn blocks_filesystem_and_tcp_access() {
        if std::env::var_os(CHILD_ENV).is_some() {
            super::apply_landlock().expect("apply Landlock");
            super::apply_seccomp().expect("apply seccomp");
            let file_error = File::open("/etc/passwd").expect_err("filesystem access was allowed");
            assert_eq!(file_error.kind(), ErrorKind::PermissionDenied);
            let tcp_error = TcpStream::connect("127.0.0.1:9").expect_err("TCP access was allowed");
            assert_eq!(tcp_error.kind(), ErrorKind::PermissionDenied);
            return;
        }

        let status = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "sandbox::tests::blocks_filesystem_and_tcp_access",
            ])
            .env(CHILD_ENV, "1")
            .status()
            .expect("run isolated process-sandbox test");
        assert!(
            status.success(),
            "isolated process-sandbox test failed: {status}"
        );
    }
}
