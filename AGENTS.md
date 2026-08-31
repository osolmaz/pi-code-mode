# AGENTS.md

- Use Node.js 22 or later.
- Keep the model-visible surface limited to `exec` and `wait` unless the project plan changes.
- Keep nested capabilities read-only and inside the selected working directory.
- Do not add shell, network, environment, module, write, or credential access without explicit approval and a security review.
- Model-written programs run automatically. Preserve all sandbox, path, credential, and resource limits.
- Run `npm run check` before a pull request is ready. Also run `npm pack --dry-run` and `npm run slophammer`.
- Add integration tests for every sandbox boundary or capability change.
