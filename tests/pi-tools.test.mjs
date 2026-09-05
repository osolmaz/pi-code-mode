import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodeModeBroker, createPiTools } from "../src/index.ts";

let root;
let nextCall;
let piContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-pi-tools-"));
  writeFileSync(join(root, "one.txt"), "alpha\nbeta\n");
  nextCall = 1;
  piContext = {
    model: { provider: "test-provider", id: "test-model", input: ["text"] },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => join(root, "session.jsonl"),
    },
  };
});

afterEach(() => {
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
      createPiTools(["read", "edit", "write", "bash"], root, piContext),
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
  });

  it("returns supported images through the Pi read contract", async () => {
    writeFileSync(
      join(root, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const broker = new CodeModeBroker(root, createPiTools(["read"], root, piContext), {
      mode: "pi",
    });

    const result = await broker.invoke("pi.read", { path: "pixel.png" }, context());
    expect(text(result)).toContain("Read image file [image/png]");
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
      createPiTools(["grep", "find", "ls", "powershell"], root, piContext),
      { mode: "pi" },
    );

    const grep = await broker.invoke(
      "pi.grep",
      { path: ".", pattern: "ALPHA", ignoreCase: true, literal: true, limit: 10 },
      context(),
    );
    expect(text(grep)).toContain("one.txt:1: alpha");
    expect(text(grep)).toContain("src/two.ts:1:");
    expect(text(grep)).toContain("node_modules/ignored.ts:1:");
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
    expect(text(linearRegex)).toBe("No matches found");

    const find = await broker.invoke(
      "pi.find",
      { path: ".", pattern: "*.txt", limit: 10 },
      context(),
    );
    expect(text(find)).toContain("one.txt");
    const nestedFind = await broker.invoke(
      "pi.find",
      { path: ".", pattern: "*.ts", limit: 10 },
      context(),
    );
    expect(text(nestedFind)).toContain("src/two.ts");
    const directoryFind = await broker.invoke(
      "pi.find",
      { path: ".", pattern: "src", limit: 10 },
      context(),
    );
    expect(text(directoryFind)).toContain("src/");

    const ls = await broker.invoke("pi.ls", { path: ".", limit: 2 }, context());
    expect(ls.details.entryLimitReached).toBe(2);
    const directoryList = await broker.invoke("pi.ls", { path: ".", limit: 10 }, context());
    expect(text(directoryList)).toContain("src/");

    mkdirSync(join(root, "many"));
    for (let index = 0; index < 501; index += 1) {
      writeFileSync(join(root, "many", `${String(index).padStart(3, "0")}.txt`), "");
    }
    const defaultList = await broker.invoke("pi.ls", { path: "many" }, context());
    expect(text(defaultList)).toContain("000.txt");
    expect(defaultList.details.entryLimitReached).toBe(500);

    const powerShellOutcome = await broker
      .invoke("pi.powershell", { command: "Write-Output test" }, context())
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    if ("result" in powerShellOutcome) {
      expect(powerShellOutcome.result).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("test") }],
      });
    } else {
      expect(powerShellOutcome.error).toBeInstanceOf(Error);
      expect(powerShellOutcome.error.message).toMatch(
        /powershell tool is only available on Windows|PowerShell is not installed/iu,
      );
    }
  });

  it("keeps native Pi path, environment, and network behavior", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pi-code-mode-pi-native-"));
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(outsideFile, "outside\n");
    const server = createServer((_request, response) => response.end("network-ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    const previous = process.env["PI_CODE_MODE_TEST_ENV"];
    process.env["PI_CODE_MODE_TEST_ENV"] = "environment-ok";
    try {
      const broker = new CodeModeBroker(root, createPiTools(["read", "bash"], root, piContext), {
        mode: "pi",
      });
      const read = await broker.invoke("pi.read", { path: outsideFile }, context());
      expect(text(read)).toContain("outside");

      const bash = await broker.invoke(
        "pi.bash",
        {
          command: `printf '%s\\n' "$PI_CODE_MODE_TEST_ENV:$PI_SESSION_ID:$PI_PROVIDER:$PI_MODEL:$PI_REASONING_LEVEL"; node -e 'fetch("http://127.0.0.1:${String(address.port)}").then(async response => console.log(await response.text()))'`,
          timeout: 5,
        },
        context(),
      );
      expect(text(bash)).toContain("environment-ok:test-session:test-provider:test-model:high");
      expect(text(bash)).toContain("network-ok");
    } finally {
      if (previous === undefined) delete process.env["PI_CODE_MODE_TEST_ENV"];
      else process.env["PI_CODE_MODE_TEST_ENV"] = previous;
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
