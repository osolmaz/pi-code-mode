---
title: Build Pi Code Mode
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-31
---

# Build Pi Code Mode

Pi Code Mode will let a model inspect a working tree through one `exec` tool. The model will write a small JavaScript program that can compose read-only file tools. A person must see and approve the exact program before it runs.

The project will also include a separate command-line harness built with Pi's `createAgentSession()` factory. The extension and harness will use the same tool description, approval contract, sandbox, limits, and read-only capabilities.

## Requirements

- Expose one model-visible tool named `exec`.
- Disable all other model-visible tools while the extension is active.
- Accept JavaScript in an object with one `code` field because Pi custom tools use JSON schemas.
- Provide `tools.read`, `tools.grep`, `tools.find`, and `tools.ls` inside the program.
- Provide a `text(value)` helper for program output.
- Show the exact source before each execution and require one approval for that source.
- Deny execution when no interactive approval path exists.
- Run each program in a fresh JavaScript isolate with no Node.js globals, shell, network, environment variables, module loader, or write API.
- Restrict file access to the active working directory and deny symlink escapes and common credential files.
- Put strict limits on source size, run time, memory, tool calls, scanned data, and output.
- Include a standalone Pi SDK harness with no discovered extensions, skills, prompt templates, context files, persistent sessions, or unrelated tools.
- Test the result with the requested DeepSeek model through Hugging Face Inference Providers. Use a harmless fixture directory and review every generated program before approval.

## Assumptions

- The first release is read-only. Shell commands, writes, edits, persistent cells, background work, and `wait` are out of scope.
- Code Mode follows the useful parts of OpenAI Codex's current contract: fresh JavaScript execution, nested tools on a global `tools` object, a `text()` output helper, and no direct host access.
- QuickJS compiled to WebAssembly is a suitable first isolation layer. Each run will also use a fresh Node.js worker so the parent can terminate an infinite loop.
- The package will support Node.js 22 or later and the public Pi extension API.

## Design

### Shared core

The core will own the limits, approval request, program digest, sandbox protocol, path checks, capability implementations, and result formatting. Its only public execution entry point will require an approval callback.

Each approved run will create a new worker. The worker will create a new QuickJS runtime and context, set memory and stack limits, and install an interrupt deadline. It will expose one narrow host bridge that accepts a tool name and JSON input. The bridge will accept only the four documented read-only tools.

The model program will run in an async function. `tools.read()`, `tools.grep()`, `tools.find()`, and `tools.ls()` will call the bridge. `text()` will collect bounded output. The worker will return copied JSON data only, then it will terminate.

### File boundary

All requested paths must be relative to the working directory. The implementation will resolve both the root and target with `realpath`, then verify that the target stays below the root. Recursive operations will repeat this check for each entry.

The capability layer will reject common secret and control paths, including `.git`, `.env` files, private key files, and common credential files. It will skip dependency and generated directories during recursive searches.

### Pi extension

The extension will register `exec` through `pi.registerTool()`. On session start it will save the current active tool names, then call `pi.setActiveTools(["exec"])`. It will enforce that list before each model turn. On shutdown it will restore the saved list so `/reload` and session changes do not leave Pi in Code Mode.

The default approval callback will use Pi's documented TUI confirmation dialog. It will deny the call when `ctx.hasUI` is false. The extension will not write custom session entries or other persistent data.

### SDK harness

The harness will use `ModelRuntime`, `resolveCliModel()`, `DefaultResourceLoader`, `SessionManager.inMemory()`, `SettingsManager.inMemory()`, and `createAgentSession()`.

Resource discovery will be disabled. The loader will receive only the Code Mode extension factory and a small Code Mode system prompt. The harness will use the user's existing Pi authentication files in place. It will not copy or print credentials.

The terminal approval prompt will print the exact source between clear markers and require an explicit `y` answer. Non-interactive input will deny the call. There will be no approve-all option.

## Security limits

The initial defaults will include:

- 64 KiB maximum JavaScript source
- 5 second wall-clock timeout
- 64 MiB QuickJS memory limit
- 512 KiB QuickJS stack limit
- 32 nested tool calls
- 256 KiB maximum for one file read
- 2 MiB maximum scanned data per program
- 1,000 scanned files or directory entries per program
- 100 search results per call
- 128 KiB maximum returned text

An outer worker timeout will remain authoritative if the QuickJS interrupt handler does not return. An abort signal from Pi will also terminate the worker.

QuickJS and WebAssembly reduce access to the Node.js host, but they do not create an operating-system security boundary. Engine bugs remain possible. The approval gate, read-only bridge, root checks, sensitive-path blocks, per-run worker, and resource limits provide defense in depth for local use.

## Repository layout

```text
src/
  core/
    approval.ts
    capabilities.ts
    limits.ts
    sandbox.ts
    sandbox-worker.ts
    types.ts
  extension/
    index.ts
    tool.ts
  harness/
    cli.ts
    index.ts
    terminal-approval.ts
tests/
fixtures/
docs/
```

One npm package will contain the extension and harness. This keeps installation simple while preserving separate core, extension, and harness modules.

## Contract impact

- **Session state:** Normal Pi tool-call and tool-result entries will be appended. The extension will not add custom entries.
- **Other persistent data:** None. The SDK harness will use an in-memory session and settings store.
- **Pi internals:** None.
- **Public Pi API:** `registerTool`, `setActiveTools`, `getActiveTools`, `session_start`, `before_agent_start`, `session_shutdown`, `ctx.hasUI`, and `ctx.ui.confirm`; plus the public SDK factories and resource loader options.

## Non-goals

- Shell, write, edit, or arbitrary MCP access
- Persistent JavaScript cells or a `wait` tool
- Background tasks or timers
- Network access
- Images, audio, or other rich output
- Dynamic tool discovery
- Provider-specific Code Mode wire protocols
- A Pi core change
- Automatic approval or policy-based approval persistence

## Acceptance criteria

1. A Pi session with the extension exposes only `exec` to the model.
2. The exact program is shown before execution and a denial starts no worker.
3. Non-interactive extension calls are denied.
4. Approved programs can compose all four read-only tools and return text.
5. Programs cannot access Node.js globals, the network, modules, the shell, writes, paths outside the root, blocked credential paths, or symlink escapes.
6. Infinite loops, excessive output, excessive scans, and excessive tool calls stop within their limits.
7. Extension reload and shutdown restore the prior tool list.
8. The SDK harness has no discovered resources, persistent session, or extra model-visible tools.
9. Package build, formatting, lint, type checks, unit tests, coverage, Slophammer, SimpleDoc, and package-content checks pass.
10. DeepSeek completes harmless fixture tasks through `exec`, and every executed program has an observed approval decision.

## Verification

Run these checks from the repository root:

```sh
npm ci
npm run check
npx -y @simpledoc/simpledoc check
npm pack --dry-run
```

Run the extension against a harmless fixture directory with `pi -e` and confirm that the tool list contains only `exec`. Deny one program and verify that no capability runs. Approve safe read-only programs and verify their results.

Run the SDK harness in a new Herdr tab with the exact available DeepSeek Inference Providers model ID. Inspect the source shown by each approval prompt. Approve only programs that use the documented read-only API within the fixture root. Deny any program that asks for shell, network, writes, absolute paths, credential paths, or unbounded work.

## Implementation result

The extension, core, and harness shipped in one package as planned. The capability methods return simple copied values: `read` returns a string, `find` returns path strings, `grep` returns match objects, and `ls` returns directory entries. This reduced the amount of wrapper code a model must write and matched the behavior models expected during the provider test.

The harness gained an optional `--api-key-env` flag. It reads one named environment variable into an in-memory credential store, then discards the credential when the process exits. It does not accept a key on the command line or save a key to Pi state.

Approval calls are sequential. Dynamic approval text uses reversible escapes for terminal controls, Unicode formatting controls, and literal backslashes. This prevents concurrent prompts and source text from changing the terminal display. Line-based reads scan to offsets beyond the first read-sized prefix and return an explicit error when a requested range exceeds a scan or return limit. The QuickJS accumulator enforces the output limit before it returns data to the worker parent, and the parent applies the limit again as a defense. Directory scans use incremental enumeration, so listing, entry, and result limits apply before a directory can be fully materialized.

The worker-only capability and QuickJS modules are covered through integration tests because the coverage process does not collect counters from terminated worker threads. The parent sandbox, limits, prompt, and extension remain above the 85 percent coverage gate. Mutation testing covers the deterministic approval digest and limit validation modules and reached a 100 percent mutation score.

## Provider test result

The test used `deepseek-ai/DeepSeek-V4-Flash-0731` through Hugging Face's automatic Inference Providers route. The model generated a single safe program that found and read two fixture files, counted their words, sorted the keys, and returned the correct counts. The exact source was approved in the terminal before execution.

The model refused a request for an absolute path before it called `exec`. A separate listing task exercised denial behavior. Two changed programs were shown and denied, no program ran, and the model stopped after the second denial. The same Herdr tab also loaded the built extension through Pi's `-e` option with extension, skill, prompt-template, theme, and context-file discovery disabled.
