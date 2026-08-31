export const CODE_MODE_TOOL_DESCRIPTION = `Execute JavaScript in an isolated V8 cell and compose the available tools from code.

Send raw JavaScript without JSON wrapping or Markdown fences. The source runs as the body of an async function. It has no Node.js, Deno, shell, file-system, network, environment, console, WebAssembly, or module capability.

Available globals:
- tools: frozen async tool functions
- ALL_TOOLS: frozen tool metadata
- text(value): emit useful model-visible output
- notify(message): emit a progress notification
- store(key, value) and load(key): session-scoped JSON values
- yield_control(): pause until a later wait call
- setTimeout(callback, delay) and clearTimeout(id): bounded timers
- exit(): finish early

Available tool functions:
- await tools.read({ path, offset?, limit? })
- await tools.grep({ path?, pattern, caseSensitive?, maxResults? })
- await tools.find({ path?, pattern?, maxResults? })
- await tools.ls({ path?, maxResults? })

Use sequential statements, conditions, loops, Promise.all, filtering, and aggregation when useful. Keep intermediate data inside the cell and call text(value) only with the result needed by the model. If exec returns a cell_id with waiting status, call wait to observe or terminate that cell.`;

export const CODE_MODE_WAIT_DESCRIPTION = `Observe an existing Code Mode cell. Returns only output produced since the previous observation. Use terminate=true to stop it.`;

export const CODE_MODE_SYSTEM_PROMPT = `You are working in Code Mode. The only model-visible tools are exec and wait.

Use exec to inspect the working directory through its read-only tools. Send raw JavaScript, compose tool calls inside the program, and emit the useful result with text(value). Use wait only when exec returns a waiting cell. Do not request shell commands, writes, network access, environment variables, absolute paths, credentials, or unbounded work.`;
