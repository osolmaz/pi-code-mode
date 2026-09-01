---
title: Build full Pi Code Mode
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-31
updated: 2026-09-01
---

# Build full Pi Code Mode

Pi Code Mode gives a model one programmatic tool surface for coding work. The provider sees only `exec` and `wait`. JavaScript written inside `exec` receives either Codex tools or Pi tools, as selected for the Pi session.

A session uses one mode from start to finish:

- `codex` gives JavaScript the Codex tool set;
- `pi` gives JavaScript the Pi tool set.

The two modes never expose their built-in coding tools together. Both modes use the same V8 runtime, workspace sandbox, command runner, limits, cancellation, and Pi interface.

This document replaces the old read-only product contract. The implementation will cut over in place without a read-only compatibility mode, hybrid default, parallel API version, or fallback runtime.

The shipped release remains read-only until this plan is implemented. User documentation must describe the shipped behavior until the cutover is complete.

## End state

The finished system will:

- work as a normal Pi extension and as the standalone `pi-code-mode` command;
- expose only `exec` and `wait` as provider tool schemas;
- accept raw JavaScript when the provider advertises the required freeform grammar-tool capability;
- select support through provider capabilities rather than model names;
- let the user select `codex` or `pi` mode explicitly;
- keep the selected mode fixed and recorded for the Pi session;
- provide exact Codex coding tools in Codex mode;
- mirror vanilla Pi's active built-in tools in Pi mode;
- let explicit project and third-party tools register for one or both modes;
- keep intermediate tool results inside V8 until JavaScript emits a result;
- allow workspace reads, writes, edits, patches, and sandboxed commands;
- support long-running commands, input, waiting, and termination;
- provide one private temporary directory for each Pi session;
- keep credentials and ambient host APIs outside JavaScript and command environments;
- show every nested side effect in Pi;
- use only documented Pi extension and Factory APIs;
- remain independent of Codex, `pi-codex-conversion`, and other agent harnesses at runtime.

## Mode selection

Both direct Pi and the standalone command read the shared config at:

```text
$XDG_CONFIG_HOME/pi-code-mode/config.json
```

When `XDG_CONFIG_HOME` is not set, the path is:

```text
~/.config/pi-code-mode/config.json
```

The config contains:

```json
{
  "mode": "codex",
  "provider": "openai",
  "model": "<compatible-model>",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

`mode` accepts only `codex` or `pi`.

The normal Pi extension reads `mode` and continues to use Pi's active provider, model, and credentials. The standalone command reads all fields.

The standalone command can override the saved mode:

```sh
pi-code-mode --mode codex
pi-code-mode --mode pi
```

The command-line value applies only to that run unless `--save-config` is also present. Selection order is:

1. `--mode` for the standalone command;
2. the saved `mode`;
3. `codex` as the default.

The extension adds a `/code-mode` command that lets the user choose Codex mode or Pi mode. It saves the choice as the default for later sessions.

Mode selection never uses the model name. There is no automatic mode.

## Session mode

The selected mode is fixed when a Pi session starts. Changing tool names and instructions during a conversation would make replay and model context unreliable.

Each session records one extension-owned entry through Pi's documented session API. A Codex-mode entry is:

```json
{
  "mode": "codex",
  "contractVersion": 1
}
```

A Pi-mode entry also records the active vanilla built-ins that were selected before Code Mode hid Pi's top-level tools:

```json
{
  "mode": "pi",
  "piBuiltins": ["read", "bash", "edit", "write"],
  "contractVersion": 1
}
```

A resumed or branched session uses its recorded mode and Pi built-in set even if shared config or Pi's `defaultTools` setting changed later. The nested built-in contract does not change during a conversation.

If `/code-mode` runs before the session has model messages, the extension can select the mode for that session. If the session already contains model messages, the command saves the new default and offers to create a new session. It does not change the current session in place.

## Provider tools

The provider receives two tools in both modes.

### `exec`

`exec` accepts raw JavaScript through a freeform grammar tool. The internal Pi representation can use one required `code` field, but the provider adapter must preserve raw source on the wire.

A program runs in a fresh V8 isolate. It can sequence, branch, loop, filter, aggregate, and run independent calls in parallel. It returns model-visible output only through `text()` and bounded notifications.

### `wait`

`wait` observes or terminates a live cell returned by `exec`. It never reruns source. A wait call remains bound to its Pi session, parent tool call, and cell.

### Provider support

Production code checks provider and API capabilities. It does not contain a model-name allowlist. Adding, removing, or renaming a compatible model requires no package code change.

An unsupported provider fails before the model turn with a clear diagnostic. There is no JSON function-call fallback for `exec` and no fallback runtime.

## JavaScript API

Every cell receives these fixed globals:

```typescript
declare const tools: Readonly<Record<string, ToolFunction>>;
declare const ALL_TOOLS: ReadonlyArray<ToolMetadata>;

declare function text(value: unknown): void;
declare function notify(message: unknown): void;
declare function store(key: string, value: unknown): void;
declare function load(key: string): unknown;
declare function yield_control(reason?: string): Promise<void>;
declare function setTimeout(
  callback: (...args: unknown[]) => void,
  delayMs?: number,
  ...args: unknown[]
): number;
declare function clearTimeout(id: number): void;
declare function exit(): never;
```

The runtime freezes tool functions, metadata, and the tool object before source starts. A cell cannot gain tools when configuration changes later.

Generated JavaScript receives no Node.js, Deno, shell, module, environment, filesystem, network, process, console, WebAssembly, or credential globals.

## Codex mode

Codex mode presents the tool names and observable behavior expected by models trained for the Codex tool contract.

The first required tools are:

```js
tools.exec_command(...)
tools.write_stdin(...)
tools.apply_patch(...)
```

Later Codex tools can include:

```js
tools.view_image(...)
tools.web_run(...)
tools.imagegen(...)
```

Names, inputs, outputs, process handling, errors, and prompt instructions must match the verified Codex behavior.

Codex mode does not also expose Pi's built-in `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, or `ls` tools. Codex core names are reserved against project and third-party collisions.

## Pi mode

Pi mode mirrors vanilla Pi's active built-in tool selection. A normal Pi session enables these tools by default:

```js
tools.read(...)
tools.bash(...)
tools.edit(...)
tools.write(...)
```

Pi also ships these optional built-ins:

```js
tools.powershell(...)
tools.grep(...)
tools.find(...)
tools.ls(...)
```

The optional tools appear in Code Mode only when they were active in Pi. This includes selection through Pi's `defaultTools` setting or an explicit tool allowlist. Before the extension replaces the provider-visible tools with `exec` and `wait`, it snapshots `pi.getActiveTools()` and checks `pi.getAllTools()` metadata. It records the recognized built-in names for the session. The standalone harness applies the same rule to its own Pi session and settings.

The Pi mode builder creates only the recognized active built-ins through Pi's documented factories:

```text
createReadTool
createBashTool
createPowerShellTool
createEditTool
createWriteTool
createGrepTool
createFindTool
createLsTool
```

These tools keep Pi's documented:

- names, parameters, and result shapes;
- error behavior;
- cancellation;
- output truncation;
- file mutation ordering;
- path behavior;
- command behavior.

An extension can override a Pi built-in under the same name, but Pi's public metadata does not provide that replacement's execution callback. Pi Code Mode will not silently substitute the vanilla implementation. The overriding extension must register its implementation explicitly for Pi Code Mode.

Pi mode does not also expose Codex's `exec_command`, `write_stdin`, or `apply_patch` tools.

## Shared code for both modes

The two modes change the names, inputs, outputs, and instructions given to the model. They do not get separate filesystem or command implementations.

Equivalent work uses the same code underneath:

```text
Codex exec_command ─┐
                    ├─ shared command runner
Pi bash ────────────┘

Codex apply_patch ──┐
                    ├─ shared workspace filesystem
Pi write and edit ──┘
```

This prevents the two modes from developing different security rules, limits, cleanup, or command behavior.

## Tool definition

Every nested tool uses one parent-side definition:

```typescript
type CodeModeTool = {
  id: string;
  sdkPath: readonly string[];
  modes: readonly ("codex" | "pi")[];
  description: string;
  usage?: string;
  kind: "function" | "freeform";
  inputSchema?: unknown;
  outputSchema?: unknown;
  deferred: boolean;
  effect: "read" | "write" | "execute" | "network" | "interactive";
  replay: "safe" | "unsafe";
  invoke: (
    input: unknown,
    context: CodeModeInvocationContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
};
```

The tool builder must:

- include only tools for the selected mode;
- reserve the built-in names for that mode;
- reject empty, dangerous, or colliding names;
- sort tools in a stable order;
- freeze the tool set for each cell;
- retain execution callbacks only in the TypeScript parent;
- send only metadata and plain-data results through the host protocol.

Read, write, execute, network, and interactive effects can enter a mode only when the matching executor and policy exist. Safety comes from the workspace sandbox, command sandbox, schemas, limits, cancellation, and explicit tool admission. A read-only rule is not the security boundary.

Unsafe nested calls use a session-owned replay cache keyed by the host session, top-level tool call, and nested call ID. Replaying a completed `exec` returns the recorded unsafe result instead of repeating a write, command, or interaction. A reused ID with different tool input fails. The cache has a fixed entry limit and is cleared at session shutdown. Read-only calls can run again.

## Project and third-party Pi tools

Pi's public `getAllTools()` returns metadata but not execution callbacks. Pi Code Mode cannot automatically wrap every installed tool without a private API.

A cooperating extension can register a Code Mode tool through a documented registration event. Registration states which modes the tool supports and provides a tool path, schema, effect, replay rule, and execution callback.

In Pi mode, an extra tool normally keeps its Pi name when there is no collision:

```js
tools.ask(...)
tools.search_issues(...)
```

In Codex mode, the tool must provide a Codex-mode path and cannot replace a reserved Codex tool.

Registrations are collected during session startup and frozen before the first model turn. A late registration can affect only a later session or tool-set generation. It cannot expand a running cell.

Interactive tools must opt in. The tool runner serializes interactive calls so generated parallel JavaScript cannot open overlapping dialogs.

The implementation does not inspect Pi internals to recover hidden callbacks.

## Deferred tools and MCP

Small tools appear in the generated declarations and `exec` description. Deferred tools add compact metadata to `ALL_TOOLS` without adding provider schemas.

A later search tool can find Pi, project, or MCP tools and add them to the next cell. A running cell cannot gain new tools after it starts.

MCP support uses the same registration, naming, schema, effect, cancellation, and trace rules. The selected mode decides how each MCP tool is named and described.

## Process boundaries

The system has three authority levels:

```text
Pi and TypeScript tool runner
  |
  +-- capability-free Deno Core host
  |
  +-- workspace and command sandbox
```

### Deno Core host

The Rust host owns V8, cells, timers, the session store, tool delegation, framing, cancellation, and resource limits. It has no useful filesystem, network, shell, environment, or credential authority.

It cannot perform a nested action itself. It sends a versioned `tool/invoke` request to the parent and waits for a plain-data result.

### TypeScript tool runner

The parent owns tool selection, schemas, caller scope, replay rules, cancellation, tracing, and routing. It does not grant ambient host access to V8.

### Workspace and command sandbox

All side effects use one sandboxed service. Pi mode and Codex mode call the same service.

The service owns:

- workspace path resolution;
- a session-scoped scratch directory;
- atomic writes and edits;
- patch application;
- command creation and process groups;
- bounded output buffers;
- command input, waiting, and termination;
- cleanup after cancellation, host failure, reload, or session shutdown.

## Workspace filesystem

The default writable roots are:

- the selected workspace;
- the session's private scratch directory, presented to file tools as `/tmp` and to commands through `TMPDIR`.

The real system `/tmp` is not exposed. Scratch data is removed when the session closes. The default cumulative limit is 256 MiB and 50,000 entries. Broker writes check projected use before writing. The process manager checks use while commands run and when they exit, and stops command groups that cross the limit.

Path handling must reject:

- parent traversal that leaves an allowed root;
- symlink and junction escapes;
- magic links, FIFOs, sockets, and device paths;
- credential paths outside the workspace;
- races that replace a validated path before mutation;
- parent-process reads above 16 MiB before allocating their contents.

The broker opens the workspace and scratch roots once and keeps stable directory descriptors. It walks each parent component relative to those descriptors with `O_DIRECTORY` and `O_NOFOLLOW`. Reads, writes, directory creation, removal, and moves then operate through `/proc/self/fd`. A command cannot redirect a broker operation outside the sandbox by replacing a validated parent with a symlink.

Writes use atomic replacement where the operation permits it. Failed multi-file patches restore file contents, file modes, moves, and parent directories created by the failed transaction. Pi's file mutation queue serializes changes to the same file. Results report changed paths.

The production Code Mode tool sets are writable. Read-only behavior is not retained as a legacy mode.

## Commands and background processes

Codex `exec_command` and Pi `bash` use one process manager.

It supports:

- foreground commands;
- a bounded yield time;
- background process handles;
- incremental output reads;
- standard-input writes;
- explicit wait and terminate operations;
- complete process-tree termination;
- bounded command count, process count, output, memory, and wall time;
- termination after 8 MiB of total command output.

A process handle belongs to one Pi session. Another session cannot observe or control it. Handles expire after cleanup.

The outer Code Mode `wait` observes a V8 cell. Codex process tools and Pi command tools control nested processes. These lifecycles and identifiers remain separate.

## Command environment

Commands receive a newly built environment rather than `process.env`.

The default environment contains only values needed for normal local commands, such as a controlled `PATH`, locale, workspace path, and scratch path. It uses a private home directory.

It must not contain:

- provider API keys;
- Hugging Face, GitHub, cloud, or package-registry tokens;
- SSH or GPG agents;
- credential-helper sockets;
- Pi session identifiers or session files;
- restart or harness control variables;
- the user's real home directory.

Pi's shell session-environment injection is disabled for nested commands.

## Network policy

The default coding policy has no network access in either mode. Workspace file operations and local commands remain available.

Network access can enter a tool set only through an explicit tool or sandbox policy. A future network setting must define destination rules, credential ownership, DNS behavior, logging, and tests. V8 never receives a direct network API.

## Side effects and approvals

There is no approval prompt for JavaScript source and no blanket approval gate before normal workspace writes or sandboxed commands. Generated code runs automatically inside the selected tools and sandbox limits.

Each operation still passes through its executor, schema, workspace policy, process policy, cancellation path, replay rule, and trace. Network, credential, and interactive tools require their own explicit contracts before admission.

An interactive tool can ask the user through Pi when consent is part of that tool. Approval of one call does not approve later calls automatically.

The runtime never retries a call after an uncertain side effect. Replay-safe metadata controls retries before execution, and completed nested call IDs prevent duplicate effects during provider replay.

## Showing nested work

Intermediate values can remain inside V8, but side effects remain visible to the user.

An expanded `exec` result shows:

- the active mode;
- nested tool name;
- target path or bounded command preview;
- start, waiting, completed, failed, and terminated states;
- elapsed time and exit status;
- changed files;
- output truncation;
- cancellation and sandbox failures.

Traces omit credentials, unrestricted command environments, full sensitive inputs, and large raw outputs. Pi session entries retain the top-level `exec` and `wait` calls. Nested traces live in bounded tool details and progress updates.

## Limits

Limits apply at four levels.

### Cell limits

- source bytes;
- active JavaScript CPU;
- complete wall time;
- V8 heap and stack;
- timers;
- emitted output;
- nested call count and concurrency;
- nested input and result bytes.

### Session limits

- active cells;
- stored JSON data;
- active commands;
- scratch storage;
- retained traces.

### Command limits

- at most eight concurrently active command workers per harness by default;
- a 30-minute wall-clock lifetime for each command by default;
- a worker-local process and thread limit;
- CPU, memory, file-size, and open-file limits;
- output and input-write limits;
- at most 16 unpolled completed records and 32 MiB of their retained output, with a 60-second expiry;
- process-group `SIGTERM` followed by guaranteed `SIGKILL` escalation after two seconds;
- seccomp denial of `setsid` and `setpgid`, which prevents descendants from leaving the managed process group.

The parent sends each worker's trusted workspace, scratch, working-directory, and limit configuration as one newline-terminated JSON record over the worker's private standard-input pipe. The worker consumes that record before the command inherits the remaining pipe. Command-writable files never carry sandbox authority.

Pi Bash keeps Pi's 2,000-line and 50 KiB display limits. Its bounded streaming collector discards earlier output in memory when those limits are exceeded. It does not use Pi's normal operating-system temporary output file because that file would be outside session scratch.

Optional Pi grep runs the system `rg` binary in a restricted command worker with bounded captured output. Generated regular expressions therefore use ripgrep's linear-time engine outside the parent Node.js event loop. Optional PowerShell uses the same worker and invokes `pwsh` when it is installed.

The manager keeps the escalation timer referenced and targets the process group even if the original worker exits first. This prevents a detached descendant that ignores `SIGTERM` from surviving Pi shutdown.

### Host limits

- active sessions and cells;
- resident memory;
- protocol frame size;
- pending requests;
- bounded tombstones and logs.

Cancellation propagates from Pi through the parent tool call, V8 cell, nested tool, command process group, and output stream.

## Direct Pi behavior

When installed as a normal Pi extension:

- Pi keeps its normal interactive window;
- Pi keeps its active provider, model, credentials, sessions, skills, prompts, themes, and commands;
- the provider tool set becomes `exec` and `wait` when Code Mode is active;
- the recorded session mode selects the tools inside JavaScript;
- `/code-mode` selects the default mode for a new session.

The extension uses documented Pi hooks and factories only. Shutdown and reload terminate cells and commands, remove scratch data, stop the host when unused, and restore the previous active tools.

## Standalone behavior

The standalone executable uses the same runtime, selected mode, tools, prompt, limits, and sandbox.

It uses Pi's public session runtime factory and `InteractiveMode`. It remains a normal Pi window rather than a custom REPL.

Its settings, sessions, provider, and model configuration remain separate from normal Pi. API keys stay in their existing credential store or process memory and are never saved in the Code Mode config.

## Cutover

The cutover replaces the current contract in place.

The change will:

- add `mode` to the shared config;
- add `--mode` to the standalone command;
- add `/code-mode` to the direct Pi extension;
- record the mode for each session;
- remove the read-only tool rule;
- build separate Codex and Pi tool sets over shared executors;
- add the workspace and command sandbox;
- add session-scoped `/tmp`;
- replace read-only prompt and documentation text;
- replace read-only tests with writable workspace and sandbox-boundary tests;
- keep the current package and executable names.

There will be no parallel `v2`, legacy reader, read-only compatibility path, hybrid default mode, model-name selector, QuickJS fallback, or direct-tool fallback.

## Implementation sequence

### Correct the plans

Remove the proposed `tools.pi` namespace. Specify separate Codex and Pi modes, shared config, session recording, mode selection, and mode-specific tools.

### Add mode selection

Add `mode` to config, `--mode` to the standalone command, `/code-mode` to direct Pi, session recording, mode display, and tests for config order, invalid values, resume, branching, and mode changes.

### Build the shared filesystem

Add workspace writes, private `/tmp`, safe path handling, atomic writes, edits, patch application, Pi file mutation ordering, scratch quotas, and cleanup.

Do not expose write tools before traversal, symlink, race, credential, and cleanup tests pass.

### Build the shared command runner

Add command sandboxing, clean environments, process handles, output polling, input, waiting, termination, process-tree cleanup, and resource limits.

Do not expose command tools before credential, network, process, and cleanup tests pass.

### Implement Codex mode

Add exact `exec_command`, `write_stdin`, and `apply_patch` behavior with fixed contract fixtures. Add optional media and web tools only after their behavior and policies are complete.

### Implement Pi mode

Snapshot and record Pi's active built-in names before activating `exec` and `wait`. Add the default `read`, `bash`, `edit`, and `write` tools through public Pi factories and the shared filesystem and command runner. Add `powershell`, `grep`, `find`, and `ls` only when Pi has them active. Require explicit registration for extension overrides. Restore the recorded built-in set on resume and branch.

### Add extension registration

Add the public registration event for cooperating Pi extensions. Test mode selection, names, collisions, invalid tools, interactive calls, cancellation, and cleanup.

### Add mode-specific instructions

Generate the correct JavaScript declarations and prompt text from each mode's actual tool set. Add fixed snapshots for both modes.

### Show nested work

Show mode, commands, patches, file changes, process states, and failures in Pi. Keep intermediate data and secrets out of the conversation.

### Cut over

Remove the old read-only tool set, prompt, tests, and docs in the same change. Run complete local checks, hostile-code tests, package checks, model compatibility tests, and CI before release.

## Verification

The compatibility suite uses provider capability checks and more than one compatible model when available. It does not select behavior through model identity.

With their default built-ins, both modes must prove that they can:

1. read and compare files;
2. create a workspace file;
3. edit a workspace file;
4. apply the mode's normal file-changing operation;
5. create and clean up a private `/tmp` file;
6. run a harmless command and inspect output;
7. use parallel tool calls;
8. keep large intermediate data inside JavaScript;
9. yield and continue through `wait`;
10. cancel without leaving a process or cell behind.

Codex mode must also prove that it can start a long command, observe it, send input, and terminate it through `exec_command` and `write_stdin`. Pi mode must preserve vanilla Pi's `bash` contract rather than add Codex process controls under a Pi tool name.

Security tests must prove that neither mode can:

- escape the workspace or scratch root;
- read the real home directory;
- access provider or local credentials;
- inherit authentication agents or control sockets;
- use the network under the default policy;
- bypass process, output, memory, or time limits;
- duplicate an unsafe side effect through replay;
- leave files, cells, or processes after required cleanup.

Mode tests must prove that:

- Codex mode exposes Codex tools and no Pi built-in coding tools;
- Pi mode exposes vanilla Pi's active built-ins and no Codex core tools;
- Pi mode defaults to `read`, `bash`, `edit`, and `write`;
- `powershell`, `grep`, `find`, and `ls` appear only when active in Pi;
- mode selection never reads the model name;
- config, CLI override, `/code-mode`, resume, and branching select the expected mode;
- resume and branching restore the recorded Pi built-in set even after Pi settings change;
- a mode cannot change in an active conversation;
- both modes use the same filesystem and command security tests.

## Completion criteria

The cutover is complete when:

- the provider sees only `exec` and `wait`;
- activation depends on provider capabilities rather than model names;
- `pi-code-mode --mode codex` starts Codex mode;
- `pi-code-mode --mode pi` starts Pi mode;
- direct Pi offers the same two modes through `/code-mode`;
- each session records and restores its mode and any Pi built-in set;
- Codex mode provides exact Codex core tools;
- Pi mode provides the active vanilla Pi built-in coding tools;
- a session never exposes both built-in tool sets;
- both modes share the same file and command executors;
- workspace writes and private `/tmp` work;
- credentials and ambient host APIs remain inaccessible;
- nested effects are visible in Pi;
- cancellation removes all child work;
- no read-only compatibility path remains;
- no private Pi API is used;
- all TypeScript, Rust, integration, hostile-code, packaging, and CI checks pass.
