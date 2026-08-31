# Pi Code Mode

Pi Code Mode is a read-only Code Mode extension and SDK harness for the Pi coding agent.
It gives the model one `exec` tool for composing file reads in a sandboxed JavaScript program, then asks a person to approve the exact program before it runs.

## Install

Install the package from GitHub:

```sh
pi install git:github.com/osolmaz/pi-code-mode
```

Restart Pi after installation. The extension disables the other model-visible tools while it is active.

## Use the extension

Start Pi in the directory that the model may inspect:

```sh
pi
```

The model can call only `exec`. Each call shows its full JavaScript source. Select **Yes** only after you have checked the source.

Programs can use these read-only functions:

```js
const files = await tools.find({ path: ".", pattern: "**/*.ts" });
const matches = await tools.grep({ path: "src", pattern: "registerTool" });
text({ files, matches });
```

The sandbox has no Node.js globals, shell, network, environment variables, module loader, or write functions. File tools stay inside the current working directory and reject common credential paths.

## Use the standalone harness

Install the standalone executable from GitHub without enabling the extension in every Pi session:

```sh
npm install --global git+https://github.com/osolmaz/pi-code-mode.git
```

The harness uses Pi's standard interactive TUI and session runtime. It disables discovered extensions, skills, prompt templates, project context files, and all model tools except `exec`. Save its nonsecret user configuration on the first run:

```sh
export OPENAI_API_KEY=<key>
pi-code-mode \
  --provider openai \
  --model gpt-5.4 \
  --api-key-env OPENAI_API_KEY \
  --save-config
```

With no prompt argument, `pi-code-mode` opens a regular Pi window. Pi's editor, transcript, selectors, slash commands, session controls, themes, and keyboard controls work as usual. The Code Mode approval request appears as a Pi confirmation dialog that shows the exact JavaScript source.

Later runs use the saved provider, model, and API-key environment-variable name:

```sh
export OPENAI_API_KEY=<key>
cd ./safe-fixture
pi-code-mode
```

The config is at `$XDG_CONFIG_HOME/pi-code-mode/config.json`, or `~/.config/pi-code-mode/config.json` when `XDG_CONFIG_HOME` is not set. It stores only `provider`, `model`, and the optional `apiKeyEnv` name. It never stores the key. Command-line options override saved values.

The standalone app keeps its Pi settings and session history in the same `pi-code-mode` configuration directory. It does not load or change the normal Pi agent directory. A session records its working directory because Code Mode uses that directory as the active read-only sandbox root.

Pass a prompt argument to submit an initial message when the Pi window opens:

```sh
pi-code-mode --cwd ./safe-fixture \
  "Count the lines in every text file and report the total."
```

Approval requests run one at a time. Control characters and backslashes appear as reversible escapes, so source text cannot use terminal controls to hide or replace the request. The executable requires an interactive terminal. There is no approve-all option.

Use a small, non-sensitive working directory when testing a model. The approval gate and sandbox reduce risk, but the JavaScript engine is not an operating-system security boundary.

## Limits

Each execution uses a fresh QuickJS WebAssembly runtime in a new worker. The default limits cover source size, run time, memory, stack size, tool calls, file reads, recursive scans and final results. Output is bounded inside the worker before transfer to the parent process. Directory entries are read incrementally and stop at scan or result limits. Line offsets can scan past the first read-sized file prefix. The tool returns an explicit error if it cannot reach or return the requested range within its byte limits.

The first release supports `read` and `grep` for text. It also supports `find` and `ls` for paths. It does not support shell commands, writes, edits, network requests, persistent cells, background work, or a `wait` tool.

## License

[MIT](LICENSE)
