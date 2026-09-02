import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { HostClient } from "../src/index.ts";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe("host client process failures", () => {
  it("rejects a pending request instead of crashing on a host input error", async () => {
    const child = fakeChild();
    const client = new HostClient(child, async () => undefined);
    child.stderr.write("fixture host startup failed");

    const pending = client.request("client/hello", {});
    child.stdin.emit("error", new Error("write EPIPE"));

    await expect(pending).rejects.toThrow(
      "Code Mode host input failed: write EPIPE: fixture host startup failed",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
