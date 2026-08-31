---
title: Build a Deno Core Code Mode host
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-31
---

# Plan: Deno Core host for Pi Code Mode

> Assumption: “demo core” means `deno_core`.

## Objective

Replace the current QuickJS implementation in `pi-code-mode` with a production Code Mode host built on Rust, `deno_core`, and V8.

The final system will:

- keep Pi’s normal interactive window;
- expose only `exec` and `wait` to the model;
- accept arbitrary JavaScript within a strict capability boundary;
- let JavaScript compose parent-owned tools through `tools`;
- support sequential, conditional, parallel, and repeated tool calls;
- keep intermediate tool results inside V8;
- support yielded cells and later observation through `wait`;
- apply permissions and approvals to each nested operation;
- keep credentials and host APIs outside the JavaScript runtime;
- run the V8 host in a separate disposable process;
- use only documented Pi extension and Pi Factory APIs;
- remove the current QuickJS runtime in one hard cutover.

This is a plan only. No compatibility layer will preserve the old runtime.

---

## Product boundary

The repository will contain two independent parts.

```text
pi-code-mode/
├── TypeScript Pi package
│   ├── extension
│   ├── standalone Pi Factory harness
│   ├── host client
│   ├── tool broker
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
  | await tools.read(...)
  v
Rust host sends tool/invoke
  |
  v
TypeScript tool broker
  |
  | policy, schema, approval, cancellation
  v
parent-owned tool implementation
  |
  | JSON-safe result
  v
V8 promise resolves
```

The host process will never execute shell commands, read project files, access credentials, or make network requests by itself.

Generated JavaScript can request those operations only through the parent-side tool broker.

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

It owns the allowed tool catalog and validates every request from the host.

### Tool implementation

A tool can perform real work.

Each tool remains responsible for its normal validation, sandbox, approval, logging, and cancellation behavior.

A compromised V8 host must not be able to invoke a tool that was not included in the cell’s frozen capability set.

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
│   ├── limits.ts
│   ├── prompt.ts
│   ├── result.ts
│   └── types.ts
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
│   ├── names.ts
│   ├── schema.ts
│   ├── values.ts
│   ├── cancellation.ts
│   ├── trace.ts
│   └── tools/
│       ├── read.ts
│       ├── grep.ts
│       ├── find.ts
│       └── ls.ts
│
├── extension/
│   ├── index.ts
│   ├── exec-tool.ts
│   ├── wait-tool.ts
│   ├── lifecycle.ts
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
- one frozen capability catalog.

A request from another session cannot observe or terminate the cell.

---

## JavaScript evaluation

The host will evaluate raw source as a main ES module.

This gives the program top-level `await`.

The runtime will use a module loader that rejects all static and dynamic imports.

Example:

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
declare function json(value: unknown): void;
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

Tool names must become valid and stable JavaScript property names.

The primary API will always support bracket access:

```js
await tools["mcp__server__tool"]({ value: 1 });
```

Dot access will work when the name is a safe identifier:

```js
await tools.read({ path: "README.md" });
```

Normalization will:

- preserve safe ASCII names;
- replace namespace separators with `__`;
- reject empty names;
- reject reserved global names;
- reject collisions;
- avoid silent suffix generation.

A collision will fail catalog creation. It will not select a winner by accident.

---

## Large tool catalogs

Small catalogs can be described directly in the `exec` tool description.

Large catalogs will use a lazy catalog API.

```typescript
declare const catalog: {
  search(query: string, limit?: number): Promise<ToolMetadata[]>;
  describe(name: string): Promise<ToolDescription>;
};
```

`catalog.search()` and `catalog.describe()` will be internal host operations. They will not count as provider tool calls.

The catalog returned to the model will contain bounded descriptions. Full JSON schemas will be loaded only when needed.

The implementation will use deterministic sorting so the same catalog creates the same prompt and tool names.

---

## Tool descriptors

The TypeScript broker will define:

```typescript
type CodeModeToolDescriptor = {
  name: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  effect: "read" | "write" | "execute" | "network" | "interactive";
  replay: "safe" | "unsafe";
  directOnly?: boolean;
  invoke: (
    input: unknown,
    context: CodeModeInvocationContext,
    signal: AbortSignal
  ) => Promise<unknown>;
};
```

### Invocation context

```typescript
type CodeModeInvocationContext = {
  sessionId: string;
  cellId: string;
  parentToolCallId: string;
  nestedToolCallId: string;
  cwd: string;
};
```

The `invoke` callback stays in the parent TypeScript process.

The host receives metadata but never receives the callback.

---

## Frozen capability sets

The broker will freeze a cell’s tools before source execution begins.

A host request will be valid only when:

- the host connection is current;
- the session is active;
- the cell is active;
- the nested call ID is new;
- the requested tool is in the frozen catalog;
- the input passes schema validation;
- the call limit has not been reached;
- the cell has not expired or been cancelled.

Changing active Pi tools during a cell will not expand that cell’s authority.

A later `exec` call can receive a new catalog.

---

## Nested tool protocol

A generated call:

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
const [a, b] = await Promise.all([
  tools.read({ path: "a.txt" }),
  tools.read({ path: "b.txt" }),
]);
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

`json(value)` will require JSON-compatible data and preserve its structured form.

`notify(value)` will publish an intermediate bounded output event.

A bare JavaScript return value will not automatically become model output. This prevents accidental output of large intermediate values.

If the program completes with no explicit output, the tool result will say:

```text
Program completed with no output.
```

---

## `exec` interface

The generic Pi extension must use an object schema:

```typescript
type ExecInput = {
  code: string;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
};
```

The provider adapter can use freeform JavaScript when a documented provider API supports it.

The host protocol will not depend on either representation.

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

```typescript
type WaitInput = {
  cellId: string;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
  terminate?: boolean;
};
```

`wait` will not accept JavaScript source.

It will observe the existing cell.

### Wait behavior

If the cell completes during the wait period, `wait` returns `completed`.

If it fails, `wait` returns `failed`.

If it remains active, `wait` returns `waiting` with the same `cellId`.

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

| Limit | Initial value |
| --- | ---: |
| Source | 64 KiB |
| V8 heap per cell | 64 MiB |
| V8 thread stack | 2 MiB |
| Active cells per session | 4 |
| Active cells per host | 8 |
| Tool calls per cell | 64 |
| Concurrent tool calls per cell | 8 |
| Input per nested call | 256 KiB |
| Result per nested call | 1 MiB |
| Total nested result data | 8 MiB |
| Model output | 128 KiB |
| Session store | 1 MiB |
| Initial yield time | 10 seconds |
| Active JavaScript CPU | 5 seconds |
| Complete cell wall time | 5 minutes |
| Yielded cell TTL | 15 minutes |
| Terminal result retention | 60 seconds |
| Protocol frame | 16 MiB |
| Host shutdown grace | 5 seconds |

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
  -> pending tool cancellation
  -> V8 isolate termination
```

Cancellation must be idempotent.

A cancelled tool result must not enter a terminated isolate.

A late host response must be ignored and recorded only as bounded diagnostic information.

---

## Approval policy

There will be no approval prompt for the JavaScript source itself.

Nested operations will use their normal action policy.

Examples:

- a read-only file tool can run automatically;
- a write tool can require policy approval;
- shell execution can use the normal command approval path;
- network access can use a domain or tool policy;
- credential access remains unavailable unless a specific tool owns that operation.

Approving one nested call will not approve later calls automatically unless the parent tool policy explicitly provides a bounded rule.

The V8 host has no authority to grant approval.

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

- `exec`;
- `wait`.

On session start, it will save the previous active tool names and activate only:

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
- the fixed system prompt;
- the model-visible `exec` and `wait` tools;
- separate Code Mode settings and session storage.

It will not implement a custom REPL.

---

## Pi public API limitation

Pi’s documented `getAllTools()` returns metadata, but it does not return execution callbacks.

Therefore, a drop-in extension cannot safely wrap and invoke every arbitrary installed Pi tool through public API alone.

The implementation will follow this boundary.

### Extension mode

The extension can expose nested tools that `pi-code-mode` owns.

The first set will remain:

- `read`;
- `grep`;
- `find`;
- `ls`.

Additional capabilities require explicit implementations and security review.

### Standalone Factory mode

The Factory harness can own a larger broker because it controls session construction and tool definitions.

During implementation, the project must verify which built-in tool constructors are public and whether their complete execution callbacks can be supplied to the broker.

### Missing Pi capability

Full wrapping of arbitrary active tools would require a documented API similar to:

```typescript
pi.invokeTool(name, input, context, signal)
```

The project will not use Pi internals to simulate this API.

---

## Prompt contract

The system prompt will state:

- the model has `exec` and `wait`;
- `exec.code` contains JavaScript;
- available capabilities are on `tools`;
- tool calls must be awaited;
- intermediate values stay in the program;
- `text()` or `json()` produces output;
- `wait` applies only to a returned cell ID;
- direct filesystem, shell, network, module, and environment access is unavailable;
- credential requests are forbidden;
- loops and retries must remain bounded.

The prompt will not claim that JavaScript can access a capability that the broker did not provide.

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
- `text()` and `json()` preserve order;
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
globalThis.process
globalThis.require
globalThis.Deno
globalThis.fetch
globalThis.WebSocket
globalThis.XMLHttpRequest
globalThis.WebAssembly
globalThis.SharedArrayBuffer
globalThis.Atomics
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

## Integration tests with Pi

Integration tests will start Pi with the built extension or Factory harness and verify:

- only `exec` and `wait` are model-visible;
- the prompt describes the actual guest API;
- a program can inspect a harmless fixture;
- a program can call tools in parallel;
- a yielded program can complete through `wait`;
- shutdown removes the host process;
- reload does not duplicate tools or host clients;
- the previous active tool list is restored;
- session state contains normal tool calls and results;
- no custom Pi state schema is added;
- normal Pi remains unchanged outside Code Mode.

---

## Model compatibility suite

A fixed test suite will measure whether a model can use the interface.

Tasks will include:

1. read two files and compare them;
2. search several files and return only matching names;
3. perform dependent calls;
4. use `Promise.all`;
5. handle one tool failure;
6. reduce large intermediate results;
7. call `yield_control()` and continue with `wait`;
8. avoid forbidden direct APIs;
9. stop at a bounded result;
10. distinguish a cell ID from a nested process ID.

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

The new runtime will replace the current runtime in place.

The cutover will:

- remove `quickjs-emscripten`;
- delete the old QuickJS worker;
- delete the synchronous host bridge;
- remove old runtime-only tests;
- replace `executeProgram()` internals with the host client;
- add `wait`;
- change results to the new cell-aware union;
- update prompts;
- update the standalone harness;
- update package contents;
- update installation instructions.

There will be no old-runtime flag.

There will be no automatic fallback to the old QuickJS implementation.

If the Rust host is unavailable, Code Mode will fail with `runtime_unavailable`.

---

## Versioning

This is a breaking runtime and API change.

The package should move from `0.1.x` to `0.2.0`.

The protocol will begin at version `1`.

Package version and host version can differ, but the client must declare the exact protocol versions it supports.

A host update that breaks protocol version 1 requires protocol version 2 and an explicit client update.

---

## Implementation phases

### Phase 1: Freeze the contract

Deliver:

- architecture record;
- threat model;
- protocol version 1 schema;
- cell state machine;
- error taxonomy;
- limit table;
- Pi API boundary;
- package distribution decision.

Exit criteria:

- every message type is defined;
- every terminal state is defined;
- arbitrary Pi tool invocation limitation is documented;
- no unresolved compatibility path remains.

### Phase 2: Build protocol libraries

Deliver:

- Rust framing and message crate;
- TypeScript framing and message module;
- shared fixtures;
- handshake;
- subprocess startup and shutdown;
- fake host used by TypeScript tests.

Exit criteria:

- malformed input fails closed;
- Rust and TypeScript pass the same fixtures;
- host process lifecycle has no orphan process.

### Phase 3: Add one-shot V8 execution

Deliver:

- `deno_core` runtime crate;
- V8 startup;
- main module evaluation;
- `text()` and `json()`;
- no module loader;
- CPU, memory, source, and output limits.

Exit criteria:

- safe JavaScript executes;
- forbidden globals are absent;
- infinite loops terminate;
- memory exhaustion does not kill Pi;
- no tools are available yet.

### Phase 4: Add asynchronous tool delegation

Deliver:

- generated `tools`;
- async Rust operation;
- host-to-client `tool/invoke`;
- TypeScript broker;
- schema validation;
- cancellation;
- parallel calls;
- bounded traces.

Exit criteria:

- sequential and parallel calls pass;
- guessed tools fail;
- tool cancellation works;
- tool errors reach JavaScript correctly.

### Phase 5: Add live cells and `wait`

Deliver:

- cell actors;
- initial yield deadline;
- `yield_control()`;
- output cursors;
- `wait`;
- termination;
- TTL cleanup;
- host health monitoring.

Exit criteria:

- a program can yield and finish later;
- output does not repeat;
- wrong-session access fails;
- expired cells are removed;
- no VM snapshots are used.

### Phase 6: Integrate the Pi extension

Deliver:

- `exec`;
- `wait`;
- active tool enforcement;
- prompt updates;
- nested trace rendering;
- session lifecycle;
- shutdown cleanup.

Exit criteria:

- standard Pi exposes only `exec` and `wait`;
- reload is safe;
- no private Pi API is used;
- extension mode retains its documented nested-tool limit.

### Phase 7: Integrate the Pi Factory harness

Deliver:

- host client ownership;
- broker ownership;
- persistent nonsecret config;
- standard InteractiveMode;
- provider and model selection;
- local host development path.

Exit criteria:

- `pi-code-mode` opens a regular Pi window;
- session history remains separate;
- API keys stay in their existing store or memory;
- no custom REPL exists.

### Phase 8: Add OS hardening

Deliver:

- Linux restrictions;
- macOS restrictions or explicit unsupported status;
- Windows restrictions or explicit unsupported status;
- process resource limits;
- host health and replacement behavior.

Exit criteria:

- each supported target passes a real sandbox test;
- unsupported targets fail before model execution;
- documentation does not overstate isolation.

### Phase 9: Build release artifacts

Deliver:

- target matrix;
- checksums;
- signatures;
- platform package or installer;
- protocol metadata;
- clean package manifests;
- release verification.

Exit criteria:

- normal users do not build V8;
- artifact identity is verified before execution;
- each target runs a real Code Mode request.

### Phase 10: Hard cutover

Deliver:

- old runtime removed;
- dependency cleanup;
- new tests authoritative;
- docs updated;
- package version updated;
- global installation refreshed.

Exit criteria:

- repository search finds no old runtime path;
- complete checks pass;
- clean install works;
- one real model completes the compatibility suite;
- the old runtime cannot be selected.

---

## Acceptance criteria

The implementation is complete only when all these conditions hold:

1. The model sees only `exec` and `wait`.
2. `exec` can run arbitrary bounded JavaScript.
3. JavaScript has no direct host capabilities.
4. Nested tools run only through the parent broker.
5. The broker enforces a frozen tool catalog.
6. Tool schemas are checked before execution.
7. Parallel tool calls return to the correct promises.
8. Intermediate results can remain inside V8.
9. Output is explicit and bounded.
10. A long cell can yield and complete through `wait`.
11. `wait` never reruns source.
12. A cancelled or expired cell cannot revive.
13. V8 failure cannot crash the Pi process.
14. Infinite loops stop.
15. Memory bombs stop.
16. Oversized frames stop.
17. Host unavailability fails visibly.
18. No QuickJS fallback exists.
19. No source approval prompt exists.
20. Nested action policy remains active.
21. Credentials never enter the host process.
22. The extension uses documented Pi APIs only.
23. The standalone executable remains a regular Pi TUI.
24. Cross-platform artifacts are pinned and verified.
25. Complete TypeScript and Rust checks pass.

---

## Known blockers

### Arbitrary Pi tools

Pi metadata does not include execution callbacks. The extension cannot wrap arbitrary installed tools through current public API.

This blocks a fully generic drop-in extension.

It does not block the standalone harness or explicitly owned nested tools.

### Cross-platform OS sandbox

Linux, macOS, and Windows use different isolation mechanisms.

Production support must be proven separately on each platform.

### V8 build cost

`deno_core` and `rusty_v8` make builds large and slow.

Users must receive prebuilt artifacts. CI needs effective caching and exact version pins.

### Host artifact publication

Platform packages or release assets are remote resources.

Their names, ownership, and publication method must be approved before creation.

### Tool side effects

Automatic JavaScript execution can make many nested calls.

Every side-effecting capability needs clear parent-side policy before it enters the catalog.

---

## Deliberately excluded work

The first production release will not include:

- VM heap snapshots;
- persistent JavaScript cells across host restarts;
- package installation;
- arbitrary imports;
- direct network access;
- direct filesystem access;
- direct subprocess access;
- environment access;
- a compatibility mode for the old runtime;
- private Pi API integration;
- automatic wrapping of arbitrary third-party Pi tools;
- a custom terminal UI;
- a standalone REPL;
- hidden retries after possible side effects.

---

## Final architecture decision

The target implementation is:

> A TypeScript Pi extension and Factory harness that communicate with a versioned Rust `deno_core` host process. Each program runs in a fresh, capability-free V8 isolate. Nested tools execute only in the TypeScript parent through a frozen broker. Yielded cells remain live and are observed through `wait`. The runtime uses strict process, isolate, tool, output, and lifecycle limits. The current QuickJS implementation is removed without a compatibility path.

This design accepts the cost of Rust and V8 in exchange for JavaScript compatibility, a mature asynchronous host bridge, clean process isolation, and a runtime that does not depend on another agent harness.
