# Pi Code Mode

Pi Code Mode is a Code Mode extension and standalone harness for the Pi coding agent.
It gives a compatible model an OpenAI-shaped `exec` tool for composing read-only file tools in JavaScript.

## Requirements

Pi Code Mode currently requires:

- Linux on x64 or ARM64;
- Node.js 22.19 or later;
- Rust 1.96.1 for installation from source;
- an OpenAI Responses model whose Pi model entry advertises `supportsOpenAIGrammarTools`.

The extension checks the API capability. It does not keep a model-name allowlist.

## Install the Pi extension

Install the package from GitHub:

```sh
pi install git:github.com/osolmaz/pi-code-mode
```

Restart Pi, then start it in the directory that the model may inspect:

```sh
cd ./safe-fixture
pi
```

The extension replaces the active model tools with `exec` and `wait`. Other Pi features stay available.

## Use Code Mode

`exec` accepts raw JavaScript through the OpenAI Lark grammar used for Code Mode custom tools. Do not wrap the program in JSON or a Markdown code block.

A program can call these read-only tools:

```js
const files = await tools.find({ path: ".", pattern: "**/*.ts" });
const matches = await tools.grep({ path: "src", pattern: "registerTool" });
text({ files, matches });
```

The cell also provides:

- `text(value)` to return a result to the model;
- `notify(message)` for a progress message;
- `store(key, value)` and `load(key)` for session-scoped JSON values;
- `yield_control()` to pause until the model calls `wait`;
- bounded `setTimeout` and `clearTimeout` functions;
- `exit()` to finish early;
- `ALL_TOOLS` for frozen tool metadata.

The optional first line can set OpenAI-compatible execution options:

```js
// @exec:{"yield_time_ms":10000,"max_output_tokens":10000}
const files = await tools.find({ path: ".", pattern: "**/*.md" });
text(files);
```

If `exec` returns a waiting cell ID, the model can call `wait` to continue observing it or terminate it.

## Use the standalone Pi window

Install the executable without enabling the extension in every normal Pi session:

```sh
npm install --global git+https://github.com/osolmaz/pi-code-mode.git
```

Save the provider, model, and API-key environment-variable name:

```sh
export OPENAI_API_KEY=<key>
pi-code-mode \
  --provider openai \
  --model <compatible-model> \
  --api-key-env OPENAI_API_KEY \
  --save-config
```

Later runs use the saved nonsecret settings:

```sh
export OPENAI_API_KEY=<key>
cd ./safe-fixture
pi-code-mode
```

`pi-code-mode` opens Pi's standard interactive window. The editor, transcript, selectors, slash commands, session controls, themes, and key bindings work as usual. A positional argument becomes the first message:

```sh
pi-code-mode --cwd ./safe-fixture \
  "Count the lines in every text file and report the total."
```

The config file is `$XDG_CONFIG_HOME/pi-code-mode/config.json`, or `~/.config/pi-code-mode/config.json` when `XDG_CONFIG_HOME` is not set. It stores only `provider`, `model`, and the optional `apiKeyEnv` name. It never stores the key. If `apiKeyEnv` is absent, the harness uses Pi's existing credential store.

The standalone harness keeps its Pi settings and session history under the same `pi-code-mode` config directory. It does not load normal Pi extensions, skills, prompt templates, or project instruction files.

## Isolation and limits

Each cell runs in a separate V8 isolate inside a Rust `deno_core` host process. The host starts with an empty environment. On Linux, Landlock denies direct file and TCP access, and seccomp denies socket creation, program execution, tracing, BPF, user-fault handling, and io_uring setup. The host fails closed if it cannot apply these controls.

The model-written program has no Node.js, Deno, shell, file-system, network, environment, console, WebAssembly, or module globals. It can access the working directory only through the parent process's `read`, `grep`, `find`, and `ls` broker. The broker rejects absolute paths, parent traversal, common credential paths, and symlinks that leave the selected directory.

Source, heap, output, CPU time, wall time, timers, nested calls, nested data, file reads, and directory scans have fixed limits. Use a small, non-sensitive working directory while testing a model.

## License

[MIT](LICENSE)
