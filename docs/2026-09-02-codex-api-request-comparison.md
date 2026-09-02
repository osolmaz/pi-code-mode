---
title: Compare Pi Code Mode and Codex API requests
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-02
---

# Compare Pi Code Mode and Codex API requests

This test captured the OpenAI Responses API traffic from Pi Code Mode and Codex while both used `gpt-5.6-luna` for the same file-writing task. It checks whether Pi Code Mode speaks the protocol that a model trained for programmatic tool calling expects. It also records where the two clients differ.

The core protocol matches. Both clients ask the model to emit raw JavaScript through a custom `exec` tool, and the same Lark grammar constrains that source. They return each tool result through `custom_tool_call_output`. A `wait` function handles a JavaScript cell that keeps running. Pi Code Mode is compatible with this protocol, but its request is not a copy of the current Codex request.

## Test setup

The test used these versions:

| Component                             | Version                 |
| ------------------------------------- | ----------------------- |
| Pi Code Mode                          | 0.3.0 at `8b18982dd2ef` |
| Pi                                    | 0.84.4                  |
| Codex CLI                             | 0.149.1                 |
| Local Codex source used for reference | `2b7c279735d0`          |
| Model                                 | `gpt-5.6-luna`          |

The installed Codex package and the local source checkout can be from different builds. The captured request from Codex CLI 0.149.1 is the primary evidence. The source checkout helps explain the fields and tool definitions.

Both runs received this exact 239-character user prompt:

```text
Create a file named `write-test.txt` in the current workspace containing exactly `code mode request comparison\n`. Use Code Mode, read the file back, verify the exact bytes, and report the tool calls you used. Do not modify any other file.
```

Each client used a fresh temporary workspace. A local loopback proxy recorded JSON request bodies and response event streams before forwarding them to the OpenAI Responses endpoint. This follows the same capture pattern as Codex's [Responses API proxy](https://github.com/openai/codex/blob/main/codex-rs/responses-api-proxy/README.md). The temporary proxy recorded header names for comparison but did not store header values. It received the API credential from the process environment and did not write it to a capture file.

Codex ran with `code_mode` and `code_mode_only` enabled. These features are under development and disabled by default in Codex CLI 0.149.1. The test therefore describes the tool interface that those flags enable in that release. The default interface is outside this comparison.

## Result

Pi Code Mode completed the task in two model requests. Its JavaScript called `tools.exec_command` to write the file. The same command used `od` to read the bytes back. The resulting file contained 29 bytes:

```text
code mode request comparison\n
```

Codex produced valid Code Mode requests and called `exec`, but its command host could not start in the nested Herdr environment. Bubblewrap could not create the required network or user namespace. The legacy Landlock path was incompatible with the active permission profile. We did not bypass the sandbox with unrestricted host access.

The Codex host failure limits the comparison to API shape and model behavior before host execution. It does not show a Codex model failure, and it does not support a task-quality comparison between the clients.

## Initial request bodies

The first request from each client used the Responses API with streaming enabled and storage disabled. The other top-level fields differed:

| Field                       | Pi Code Mode            | Codex CLI 0.149.1                              |
| --------------------------- | ----------------------- | ---------------------------------------------- |
| `model`                     | `gpt-5.6-luna`          | `gpt-5.6-luna`                                 |
| `stream`                    | `true`                  | `true`                                         |
| `store`                     | `false`                 | `false`                                        |
| Tool transport              | Top-level `tools` array | `additional_tools` developer input item        |
| `tool_choice`               | Omitted                 | `auto`                                         |
| `parallel_tool_calls`       | Omitted                 | `false`                                        |
| Reasoning                   | `{"effort":"none"}`     | `{"effort":"medium","context":"all_turns"}`    |
| Text controls               | Omitted                 | `{"verbosity":"low"}`                          |
| Included response data      | Omitted                 | `reasoning.encrypted_content`                  |
| Maximum output              | `128000`                | Omitted                                        |
| Client metadata             | Omitted                 | Codex metadata for the session and active turn |
| Input items                 | 2                       | 5                                              |
| Canonical compact JSON size | 5,399 bytes             | 81,373 bytes                                   |

The compact sizes come from parsing each captured body and encoding it again without optional whitespace. They are useful for this one run, but they are not measured HTTP wire sizes.

Pi sent a 2,715-character developer instruction and the 239-character user prompt. Codex sent one tool declaration item and two developer messages. It then sent one user context message and the same user prompt. Its text inputs contained 67,563 characters in total. Pi's text inputs contained 2,954 characters.

The size difference mostly comes from harness policy. Standalone Pi Code Mode started with a short Code Mode instruction and no project resources. Codex added its full built-in instructions, environment description, skills, project guidance, and turn context. This single comparison does not establish a general token or cost advantage.

## Tool declaration transport

Pi Code Mode declares `exec` and `wait` in the normal top-level `tools` array. The shape is equivalent to this shortened example:

```json
{
  "tools": [
    {
      "type": "custom",
      "name": "exec",
      "format": {
        "type": "grammar",
        "syntax": "lark",
        "definition": "..."
      }
    },
    {
      "type": "function",
      "name": "wait",
      "parameters": {
        "type": "object",
        "required": ["cell_id"]
      }
    }
  ]
}
```

Codex does not send a top-level `tools` field in this Code Mode request. It places a namespace inside the first input item:

```json
{
  "input": [
    {
      "type": "additional_tools",
      "role": "developer",
      "tools": [
        {
          "type": "namespace",
          "name": "functions",
          "tools": [
            { "type": "custom", "name": "exec" },
            { "type": "function", "name": "wait" },
            { "type": "function", "name": "request_user_input" }
          ]
        }
      ]
    }
  ]
}
```

The namespace changes how the declarations reach the model. It does not change the response call name. Both captured responses used a `custom_tool_call` whose `name` was `exec`; neither used `functions.exec`.

## The `exec` grammar

The two clients sent the same grammar content:

```lark
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
```

Codex included one newline before and after the definition. Pi omitted those two outer newlines. The grammar rules are otherwise byte-for-byte equal.

The grammar accepts ordinary JavaScript or JavaScript preceded by an `@exec` control line. The control line can set the initial yield time and output budget. It does not parse JavaScript. V8 parses and runs the source after the provider has returned it.

Pi's implementation is in [`src/provider/exec-grammar.ts`](../src/provider/exec-grammar.ts). Codex defines its grammar in [`execute_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/code_mode/execute_spec.rs).

## JavaScript tools

The custom `exec` call starts a JavaScript cell. The cell sees a typed `tools` object whose methods can reach the coding host. The top-level `wait` function is for a JavaScript cell that remains active after the first response window.

The tested Pi Codex mode exposed these methods inside JavaScript:

| Method               | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `tools.exec_command` | Start a sandboxed command and return output or a command session ID |
| `tools.write_stdin`  | Send input to a command session, poll it, or continue waiting       |
| `tools.apply_patch`  | Apply a Codex patch to workspace files                              |

Codex CLI 0.149.1 exposed a larger nested set:

| Method               | Purpose                            |
| -------------------- | ---------------------------------- |
| `tools.exec_command` | Start a command                    |
| `tools.write_stdin`  | Interact with a running command    |
| `tools.apply_patch`  | Apply a patch                      |
| `tools.update_plan`  | Change the current task plan       |
| `tools.view_image`   | Load an image for model inspection |

Codex also declared `request_user_input` beside `exec` and `wait` in the `functions` namespace. Pi Code Mode did not declare it in this run.

This catalog difference is separate from the Code Mode transport. Pi implements the same programmatic call pattern with a smaller Codex-mode host API. Current Codex compatibility work should account for `update_plan`, `view_image`, and `request_user_input` when those functions are useful and can be implemented without making Pi Code Mode depend on Codex.

## `wait` and command polling

There are two wait levels, and they handle different processes.

`wait` belongs to the provider-visible Code Mode interface. It receives a JavaScript `cell_id`. A client uses it when the JavaScript program itself is still running after `exec` yields. Both clients require `cell_id` and accept `yield_time_ms`, `max_tokens`, and `terminate`.

`tools.write_stdin` belongs to the JavaScript SDK. It receives a command `session_id`. The JavaScript program uses it when a shell command started by `tools.exec_command` is still running or needs input.

Pi places integer types and bounds directly in the `wait` JSON Schema. It also supplies defaults there. Its initial wait can range from 0 through 1,800,000 milliseconds, while `max_tokens` can range from 1 through 32,000. Codex uses JSON Schema `number` fields without schema bounds. Its descriptions state the 10,000 millisecond and 10,000 token defaults.

The distinction can be shown with one program:

```js
const command = await tools.exec_command({
  cmd: "long-running-command",
  yield_time_ms: 1000,
});

if (command.session_id !== undefined) {
  const result = await tools.write_stdin({
    session_id: command.session_id,
    chars: "",
    yield_time_ms: 10000,
  });
  text(result);
} else {
  text(command);
}
```

If this JavaScript cell outlives the top-level `exec` response window, the harness returns a cell ID to the model. The model then calls provider-level `wait` with that cell ID. A command session ID and a cell ID must never be exchanged.

## Turn sequence

Both first responses contained a `custom_tool_call` with raw JavaScript in its `input` field and a provider call ID. Each second request included the prior call followed by a matching `custom_tool_call_output`. This is the main request-and-response contract needed for multi-turn Code Mode.

Pi used its first cell to perform the requested write and byte check. With the workspace path shortened here, the program was:

```js
const r = await tools.exec_command({
  cmd: "printf 'code mode request comparison\\n' > write-test.txt && printf '\\n--READBACK--\\n' && od -An -t x1c write-test.txt",
  workdir: "<workspace>",
  yield_time_ms: 10000,
  max_output_tokens: 2000,
});
text(r.output ?? r);
```

Codex used its first cell to inspect the available JavaScript tools:

```js
const matches = ALL_TOOLS.filter((x) =>
  /code.?mode|file|workspace|read|write/i.test(x.name + " " + x.description),
);
text(matches);
```

Codex then sent the introspection result in its next API request. This confirms that `ALL_TOOLS` and the nested tool descriptions reached the model as intended. The `text()` output also continued through `custom_tool_call_output`. Host startup failed on later side-effect calls because of the nested sandbox limit described above.

## Request headers

The capture compared header names without retaining values.

Both clients sent authorization and content negotiation headers. Each also sent a user agent and a client request ID. Pi sent `session_id` and the `x-stainless-*` headers produced by its OpenAI client library.

Codex sent its own session and turn headers, including `session-id`, `thread-id`, `x-codex-beta-features`, `x-codex-turn-metadata`, and `x-codex-window-id`. It also sent `originator` and `x-openai-internal-codex-responses-lite`.

These headers help OpenAI identify client behavior and connect turns. Pi Code Mode does not need to copy private Codex identification headers. Any future OpenAI-specific header must have a public contract and a concrete compatibility reason before it is added.

## Compatibility finding

The test establishes the following facts for the versions above:

- `gpt-5.6-luna` accepted Pi Code Mode's OpenAI Responses request and emitted a valid custom `exec` call.
- Pi ran the model's JavaScript and dispatched a nested coding tool. The tool completed an exact file write and byte check.
- Pi and Codex use the same Lark grammar and the same `custom_tool_call` continuation pattern.
- Current Codex transports its tool namespace through `additional_tools`, while Pi uses the public top-level `tools` field.
- Current Codex supplies more instructions, metadata, request controls, and nested tools than the tested Pi session.
- The Codex task did not finish because its local command sandbox could not start inside the test environment.

Pi Code Mode is therefore compatible with the core Codex-style Code Mode protocol. It is not wire-identical to Codex CLI 0.149.1. Wire identity is also a poor maintenance target because Codex can change its request metadata and prompt text between releases. Its experimental feature shape can change too. The durable target is the documented OpenAI programmatic tool-calling contract, plus deliberate Codex-mode tool behavior where Pi can support it safely.

## Repeating the comparison

A repeatable comparison needs a request recorder and equal model access. Give each client a separate empty workspace, the same user prompt, and explicit Code Mode settings. Record request bodies and response events, but omit authorization values and raw environment secrets. Normalize JSON before comparing sizes or field sets.

For Codex, enable both `code_mode` and `code_mode_only` and record the exact CLI version. Check whether those flags remain experimental before drawing conclusions from a newer release. For Pi, record the Pi and Pi Code Mode versions with the selected mode. Also record the active provider and reasoning setting, plus any project resources loaded into the session.

Run each host only inside a sandbox configuration it officially supports. If one host cannot start, preserve the request capture and report the host limit. Do not weaken sandbox policy only to force an end-to-end result.

Raw captures should remain local and temporary. Requests can contain system instructions and absolute paths. They can also contain project policy or session and model metadata even when they contain no API key.

## Source references

- [Pi OpenAI contract](../src/provider/openai-contract.ts)
- [Pi `exec` grammar](../src/provider/exec-grammar.ts)
- [Pi Codex-mode tools](../src/modes/codex/tools.ts)
- [Codex Code Mode `exec` definition](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/code_mode/execute_spec.rs)
- [Codex Code Mode `wait` definition](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/code_mode/wait_spec.rs)
- [Codex Responses request types](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs)
- [Codex Responses API proxy](https://github.com/openai/codex/blob/main/codex-rs/responses-api-proxy/README.md)
