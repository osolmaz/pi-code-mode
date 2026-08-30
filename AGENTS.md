# AGENTS.md

- Use Node.js 22 or later.
- Keep the model-visible surface limited to `exec` unless the project plan changes.
- Keep nested capabilities read-only and inside the selected working directory.
- Do not add shell, network, environment, module, write, or credential access without explicit approval and a security review.
- Require a separate approval for the exact source of every program. Do not add an approve-all path.
- Run `npm run check` before a pull request is ready. Also run `npm pack --dry-run` and `npm run slophammer`.
- Add integration tests for every sandbox boundary or capability change.
