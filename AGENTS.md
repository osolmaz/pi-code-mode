# AGENTS.md

- Use Node.js 22 or later.
- Keep the provider-visible tool surface limited to `exec` and `wait`.
- Support separate `codex` and `pi` modes. Expose only the selected mode's built-in coding tools in each session, and never expose both built-in sets together.
- Make Pi mode mirror vanilla Pi's active built-in selection. Its default tools are `read`, `bash`, `edit`, and `write`; `powershell`, `grep`, `find`, and `ls` appear only when Pi has them active.
- Keep the Deno Core host capability-free. Route filesystem and process effects through the parent broker and shared workspace sandbox.
- Permit writes and commands only inside the selected workspace and session-scoped scratch directory. Keep network access disabled by default.
- Build nested command environments from an allowlist. Never pass provider keys, tokens, authentication agents, control sockets, Pi session variables, or the user's real home directory.
- Use documented Pi APIs only. Third-party Pi tools must register explicitly for one or both modes because public Pi metadata does not include execution callbacks.
- Model-written programs run automatically. Preserve all sandbox, path, credential, process, cancellation, replay, and resource limits.
- Run `npm run check` before a pull request is ready. Also run `npm pack --dry-run` and `npm run slophammer`.
- Add integration tests for every sandbox boundary or capability change.
