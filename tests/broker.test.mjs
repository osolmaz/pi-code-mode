import { describe, expect, it } from "vitest";

import { CodeModeBroker } from "../src/index.ts";

function descriptor(name, invoke, overrides = {}) {
  return {
    name,
    codeModeName: name,
    description: `${name} tool`,
    kind: "function",
    effect: "read",
    replay: "safe",
    invoke,
    ...overrides,
  };
}

const invocation = { sessionId: "session", cellId: "cell", parentToolCallId: "parent" };

describe("nested tool broker", () => {
  it("hides direct-only tools and freezes visible descriptors", () => {
    const broker = new CodeModeBroker("/work", [
      descriptor("visible", async () => "ok"),
      descriptor("hidden", async () => "no", { directOnly: true }),
    ]);

    expect(broker.descriptors.map((tool) => tool.codeModeName)).toEqual(["visible"]);
    expect(Object.isFrozen(broker.descriptors)).toBe(true);
    expect(Object.isFrozen(broker.descriptors[0])).toBe(true);
  });

  it("rejects tools with effects beyond read-only access", () => {
    for (const effect of ["write", "execute", "network", "interactive"]) {
      expect(
        () => new CodeModeBroker("/work", [descriptor("unsafe", async () => "no", { effect })]),
      ).toThrow("Code Mode only accepts read-only tools");
    }
  });

  it("rejects duplicate and unknown tool names", async () => {
    expect(
      () =>
        new CodeModeBroker("/work", [
          descriptor("same", async () => 1),
          descriptor("other", async () => 2, { codeModeName: "same" }),
        ]),
    ).toThrow("duplicate Code Mode tool name");

    const broker = new CodeModeBroker("/work", []);
    await expect(broker.invoke("missing", {}, invocation)).rejects.toThrow("tool is not allowed");
  });

  it("passes the fixed working directory and normalizes undefined", async () => {
    let received;
    const broker = new CodeModeBroker("/fixed", [
      descriptor("inspect", async (input, context, signal) => {
        received = { input, context, aborted: signal.aborted };
        return undefined;
      }),
    ]);

    await expect(broker.invoke("inspect", { value: 1 }, invocation)).resolves.toBeNull();
    expect(received).toEqual({
      input: { value: 1 },
      context: { ...invocation, cwd: "/fixed" },
      aborted: false,
    });
  });

  it("rejects calls after cancellation and non-JSON results", async () => {
    const cancelled = new CodeModeBroker("/work", [descriptor("read", async () => "ok")]);
    cancelled.cancel();
    await expect(cancelled.invoke("read", {}, invocation)).rejects.toThrow();

    const cyclic = {};
    cyclic.self = cyclic;
    const invalid = new CodeModeBroker("/work", [descriptor("read", async () => cyclic)]);
    await expect(invalid.invoke("read", {}, invocation)).rejects.toThrow("circular");
  });
});
