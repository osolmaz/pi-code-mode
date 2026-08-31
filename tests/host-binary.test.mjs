import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveHostBinary } from "../src/index.ts";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-binary-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("host binary resolution", () => {
  it("uses a configured absolute executable", () => {
    const binary = join(root, "host");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o700);

    expect(resolveHostBinary({ PI_CODE_MODE_HOST: ` ${binary} ` })).toBe(binary);
  });

  it("rejects relative paths and directories", () => {
    expect(() => resolveHostBinary({ PI_CODE_MODE_HOST: "relative/host" })).toThrow(
      "must be an absolute path",
    );
    expect(() => resolveHostBinary({ PI_CODE_MODE_HOST: root })).toThrow("is not a file");
  });

  it("falls back to the packaged host for blank configuration", () => {
    expect(resolveHostBinary({ PI_CODE_MODE_HOST: "  " })).toContain("pi-code-mode-host");
  });
});
