use serde::Serialize;

use crate::types::RuntimeTool;

#[derive(Serialize)]
struct ToolMetadata<'a> {
    name: &'a str,
    description: &'a str,
    deferred: bool,
}

pub fn bootstrap_source(tools: &[RuntimeTool]) -> Result<String, serde_json::Error> {
    let metadata = tools
        .iter()
        .map(|tool| ToolMetadata {
            name: &tool.name,
            description: &tool.description,
            deferred: tool.deferred,
        })
        .collect::<Vec<_>>();
    let metadata = serde_json::to_string(&metadata)?;
    Ok(format!(
        r#"(() => {{
  const ops = Deno.core.ops;
  const define = (name, value) => Object.defineProperty(globalThis, name, {{
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  }});
  const jsonText = (value) => {{
    if (typeof value === "string") return value;
    try {{
      const encoded = JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item
      );
      return encoded === undefined ? String(value) : encoded;
    }} catch {{
      return String(value);
    }}
  }};
  const tools = Object.create(null);
  for (const metadata of {metadata}) {{
    const invoke = Object.freeze((input = {{}}) => ops.op_tool_invoke(metadata.name, input));
    Object.defineProperty(tools, metadata.name, {{
      value: invoke,
      enumerable: true,
      configurable: false,
      writable: false,
    }});
  }}
  define("tools", Object.freeze(tools));
  define("ALL_TOOLS", Object.freeze({metadata}.map((entry) => Object.freeze(entry))));
  define("text", Object.freeze((value) => ops.op_emit_text(jsonText(value))));
  define("notify", Object.freeze((message) => ops.op_notify(String(message))));
  define("store", Object.freeze((key, value) => ops.op_store(String(key), value)));
  define("load", Object.freeze((key) => ops.op_load(String(key))));
  define("yield_control", Object.freeze(() => ops.op_yield_control()));
  define("exit", Object.freeze(() => ops.op_exit()));

  let nextTimer = 1;
  const activeTimers = new Map();
  define("setTimeout", Object.freeze((callback, delay = 0, ...args) => {{
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const id = nextTimer++;
    ops.op_timer_start(id, delay);
    activeTimers.set(id, true);
    ops.op_sleep(id).then((completed) => {{
      if (!completed || !activeTimers.delete(id)) return;
      callback(...args);
    }});
    return id;
  }}));
  define("clearTimeout", Object.freeze((id) => {{
    if (activeTimers.delete(id)) ops.op_timer_cancel(id);
  }}));

  for (const name of ["console", "WebAssembly", "SharedArrayBuffer", "Atomics", "Deno"]) {{
    Reflect.deleteProperty(globalThis, name);
  }}
}})();"#
    ))
}

#[must_use]
pub fn program_source(source: &str) -> String {
    format!("(async () => {{\n{source}\n}})()")
}

#[cfg(test)]
mod tests {
    use crate::types::RuntimeTool;

    use super::bootstrap_source;

    #[test]
    fn escapes_tool_metadata_as_json() {
        let source = bootstrap_source(&[RuntimeTool {
            name: "read\"file".to_owned(),
            description: "line\ntext".to_owned(),
            deferred: false,
        }])
        .expect("build bootstrap");
        assert!(source.contains("read\\\"file"));
        assert!(source.contains("line\\ntext"));
    }
}
