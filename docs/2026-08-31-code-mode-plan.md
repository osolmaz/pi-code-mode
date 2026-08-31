---
title: Build Pi Code Mode
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-31
---

# Build Pi Code Mode

Pi Code Mode lets a model inspect a working tree through one `exec` tool. The model writes a small JavaScript program that can compose read-only file tools. The program runs automatically in a restricted sandbox.

The project also includes a separate command-line harness built with Pi's public session runtime factory and `InteractiveMode`. The extension and harness use the same tool description, sandbox, limits, and read-only capabilities.

## Requirements

- Expose one model-visible tool named `exec`.
- Disable all other model-visible tools while the extension is active.
- Accept JavaScript in an object with one `code` field because Pi custom tools use JSON schemas.
- Provide `tools.read`, `tools.grep`, `tools.find`, and `tools.ls` inside the program.
- Provide a `text(value)` helper for program output.
- Run each `exec` call automatically without a separate user confirmation.
- Run each program in a fresh JavaScript isolate with no Node.js globals, shell, network, environment variables, module loader, or write API.
- Restrict file access to the active working directory and deny symlink escapes and common credential files.
- Put strict limits on source size, run time, memory, tool calls, scanned data, and output.
- Include a standalone Pi SDK harness that uses the standard Pi TUI, keeps its state separate from normal Pi, and loads no discovered extensions, skills, prompt templates, context files, or unrelated tools.
- Test the result with the requested DeepSeek model through Hugging Face Inference Providers. Use a harmless, non-sensitive fixture directory.

## Assumptions

- The first release is read-only. Shell commands, writes, edits, persistent cells, background work, and `wait` are out of scope.
- Code Mode follows the useful parts of OpenAI Codex's current contract: fresh JavaScript execution, nested tools on a global `tools` object, a `text()` output helper, and no direct host access.
- QuickJS compiled to WebAssembly is a suitable first isolation layer. Each run will also use a fresh Node.js worker so the parent can terminate an infinite loop.
- The package will support Node.js 22 or later and the public Pi extension API.

## Design

### Shared core

The core owns the limits, sandbox protocol, path checks, capability implementations, and result formatting. Its public execution entry point runs validated source directly in the sandbox.

Each run creates a new worker. The worker creates a new QuickJS runtime and context, sets memory and stack limits, and installs an interrupt deadline. It exposes one narrow host bridge that accepts a tool name and JSON input. The bridge accepts only the four documented read-only tools.

The model program will run in an async function. `tools.read()`, `tools.grep()`, `tools.find()`, and `tools.ls()` will call the bridge. `text()` will collect bounded output. The worker will return copied JSON data only, then it will terminate.

### File boundary

All requested paths must be relative to the working directory. The implementation will resolve both the root and target with `realpath`, then verify that the target stays below the root. Recursive operations will repeat this check for each entry.

The capability layer will reject common secret and control paths, including `.git`, `.env` files, private key files, and common credential files. It will skip dependency and generated directories during recursive searches.

### Pi extension

The extension will register `exec` through `pi.registerTool()`. On session start it will save the current active tool names, then call `pi.setActiveTools(["exec"])`. It will enforce that list before each model turn. On shutdown it will restore the saved list so `/reload` and session changes do not leave Pi in Code Mode.

The extension runs `exec` calls without using Pi UI confirmation. It does not write custom session entries or other persistent data.

### SDK harness

The standalone harness uses `ModelRuntime`, `resolveCliModel()`, `createAgentSessionRuntime()`, `createAgentSessionServices()`, `createAgentSessionFromServices()`, and `InteractiveMode`. A smaller programmatic helper remains available for one-shot SDK calls through an in-memory `createAgentSession()`.

Resource discovery is disabled. The loader receives only the Code Mode extension factory and a small Code Mode system prompt. The executable reads an explicitly named API-key environment variable into an in-memory credential store. It does not copy, print, or persist credentials.

The same automatic execution behavior applies in interactive and programmatic sessions.

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

QuickJS and WebAssembly reduce access to the Node.js host, but they do not create an operating-system security boundary. Engine bugs remain possible. The read-only bridge, root checks, sensitive-path blocks, per-run worker, and resource limits provide defense in depth for local use. Users must run Code Mode only in small, non-sensitive working directories.

## Repository layout

```text
src/
  core/
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
    config.ts
    index.ts
tests/
fixtures/
docs/
```

One npm package will contain the extension and harness. This keeps installation simple while preserving separate core, extension, and harness modules.

## Contract impact

- **Session state:** Normal Pi tool-call and tool-result entries will be appended. The extension will not add custom entries.
- **Other persistent data:** The standalone executable stores nonsecret configuration, Pi settings, and session history under its own XDG configuration directory. It does not use normal Pi state.
- **Pi internals:** None.
- **Public Pi API:** `registerTool`, `setActiveTools`, `getActiveTools`, `session_start`, `before_agent_start`, and `session_shutdown`; plus `createAgentSessionRuntime`, `createAgentSessionServices`, `createAgentSessionFromServices`, `InteractiveMode`, and public resource loader options.

## Non-goals

- Shell, write, edit, or arbitrary MCP access
- Persistent JavaScript cells or a `wait` tool
- Background tasks or timers
- Network access
- Images, audio, or other rich output
- Dynamic tool discovery
- Provider-specific Code Mode wire protocols
- A Pi core change

## Acceptance criteria

1. A Pi session with the extension exposes only `exec` to the model.
2. An `exec` call starts without a separate UI confirmation or callback.
3. Non-interactive extension calls execute under the same sandbox limits.
4. Programs can compose all four read-only tools and return text.
5. Programs cannot access Node.js globals, the network, modules, the shell, writes, paths outside the root, blocked credential paths, or symlink escapes.
6. Infinite loops, excessive output, excessive scans, and excessive tool calls stop within their limits.
7. Extension reload and shutdown restore the prior tool list.
8. The SDK harness opens the standard Pi TUI, keeps its settings and sessions in its own agent directory, and has no discovered resources or extra model-visible tools.
9. Package build, formatting, lint, type checks, unit tests, coverage, Slophammer, SimpleDoc, and package-content checks pass.
10. DeepSeek completes harmless fixture tasks through `exec` in a non-sensitive fixture directory.

## Verification

Run these checks from the repository root:

```sh
npm ci
npm run check
npx -y @simpledoc/simpledoc check
npm pack --dry-run
```

Run the extension against a harmless fixture directory with `pi -e` and confirm that the tool list contains only `exec`. Verify that safe read-only programs run without a UI prompt and return correct results.

Run the SDK harness in a new Herdr tab with the exact available DeepSeek Inference Providers model ID. Use a small, non-sensitive fixture root. Verify that the sandbox rejects shell, network, writes, absolute paths, credential paths, and unbounded work.

## Implementation result

The extension, core, and harness shipped in one package as planned. The capability methods return simple copied values: `read` returns a string, `find` returns path strings, `grep` returns match objects, and `ls` returns directory entries. This reduced the amount of wrapper code a model must write and matched the behavior models expected during the provider test.

The harness gained an optional `--api-key-env` flag. It reads one named environment variable into an in-memory credential store, then discards the credential when the process exits. It does not accept a key on the command line or save a key to Pi state.

Line-based reads scan to offsets beyond the first read-sized prefix and return an explicit error when a requested range exceeds a scan or return limit. The QuickJS accumulator enforces the output limit before it returns data to the worker parent, and the parent applies the limit again as a defense. Directory scans use incremental enumeration, so listing, entry, and result limits apply before a directory can be fully materialized.

The worker-only capability and QuickJS modules are covered through integration tests because the coverage process does not collect counters from terminated worker threads. The parent sandbox, limits, prompt, and extension remain above the 85 percent coverage gate. Mutation testing covers limit validation and user-config modules.

## Provider test result

The original test used `deepseek-ai/DeepSeek-V4-Flash-0731` through Hugging Face's automatic Inference Providers route. The model generated a single safe program that found and read two fixture files, counted their words, sorted the keys, and returned the correct counts. This test happened before the later removal of the approval gate.

The model refused a request for an absolute path before it called `exec`. The same Herdr tab also loaded the built extension through Pi's `-e` option with extension, skill, prompt-template, theme, and context-file discovery disabled.

## Persistent standalone configuration

The standalone executable reads a per-user JSON config from the XDG config directory. The model has three stable fields: required `provider` and `model` strings and an optional `apiKeyEnv` string. The last field stores only an environment-variable name. API key values are never persisted. CLI options override the saved fields, and `--save-config` writes the effective values with private directory and file permissions.

Running `pi-code-mode` creates an `AgentSessionRuntime` with Pi's public factory APIs and opens the standard `InteractiveMode` TUI. The runtime keeps Pi settings and session history in the Code Mode configuration directory. It disables discovered extensions, skills, prompt templates, and project context files, but leaves the standard TUI and themes available. The model receives only `exec`, which runs programs automatically in the sandbox. A positional prompt is the initial TUI message rather than a separate one-shot mode.
