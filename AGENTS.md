# AGENTS.md

- Use Node.js 22 or later.
- Keep the provider-visible tool surface limited to `exec` and `wait`.
- Support separate `codex` and `pi` modes. Expose only the selected mode's built-in coding tools in each session, and never expose both built-in sets together.
- Make Pi mode mirror vanilla Pi's active built-in selection. Its default tools are `read`, `bash`, `edit`, and `write`; `powershell`, `grep`, `find`, and `ls` appear only when Pi has them active.
- Keep the Deno Core host capability-free. Route filesystem and process effects through the parent broker.
- Do not add a second permission policy around nested coding tools. Pi mode must use Pi's documented built-in tool factories with their normal filesystem, command, network, environment, process, and lifecycle behavior. Codex mode must provide the same unrestricted local command behavior when the parent Pi process is unrestricted.
- Do not create private workspace or temporary-directory views, credential-path filters, network blocks, command resource caps, or session-end process cleanup that the selected native tool contract does not provide. The parent Pi process, calling harness, container, and operating system own those controls.
- Use documented Pi APIs only. Third-party Pi tools must register explicitly for one or both modes because public Pi metadata does not include execution callbacks.
- Model-written programs run automatically. Preserve Code Mode host isolation, cancellation of active calls, replay protection, and provider-output bounds without changing the selected coding tools' permissions.
- Run `npm run check` before a pull request is ready. Also run `npm pack --dry-run` and `npm run slophammer`.
- Add integration tests for every sandbox boundary or capability change.
