import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodeModeBroker,
  SandboxedProcessManager,
  WorkspaceSandbox,
  createPiTools,
} from "../src/index.ts";

let root;
let workspace;
let processes;
let nextCall;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-pi-tools-"));
  writeFileSync(join(root, "one.txt"), "alpha\nbeta\n");
  workspace = new WorkspaceSandbox(root);
  processes = new SandboxedProcessManager(workspace);
  nextCall = 1;
});

afterEach(() => {
  processes.close();
  workspace.close();
  rmSync(root, { recursive: true, force: true });
});

function context() {
  const id = `nested-${String(nextCall++)}`;
  return {
    sessionId: "session",
    cellId: "cell",
    parentToolCallId: "parent",
    nestedToolCallId: id,
  };
}

function text(result) {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("Pi mode built-ins", () => {
  it("runs the default read, edit, write, and one-shot bash contracts", async () => {
    const broker = new CodeModeBroker(
      root,
      createPiTools(["read", "edit", "write", "bash"], workspace, processes),
      { mode: "pi" },
    );

    const read = await broker.invoke("pi.read", { path: "one.txt" }, context());
    expect(text(read)).toContain("alpha");

    const edit = await broker.invoke(
      "pi.edit",
      { path: "one.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
      context(),
    );
    expect(text(edit)).toContain("Successfully replaced 1 block");

    await broker.invoke("pi.write", { path: "two.txt", content: "second\n" }, context());
    const bash = await broker.invoke(
      "pi.bash",
      { command: "printf shell; printf changed > shell.txt", timeout: 5 },
      context(),
    );
    expect(text(bash)).toContain("shell");
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("alpha\ngamma\n");
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("second\n");
    expect(readFileSync(join(root, "shell.txt"), "utf8")).toBe("changed");

    const large = await broker.invoke(
      "pi.bash",
      { command: `python3 -c 'print("x" * 60000)'`, timeout: 5 },
      context(),
    );
    expect(large.details.truncation.truncated).toBe(true);
    expect(large.details.fullOutputPath).toBeUndefined();
    expect(text(large)).toContain("Earlier output was discarded inside the session sandbox");
  });

  it("returns supported images through the Pi read contract", async () => {
    writeFileSync(
      join(root, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const broker = new CodeModeBroker(root, createPiTools(["read"], workspace, processes), {
      mode: "pi",
    });

    const result = await broker.invoke("pi.read", { path: "pixel.png" }, context());
    expect(text(result)).toContain("Read image file [image/png]");
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );
  });

  it("runs optional grep, find, and ls and reports unavailable PowerShell", async () => {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "two.ts"), "const value = 'alpha';\n");
    writeFileSync(join(root, "node_modules", "ignored.ts"), "alpha\n");
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "long.txt"), `${"a".repeat(100_000)}!\n`);
    const broker = new CodeModeBroker(
      root,
      createPiTools(["grep", "find", "ls", "powershell"], workspace, processes),
      { mode: "pi" },
    );

    const grep = await broker.invoke(
      "pi.grep",
      { path: ".", pattern: "ALPHA", ignoreCase: true, literal: true, limit: 10 },
      context(),
    );
    expect(text(grep)).toContain("one.txt:1: alpha");
    expect(text(grep)).toContain("src/two.ts:1:");
    expect(text(grep)).not.toContain("ignored.ts");
    const regexGrep = await broker.invoke(
      "pi.grep",
      { path: "one.txt", pattern: "^a", literal: false, limit: 1 },
      context(),
    );
    expect(text(regexGrep)).toContain(":1: alpha");
    expect(regexGrep.details.matchLimitReached).toBe(1);

    const filteredGrep = await broker.invoke(
      "pi.grep",
      { path: ".", pattern: "alpha", glob: "*.ts", context: 1, limit: 10 },
      context(),
    );
    expect(text(filteredGrep)).toContain("src/two.ts:1: const value");
    expect(text(filteredGrep)).not.toContain("one.txt");

    const contextGrep = await broker.invoke(
      "pi.grep",
      { path: "one.txt", pattern: "beta", context: 1, limit: 10 },
      context(),
    );
    expect(text(contextGrep)).toContain("one.txt-1- alpha");
    expect(text(contextGrep)).toContain("one.txt:2: beta");

    const linearRegex = await broker.invoke(
      "pi.grep",
      { path: "long.txt", pattern: "(a+)+$", limit: 10 },
      context(),
    );
    expect(text(linearRegex)).toBe("");

    const find = await broker.invoke(
      "pi.find",
      { path: ".", pattern: "*.txt", limit: 10 },
      context(),
    );
    expect(text(find)).toContain("one.txt");

    const ls = await broker.invoke("pi.ls", { path: ".", limit: 2 }, context());
    expect(ls.details.entryLimitReached).toBe(2);
    const directoryList = await broker.invoke("pi.ls", { path: ".", limit: 10 }, context());
    expect(text(directoryList)).toContain("src/");

    await expect(broker.invoke("pi.ls", { path: ".", limit: 0 }, context())).rejects.toThrow(
      "limit must be",
    );
    await expect(broker.invoke("pi.find", { path: ".", pattern: 7 }, context())).rejects.toThrow();

    await expect(
      broker.invoke("pi.powershell", { command: "Write-Output test" }, context()),
    ).rejects.toThrow("PowerShell is not installed");
  });
});
