---
title: Remove extra coding-tool restrictions
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-06
---

# Remove extra coding-tool restrictions

Pi Code Mode must not impose a second permission system around the coding tools selected for a session. The current implementation changes normal Pi behavior by confining files and commands to a private workspace view, denying network access, filtering credential-like paths, replacing the command environment, limiting command memory and temporary storage, and killing background processes when the session ends. These changes caused valid Terminal-Bench solutions to fail after the agent had completed the work.

This change replaces that policy in place. Pi mode will use Pi's public built-in tool factories with their normal behavior. Codex mode will keep its tool names and interactive command contract, but its local commands will run with the parent Pi process's normal permissions. The isolated Deno Core host will stay capability-free.

## Requirements

- Keep `exec` and `wait` as the only provider-visible tools.
- Keep separate `pi` and `codex` nested tool sets.
- Make Pi mode use Pi's documented `createReadTool`, `createBashTool`, `createPowerShellTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, and `createLsTool` factories.
- Let nested Pi tools use normal absolute paths, network access, command environment, temporary storage, and process behavior.
- Let Codex-mode commands use the parent process's filesystem, network, environment, and operating-system limits.
- Remove the private `/tmp` mapping, scratch byte and entry quotas, credential-path filters, command memory and file limits, and command-only Landlock and seccomp policy.
- Do not kill a successfully detached background process when its command shell exits or when the Code Mode session shuts down.
- Keep explicit cancellation able to stop a still-running managed command.
- Keep output truncation, replay protection, JavaScript host limits, and Deno Core host isolation. These protect the model context and Code Mode host. They do not change coding-tool permissions.
- Keep the existing package name, modes, and provider contract. Do not add an unrestricted variant or compatibility switch.

## Implementation

1. Update `AGENTS.md` so the repository requires native tool parity and forbids extra permission policy in the default package.
2. Replace the sandbox workspace with a normal workspace helper used only for transactional Codex patches.
3. Replace the sandboxed process manager with a native process manager that preserves the Codex `exec_command` and `write_stdin` shapes.
4. Make the command worker inherit the parent environment and run Bash directly. Remove command-only sandbox setup and resource-limit configuration.
5. Build Pi-mode descriptors from Pi's public built-in tool factories instead of custom sandbox wrappers.
6. Update lifecycle ownership so shutdown closes Code Mode bookkeeping without terminating detached background work.
7. Remove obsolete scratch quota and sensitive-path code, exports, tests, and documentation.
8. Add integration tests for absolute file access, inherited non-secret environment values, loopback network access, large temporary files, native Pi result shapes, explicit cancellation, and background-process survival.

## Non-goals

- Do not give the Deno Core JavaScript host direct filesystem, process, or network APIs.
- Do not remove provider-output truncation or replay protection.
- Do not change model selection, mode selection, session persistence, or OpenAI grammar-tool handling.
- Do not add a benchmark-only package, feature flag, or alternate runtime.

## Contract impact

- **Session state:** The existing mode and nested-tool trace entries stay unchanged.
- **Other persistent data:** None.
- **Pi internals:** None. The implementation uses exported tool factories and documented extension APIs.
- **Public API:** The exported sandbox class names are removed in the hard cutover. The package keeps `createPiTools`, `createCodexTools`, `exec`, and `wait`, but their nested effects now follow the parent process and native Pi tools.

## Acceptance criteria

- Pi-mode file and command calls match the current Pi built-ins for schemas, result shapes, path access, environment, network, temporary storage, and process behavior.
- Codex-mode commands can access the same local resources as the parent Pi process and retain interactive polling and input.
- A detached background service can remain alive after the starting command completes and after Code Mode session shutdown.
- Explicit cancellation still terminates a running managed command.
- No command-only Landlock, seccomp, `prlimit`, private home, private temporary directory, credential path scan, scratch byte quota, or scratch entry quota remains in the default package.
- The Deno Core host still starts under its existing filesystem, network, and syscall isolation.
- `npm run check`, `npm pack --dry-run`, and focused integration tests pass.
- A temporary `pi -e` smoke test loads the built package and exercises Pi mode without changing installed Pi state.

## Verification

Run these checks from the repository root:

```sh
npm run check
npm pack --dry-run
```

The integration suite must also prove:

1. native Pi read, write, edit, search, and Bash behavior;
2. absolute path and loopback network access;
3. inherited non-secret environment access;
4. temporary output larger than the removed 256 MiB quota;
5. detached background-process survival after shell completion and runtime shutdown;
6. explicit cancellation of an active command;
7. continued Deno Core host isolation;
8. package loading through `pi -e`.
