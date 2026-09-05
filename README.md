# Pi Code Mode

Pi Code Mode is a Code Mode extension and standalone Pi harness.
It lets a compatible model write JavaScript that reads and changes files, applies patches, runs commands, and combines many tool calls without placing each intermediate result in model context.

## Requirements

Pi Code Mode requires:

- Linux on x64 or ARM64;
- Node.js 22.19 or later;
- Rust 1.96.1 when installing from source;
- an OpenAI Responses model whose Pi model entry advertises `supportsOpenAIGrammarTools`.

The extension checks the API capability. It does not check model names.

## Install the Pi extension

```sh
pi install git:github.com/osolmaz/pi-code-mode
```

Restart Pi and open a workspace:

```sh
cd ./project
pi
```

The extension keeps Pi's normal window and replaces the model-visible tools with `exec` and `wait`. Run `/code-mode` to select `codex` or `pi` mode. The selection applies to a new session and is stored in `~/.config/pi-code-mode/config.json`.

Each session records its mode and tool set. Resuming or branching a session restores that recorded contract.

## Modes

### Codex mode

Codex mode provides these functions inside JavaScript:

- `tools.exec_command` runs a local command and returns output or a numeric session ID;
- `tools.write_stdin` sends input to a running command or polls it;
- `tools.apply_patch` applies a Codex patch as one transaction.

Example:

```js
const inspected = await tools.exec_command({
  cmd: "git status --short && npm test",
  yield_time_ms: 30000,
});

if (inspected.session_id !== undefined) {
  const finished = await tools.write_stdin({
    session_id: inspected.session_id,
    chars: "",
    yield_time_ms: 30000,
  });
  text(finished);
} else {
  text(inspected);
}
```

Patch example:

```js
const result = await tools.apply_patch(`*** Begin Patch
*** Update File: src/example.ts
@@
-export const value = 1;
+export const value = 2;
*** End Patch`);
text(result);
```

### Pi mode

Pi mode mirrors the active vanilla Pi built-ins for that session. A normal session provides:

- `tools.read`;
- `tools.bash`;
- `tools.edit`;
- `tools.write`.

If the matching vanilla Pi built-ins are active when the session starts, Pi Code Mode can also provide `powershell`, `grep`, `find`, and `ls`. Pi mode creates these tools with Pi's public built-in tool factories. It keeps Pi's names, input schemas, result objects, errors, paths, command environment, network access, output handling, and one-shot shell behavior. Codex process-session controls do not appear in Pi mode.

## JavaScript cells

Send raw JavaScript to `exec`. Do not wrap it in JSON or Markdown fences.

The cell provides:

- `tools`, a frozen object with the selected mode's functions;
- `ALL_TOOLS`, frozen tool names and descriptions;
- `text(value)` to return useful output to the model;
- `notify(message)` to report progress;
- `store(key, value)` and `load(key)` for session JSON values;
- `yield_control()` to pause until the model calls `wait`;
- bounded `setTimeout` and `clearTimeout` functions;
- `exit()` to finish early.

The cell has no Node.js, Deno, direct shell, file-system, network, environment, console, WebAssembly, or module globals. All host access goes through `tools`.

You can use normal JavaScript control flow:

```js
const results = await Promise.all([
  tools.read({ path: "README.md" }),
  tools.read({ path: "package.json" }),
]);
text(results);
```

An optional first line can set OpenAI-compatible cell options:

```js
// @exec:{"yield_time_ms":10000,"max_output_tokens":10000}
text(ALL_TOOLS);
```

If `exec` returns a waiting cell ID, call `wait` to observe or stop the cell.

## Standalone Pi window

Install the standalone executable:

```sh
npm install --global git+https://github.com/osolmaz/pi-code-mode.git
```

Save nonsecret settings:

```sh
export OPENAI_API_KEY=<key>
pi-code-mode \
  --provider openai \
  --model <compatible-model> \
  --mode codex \
  --api-key-env OPENAI_API_KEY \
  --save-config
```

Later runs use the saved settings:

```sh
export OPENAI_API_KEY=<key>
cd ./project
pi-code-mode
```

Select a mode for one launch with `--mode codex` or `--mode pi`. A positional argument becomes the first message:

```sh
pi-code-mode --mode pi --cwd ./project "Run the tests and fix the failure."
```

The config file is `$XDG_CONFIG_HOME/pi-code-mode/config.json`, or `~/.config/pi-code-mode/config.json`. It can store `provider`, `model`, `mode`, and the name in `apiKeyEnv`. It never stores an API key. If `apiKeyEnv` is absent, the harness uses Pi's existing credential store.

The standalone harness uses Pi's standard editor, transcript, selectors, slash commands, session controls, themes, and key bindings. It keeps its settings and session history under the `pi-code-mode` config directory. It does not load normal Pi extensions, skills, prompt templates, or project instruction files.

## Permissions

JavaScript runs in a separate Rust `deno_core` and V8 process. Landlock and seccomp keep that host from using files, network sockets, subprocesses, tracing, mounts, namespaces, BPF, user-fault handling, or io_uring directly. All effects still go through the named functions under `tools`.

The nested coding tools use the parent Pi process and calling harness permissions. Pi mode delegates to Pi's built-in tool factories. Codex-mode commands inherit the parent command environment and can use normal filesystem paths, network access, home directory, temporary directory, and background processes. Pi Code Mode does not add a private workspace view, credential-path filter, network block, scratch quota, command memory cap, or session-end cleanup for detached background processes.

This behavior matches normal local coding tools, so a model can reach the same files, network, and credentials that those tools can reach. Use a container, operating-system sandbox, restricted account, or other harness policy when the model must have fewer permissions.

Pi Code Mode records the selected session contract and nested side-effect metadata in the Pi session. It keeps results for unsafe nested call IDs in memory for the active session, so replaying a completed top-level call does not repeat its writes or commands. Active calls still support cancellation, and model-visible output remains bounded.

## Design

[Build full Pi Code Mode](docs/2026-08-31-code-mode-plan.md) describes the product contract, security boundary, and upstream Codex and Pi contracts.

[Compare Pi Code Mode and Codex API requests](docs/2026-09-02-codex-api-request-comparison.md) records a same-model request capture and the differences between the two clients.

## License

[MIT](LICENSE)
