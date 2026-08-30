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

## Use the SDK harness

The separate harness creates an in-memory Pi session with resource discovery disabled and `exec` as its only tool:

```sh
npx pi-code-mode \
  --provider <provider> \
  --model <model> \
  --api-key-env <variable> \
  --cwd ./safe-fixture \
  "Count the lines in every text file and report the total."
```

The optional `--api-key-env` flag loads one named environment variable into an in-memory credential store for the run. The harness does not save that key.

The harness prints each program between source markers and asks `Run this program? [y/N]`. Approval prompts run one at a time. Control characters and backslashes appear as reversible escapes, so source text cannot use terminal controls to hide or replace the prompt. The harness denies execution when standard input is not an interactive terminal. There is no approve-all option.

Use a small, non-sensitive working directory when testing a model. The approval gate and sandbox reduce risk, but the JavaScript engine is not an operating-system security boundary.

## Limits

Each execution uses a fresh QuickJS WebAssembly runtime in a new worker. The default limits cover source size, run time, memory, stack size, tool calls, file reads, recursive scans and final results. Output is bounded inside the worker before transfer to the parent process. Directory entries are read incrementally and stop at scan or result limits. Line offsets can scan past the first read-sized file prefix. The tool returns an explicit error if it cannot reach or return the requested range within its byte limits.

The first release supports `read` and `grep` for text. It also supports `find` and `ls` for paths. It does not support shell commands, writes, edits, network requests, persistent cells, background work, or a `wait` tool.

## License

[MIT](LICENSE)
