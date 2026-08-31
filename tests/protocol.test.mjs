import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { truncateUtf8 } from "../src/core/output.ts";
import { encodeFrame, FrameDecoder } from "../src/host/framing.ts";
import {
  MAX_FRAME_BYTES,
  executionOptions,
  parseCellResult,
  parseEnvelope,
  parseHostHello,
  parseSessionId,
  parseToolInvoke,
  wireTools,
} from "../src/host/protocol.ts";
import { resolveLimits } from "../src/index.ts";

const validStats = { toolCalls: 1, outputBytes: 2, wallTimeMs: 3 };

function validCell(overrides = {}) {
  return {
    status: "completed",
    cellId: "cell-1",
    output: [{ type: "text", text: "done" }],
    truncated: false,
    stats: validStats,
    ...overrides,
  };
}

function validHello(overrides = {}) {
  return {
    protocolVersion: 1,
    host: { name: "host", version: "1", runtime: "deno_core", v8: "15" },
    capabilities: { wait: true, images: false, notifications: true, sessionStore: true },
    ...overrides,
  };
}

describe("host protocol", () => {
  it("encodes execution options and optional tool metadata", () => {
    const limits = resolveLimits();
    expect(executionOptions(limits, 25, 50)).toMatchObject({
      yieldTimeMs: 25,
      maxOutputBytes: 50,
      maxSourceBytes: limits.maxSourceBytes,
      cpuLimitMs: limits.cpuLimitMs,
    });
    expect(
      wireTools([
        {
          name: "full",
          codeModeName: "full",
          description: "full tool",
          usage: "await tools.full({})",
          kind: "function",
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
          deferred: true,
          effect: "read",
          replay: "safe",
          invoke: async () => null,
        },
        {
          name: "minimal",
          codeModeName: "minimal",
          description: "minimal tool",
          kind: "function",
          effect: "read",
          replay: "safe",
          invoke: async () => null,
        },
      ]),
    ).toEqual([
      {
        name: "full",
        codeModeName: "full",
        description: "full tool",
        usage: "await tools.full({})",
        kind: "function",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
        deferred: true,
      },
      {
        name: "minimal",
        codeModeName: "minimal",
        description: "minimal tool",
        kind: "function",
        deferred: false,
      },
    ]);
  });

  it("decodes request, event, and response envelopes", () => {
    expect(parseEnvelope({ type: "request", id: "1", method: "run", params: 1 })).toEqual({
      type: "request",
      id: "1",
      method: "run",
      params: 1,
    });
    expect(parseEnvelope({ type: "event", method: "tick", params: null })).toEqual({
      type: "event",
      method: "tick",
      params: null,
    });
    expect(parseEnvelope({ type: "response", id: "2", result: 3 })).toEqual({
      type: "response",
      id: "2",
      result: 3,
    });
    expect(
      parseEnvelope({
        type: "response",
        id: "3",
        error: { code: "failed", message: "bad" },
      }),
    ).toEqual({ type: "response", id: "3", error: { code: "failed", message: "bad" } });
  });

  it("rejects malformed envelopes and identifiers", () => {
    for (const value of [null, [], "message"]) {
      expect(() => parseEnvelope(value)).toThrow("must be an object");
    }
    expect(() => parseEnvelope({ type: "unknown" })).toThrow("unknown protocol message type");
    expect(() => parseEnvelope({ type: "request", id: 1, method: "run" })).toThrow(
      "protocol id must be a string",
    );
    expect(() => parseEnvelope({ type: "response", id: "1", error: "bad" })).toThrow(
      "protocol error must be an object",
    );
    expect(() => parseSessionId(null)).toThrow("session response must be an object");
    expect(() => parseSessionId({ sessionId: 1 })).toThrow("protocol sessionId must be a string");
  });

  it("decodes nested tool calls", () => {
    const invocation = {
      sessionId: "session",
      cellId: "cell",
      parentToolCallId: "parent",
      callId: "call",
      tool: "read",
      input: { path: "a.txt" },
    };
    expect(parseToolInvoke(invocation)).toEqual(invocation);
    expect(() => parseToolInvoke(null)).toThrow("tool invocation must be an object");
    expect(() => parseToolInvoke({ ...invocation, tool: 1 })).toThrow(
      "protocol tool must be a string",
    );
  });

  it("decodes all cell result variants and output tags", () => {
    for (const status of ["completed", "failed", "waiting", "terminated"]) {
      const result = parseCellResult(
        validCell({
          status,
          error: status === "failed" ? "failure" : undefined,
          output: [
            { type: "text", text: "done" },
            { type: "notification", message: "progress" },
          ],
        }),
      );
      expect(result.status).toBe(status);
      expect(result.output).toHaveLength(2);
    }
  });

  it("rejects malformed cell results", () => {
    const invalid = [
      [null, "must be an object"],
      [validCell({ status: "other" }), "unknown cell status"],
      [validCell({ output: null }), "invalid output or stats"],
      [validCell({ output: [null] }), "cell output must be an object"],
      [validCell({ output: [{ type: "other" }] }), "unknown cell output type"],
      [validCell({ stats: { ...validStats, toolCalls: 1.5 } }), "safe integers"],
      [validCell({ truncated: "no" }), "truncated must be boolean"],
      [validCell({ error: 7 }), "error must be a string"],
    ];
    for (const [value, message] of invalid) expect(() => parseCellResult(value)).toThrow(message);
  });

  it("validates host handshakes", () => {
    expect(parseHostHello(validHello())).toEqual(validHello());
    expect(() => parseHostHello(null)).toThrow("host hello is invalid");
    expect(() => parseHostHello(validHello({ protocolVersion: 1.5 }))).toThrow(
      "host protocol version is invalid",
    );
    expect(() =>
      parseHostHello(
        validHello({
          capabilities: { wait: "yes", images: false, notifications: true, sessionStore: true },
        }),
      ),
    ).toThrow("host capability is invalid: wait");
    expect(() =>
      parseHostHello(
        validHello({ host: { name: 1, version: "1", runtime: "deno_core", v8: "15" } }),
      ),
    ).toThrow("protocol name must be a string");
  });
});

describe("framed transport", () => {
  it("decodes partial and combined frames", () => {
    const first = encodeFrame({ type: "event", method: "one", params: 1 });
    const second = encodeFrame({ type: "event", method: "two", params: 2 });
    const decoder = new FrameDecoder();

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { type: "event", method: "one", params: 1 },
      { type: "event", method: "two", params: 2 },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects oversized, malformed, and incomplete frames", () => {
    expect(() =>
      encodeFrame({ type: "event", method: "large", params: "x".repeat(MAX_FRAME_BYTES) }),
    ).toThrow("protocol frame exceeds the limit");

    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32LE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(oversizedHeader)).toThrow(
      "protocol frame exceeds the limit",
    );

    const malformed = Buffer.from("not-json", "utf8");
    const malformedFrame = Buffer.alloc(4 + malformed.byteLength);
    malformedFrame.writeUInt32LE(malformed.byteLength);
    malformed.copy(malformedFrame, 4);
    expect(() => new FrameDecoder().push(malformedFrame)).toThrow();

    const incomplete = new FrameDecoder();
    incomplete.push(Buffer.from([1]));
    expect(() => incomplete.finish()).toThrow("stream ended inside a frame");
  });
});

describe("UTF-8 output bounds", () => {
  it("keeps short text and trims partial code points", () => {
    expect(truncateUtf8("short", 10)).toEqual({ text: "short", truncated: false });
    expect(truncateUtf8("a😀b", 3)).toEqual({ text: "a", truncated: true });
  });
});
