---
title: Build a Deno Core Code Mode host
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-31
updated: 2026-09-01
---

# Plan: Deno Core host for Pi Code Mode

> Assumption: “demo core” means `deno_core`.

## Objective

Complete the production Code Mode host built on Rust, `deno_core`, and V8, then replace the current read-only capability contract in place.

The V8 host and OpenAI-shaped `exec` and `wait` surface are already implemented. The remaining cutover adds the full coding capability layer without giving the V8 process ambient host authority.

The final system will:

- keep Pi's normal interactive window;
- expose only OpenAI-shaped `exec` and `wait` tools to the provider;
- send raw JavaScript through freeform grammar tools when the selected provider advertises that capability;
- activate through provider capabilities without checking model names;
- accept arbitrary bounded JavaScript within a strict capability boundary;
- let each session select `codex` or `pi` mode;
- provide exact Codex-compatible coding tools inside `tools` in Codex mode;
- mirror vanilla Pi's active built-in coding tools inside `tools` in Pi mode;
- never expose both built-in tool sets in one session;
- accept explicit project and third-party tool registrations for one or both modes;
- route equivalent work in both modes through one workspace and process sandbox;
- support sequential, conditional, parallel, and repeated tool calls;
- keep intermediate tool results inside V8;
- support yielded cells and later observation through `wait`;
- allow workspace writes, patches, commands, and long-running process control;
- provide private session scratch as `/tmp` to file tools and through `TMPDIR` to commands;
- keep credentials and host APIs outside JavaScript and nested command environments;
- show every nested side effect in Pi;
- run the V8 host in a separate disposable process;
- use only documented Pi extension and Factory APIs;
- remove the read-only tool-set contract in one hard cutover.

The product contract is defined in [Build full Pi Code Mode](2026-08-31-code-mode-plan.md). No compatibility layer will preserve the read-only tool set.

---

## Product boundary

The repository will contain two independent parts.

```text
pi-code-mode/
├── TypeScript Pi package
│   ├── extension
│   ├── standalone Pi Factory harness
│   ├── OpenAI tool-contract adapter
│   ├── mode selection and session state
│   ├── Codex mode tool builder
│   ├── Pi mode tool builder
│   ├── extension tool registration
│   ├── host client
│   ├── tool broker
│   ├── workspace and process sandbox
│   └── executable installer/resolver
│
└── Rust Code Mode host
    ├── protocol server
    ├── V8 cell runtime
    ├── tool-call bridge
    ├── cell lifecycle manager
    └── resource and security limits
```

The Rust code will live in the same repository, but it will have a strict process and protocol boundary. TypeScript will not import Rust libraries. Rust will not import Pi packages.

The shared protocol will be the only contract between them.

This structure keeps the Pi product in TypeScript while treating the Rust host as a versioned runtime artifact.

---

## Architecture

```text
Pi TUI
  |
  | model calls exec or wait
  v
Pi Code Mode extension
  |
  | validates input and session authority
  v
TypeScript host client
  |
  | length-prefixed protocol over stdin/stdout
  v
Rust code-mode host process
  |
  | one V8 isolate per cell
  v
model-generated JavaScript
  |
  | await tools.<selected-mode tool>(...)
  v
Rust host sends tool/invoke
  |
  v
TypeScript tool broker
  |
  | selected mode, tool set, schema, policy, cancellation, trace
  v
selected Codex or Pi tool builder, plus allowed project or later MCP tools
  |
  v
shared workspace and process sandbox
  |
  | JSON-safe result
  v
V8 promise resolves
```

The host process will never execute shell commands, read project files, access credentials, or make network requests by itself.

Generated JavaScript can request those operations only through the parent-side tool broker.

---

## OpenAI model contract

Pi Code Mode will use an OpenAI-shaped provider contract. The outer `exec` and `wait` tools will follow current public Codex Code Mode behavior. Codex mode will also follow Codex's nested tool contract. Pi mode will keep the same outer tools but describe and expose Pi's nested coding tools instead. The host protocol and runtime will remain independent.

The production implementation will not contain checks for any model name. Model identities change. The stable contract is the tool format and capability set that the selected provider can send.

### Boundary

The system has three separate contracts:

1. The OpenAI adapter defines what the model sees.
2. The Pi extension normalizes model tool calls into internal TypeScript requests.
3. The Rust host executes normalized requests without knowing the provider, API, or model.

```text
OpenAI Responses model
  |
  | freeform exec or function wait
  v
OpenAI contract adapter
  |
  | normalized TypeScript request
  v
Pi Code Mode extension
  |
  | versioned host protocol
  v
Rust V8 host
```

No OpenAI request headers, response item types, model identifiers, credentials, or transport state will enter the Rust host protocol.

### `exec` as an OpenAI freeform tool

The model must see `exec` as a freeform custom tool whose input is raw JavaScript source. It must not see a JSON object or a quoted `code` string.

The grammar will match the Codex source contract:

```lark
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
```

Pi custom tools execute with parsed parameter objects. The extension will therefore register an internal schema with one required string property named `code` and attach Pi's documented grammar `constrainedSampling` metadata. On a compatible OpenAI Responses provider, Pi serializes that tool as a freeform custom tool and maps its raw input back to the internal `code` property.

This translation is an adapter detail. The host receives only normalized source and execution options.

The extension will not silently fall back to a normal JSON function tool for `exec`. A JSON fallback changes the action format presented to the model and is not the same compatibility target.

### `wait` as an OpenAI function tool

The model must see `wait` as a normal, non-strict function tool with this input:

```typescript
type OpenAIWaitInput = {
  cell_id: string;
  yield_time_ms?: number;
  max_tokens?: number;
  terminate?: boolean;
};
```

The default `yield_time_ms` will be 10,000. The default `max_tokens` will be 10,000. The extension will normalize these snake-case fields into its internal cell request.

The host will continue to enforce byte limits for security. The OpenAI adapter can accept token-shaped output options for contract compatibility, but it must not report invented token counts. If an exact tokenizer is unavailable, it will enforce the hard byte cap and describe any model-visible token truncation as approximate.

### `exec` pragma

The first line can set model-facing execution options:

```js
// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}
```

The extension will parse the pragma before it sends the source to the host. It will validate both values, remove no other source text, and pass normalized limits separately. Invalid pragma JSON or out-of-range values will fail before execution.

Explicit pragma values take precedence over defaults. They cannot exceed the package's hard security limits.

### Activation

Code Mode activation will require both:

- a selected `codex` or `pi` mode;
- a selected OpenAI Responses-family provider that advertises grammar custom-tool support through Pi's documented model compatibility metadata.

Activation will not use a model-name allowlist.

If the provider cannot represent freeform `exec`, Code Mode will fail before the model request. It will not expose the old tools, use a JSON-shaped substitute, or guess from the provider name.

### Mode selection

The direct Pi extension and the standalone command will read one shared config file:

```text
$XDG_CONFIG_HOME/pi-code-mode/config.json
```

When `XDG_CONFIG_HOME` is not set, the path will be:

```text
~/.config/pi-code-mode/config.json
```

The config will have this shape:

```json
{
  "mode": "codex",
  "provider": "openai",
  "model": "<compatible-model>",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

`mode` will accept only `codex` or `pi`. The config will store an API-key environment-variable name, not an API key. Writes will be atomic and will preserve fields that belong to the other entry point.

The standalone command will also accept `--mode codex` and `--mode pi`. Selection order for a new session will be:

1. the standalone `--mode` option;
2. the saved `mode` value;
3. `codex` as the default.

The direct Pi extension will use only the saved `mode` from this file. It will continue to use Pi's active provider, model, and credentials. The standalone command will continue to read its saved provider, model, and API-key environment-variable name from the same file. A command-line mode will apply only to that run unless the user also passes `--save-config`.

A missing `mode` will use the `codex` default. An invalid saved or command-line value will fail with a clear message. It will not select a mode by guessing. A recorded mode in a resumed session takes priority over new command-line or config values; a conflicting request must start a new session.

The extension will add `/code-mode` so the user can select Codex mode or Pi mode. It will save the selection as the default for later sessions.

The selected mode will be fixed when a Pi session starts. The extension will record one entry through Pi's documented session API. Codex mode needs only the mode and contract version:

```json
{
  "mode": "codex",
  "contractVersion": 1
}
```

Pi mode will also record the recognized active vanilla built-ins that were present before the extension activated only `exec` and `wait`:

```json
{
  "mode": "pi",
  "piBuiltins": ["read", "bash", "edit", "write"],
  "contractVersion": 1
}
```

A resumed or branched session will use its recorded mode and Pi built-in set even when the shared config or Pi settings later change. Before the first model message, `/code-mode` can select the current session's mode and take a new Pi built-in snapshot. After the session contains model messages, it will save the new default and offer a new session instead of changing the active contract.

Mode selection will never use the model name. There will be no automatic or mixed mode.

### Public OpenAI Responses first

The first release will use Pi's documented OpenAI Responses grammar-tool path. It will not replace the complete OpenAI provider when Pi can already serialize the required custom tool.

Codex Responses Lite uses a separate internal request envelope, header, replay format, and namespace representation. That transport will not be part of the first core implementation. If it becomes necessary, it must be a separate adapter registered through Pi's public provider API. The host, broker, and model tool definitions must remain unchanged.

Likewise, `tool_namespaces_info` is transport metadata rather than a runtime requirement. A later adapter can derive it from the frozen tool set when a documented or verified endpoint requires it. The core will not depend on it.

### Replay and session conversion

Pi session history will retain normal Pi tool call and result entries. The OpenAI adapter must preserve the distinction between:

- freeform `custom_tool_call` and `custom_tool_call_output` for `exec`;
- function calls and function outputs for `wait`;
- the internal `{ code }` representation used by Pi;
- the raw JavaScript representation sent to OpenAI.

Tests must cover initial calls, streaming partial source, replay, branching, compaction, provider changes, and deterministic call identifiers. A retry must not duplicate a completed nested side effect.

### Independence

Pi Code Mode will use Codex and `pi-codex-conversion` as behavioral references only.

The package will not:

- vendor Codex source;
- import `pi-codex-conversion`;
- launch a Codex binary or Codex Code Mode host;
- use Codex's private Rust protocol;
- copy the Responses Lite provider implementation into the core;
- require a specific OpenAI model name;
- expose unrelated Codex conversion features.

The repository will own its TypeScript adapter, prompt, host protocol, Rust runtime, broker, tests, installer, and release artifacts.

---

## Comparison with other Code Mode implementations

This comparison uses the source available on 2026-08-31. The inspected revisions were:

- OpenAI Codex `1c1e17782aeb51a5a253997067fa887a9d593cc9`;
- OpenClaw `c003292c236583f0b043be7f2f62234296de6e9d` from `upstream/main`;
- OpenCode `9f69463f1d556af2b5b51d2efa1c04f5f544f911` from `dev`;
- OMP, meaning Oh My Pi, `65f79e76fcc89b96632fe86a598f314bd7cfc725`.

The revision identifiers make the comparison reproducible. The links below use each repository's relevant branch so they continue to point to the maintained source.

### Summary

| Implementation | Model-visible surface                                            | Guest runtime                                               | Long-running cells                                                                 | Ambient host authority                                                            | Nested tool boundary                                          |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| OpenAI Codex   | Raw-source `exec` and structured `wait`                          | Rust host with sandbox-enabled V8 through `rusty_v8`        | Live isolate pauses and resumes                                                    | No Node, filesystem, network, console, or module access                           | Calls return to the Codex session delegate                    |
| OpenClaw       | Structured `exec` and `wait`, plus required direct-only tools    | QuickJS-WASI in a Node.js worker thread                     | QuickJS snapshots are stored and restored                                          | No filesystem, network, process, environment, or modules                          | Calls return to the normal OpenClaw tool executor             |
| OpenCode       | One structured `execute` tool                                    | Owned TypeScript tree-walking interpreter over an Acorn AST | No `wait`; each program is one-shot                                                | No ambient host APIs because unsupported syntax and globals are never implemented | Generic explicit tool tree; current adapter exposes MCP tools |
| OMP            | `eval` plus a direct keep-set such as `ask`, `todo`, and `yield` | Persistent language kernels; JavaScript runs under Bun      | Kernel state persists; generic background jobs replace a Code Mode `wait` protocol | Broad Bun, filesystem, shell, network, process, and module authority              | Enabled session tools are bridged through `tool.<name>()`     |
| This plan      | Raw JavaScript `exec` and structured `wait`                      | Separate Rust `deno_core` and V8 host process               | Live isolate pauses and resumes                                                    | No Deno, Node, filesystem, network, process, environment, or modules              | Calls return to a frozen TypeScript broker owned by Pi        |

The implementations solve related problems, but they do not have the same security or lifecycle contract. The name “Code Mode” alone does not establish that code is isolated, that tools are nested, or that a `wait` operation exists.

### OpenAI Codex

OpenAI Codex is the closest implementation to this plan.

#### Model contract

Codex exposes a raw JavaScript `exec` tool. The tool description says that the source runs as an asynchronous module in a fresh V8 isolate. Nested tools are methods on the global `tools` object. A separate `wait` tool observes a yielded cell by `cell_id`.

The model can also use:

- `ALL_TOOLS` for bounded tool discovery;
- `text`, `image`, `audio`, and generated-image output helpers;
- `store` and `load` for session-scoped JSON values;
- `notify` for progress;
- `yield_control` for an explicit yield;
- `setTimeout` and `clearTimeout`;
- `exit` for an intentional early end.

The source can include a first-line `// @exec:` pragma for the initial yield time and maximum output tokens. `exec` returns after completion, failure, or its yield boundary. `wait` returns only new output and can yield again with the same cell identifier.

#### Host and runtime

Codex separates the runtime into several Rust crates:

- `code-mode-protocol` defines tool descriptions, session interfaces, runtime responses, framing, and host messages;
- `code-mode-runtime` owns V8, cells, callbacks, globals, timers, values, and termination;
- `code-mode-host` is a standalone executable with standard-I/O and gRPC transports;
- `code-mode` is the Codex-side client and session provider.

One lazily started host process can serve multiple Codex sessions. Each cell receives a fresh V8 isolate and runs on its own runtime thread. The host keeps session-scoped stored values and a map of live cells. The Codex process retains ownership of real tools through `CodeModeSessionDelegate`.

Codex currently uses the `v8` crate directly with its `v8_enable_sandbox` feature. It does **not** use `deno_core` as its runtime abstraction. It imports `deno_core_icudata` only to initialize ICU data. This is the main implementation-level difference from this plan.

The runtime deletes `console`, `Atomics`, `SharedArrayBuffer`, and `WebAssembly`. It installs only the intended globals. Static and dynamic module resolution reject imports. There is no Node or Deno global surface.

The inspected implementation has a separate process and V8 sandbox support. It does not, by itself, establish the cross-platform operating-system policy sandbox specified later in this plan. This plan therefore keeps a stricter process-launch and OS-isolation requirement.

#### Cell lifecycle

Codex keeps yielded cells live. It does not serialize a V8 heap snapshot for each yield.

A cell actor coordinates:

- the V8 runtime thread;
- one observer at a time;
- nested tool promises;
- output accumulated since the last observation;
- cancellation and isolate termination;
- completion and session-store commits.

When execution reaches a pending frontier, the runtime can pause until `wait` resumes observation. A terminating request cancels nested work and calls V8's `terminate_execution()` through an isolate handle.

This live-cell design is the direct precedent for the plan's `exec` and `wait` lifecycle.

#### Tool authority

Every `ExecuteRequest` contains the enabled tool definitions for that cell. A tool callback emits a typed nested call to the host. The host delegates that call back to Codex, where the parent session owns the real implementation and cancellation token.

This is the same authority direction required by this plan:

```text
untrusted JavaScript
  -> runtime callback
  -> external host protocol
  -> parent agent tool broker
  -> real operation
```

The runtime never receives a generic shell, filesystem object, credential store, or HTTP client.

#### Elements to adopt

This plan will adopt the following Codex properties:

- a separate, versioned host executable;
- `exec` and `wait` as the model-visible control surface;
- one live isolate per cell;
- raw JavaScript evaluated as an asynchronous module;
- nested tools on `tools`;
- bounded discovery through `ALL_TOOLS`;
- parent-owned tool execution;
- cell-scoped cancellation and isolate termination;
- session-scoped JSON storage rather than shared JavaScript heaps;
- no compatibility fallback when the runtime is unavailable.

This plan will not copy Codex internals or private interfaces. It will reproduce the public behavior through Pi's documented extension and Factory APIs.

Sources:

- [Codex Code Mode protocol and descriptions](https://github.com/openai/codex/tree/main/codex-rs/code-mode-protocol)
- [Codex Code Mode runtime](https://github.com/openai/codex/tree/main/codex-rs/code-mode-runtime)
- [Codex V8 globals](https://github.com/openai/codex/blob/main/codex-rs/code-mode-runtime/src/runtime/globals.rs)
- [Codex cell actor](https://github.com/openai/codex/blob/main/codex-rs/code-mode-runtime/src/cell_actor/mod.rs)
- [Codex remote session and host process](https://github.com/openai/codex/blob/main/codex-rs/code-mode/src/remote_session.rs)
- [Codex standalone host](https://github.com/openai/codex/tree/main/codex-rs/code-mode-host)

### OpenClaw

OpenClaw is the second-closest implementation at the model and policy boundary. Its runtime and resume method are different.

#### Model contract

When enabled, OpenClaw hides catalog-compatible tools and exposes:

- `exec`;
- `wait`;
- required direct-only tools whose result or control semantics cannot cross the bridge.

Its `exec` input is structured and accepts `code`, an internal-compatible `command` alias, `language`, and a guarded `restartSafe` field. JavaScript and TypeScript are supported. TypeScript is transformed to JavaScript without type checking or module resolution.

OpenClaw provides more discovery surfaces than Codex:

- safe tool names can become direct guest globals;
- `catalog.search()` and `catalog.all()` provide lazy lookup;
- callable catalog handles provide `describe()`;
- MCP tools use generated virtual declaration files and `MCP` namespaces;
- `API.list()` and `API.read()` expose those declarations without filesystem access;
- optional node, skill, and Swarm namespaces add domain-specific composition.

#### Runtime and snapshots

OpenClaw uses `quickjs-wasi` in a Node.js worker thread. It creates a QuickJS VM for initial execution. When a cell must wait, it serializes the QuickJS VM state and stores:

- the snapshot;
- pending bridge requests;
- run and session scope;
- output and lifecycle metadata.

`wait` restores the snapshot into a new runtime and continues the suspended program. Snapshots are process-local, size-limited, scoped, and subject to a time-to-live. They do not survive a Gateway restart. OpenClaw separately supports guarded replay for a narrow set of proven replay-safe work; replay is not the same as restoring the old VM.

This differs from the plan's live-isolate design. Snapshotting reduces the cost of parking many cells, but it creates a larger serialization contract and ties lifecycle correctness to QuickJS-WASI snapshot fidelity. The plan will keep live V8 isolates until measurements prove that snapshot support is necessary.

#### Tool authority and policy

OpenClaw builds the hidden catalog only after its normal effective tool policy is resolved. Each nested call crosses the host bridge and re-enters the normal executor with the original:

- agent and session identity;
- sender and channel context;
- sandbox policy;
- approval policy;
- plugin hooks;
- abort signal;
- telemetry and trajectory context.

Nested calls are projected as real child activity under the parent Code Mode call. The guest does not receive host errors or prototypes. Tool failures become plain catchable JavaScript errors.

OpenClaw also tracks whether a failed cell started possible side effects. Ordinary recovery is allowed only when host evidence proves that no mutation started or that completed work was audited read-only. This is stronger than treating every JavaScript exception as safe to retry.

#### Security

The QuickJS guest receives no filesystem, network, subprocess, environment, package, or module authority. The worker thread protects the main event loop from cooperative failures, while QuickJS memory and interrupt controls stop bounded hostile programs. OpenClaw's own documentation states that operators can still need OS-level hardening.

Default limits include a 10-second execution time, 64 MiB of guest memory, 64 KiB of output, 10 MiB per snapshot, 16 pending nested calls, and a 15-minute snapshot lifetime. These are useful starting points, not automatic proof that the same limits are correct for V8.

#### Elements to adopt

This plan will adopt or adapt:

- fail-closed activation;
- policy filtering before catalog construction;
- run-scoped catalogs;
- deterministic name-collision handling;
- direct-only tool classification;
- bounded lazy discovery for large catalogs;
- nested-call transcript projection;
- explicit side-effect and replay-safety metadata;
- output, pending-call, memory, and expiry limits;
- no recursive access to Code Mode control tools.

This plan will not adopt QuickJS snapshots, worker-thread-only containment, or OpenClaw-specific namespaces.

Sources:

- [OpenClaw Code Mode documentation](https://github.com/openclaw/openclaw/blob/main/docs/tools/code-mode.md)
- [OpenClaw Code Mode surface](https://github.com/openclaw/openclaw/blob/main/src/agents/code-mode.ts)
- [OpenClaw execution coordinator](https://github.com/openclaw/openclaw/blob/main/src/agents/code-mode-execution.ts)
- [OpenClaw QuickJS runtime adapter](https://github.com/openclaw/openclaw/blob/main/src/agents/code-mode-runtime.ts)
- [OpenClaw host bridge](https://github.com/openclaw/openclaw/blob/main/src/agents/code-mode-bridge.ts)
- [OpenClaw suspended-run state](https://github.com/openclaw/openclaw/blob/main/src/agents/code-mode-state.ts)

### OpenCode

OpenCode takes the smallest and most language-restrictive approach.

#### Generic package

The private workspace package `@opencode-ai/codemode` is host-neutral. A host builds an explicit tree of schema-described tools and calls either:

```typescript
CodeMode.execute({ tools, code });
```

or:

```typescript
const runtime = CodeMode.make({ tools });
await runtime.execute(code);
```

The model-facing program can sequence, branch, loop, transform values, and run up to eight eagerly forked calls concurrently.

#### Interpreter

OpenCode does not embed V8, QuickJS, Bun, Deno, or Node for guest execution. It:

1. removes supported TypeScript syntax;
2. parses JavaScript with Acorn;
3. evaluates the AST with an owned tree-walking interpreter;
4. implements selected standard-library operations itself;
5. copies tool inputs and outputs through plain-data and schema boundaries.

Because the interpreter implements only selected syntax and globals, guest code cannot reach `eval`, modules, files, processes, or network APIs. There is no native JavaScript realm to escape. This gives a small capability boundary and deterministic control over syntax.

The tradeoff is language compatibility. It is not arbitrary JavaScript. The design document lists missing promise pipelines, async iteration, standard-library variants, typed arrays, binary values, and other syntax or built-ins. Model-generated JavaScript that works in Codex or a browser can fail as unsupported syntax in OpenCode.

#### Lifecycle and limits

OpenCode execution is one-shot. It has no `wait`, live cell, snapshot, or persistent guest state. A reusable `CodeMode.make()` value reuses prepared catalog data and host tool definitions, not the lexical state of a previous program.

The generic package supports optional limits for wall time, admitted tool calls, and output bytes. Those limits have no package defaults. The inspected OpenCode adapter does not set them, although the outer tool call can be interrupted through its abort signal.

#### Current OpenCode adapter

The current `execute` tool adapter exposes connected MCP tools after OpenCode permission filtering. It:

- groups MCP tools by server namespace;
- creates a schema-described tool tree;
- asks for permission before each nested MCP call;
- runs plugin before and after hooks;
- records child-call state for the UI;
- returns attachments through the normal OpenCode attachment channel.

The generic package can host non-MCP tools, but the current product adapter is not a complete replacement for OpenCode's built-in tool surface.

#### Elements to adopt

This plan will adopt the explicit capability-tree principle, plain-data boundaries, schema validation, safe diagnostic projection, and bounded discovery ideas.

This plan will not adopt a partial JavaScript interpreter. The product goal is to run the ordinary JavaScript that Code Mode-trained models generate. Maintaining a second language implementation would create a long compatibility tail and move effort away from host policy and lifecycle correctness.

Sources:

- [OpenCode Code Mode package README](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/README.md)
- [OpenCode Code Mode design](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/codemode.md)
- [OpenCode interpreter](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/src/interpreter/runtime.ts)
- [OpenCode host-neutral API](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/src/codemode.ts)
- [OpenCode MCP adapter](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/code-mode.ts)

### OMP

OMP, or Oh My Pi, implements a Codex-aware Code Mode surface over its existing general-purpose `eval` system. It is the least similar runtime to this plan, even though it deliberately mirrors Codex provider metadata.

#### Activation and model surface

OMP's `providers.openai-codex.codeMode` setting can be `off`, `auto`, or `on`. It is off by default. `auto` activates for models whose catalog tool mode is `code_mode_only`.

When active, OMP keeps a direct set that includes:

- `eval`;
- `ask`;
- `todo`;
- `yield`;
- `think`;
- checkpoint and rewind controls;
- internal agent, budget, completion, and concurrency bridges.

Other enabled session tools are removed from the direct model surface and advertised as `tool.<name>(args)` methods inside `eval`. OMP also emits Codex-compatible `tool_namespaces_info` metadata that identifies direct, bridged, deferred, harness, and MCP functions.

OMP therefore matches part of Codex's provider-facing tool partition, but its model tool is `eval`, not Codex's raw-source `exec`, and it does not provide the same `exec` and `wait` cell protocol.

#### Runtime

OMP's `eval` tool is a general persistent notebook-like system. It supports:

- JavaScript under Bun;
- Python through an IPython kernel;
- optional Ruby and Julia kernels;
- persistent state across cells;
- reset operations;
- cell timeouts;
- generic background jobs and later delivery;
- output, images, artifacts, subagents, and completion helpers.

The JavaScript path runs source through indirect global `eval` in a retained worker or subprocess. Its own model prompt explicitly advertises `Bun.file`, `Bun.write`, `Bun.$`, `fetch`, and `Buffer`. The runtime also supports Node-compatible filesystem, process, module, and stream APIs.

This is intentional general code execution, not a capability-free Code Mode guest. The prompt asks models to prefer `tool.*` so calls use the session pipeline, but prompt preference is not a security boundary. Generated code can use ambient filesystem, shell, network, and module APIs directly.

#### Tool bridge

The JavaScript prelude forwards `tool.<name>(args)` to the parent worker protocol. The parent resolves only currently enabled tools and applies the available ACP permission wrapper. Results are reduced to text, details, images, and error state before returning to the cell.

The top-level `eval` tool has execution approval semantics and can show its language and source in approval details. This is a broad code-execution grant. It is different from granting a capability-free program and then applying policy separately to each nested operation.

#### Lifecycle

OMP persists language-kernel state across separate `eval` calls. Long-running work can become a generic background job and later deliver output. This is useful notebook behavior, but it is not the same lifecycle as a bounded Code Mode cell:

- there is no isolated fresh JavaScript realm per `exec`;
- there is no Code Mode cell identifier returned for `wait`;
- session state includes arbitrary language objects, imported modules, open resources, and host references;
- a kernel restart can lose all retained state;
- the authority of one cell is much broader than a frozen nested-tool catalog.

#### Elements to adopt

This plan can adopt OMP's provider metadata compatibility, generated TypeScript declarations, provider-capability tests, and clear rendering of nested activity.

This plan will not adopt ambient Bun authority, general language kernels, prompt-enforced restrictions, or persistent arbitrary JavaScript heaps. Those choices conflict with the plan's hostile-code trust model.

Sources:

- [OMP Code Mode surface partition](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/code-mode.ts)
- [OMP Code Mode prompt](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/tools/eval-code-mode.md)
- [OMP eval tool](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/eval.ts)
- [OMP JavaScript runtime](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/eval/js/shared/runtime.ts)
- [OMP JavaScript tool bridge](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/eval/js/tool-bridge.ts)
- [OMP settings reference](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)

### Relative fit for Pi Code Mode

The comparison gives four different kinds of closeness.

| Question                                                      | Closest implementation | Reason                                                                                                      |
| ------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Which host and cell architecture is closest?                  | OpenAI Codex           | Separate Rust host, V8 isolates, live cells, `exec`, `wait`, and parent delegates                           |
| Which policy and catalog design is strongest?                 | OpenClaw               | Run-scoped filtering, lazy discovery, direct-only tools, normal executor re-entry, and side-effect evidence |
| Which implementation has the smallest language boundary?      | OpenCode               | No native JavaScript engine and only an owned syntax subset                                                 |
| Which implementation is the most flexible coding environment? | OMP                    | Persistent multi-language kernels with broad host capabilities                                              |
| Which implementation best matches this product goal?          | OpenAI Codex           | The plan exists to provide Codex-like Code Mode in an ordinary Pi session                                   |

The intended result is not a line-for-line clone of one project. It combines:

- Codex's external host, V8 cell, `exec`, `wait`, and parent-delegate architecture;
- OpenClaw's policy ordering, catalog lifecycle, limits, transcript projection, and failure discipline;
- OpenCode's explicit capability tree, plain-data crossing, and schema discipline;
- OMP's provider metadata and generated declaration lessons, without its ambient execution authority.

### Deliberate differences from Codex

This plan remains different from current Codex in the following ways:

1. It uses `deno_core` as the V8 embedding layer, while Codex uses `rusty_v8` directly.
2. It requires a documented operating-system process-isolation policy in addition to V8's own sandbox.
3. It is a Pi extension and Pi Factory harness, not a modification to Pi core.
4. It uses a TypeScript parent broker because Pi's public extension API owns tools and session context.
5. It offers separate Codex and Pi modes instead of one fixed nested tool set.
6. It exposes only the selected mode's built-in tools at the root of `tools`, mirrors vanilla Pi's active built-ins in Pi mode, and uses the same executors for equivalent work.
7. It keeps network and credential capabilities out of the default coding profile.
8. It will not depend on Codex binaries, private protocols, source packages, or private provider behavior.

`deno_core` must remain an internal implementation detail. The guest will not receive Deno APIs. If the implementation cannot prevent `deno_core` from expanding the guest authority beyond the frozen tool catalog, the runtime choice fails the acceptance criteria.

---

## Trust model

The design will use four trust levels.

### Generated JavaScript

Generated JavaScript is hostile.

It can use ordinary JavaScript language features, but it receives no direct host capabilities.

### Rust host

The Rust executable is trusted runtime code.

It contains V8 and the protocol implementation, but it receives no credentials and no useful operating-system authority.

### TypeScript tool broker

The broker is trusted policy code.

It owns the allowed tool set, validates every request from the host, and routes each admitted call to the shared workspace, process, media, web, or extension executor.

### Tool implementation

A tool can perform real work.

Each tool remains responsible for its normal validation, sandbox, approval, logging, and cancellation behavior.

A compromised V8 host must not be able to invoke a tool that was not included in the cell's frozen tool set.

---

## Rust workspace layout

```text
runtime/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── crates/
│   ├── protocol/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── framing.rs
│   │       ├── message.rs
│   │       ├── validation.rs
│   │       └── version.rs
│   │
│   ├── host/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── server.rs
│   │       ├── connection.rs
│   │       ├── session.rs
│   │       ├── cell.rs
│   │       ├── cell_actor.rs
│   │       ├── delegate.rs
│   │       ├── limits.rs
│   │       ├── output.rs
│   │       ├── shutdown.rs
│   │       └── error.rs
│   │
│   └── runtime/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── isolate.rs
│           ├── bootstrap.rs
│           ├── ops.rs
│           ├── module_loader.rs
│           ├── tools.rs
│           ├── values.rs
│           ├── timers.rs
│           ├── store.rs
│           └── termination.rs
│
├── tests/
│   ├── protocol.rs
│   ├── runtime.rs
│   ├── limits.rs
│   ├── tool_bridge.rs
│   ├── wait.rs
│   └── hostile_code.rs
│
└── fuzz/
    ├── protocol_frames.rs
    ├── messages.rs
    └── tool_values.rs
```

### Crate responsibilities

`protocol` will contain no V8 or Pi dependencies. It will define the wire format and validation rules.

`runtime` will own one V8 isolate and its JavaScript environment.

`host` will own sessions, cells, process transport, tool delegation, limits, and shutdown.

---

## TypeScript layout

```text
src/
├── core/
│   ├── config.ts
│   ├── limits.ts
│   ├── mode.ts
│   ├── prompt.ts
│   ├── result.ts
│   └── types.ts
│
├── provider/
│   ├── capabilities.ts
│   ├── exec-grammar.ts
│   ├── openai-contract.ts
│   ├── replay.ts
│   └── tool-codec.ts
│
├── host/
│   ├── assets.ts
│   ├── binary.ts
│   ├── client.ts
│   ├── connection.ts
│   ├── framing.ts
│   ├── process.ts
│   ├── protocol.ts
│   ├── session.ts
│   ├── cell.ts
│   └── errors.ts
│
├── broker/
│   ├── broker.ts
│   ├── catalog.ts
│   ├── capability.ts
│   ├── names.ts
│   ├── schema.ts
│   ├── values.ts
│   ├── cancellation.ts
│   ├── replay.ts
│   └── trace.ts
│
├── modes/
│   ├── codex/
│   │   ├── exec-command.ts
│   │   ├── write-stdin.ts
│   │   └── apply-patch.ts
│   ├── pi/
│   │   ├── files.ts
│   │   ├── search.ts
│   │   └── bash.ts
│   └── registration.ts
│
├── sandbox/
│   ├── workspace.ts
│   ├── paths.ts
│   ├── scratch.ts
│   ├── environment.ts
│   ├── process-manager.ts
│   └── policy.ts
│
├── extension/
│   ├── index.ts
│   ├── exec-tool.ts
│   ├── wait-tool.ts
│   ├── lifecycle.ts
│   ├── mode-command.ts
│   ├── session-mode.ts
│   └── rendering.ts
│
├── harness/
│   ├── cli.ts
│   ├── config.ts
│   ├── runtime.ts
│   ├── resource-loader.ts
│   └── index.ts
│
└── index.ts
```

The old `sandbox-worker.ts` and QuickJS-specific files will be removed after the new host passes the complete acceptance suite.

---

## Runtime choice

The host will use:

- Rust;
- `deno_core`;
- V8 through `rusty_v8`;
- Tokio for process and cell coordination;
- Serde for protocol values;
- a pinned Rust toolchain;
- exact dependency versions in `Cargo.lock`.

`deno_core` will provide:

- V8 initialization;
- `JsRuntime`;
- asynchronous Rust operations exposed as JavaScript promises;
- event-loop processing;
- isolate access;
- termination handles;
- heap-limit callbacks;
- structured Rust and V8 value conversion.

The implementation will not include the full Deno runtime.

The following APIs will remain absent:

- `Deno`;
- Node.js globals;
- filesystem APIs;
- `fetch`;
- sockets;
- subprocess APIs;
- environment variables;
- package installation;
- module resolution;
- dynamic imports;
- console output.

---

## V8 initialization

The host will initialize V8 once when the process starts.

The host handshake will not succeed until V8 initialization is complete.

Startup will fail visibly if:

- the V8 platform cannot initialize;
- runtime extensions cannot load;
- required process restrictions cannot be installed;
- the protocol input or output stream is unavailable.

A failed host process will not silently fall back to QuickJS.

---

## Cell model

A cell is one JavaScript program and one V8 isolate.

Each cell owns:

- a unique cell ID;
- its source;
- a frozen tool catalog;
- one V8 isolate;
- pending tool calls;
- buffered output;
- output sequence numbers;
- active limits;
- cancellation state;
- timing statistics;
- a completion result;
- a short terminal-result retention period.

Cells will remain in memory while they are running or yielded.

They will not use V8 heap snapshots.

### Cell states

```text
created
  |
  v
starting
  |
  v
running
  | \
  |  \ explicit yield or initial wait expires
  |   \
  |    v
  |  yielded
  |    |
  |    v
  |  running
  |
  +--> completed
  |
  +--> failed
  |
  +--> terminated
  |
  +--> expired
```

Terminal states cannot return to `running`.

### Cell ownership

Every cell will be bound to:

- one host connection;
- one Code Mode session;
- one Pi session identifier;
- one parent tool-call identifier;
- one frozen tool set.

A request from another session cannot observe or terminate the cell.

---

## JavaScript evaluation

The host will evaluate raw source as a main ES module.

This gives the program top-level `await`.

The runtime will use a module loader that rejects all static and dynamic imports.

Example in Pi mode:

```js
const result = await tools.read({ path: "README.md" });
text(result);
```

The source will not be wrapped in an exposed Node or Deno function.

The host can prepend an internal bootstrap module, but model source and bootstrap source will remain separate for error locations.

Errors will report a stable virtual file name such as:

```text
pi-code-mode:exec-main.mjs
```

---

## Injected JavaScript API

The initial global API will be:

```typescript
declare const tools: Readonly<Record<string, ToolFunction>>;
declare const ALL_TOOLS: ReadonlyArray<ToolMetadata>;

declare function text(value: unknown): void;
declare function notify(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
declare function setTimeout(
  callback: (...args: unknown[]) => void,
  delayMs?: number,
  ...args: unknown[]
): number;
declare function clearTimeout(id: number): void;

declare function store(key: string, value: unknown): void;
declare function load(key: string): unknown;
declare function exit(): never;
```

### Tool function

```typescript
type ToolFunction = (input?: string | Record<string, unknown>) => Promise<unknown>;
```

### Tool metadata

```typescript
type ToolMetadata = {
  name: string;
  description: string;
  input?: string;
  output?: string;
};
```

The runtime will freeze:

- `tools`;
- `ALL_TOOLS`;
- individual tool functions;
- tool metadata entries.

Generated code will not be able to replace a tool binding for later calls.

The selected mode determines the built-in root names.

Codex mode will preserve exact Codex-compatible names:

```text
tools.exec_command
tools.write_stdin
tools.apply_patch
```

Optional Codex-compatible media and web tools can use `tools.view_image`, `tools.web_run`, and `tools.imagegen` after their contracts are implemented.

Pi mode will mirror vanilla Pi's active built-in names at the same root. Vanilla Pi enables this set by default:

```text
tools.read
tools.bash
tools.edit
tools.write
```

Pi's optional built-ins will appear only when Pi has them active:

```text
tools.powershell
tools.grep
tools.find
tools.ls
```

A cell will receive only one mode's built-in set. Codex mode will not install Pi built-ins, and Pi mode will not install Codex built-ins. Both modes will call the same workspace and process code for equivalent work.

---

## Global removals

The bootstrap will remove or disable:

- `console`;
- `WebAssembly`;
- `SharedArrayBuffer`;
- `Atomics`;
- dynamic import;
- host-defined module loading.

The implementation will review whether to keep:

- `eval`;
- `Function`;
- `Intl`;
- `WeakRef`;
- `FinalizationRegistry`.

`eval` and `Function` do not add host capabilities, but they increase dynamic behavior. The default plan is to keep normal JavaScript semantics unless a security test shows a concrete reason to remove them.

---

## Tool naming

Tool paths must become valid and stable JavaScript properties.

The tool definition carries an `sdkPath` such as `["exec_command"]`, `["read"]`, or `["project", "issue.search"]`. The SDK generator builds and freezes the matching object tree for the selected mode.

Bracket access remains available for unusual project and MCP names:

```js
await tools.project["issue.search"]({ query: "sandbox" });
```

Dot access is used for safe identifiers. In Pi mode:

```js
await tools.read({ path: "README.md" });
```

Tool-set construction will:

- reserve the built-in root names for the selected mode;
- include only registrations that allow the selected mode;
- preserve safe ASCII path segments;
- reject empty or dangerous segments;
- reject reserved global names and prototype keys;
- reject collisions between a function and an object path;
- avoid silent suffix generation.

A collision will fail tool-set creation. It will not select a winner by accident.

---

## Deferred tools and `ALL_TOOLS`

Small catalogs can describe all promoted tools directly in the `exec` tool description.

Large catalogs will follow the Codex pattern:

- every allowed tool remains installed on `tools`;
- promoted tools receive compact TypeScript declarations in the `exec` description;
- deferred tools receive no full startup declaration;
- `ALL_TOOLS` lists bounded `name` and `description` metadata for deferred discovery;
- generated code filters `ALL_TOOLS` and then calls the selected method on `tools`.

Example:

```js
const matches = ALL_TOOLS.filter(
  ({ name, description }) => name.includes("search") || description.includes("search"),
);
text(matches);
```

The cutover can keep `ALL_TOOLS` as the first discovery mechanism. A later search capability can add bindings to the next cell for large Pi and MCP catalogs. It must not expand a running cell's frozen authority.

The implementation will use deterministic sorting so the same frozen tool set creates the same declarations and tool paths. Complete input schemas can remain in the parent broker and generated declarations; they do not need to enter model context for deferred tools.

---

## Tool definitions

The TypeScript broker will define:

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

### Invocation context

```typescript
type CodeModeInvocationContext = {
  mode: "codex" | "pi";
  sessionId: string;
  cellId: string;
  parentToolCallId: string;
  nestedToolCallId: string;
  cwd: string;
};
```

The `invoke` callback stays in the parent TypeScript process. The host receives metadata but never receives the callback.

The tool builder first removes definitions that do not allow the session's mode. It then admits read, write, execute, network, and interactive effects only when the matching executor and policy exist. The broker must not enforce read-only access as a substitute for sandboxing. The default production profile admits workspace read, write, patch, and sandboxed execution effects, while network remains disabled.

---

## Frozen tool sets

The broker will freeze a cell’s tools before source execution begins.

A host request will be valid only when:

- the host connection is current;
- the session is active;
- the cell is active;
- the nested call ID is new;
- the requested tool is in the frozen tool set;
- the input passes schema validation;
- the call limit has not been reached;
- the cell has not expired or been cancelled.

Changing registered project tools during a cell will not expand that cell’s authority.

A later `exec` call can receive a new tool set for the same session mode. It cannot switch the session between Codex mode and Pi mode.

---

## Workspace and process sandbox

Side effects will not run inside the Deno Core host. The TypeScript broker routes them to one shared workspace and process sandbox used by both mode builders and registered tools.

### Writable roots

The production coding profile exposes two writable roots:

- the selected workspace;
- one private scratch directory mapped as `/tmp` for the Pi session.

The real system `/tmp` and real home directory remain unavailable. Scratch storage is bounded and removed during session shutdown.

Path operations must reject parent traversal, symlink and junction escapes, magic links, device paths, and validation-to-use races. Writes and edits use atomic replacement where possible and Pi's file-mutation queue for operations on the same path.

### Process manager

Codex `exec_command`, Pi `bash`, and Pi `powershell` use one process manager. It supports foreground commands, yielded background handles, output polling, standard-input writes, waiting, termination, and complete process-tree cleanup.

Only the Codex contract exposes background command handles and `write_stdin`. Pi's shell tools preserve vanilla Pi's input, output, timeout, and cancellation contract. Pi Code Mode will not add Codex process-control fields or results to a Pi tool.

Process handles belong to one Pi session and expire after completion or cleanup. The process manager bounds command count, child count, memory, runtime, idle time, input, and retained output.

The outer `wait` tool observes a V8 cell. Nested `exec_command` and `write_stdin` calls control Codex command processes. Their identifiers and state machines must not be interchangeable.

### Command environment

Each command receives a new environment built from an allowlist. Nested commands must not inherit provider keys, tokens, SSH or GPG agents, credential-helper sockets, cloud configuration, package-registry credentials, Pi session variables, restart controls, or the user's real home path.

The command uses a private home directory and the session scratch directory. Pi's shell session-environment injection is disabled for nested commands.

### Network

Network access is disabled in the default coding profile. A future network capability must define destination policy, DNS behavior, credentials, observability, and tests before admission. V8 will never receive an ambient network API.

---

## Nested tool protocol

A generated call in Pi mode:

```js
const result = await tools.read({ path: "README.md" });
```

will create a host-to-client request:

```json
{
  "type": "request",
  "id": "h:41",
  "method": "tool/invoke",
  "params": {
    "sessionId": "session-1",
    "cellId": "cell-7",
    "callId": "call-12",
    "tool": "read",
    "input": {
      "path": "README.md"
    }
  }
}
```

The TypeScript client will reply:

```json
{
  "type": "response",
  "id": "h:41",
  "ok": true,
  "result": {
    "value": "file contents"
  }
}
```

A tool error will use:

```json
{
  "type": "response",
  "id": "h:41",
  "ok": false,
  "error": {
    "code": "tool_failed",
    "message": "path is outside the working directory"
  }
}
```

The V8 promise will reject with a plain JavaScript `Error`.

Host stack objects and TypeScript error instances will never cross the protocol.

---

## Parallel calls

The runtime must support:

```js
const [a, b] = await Promise.all([tools.read({ path: "a.txt" }), tools.read({ path: "b.txt" })]);
```

Each call will get a unique call ID.

Results can resolve in any order.

The V8 promise associated with each call must receive only its own result.

Limits will apply to:

- total calls;
- concurrent calls;
- total input bytes;
- total result bytes;
- call duration;
- complete cell duration.

Cancellation of the cell will cancel all pending parent calls.

One tool failure will reject only that tool promise unless the JavaScript program leaves the error uncaught.

---

## Output model

`text(value)` will:

- return strings directly;
- serialize other JSON-compatible values;
- reject unsupported values with a clear error;
- append output in call order;
- enforce a cumulative byte limit.

`text(value)` will be the only general model-output helper in the first release. Structured values will be serialized by `text()` according to the documented Codex-shaped contract.

`notify(value)` will publish an intermediate bounded output event.

A bare JavaScript return value will not automatically become model output. This prevents accidental output of large intermediate values.

If the program completes with no explicit output, the tool result will say:

```text
Program completed with no output.
```

---

## `exec` interface

The OpenAI model-facing input is raw JavaScript source. It is sent as a freeform custom-tool call, not as JSON.

Pi's internal tool callback uses this normalized representation:

```typescript
type InternalExecInput = {
  code: string;
};
```

Execution options come from the optional first-line `// @exec:` pragma and package hard limits. They are not additional model-facing JSON fields.

The OpenAI adapter maps raw source to `InternalExecInput.code`. The host protocol receives source, normalized yield time, and normalized output limits. It does not know whether the original provider call was freeform or structured.

If the selected provider cannot serialize the freeform grammar tool, the extension reports that OpenAI Code Mode transport is unavailable. It does not use a function-tool fallback.

### Execution flow

1. Validate source and options.
2. Resolve the current working directory.
3. Freeze the nested tool catalog.
4. Ensure the host process is ready.
5. Open or reuse the Code Mode session.
6. Send `cell/exec`.
7. Wait for completion, failure, explicit yield, or initial yield deadline.
8. Return the current output and status.
9. Keep the cell only when the status is `waiting`.
10. Dispose all terminal cell state after bounded result retention.

### Result

```typescript
type ExecResult =
  | {
      status: "completed";
      output: CodeModeOutput[];
      stats: CodeModeStats;
    }
  | {
      status: "waiting";
      cellId: string;
      reason: "yield" | "pending_tools" | "initial_deadline";
      output: CodeModeOutput[];
      pendingCalls: PendingCallSummary[];
      stats: CodeModeStats;
    }
  | {
      status: "failed";
      error: string;
      code: CodeModeErrorCode;
      output: CodeModeOutput[];
      stats: CodeModeStats;
    };
```

---

## `wait` interface

The OpenAI model-facing function input is:

```typescript
type WaitInput = {
  cell_id: string;
  yield_time_ms?: number;
  max_tokens?: number;
  terminate?: boolean;
};
```

The extension will normalize these fields to internal camel-case names. `cell_id` is required. Unknown fields are rejected. `wait` will not accept JavaScript source.

It will observe the existing cell.

### Wait behavior

If the cell completes during the wait period, `wait` returns `completed`.

If it fails, `wait` returns `failed`.

If it remains active, `wait` returns `waiting` with the same `cell_id` in its model-visible result.

If `terminate` is true, the host terminates the isolate and returns `terminated`.

The TypeScript client will track the last delivered output sequence. Each `wait` returns only new output.

Only one `wait` request can be active for a cell at one time.

---

## Live cells instead of snapshots

The first production version will keep yielded V8 isolates alive.

It will not serialize V8 heap state.

Reasons:

- V8 does not offer a stable portable continuation format;
- heap state can depend on the exact V8 build;
- opaque snapshots complicate upgrades;
- snapshots complicate crash recovery;
- snapshot validation creates another untrusted binary input;
- local Pi sessions need only a small number of active cells.

Memory will be controlled with:

- a low active-cell limit;
- per-isolate heap limits;
- cell TTL;
- session TTL;
- host RSS monitoring;
- explicit termination;
- host replacement after unhealthy memory growth.

Snapshot or hibernation work will require separate evidence that live-cell memory is a real problem.

---

## Session store

`store()` and `load()` will use a host-owned JSON map.

Limits will apply to:

- key length;
- key count;
- value size;
- total store size.

The store will last only for one Code Mode session.

It will not be written to disk.

It will not contain credentials.

When the host process exits, the store disappears.

---

## Timers

The runtime will provide controlled timers.

Timers will:

- use host time;
- count against the cell wall-clock deadline;
- stop when the cell terminates;
- have a maximum delay;
- have a maximum active timer count.

A timer alone will not keep a completed program alive unless the program awaits work tied to it.

---

## Protocol framing

Transport will use:

```text
4-byte little-endian unsigned payload length
UTF-8 JSON payload
```

The protocol will reject:

- oversized frames;
- invalid UTF-8;
- invalid JSON;
- unknown message types;
- missing required fields;
- duplicate active request IDs;
- responses for unknown requests;
- requests after shutdown;
- invalid state transitions.

The default maximum frame will be 16 MiB.

Binary output will use references or base64 only when the output contract explicitly permits it. Large binary data must not pass through ordinary JSON messages.

---

## Handshake

Client message:

```json
{
  "type": "client_hello",
  "protocolVersions": [1],
  "client": {
    "name": "pi-code-mode",
    "version": "0.2.0"
  },
  "capabilities": {
    "images": false,
    "notifications": true,
    "sessionStore": true
  }
}
```

Host response:

```json
{
  "type": "host_hello",
  "protocolVersion": 1,
  "host": {
    "name": "pi-code-mode-host",
    "version": "0.2.0",
    "runtime": "deno_core",
    "v8": "exact-version"
  },
  "capabilities": {
    "wait": true,
    "images": false,
    "notifications": true,
    "sessionStore": true
  }
}
```

If no common protocol version exists, both sides stop.

The client will never guess that an incompatible host is usable.

---

## Protocol methods

### Client to host

```text
session/open
session/close
cell/exec
cell/wait
cell/terminate
cell/status
host/shutdown
```

### Host to client

```text
tool/invoke
tool/cancel
```

### Host events

```text
cell/output
cell/state
cell/metrics
host/warning
host/fatal
```

Every method will have a schema in Rust and TypeScript.

Protocol fixtures will prove that both implementations encode the same messages.

---

## Request IDs

Client-originated request IDs will use:

```text
c:<integer>
```

Host-originated request IDs will use:

```text
h:<integer>
```

This prevents collisions in the bidirectional protocol.

Cell IDs and session IDs will be random UUIDs generated by the host.

The client will treat IDs as opaque strings.

Recent completed request IDs will remain in bounded tombstone sets to detect accidental reuse without unbounded memory growth.

---

## Error taxonomy

```typescript
type CodeModeErrorCode =
  | "invalid_input"
  | "protocol_error"
  | "runtime_unavailable"
  | "runtime_crashed"
  | "execution_failed"
  | "execution_terminated"
  | "aborted"
  | "cpu_limit_exceeded"
  | "wall_time_exceeded"
  | "memory_limit_exceeded"
  | "stack_limit_exceeded"
  | "source_limit_exceeded"
  | "tool_call_limit_exceeded"
  | "output_limit_exceeded"
  | "session_expired"
  | "cell_expired"
  | "cell_not_found"
  | "cell_scope_mismatch"
  | "wait_already_active"
  | "tool_not_allowed"
  | "tool_input_invalid"
  | "tool_failed"
  | "internal_error";
```

The model will receive short actionable messages.

Detailed host diagnostics will remain in bounded local logs and must not include secrets.

---

## Initial limits

The first implementation will use conservative defaults.

| Limit                          | Initial value |
| ------------------------------ | ------------: |
| Source                         |        64 KiB |
| V8 heap per cell               |        64 MiB |
| V8 thread stack                |         2 MiB |
| Active cells per session       |             4 |
| Active cells per host          |             8 |
| Tool calls per cell            |            64 |
| Concurrent tool calls per cell |             8 |
| Input per nested call          |       256 KiB |
| Result per nested call         |         1 MiB |
| Total nested result data       |         8 MiB |
| Model output                   |       128 KiB |
| Session store                  |         1 MiB |
| Initial yield time             |    10 seconds |
| Active JavaScript CPU          |     5 seconds |
| Complete cell wall time        |     5 minutes |
| Yielded cell TTL               |    15 minutes |
| Terminal result retention      |    60 seconds |
| Protocol frame                 |        16 MiB |
| Host shutdown grace            |     5 seconds |

These values are starting limits, not performance claims.

Benchmarks and compatibility tests must justify later increases.

---

## CPU and wall-clock accounting

The host must distinguish active JavaScript time from time spent waiting for tools.

The active CPU budget should not be consumed while the isolate is waiting on a parent tool result.

The complete wall-clock budget continues across:

- JavaScript execution;
- tool waits;
- user approval waits;
- yielded periods;
- repeated `wait` calls.

The host will use an isolate termination handle for active execution.

The TypeScript parent will use a separate watchdog. If the host does not acknowledge termination within a short grace period, the parent kills and replaces the host process.

A host replacement fails all cells owned by that host.

---

## Memory controls

Each isolate will receive explicit V8 heap limits.

The host will use a near-heap-limit callback that terminates the cell instead of allowing V8 to crash the process.

The host process will monitor total resident memory.

If process memory crosses a hard ceiling:

1. reject new cells;
2. terminate expired or unhealthy cells;
3. report a host warning;
4. restart the host when memory does not return below the safe threshold.

The client will not silently retry a program after a possible side effect.

---

## Cancellation

Pi’s tool abort signal will propagate through all layers.

```text
Pi AbortSignal
  -> TypeScript client request cancellation
  -> host cell termination
  -> pending capability cancellation
  -> sandboxed command process-group termination
  -> V8 isolate termination
```

Cancellation must be idempotent.

A cancelled tool result must not enter a terminated isolate.

A late host response must be ignored and recorded only as bounded diagnostic information.

---

## Side-effect policy

There will be no approval prompt for JavaScript source and no blanket approval gate before each normal workspace action. The production coding profile admits bounded reads, writes, patches, and sandboxed commands automatically.

Each operation still passes through its capability executor, schema, workspace policy, process policy, cancellation path, replay rule, and trace. Network, credential, and interactive capabilities require their own explicit contracts before catalog admission.

An interactive capability can ask the user through Pi when consent is part of that capability. Approval of one call does not approve later calls automatically.

The V8 host has no authority to grant access, approval, or policy exceptions.

---

## OS process isolation

The host process will start with:

- no inherited credentials;
- a minimal environment;
- closed unrelated file descriptors;
- no shell;
- a fixed executable path;
- bounded stdin, stdout, and stderr;
- an unprivileged identity where supported.

### Linux

The production target will add:

- `no_new_privs`;
- a seccomp syscall policy;
- Landlock filesystem restrictions where supported;
- no network namespace access where practical;
- process and memory limits.

### macOS

The production target will investigate:

- a Seatbelt profile where supported;
- reduced inherited file descriptors;
- process resource limits;
- no network and file access through the host API.

The plan will not rely on undocumented private APIs without a separate decision.

### Windows

The production target will add:

- a Job Object;
- a restricted token;
- process and memory limits;
- child-process prevention;
- network restrictions where available.

A platform without the required production restriction will be marked unsupported rather than silently run with a weaker claim.

---

## Host logging

Standard output is protocol-only.

The host must never write prose logs to stdout.

Standard error can contain bounded diagnostics.

Default logs must not include:

- generated source;
- tool inputs;
- tool results;
- environment variables;
- credentials;
- complete filesystem paths.

Debug source logging will require an explicit local option and a clear warning.

---

## Tool traces

Nested calls should remain inspectable without flooding model context.

The TypeScript broker will collect bounded trace records:

```typescript
type NestedToolTrace = {
  mode: "codex" | "pi";
  callId: string;
  tool: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  durationMs?: number;
  inputBytes: number;
  resultBytes?: number;
  errorCode?: string;
};
```

Tool results shown to the model will include only the output selected by JavaScript.

Pi UI details can show nested traces when expanded.

No secret input or full output will be added to trace metadata.

---

## Pi extension behavior

The extension will register:

- `exec` with the one-string internal schema and OpenAI Lark grammar `constrainedSampling` metadata;
- `wait` as the documented OpenAI-shaped function tool.

Before activation, it will verify that the selected OpenAI Responses-family model configuration advertises grammar custom-tool support. This is a capability check, not a model-name check.

On session start, it will resolve one mode from the session entry, shared config, or default. For a new Pi-mode session, it will snapshot the active vanilla Pi built-ins before hiding the top-level tool set. It will record the mode, contract version, and Pi built-in names, then build only that mode's nested tools and prompt. A resumed or branched session will keep its recorded mode and Pi built-in set.

The extension will register `/code-mode`. Before the first model message, the command can set the session mode. After model messages exist, it will save the new default and offer a new session instead of changing the current tool contract.

The extension will then save the previous active tool names and activate only:

```text
exec
wait
```

Before each model turn, it will enforce the same tool list.

On shutdown or reload, it will:

1. terminate active cells;
2. close the Code Mode session;
3. stop the host when no session uses it;
4. restore the previous active tool list.

The lifecycle must be idempotent.

---

## Pi Factory harness

The standalone executable will continue to use Pi’s standard interactive mode.

It will preserve:

- editor behavior;
- transcript;
- model selection;
- thinking selection;
- themes;
- keyboard controls;
- slash commands;
- session history.

It will disable discovered resources that can change the Code Mode contract unless explicitly enabled by the harness.

The harness will create and own:

- the Code Mode host client;
- the broker;
- the mode-specific system prompt;
- the model-visible `exec` and `wait` tools;
- separate Code Mode settings and session storage.

The harness will read the shared config, accept `--mode codex` and `--mode pi`, and use command line, saved config, then `codex` as the selection order. It will record the resolved mode for the Pi session. `--save-config` will save the command-line selection; without it, the override applies only to the current run.

It will not implement a custom REPL.

---

## Pi public API limitation

Pi’s documented `getAllTools()` returns metadata, but it does not return execution callbacks.

Therefore, a drop-in extension cannot safely wrap and invoke every arbitrary installed Pi tool through public API alone.

Pi does expose documented grammar-tool metadata through `constrainedSampling`, and OpenAI Responses model definitions can advertise `supportsOpenAIGrammarTools`. The extension will use those public contracts for raw `exec` calls. It will not patch provider payloads when the stock provider path is sufficient.

A complete provider override through `pi.registerProvider()` is allowed only for a separately scoped transport adapter. The first release will not override OpenAI account handling, authentication, retry behavior, or unrelated request fields.

The implementation will follow these boundaries.

### Pi mode built-in tools

Vanilla Pi ships `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. A normal session enables `read`, `bash`, `edit`, and `write` by default. `powershell`, `grep`, `find`, and `ls` are optional built-ins selected through Pi's settings or explicit tool allowlist.

Before the extension replaces the provider-visible tools with `exec` and `wait`, it will snapshot `pi.getActiveTools()` and inspect `pi.getAllTools()` metadata. The Factory harness will take the same snapshot from its own Pi session. The Pi mode builder will include only recognized vanilla built-ins that were active in that snapshot.

It will create those tools through the documented read, bash, PowerShell, edit, write, grep, find, and `ls` factories. Secure custom operations will replace a default operation only when the standard operation would exceed the Code Mode workspace or process policy. Names, inputs, results, errors, truncation, cancellation, and prompt guidance will remain compatible with vanilla Pi.

An extension can override a built-in name, but public metadata does not provide the override's execution callback. When `sourceInfo` shows that an active built-in name belongs to an extension, Pi Code Mode will not silently create the vanilla implementation under that name. The extension must use explicit Code Mode registration.

The Pi mode builder does not install Codex built-ins. Equivalent work in Codex and Pi modes uses the same workspace or process executor, but each mode keeps its own observable tool contract.

### Explicit extension registration

A cooperating extension can register a nested tool through a documented Code Mode handshake on Pi's public extension event bus. The registration carries the tool definition, its allowed `codex` and/or `pi` modes, and its execution callback.

Registration happens during session startup. The tool builder first removes registrations that do not allow the session's mode. It then validates, sorts, and freezes the accepted tools before the first model turn. Late registration can affect only a later tool-set generation in the same mode and never a running cell.

Interactive registrations are serialized. Invalid effects, schemas, SDK paths, collisions, or callbacks fail registration visibly.

### Missing generic invocation API

Automatic wrapping of every active Pi tool would require a documented API similar to:

```typescript
pi.invokeTool(name, input, context, signal);
```

The project will not use Pi internals to simulate this API. Tools that do not opt into the Code Mode registration contract remain unavailable inside `exec`.

---

## Prompt contract

The model-facing `exec` description will state:

- input is raw JavaScript source, not JSON, a quoted string, or a Markdown fence;
- source runs as an asynchronous module in a fresh restricted V8 isolate;
- the active mode is `codex` or `pi`;
- Codex mode uses exact Codex-compatible root names on `tools`;
- Pi mode uses the exact active vanilla Pi built-in names at the root of `tools`;
- the other mode's built-in tools are absent;
- project and deferred tools are described through stable SDK paths and `ALL_TOOLS`;
- tool calls must be awaited;
- intermediate values stay in the program;
- `text()` produces output;
- a first-line `// @exec:` pragma can set bounded yield and output options;
- `wait` applies only to a returned `cell_id`;
- direct filesystem, shell, network, module, environment, Node, and Deno access is unavailable;
- workspace effects use brokered tools and the shared sandbox;
- loops and retries must remain bounded.

The description will include deterministic TypeScript declarations for promoted nested tools and bounded discovery guidance for deferred tools in `ALL_TOOLS`.

The package will keep one canonical OpenAI tool-description fixture. Tests will fail when the public `exec` or `wait` contract changes unintentionally.

The prompt will not mention a model name or claim that JavaScript can access a capability that the broker did not provide.

---

## Package distribution

The Rust host must ship as a pinned prebuilt artifact.

Supported targets should initially be:

```text
x86_64-unknown-linux-gnu
aarch64-unknown-linux-gnu
x86_64-apple-darwin
aarch64-apple-darwin
x86_64-pc-windows-msvc
aarch64-pc-windows-msvc
```

Each artifact will include:

- exact version;
- protocol version;
- SHA-256 checksum;
- build target;
- source commit;
- dependency lock;
- signature or Sigstore record where supported.

The TypeScript client will verify the checksum before execution.

### Development resolution

Development can use:

```text
PI_CODE_MODE_HOST_PATH=/absolute/path/to/pi-code-mode-host
```

This option is for trusted local development only.

### Release resolution

The project must select one production distribution method before publishing:

1. platform-specific optional npm packages;
2. signed GitHub release assets installed by an explicit command;
3. one large npm package containing all target binaries.

The preferred production choice is platform-specific optional npm packages because installation remains package-manager controlled and does not download executable code at first launch.

Creating those packages is a separate remote-resource action and requires confirmation of package names and publishing authority.

There will be no source compilation during normal user installation.

---

## Build scripts

Root package scripts should include:

```json
{
  "build": "npm run build:ts && npm run build:host",
  "build:ts": "tsc --project tsconfig.build.json",
  "build:host": "cargo build --manifest-path runtime/Cargo.toml --release",
  "check:host": "cargo fmt --check --manifest-path runtime/Cargo.toml && cargo clippy --manifest-path runtime/Cargo.toml --all-targets --all-features -- -D warnings && cargo test --manifest-path runtime/Cargo.toml",
  "check:ts": "npm run format && npm run lint && npm run typecheck && npm run test",
  "check": "npm run check:ts && npm run check:host && npm run integration"
}
```

Release builds will use a separate matrix workflow rather than assuming the local machine can cross-compile V8 targets.

---

## Continuous integration

CI will run separate jobs for:

- TypeScript format, lint, type checks, tests, and coverage;
- Rust format, Clippy, tests, and audit;
- protocol fixture comparison;
- Linux integration tests with a real host process;
- sandbox boundary tests;
- package-content validation;
- release artifact matrix;
- platform smoke tests.

Release jobs must build from an exact tag and commit.

Artifacts from one commit cannot be attached to another release.

---

## Rust quality gates

The Rust workspace will use:

- `cargo fmt`;
- `cargo clippy -- -D warnings`;
- `cargo test`;
- `cargo audit`;
- `cargo deny`;
- locked dependency builds;
- protocol fuzzing;
- unsafe-code review.

Any required `unsafe` block must have a local safety comment and test coverage for its boundary.

The project should deny unsafe code in its own crates where `deno_core` integration does not require it.

---

## Protocol tests

The protocol crate and TypeScript client will share JSON fixture files.

Fixtures will cover:

- successful handshake;
- incompatible versions;
- session open and close;
- completed exec;
- yielded exec;
- wait completion;
- termination;
- tool success;
- tool failure;
- malformed frames;
- duplicate IDs;
- unknown cells;
- scope mismatch;
- oversized values;
- shutdown during a call.

Rust and TypeScript must both parse and emit the same fixture shapes.

---

## Runtime tests

Runtime tests will prove:

- top-level `await` works;
- sequential tool calls work;
- dependent calls work;
- parallel calls work;
- caught tool errors work;
- uncaught tool errors fail the cell;
- repeated `text()` calls preserve order;
- bare values do not become output;
- session store survives between cells;
- isolate globals do not survive between cells;
- imports fail;
- Node globals are absent;
- Deno globals are absent;
- direct filesystem access is absent;
- direct network access is absent;
- subprocess access is absent;
- environment access is absent.

---

## Limit tests

Tests will cover:

- empty source;
- oversized source;
- infinite loop;
- excessive allocation;
- deep recursion;
- excessive output;
- excessive store data;
- excessive tool calls;
- excessive concurrent calls;
- oversized tool input;
- oversized tool result;
- expired cell;
- expired session;
- host RSS ceiling;
- parent watchdog termination.

Every failure must have a stable error code.

---

## `wait` tests

Tests will prove:

- initial yield returns a cell ID;
- explicit `yield_control()` returns a cell ID;
- pending tool work returns `waiting`;
- `wait` returns only new output;
- repeated `wait` can observe the same cell;
- final `wait` returns completion;
- terminal output is not duplicated;
- concurrent waits are rejected;
- wrong-session waits are rejected;
- termination stops pending work;
- late tool results do not revive a cell;
- expired cells cannot be resumed;
- a host crash fails the cell visibly.

---

## Tool broker tests

Tests will prove:

- only frozen tools are callable;
- guessed tool names fail;
- catalog name collisions fail;
- schema-invalid input never reaches a tool;
- cancellation reaches the tool;
- tool errors become plain JavaScript errors;
- result values stay JSON-safe;
- credentials are not exposed;
- sensitive paths remain blocked;
- side-effect policy is applied per call;
- parallel calls keep results matched to the correct promises.

---

## Hostile-code tests

The suite will include attempts to access:

```js
globalThis.process;
globalThis.require;
globalThis.Deno;
globalThis.fetch;
globalThis.WebSocket;
globalThis.XMLHttpRequest;
globalThis.WebAssembly;
globalThis.SharedArrayBuffer;
globalThis.Atomics;
```

It will also attempt:

- static imports;
- dynamic imports;
- prototype changes;
- tool-object replacement;
- getter side effects;
- promise storms;
- timer storms;
- recursive stack exhaustion;
- huge strings;
- cyclic outputs;
- BigInt output;
- symbol output;
- malformed Unicode;
- tool-call floods;
- output after termination.

The parent process must remain healthy.

---

## OpenAI contract tests

Provider-contract tests will verify:

- `exec` is serialized as a custom freeform tool with the canonical Lark grammar;
- `exec` has no model-visible JSON parameter schema;
- raw streamed `exec` source maps to the internal `code` property;
- `wait` remains a function tool with `cell_id`, `yield_time_ms`, `max_tokens`, and `terminate`;
- only `exec` and `wait` are sent in the active model tool list;
- incompatible providers fail before the request instead of receiving a JSON-shaped substitute;
- replay emits `custom_tool_call` and `custom_tool_call_output` for `exec`;
- replay emits function call and function output items for `wait`;
- branching and compaction preserve source and call identity;
- switching providers either converts history correctly or fails before sending an invalid request;
- activation behavior is unchanged when test model names change;
- production source contains no model alias allowlist.

Fixtures will be authored for this package's contract. They will not import fixtures or source from Codex or `pi-codex-conversion`.

---

## Integration tests with Pi

Integration tests will start Pi with the built extension or Factory harness and verify:

- only `exec` and `wait` are model-visible;
- the prompt describes the selected mode's actual guest API;
- Codex mode exposes Codex built-ins and no Pi built-ins;
- Pi mode defaults to `read`, `bash`, `edit`, and `write` and exposes no Codex built-ins;
- Pi mode includes `powershell`, `grep`, `find`, and `ls` only when they were active in Pi;
- an extension override of a Pi built-in requires explicit Code Mode registration;
- each mode can inspect and change a harmless fixture;
- each mode can run a sandboxed command;
- Codex mode can control a long-running command through `exec_command` and `write_stdin`;
- Pi mode preserves vanilla Pi's shell-tool contract without Codex-only fields or results;
- a program can call tools in parallel;
- a yielded program can complete through `wait`;
- `--mode` overrides saved config only for the current standalone run unless `--save-config` is present;
- `/code-mode` can select a mode before model messages and does not change an active conversation after model messages;
- resumed and branched sessions keep their recorded mode and Pi built-in set after settings change;
- mode selection does not inspect model names;
- shutdown removes the host process;
- reload does not duplicate tools or host clients;
- the previous active tool list is restored;
- session state contains normal tool calls, results, and one extension-owned contract entry with any Pi built-in names;
- normal Pi remains unchanged outside Code Mode.

---

## Model compatibility suite

A fixed test suite will measure whether a model can use the interface.

Model identifiers belong only in test configuration and result records. Production activation logic will not read this matrix. The matrix must include more than one compatible model when they are available, and adding or removing a test model must require no package code change.

Tasks will include:

1. run the same file-reading task separately in Codex mode and Pi mode;
2. search several files and return only matching names;
3. create and edit a workspace file in each mode;
4. apply a patch in Codex mode and make the equivalent edit in Pi mode;
5. create and clean up a private `/tmp` file;
6. run a command and inspect its output in each mode;
7. start a long Codex command, send input, wait, and terminate;
8. preserve vanilla Pi's shell parameters, results, timeout, and cancellation behavior;
9. reject attempts to call the other mode's built-in names;
10. perform dependent calls;
11. use `Promise.all`;
12. handle one tool failure;
13. reduce large intermediate results;
14. call `yield_control()` and continue with `wait`;
15. avoid forbidden direct APIs and credentials;
16. stop at a bounded result;
17. distinguish a cell ID from a nested process ID.

The suite will save prompts, generated code, raw tool traces, results, and model metadata.

It will not treat one successful result as proof that a model was trained on Code Mode.

---

## Benchmarks

Benchmarks will record:

- host cold-start time;
- host warm-start time;
- first isolate time;
- later isolate time;
- one empty cell;
- one tool call;
- ten sequential tool calls;
- ten parallel tool calls;
- idle cell memory;
- active cell memory;
- termination latency;
- host replacement latency.

A performance optimization will require a minimum worthwhile effect before it increases complexity.

No snapshot implementation will begin from memory estimates alone.

---

## Observability

Each cell result will include bounded statistics:

```typescript
type CodeModeStats = {
  durationMs: number;
  activeJsMs: number;
  toolWaitMs: number;
  toolCalls: number;
  peakConcurrentToolCalls: number;
  inputBytes: number;
  nestedResultBytes: number;
  outputBytes: number;
  heapUsedBytes?: number;
};
```

The model does not need all statistics in its visible result.

Detailed statistics can remain in `details` for tests and UI expansion.

The host will never invent token counts or tokens per second. Those require provider timing and token data outside the host.

---

## Hard cutover

The Deno Core runtime has replaced the old QuickJS runtime. The next cutover replaces the read-only capability contract in place.

The capability cutover will:

- remove the broker rule that rejects non-read effects;
- add explicit `codex` and `pi` modes;
- add the shared config, standalone `--mode` option, `/code-mode` command, and recorded session mode;
- build only the selected mode's built-in tool set for each session;
- add exact Codex core tools at the root of `tools` in Codex mode;
- mirror Pi's active vanilla built-ins at the root of `tools` in Pi mode;
- add the shared workspace and process sandbox;
- add session-scoped `/tmp`;
- add persistent command handles and input;
- add explicit extension tool registration for one or both modes;
- replace read-only prompts, tests, and plan text;
- update the standalone harness and package contents.

There will be no old-catalog flag, parallel `v2`, or read-only compatibility path. The package and executable names stay unchanged.

If the Rust host or required sandbox is unavailable, Code Mode will fail visibly. It will not fall back to an ambient or less capable runtime.

---

## Versioning

The Deno Core cutover established protocol version 1. The capability cutover will keep version 1 when existing tool metadata and invocation messages can represent the new catalog safely.

A wire-format change that cannot preserve protocol version 1 requires an explicit protocol change and matching client update. Package version, host version, and protocol version remain separate values. The release version will follow the repository's semantic-versioning policy after the final implementation scope is known.

---

## Implementation phases

The Deno Core host, versioned protocol, `exec`, `wait`, Pi extension, standalone harness, Linux host sandbox, and initial release artifacts are complete. The remaining phases replace the read-only capability contract.

### Phase 1: Freeze the two mode contracts

Deliver:

- exact Codex core request and result fixtures;
- exact Pi built-in request and result fixtures;
- Pi's default and optional built-in selection rules;
- root tool names for each mode;
- a mode-aware tool definition;
- reserved names and collision rules for each mode;
- workspace and scratch path rules;
- command and process state machines;
- trace and error shapes;
- explicit extension registration contract with allowed modes.

Exit criteria:

- every Codex core call and process state is defined;
- every Pi built-in call is defined;
- Pi mode defaults to `read`, `bash`, `edit`, and `write`;
- optional Pi built-ins appear only when active in Pi;
- one session cannot receive both built-in sets;
- equivalent work in both modes maps to one executor;
- no model identity appears in activation logic or compatibility criteria;
- no read-only or mixed compatibility path remains in the plan.

### Phase 2: Add mode selection and session state

Deliver:

- the shared config path and schema;
- `codex` and `pi` value validation;
- `codex` as the documented default;
- standalone `--mode` and `--save-config` handling;
- the direct Pi `/code-mode` command;
- a snapshot of active Pi built-ins before activating `exec` and `wait`;
- the extension-owned session contract entry with mode and any Pi built-in names;
- separate prompt and declaration builders for both modes.

Exit criteria:

- standalone precedence is command line, saved config, then default;
- direct Pi uses the saved mode but keeps Pi's active provider, model, credentials, and built-in selection;
- the standalone harness applies its own Pi settings to the same built-in selection rules;
- resumed and branched sessions keep their recorded mode and Pi built-in set;
- an active conversation cannot change mode in place;
- mode selection never reads a model name.

### Phase 3: Build the workspace sandbox

Deliver:

- workspace and session scratch roots;
- `/tmp` mapping;
- symlink-safe and race-safe path operations;
- atomic writes and edits;
- patch application;
- Pi file-mutation queue integration;
- scratch quotas and cleanup.

Exit criteria:

- normal create, read, edit, patch, rename, and cleanup cases pass;
- traversal, symlink, magic-link, device, and race attacks fail;
- no path outside the workspace or private scratch root can be changed.

### Phase 4: Build the process manager

Deliver:

- a sandboxed command launcher;
- a sanitized allowlisted environment;
- private home and scratch paths;
- foreground and background command states;
- bounded output polling;
- standard-input writes;
- wait, terminate, timeout, and process-tree cleanup;
- process, memory, output, and lifetime limits.

Exit criteria:

- harmless workspace commands and tests run;
- long commands can yield, receive input, finish, and terminate;
- cancellation and shutdown leave no child process;
- credentials, agents, control sockets, real home files, and default network access remain unavailable.

### Phase 5: Add Codex mode tools

Deliver:

- `tools.exec_command`;
- `tools.write_stdin`;
- `tools.apply_patch`;
- stable output and error conversion;
- command and patch traces;
- replay protection for side effects.

Exit criteria:

- the Codex mode tools pass exact contract fixtures;
- a compatible model can edit and test a fixture project through one JavaScript program;
- no Codex binary, private protocol, or runtime dependency is present.

### Phase 6: Add Pi mode tools

Deliver:

- default `tools.read`, `tools.bash`, `tools.edit`, and `tools.write`;
- optional `tools.powershell`, `tools.grep`, `tools.find`, and `tools.ls` when active in Pi;
- active built-in snapshot and source checks;
- documented Pi factory and operation integration;
- explicit-registration handling for extension overrides.

Exit criteria:

- Pi names, parameters, results, errors, prompt guidance, cancellation, truncation, and mutation queues match vanilla Pi;
- the default and optional built-in selections match Pi settings and explicit allowlists;
- extension overrides are not silently replaced by vanilla implementations;
- Pi mode contains no Codex built-in names;
- Pi shell tools and Codex command execution use the same process manager while keeping different public contracts;
- Pi file tools and Codex patching use the same workspace policy.

### Phase 7: Add explicit extension registration

Deliver:

- a public event-bus handshake;
- required `codex` and/or `pi` mode declarations;
- startup registration, mode filtering, and validation;
- deterministic tool-set generations;
- interactive call serialization;
- bounded deferred metadata in `ALL_TOOLS`.

Exit criteria:

- a cooperating extension can register and execute a nested tool without a private Pi API;
- invalid or colliding registrations fail visibly;
- late registration cannot expand a running cell.

### Phase 8: Add traces and optional tools

Deliver:

- nested progress rendering;
- changed-file summaries;
- command state and exit details;
- bounded diagnostics;
- optional media, web, and MCP adapters only after their contracts and policies are complete.

Exit criteria:

- every side effect is visible in expanded Pi output;
- intermediate data remains outside model context unless JavaScript emits it;
- secrets and unrestricted environments never enter traces.

### Phase 9: Hard cutover

Deliver:

- read-only tool-set restriction removed;
- old read-only declarations removed;
- two mode prompts and declarations made authoritative;
- mode selection enabled in the extension and standalone harness;
- read-only tests replaced;
- docs and package contents updated;
- local installation refreshed.

Exit criteria:

- repository search finds no active read-only product contract;
- complete local and CI checks pass;
- clean installation works;
- multiple compatible models complete both mode-specific suites;
- the old catalog cannot be selected.

---

## Acceptance criteria

The implementation is complete only when all these conditions hold:

1. The provider sees only `exec` and `wait`.
2. A compatible provider sees `exec` as a raw-source custom tool with the canonical Lark grammar.
3. The provider sees `wait` as a function tool with the canonical snake-case fields.
4. Production activation uses provider capabilities and contains no model-name allowlist.
5. `exec` can run arbitrary bounded JavaScript.
6. JavaScript has no direct host capabilities.
7. Nested tools run only through the parent broker.
8. The broker enforces a frozen tool set with stable SDK paths.
9. Every session selects exactly one `codex` or `pi` mode.
10. Codex mode exposes exact Codex built-in names at the root of `tools`.
11. Pi mode mirrors the active vanilla Pi built-ins at the root of `tools`.
12. Pi mode defaults to `read`, `bash`, `edit`, and `write`.
13. Pi mode includes `powershell`, `grep`, `find`, and `ls` only when Pi has them active.
14. An extension override of a Pi built-in requires explicit Code Mode registration.
15. Neither mode exposes the other mode's built-in names.
16. The selected mode and Pi built-in set are recorded and fixed for resumed and branched sessions.
17. The direct extension and standalone command use the shared config path.
18. Standalone mode precedence is command line, saved config, then `codex`.
19. `/code-mode` does not change the contract after model messages exist.
20. Equivalent work in Codex and Pi modes shares one executor while preserving each public contract.
21. Tool schemas are checked before execution.
22. Parallel calls return to the correct promises.
23. Intermediate results can remain inside V8.
24. Output is explicit and bounded.
25. A long cell can yield and complete through `wait`.
26. `wait` never reruns source.
27. Workspace files and session `/tmp` can be created, edited, patched, and read.
28. Codex commands can start, yield, receive input, finish, and terminate.
29. Pi shell tools preserve vanilla Pi's parameters, results, timeout, and cancellation behavior.
30. Commands cannot escape the workspace sandbox or access the real home directory.
31. Nested commands receive no provider key, token, authentication agent, credential socket, or Pi session state.
32. Network is unavailable under the default coding policy.
33. Every nested side effect is visible in bounded Pi traces.
34. Replay cannot duplicate an unsafe completed side effect.
35. A cancelled or expired cell cannot revive.
36. Cancellation and shutdown remove complete command process trees.
37. V8 or command failure cannot crash the Pi process.
38. Infinite loops, memory bombs, oversized frames, and output floods stop.
39. Host or sandbox unavailability fails visibly.
40. No QuickJS, read-only tool set, mixed mode, JSON-function, ambient-execution, or direct-tool fallback exists.
41. No source approval prompt or blanket workspace-action gate exists.
42. OpenAI request and authentication state never enter the host protocol.
43. The extension uses documented Pi APIs only.
44. Third-party Pi tools require explicit registration for one or both modes rather than private callback discovery.
45. The package does not depend on Codex or `pi-codex-conversion` at runtime.
46. The standalone executable remains a regular Pi TUI.
47. Supported artifacts are pinned and verified.
48. Complete TypeScript, Rust, integration, hostile-code, packaging, and CI checks pass.

---

## Known blockers

### OpenAI freeform tool transport

Exact Code Mode activation requires a Pi provider path that advertises OpenAI grammar custom-tool support.

If the selected provider cannot preserve raw `exec` input and custom-tool replay, the extension must stop before the model turn. Provider-name matching or a JSON function fallback is not acceptable.

### Arbitrary Pi tools

Pi metadata does not include execution callbacks, so the extension cannot automatically wrap every installed tool through the current public API.

The production design snapshots active vanilla Pi built-ins, creates those known tools explicitly, and provides an opt-in registration contract for cooperating extensions and overrides. Tools that do not register remain outside Code Mode. A future documented Pi invocation API could broaden this without changing the host protocol.

### Cross-platform OS sandbox

Linux, macOS, and Windows use different isolation mechanisms.

Production support must be proven separately on each platform.

### V8 build cost

`deno_core` and `rusty_v8` make builds large and slow.

Users must receive prebuilt artifacts. CI needs effective caching and exact version pins.

### Host artifact publication

Platform packages or release assets are remote resources.

Their names, ownership, and publication method must be approved before creation.

### Workspace and process sandbox

Automatic JavaScript execution can make many side-effecting calls. Writes and commands cannot enter the production catalog until the shared workspace and process sandbox passes traversal, credential, environment, network, cancellation, process-tree, replay, and cleanup tests.

---

## Deliberately excluded work

The production design will not include:

- VM heap snapshots;
- persistent JavaScript lexical state across host restarts;
- arbitrary imports;
- ambient network, filesystem, subprocess, module, or environment APIs in V8;
- model-name activation rules;
- vendored Codex or `pi-codex-conversion` source;
- a read-only compatibility mode, mixed built-in mode, or parallel API version;
- private Pi API integration;
- automatic wrapping of arbitrary third-party Pi tools;
- a custom terminal UI;
- a standalone REPL;
- hidden retries after possible side effects.

---

## Final architecture decision

The target implementation is:

> A self-contained TypeScript Pi extension and Factory harness with an OpenAI-shaped provider surface, a versioned Rust `deno_core` host, one parent-side tool broker, and one shared workspace and process sandbox. Compatible providers receive raw-source `exec` and structured `wait`; activation uses provider capabilities rather than model names. Each session selects Codex mode or Pi mode, records that choice, and exposes only that mode's built-in tools at the root of `tools`. Pi mode mirrors the active vanilla Pi built-ins and defaults to `read`, `bash`, `edit`, and `write`. Each program runs in a fresh capability-free V8 isolate. Project and third-party tools can register for one or both modes. Equivalent work in both modes uses the same parent-owned executors while preserving each public tool contract. Yielded cells remain live and are observed through `wait`. Workspace writes, private scratch files, patches, and commands are allowed inside the sandbox. Credentials and ambient host APIs remain unavailable. The read-only tool set is removed without a compatibility path.

This design accepts the cost of Rust, V8, and a separate command sandbox in exchange for JavaScript compatibility, exact Codex behavior, Pi integration, visible side effects, and clean isolation. The runtime remains independent of Codex, `pi-codex-conversion`, and other agent harnesses.
