import { describe, expect, it } from "vitest";

import { CodeModeBroker } from "../src/index.ts";

function descriptor(id, invoke, overrides = {}) {
  return {
    id,
    sdkPath: [id],
    modes: ["codex"],
    description: `${id} tool`,
    kind: "function",
    effect: "read",
    replay: "safe",
    invoke,
    ...overrides,
  };
}

const invocation = {
  sessionId: "session",
  cellId: "cell",
  parentToolCallId: "parent",
  nestedToolCallId: "nested",
};

describe("nested tool broker", () => {
  it("filters by mode and freezes visible descriptors", () => {
    const broker = new CodeModeBroker("/work", [
      descriptor("visible", async () => "ok"),
      descriptor("hidden", async () => "no", { modes: ["pi"] }),
    ]);

    expect(broker.descriptors.map((tool) => tool.id)).toEqual(["visible"]);
    expect(Object.isFrozen(broker.descriptors)).toBe(true);
    expect(Object.isFrozen(broker.descriptors[0])).toBe(true);
    expect(Object.isFrozen(broker.descriptors[0].sdkPath)).toBe(true);
  });

  it("admits coding effects and rejects disabled network effects", () => {
    expect(
      () =>
        new CodeModeBroker("/work", [
          descriptor("write", async () => "ok", { effect: "write" }),
          descriptor("execute", async () => "ok", { effect: "execute" }),
          descriptor("interactive", async () => "ok", { effect: "interactive" }),
        ]),
    ).not.toThrow();
    expect(
      () =>
        new CodeModeBroker("/work", [
          descriptor("network", async () => "no", { effect: "network" }),
        ]),
    ).toThrow("effect is not allowed");
  });

  it("rejects duplicate IDs, duplicate paths, unsafe paths, and unknown tools", async () => {
    expect(
      () =>
        new CodeModeBroker("/work", [
          descriptor("same", async () => 1),
          descriptor("same", async () => 2, { sdkPath: ["other"] }),
        ]),
    ).toThrow("duplicate Code Mode tool id");
    expect(
      () =>
        new CodeModeBroker("/work", [
          descriptor("one", async () => 1, { sdkPath: ["same"] }),
          descriptor("two", async () => 2, { sdkPath: ["same"] }),
        ]),
    ).toThrow("colliding Code Mode tool path");
    expect(
      () =>
        new CodeModeBroker("/work", [
          descriptor("unsafe", async () => 1, { sdkPath: ["__proto__"] }),
        ]),
    ).toThrow("invalid Code Mode tool path segment");

    const broker = new CodeModeBroker("/work", []);
    await expect(broker.invoke("missing", {}, invocation)).rejects.toThrow("tool is not allowed");
  });

  it("passes the fixed mode and working directory and normalizes undefined", async () => {
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
      context: { ...invocation, cwd: "/fixed", mode: "codex" },
      aborted: false,
    });
  });

  it("validates nested inputs and outputs against frozen schemas", async () => {
    const broker = new CodeModeBroker("/work", [
      descriptor("typed", async ({ value }) => value, {
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: { type: "string" },
      }),
    ]);
    await expect(broker.invoke("typed", { value: "ok" }, invocation)).resolves.toBe("ok");
    await expect(
      broker.invoke("typed", { value: 1 }, { ...invocation, nestedToolCallId: "nested-2" }),
    ).rejects.toThrow("input does not match");
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
