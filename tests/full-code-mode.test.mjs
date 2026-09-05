import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodeModeBroker,
  CodeModeHostManager,
  ProcessManager,
  Workspace,
  applyPatch,
  parseApplyPatch,
  resolveLimits,
} from "../src/index.ts";

let root;
let workspace;
let processes;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-full-"));
  workspace = new Workspace(root);
  processes = new ProcessManager(root);
});

afterEach(() => {
  processes?.close();
  workspace?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Codex workspace operations", () => {
  it("uses normal relative and absolute paths without content filters", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pi-code-mode-outside-"));
    const outsideFile = join(outside, "outside.txt");
    try {
      await workspace.writeFile("file.txt", "workspace");
      await workspace.writeFile(outsideFile, "outside");
      await workspace.writeFile(".env", "TEST_ONLY=value\n");
      await workspace.writeFile("deploy.pem", "test-only\n");

      expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("workspace");
      expect(workspace.readFile(outsideFile).toString()).toBe("outside");
      expect(workspace.readFile(".env").toString()).toBe("TEST_ONLY=value\n");
      expect(workspace.readFile("deploy.pem").toString()).toBe("test-only\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("supports permissions, moves, removals, and lifecycle checks", async () => {
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "file");
    expect(() => new Workspace(fileRoot)).toThrow("workspace root must be a directory");
    expect(() => new ProcessManager(fileRoot)).toThrow("working directory must be a directory");

    writeFileSync(join(root, "mode.txt"), "mode\n", { mode: 0o744 });
    mkdirSync(join(root, "dir"));

    await workspace.mutate(() => workspace.writeFile(join(root, "mode.txt"), "changed\n"));
    expect(workspace.stat("mode.txt").mode & 0o777).toBe(0o744);
    await workspace.move("mode.txt", "dir/moved.txt");
    expect(workspace.exists("mode.txt")).toBe(false);
    await workspace.chmod("dir/moved.txt", 0o600);
    expect(statSync(join(root, "dir", "moved.txt")).mode & 0o777).toBe(0o600);
    await workspace.remove("dir", true);
    expect(workspace.exists("dir")).toBe(false);
    await expect(workspace.remove(".", true)).rejects.toThrow("cannot remove");
    expect(() => workspace.resolve("bad\0path")).toThrow("invalid");

    workspace.close();
    expect(() => workspace.resolve("closed.txt")).toThrow("workspace is closed");
  });

  it("applies multi-file Codex patches and rolls back a failed patch", async () => {
    writeFileSync(join(root, "one.txt"), "old\n");
    await applyPatch(
      workspace,
      `*** Begin Patch
*** Update File: one.txt
@@
-old
+new
*** Add File: two.txt
+second
*** End Patch`,
    );
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("second\n");

    writeFileSync(join(root, "executable.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await expect(
      applyPatch(
        workspace,
        `*** Begin Patch
*** Update File: one.txt
@@
-new
+broken
*** Delete File: executable.sh
*** Add File: created/inside.txt
+temporary
*** Delete File: missing.txt
*** End Patch`,
      ),
    ).rejects.toThrow("does not exist");
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(join(root, "executable.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect(workspace.stat("executable.sh").mode & 0o777).toBe(0o755);
    expect(workspace.exists("created")).toBe(false);
  });

  it("preserves CRLF and parses move, insertion, deletion, and malformed patches", async () => {
    writeFileSync(join(root, "windows.txt"), "first\r\nsecond\r\n");
    await applyPatch(
      workspace,
      `*** Begin Patch
*** Update File: windows.txt
@@
 first
-second
+changed
*** End Patch`,
    );
    expect(readFileSync(join(root, "windows.txt"), "utf8")).toBe("first\r\nchanged\r\n");

    writeFileSync(join(root, "move.txt"), "first\nlast");
    writeFileSync(join(root, "delete.txt"), "delete\n");
    const patch = `*** Begin Patch
*** Update File: move.txt
*** Move to: moved.txt
@@
+before
 first
@@
-last
+after
*** Delete File: delete.txt
*** End Patch`;
    expect(parseApplyPatch(patch)).toHaveLength(2);
    await applyPatch(workspace, patch);
    expect(readFileSync(join(root, "moved.txt"), "utf8")).toBe("before\nfirst\nafter");
    expect(workspace.exists("delete.txt")).toBe(false);

    for (const invalid of [
      "bad",
      "*** Begin Patch\n*** End Patch",
      "*** Begin Patch\n*** Unknown: x\n*** End Patch",
      "*** Begin Patch\n*** Add File: x\nplain\n*** End Patch",
      "*** Begin Patch\n*** Update File: moved.txt\nplain\n*** End Patch",
      "*** Begin Patch\n*** Update File: moved.txt\n@@\n?bad\n*** End Patch",
    ]) {
      expect(() => parseApplyPatch(invalid)).toThrow();
    }
  });
});

describe("Codex command process", () => {
  it("inherits environment access and can use host paths and loopback network", async () => {
    const server = createServer((_request, response) => response.end("network-ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");
    const previous = process.env["PI_CODE_MODE_TEST_ENV"];
    process.env["PI_CODE_MODE_TEST_ENV"] = "environment-ok";
    try {
      const result = await processes.exec({
        cmd: `printf '%s\\n' "$PI_CODE_MODE_TEST_ENV"
head -n 1 /etc/passwd
node -e 'fetch("http://127.0.0.1:${String(address.port)}").then(async response => console.log(await response.text()))'`,
        yield_time_ms: 5_000,
      });
      expect(result.exit_code).toBe(0);
      expect(result.output).toContain("environment-ok");
      expect(result.output).toContain("root:");
      expect(result.output).toContain("network-ok");
    } finally {
      if (previous === undefined) delete process.env["PI_CODE_MODE_TEST_ENV"];
      else process.env["PI_CODE_MODE_TEST_ENV"] = previous;
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("uses normal temporary directories without a private quota", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-code-mode-command-temp-"));
    try {
      const result = await processes.exec({
        cmd: "truncate -s 300M large.bin; stat -c %s large.bin",
        workdir: temporary,
        yield_time_ms: 2_000,
      });
      expect(result.exit_code).toBe(0);
      expect(result.output.trim()).toBe(String(300 * 1024 * 1024));
      expect(statSync(join(temporary, "large.bin")).size).toBe(300 * 1024 * 1024);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("does not terminate detached background work when the session closes", async () => {
    const marker = join(root, "background-finished.txt");
    const result = await processes.exec({
      cmd: `setsid sh -c 'sleep 0.4; printf survived > "${marker}"' >/dev/null 2>&1 &`,
      yield_time_ms: 2_000,
    });
    expect(result.exit_code).toBe(0);
    processes.close();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(readFileSync(marker, "utf8")).toBe("survived");
  });

  it("yields, accepts input, supports PTYs, and preserves split UTF-8", async () => {
    const initial = await processes.exec({
      cmd: 'printf "ready\\n"; read line; printf "got:%s\\n" "$line"',
      yield_time_ms: 250,
    });
    expect(initial.session_id).toBeTypeOf("number");
    expect(initial.output).toContain("ready");
    const completed = await processes.write({
      session_id: initial.session_id,
      chars: "hello\n",
      yield_time_ms: 2_000,
    });
    expect(completed).toMatchObject({ exit_code: 0, output: "got:hello\n" });

    const utf8 = await processes.exec({
      cmd: `python3 - <<'PY'
import os
import time
os.write(1, b"\\xe2\\x82")
time.sleep(0.1)
os.write(1, b"\\xac")
PY`,
      yield_time_ms: 2_000,
    });
    expect(utf8).toMatchObject({ exit_code: 0, output: "€" });

    const tty = await processes.exec({
      cmd: 'read line; printf "pty:%s\\n" "$line"',
      tty: true,
      yield_time_ms: 250,
    });
    const ttyCompleted = await processes.write({
      session_id: tty.session_id,
      chars: "hello\n",
      yield_time_ms: 2_000,
    });
    expect(ttyCompleted.exit_code).toBe(0);
    expect(ttyCompleted.output).toContain("pty:hello");
  });

  it("keeps output bounds and kills an explicitly cancelled command tree", async () => {
    const truncated = await processes.exec({
      cmd: "python3 -c 'print(\"x\" * 100)'",
      max_output_tokens: 1,
      yield_time_ms: 2_000,
    });
    expect(truncated.output).toContain("output truncated");
    expect(truncated.original_token_count).toBeGreaterThan(1);

    const pidFile = join(root, "cancelled.pid");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    await expect(
      processes.exec(
        {
          cmd: `trap '' TERM
printf '%s' "$$" > "${pidFile}"
while :; do sleep 1; done`,
          yield_time_ms: 30_000,
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    globalThis.clearTimeout(timer);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("supports explicit active-process and wall-time bounds", async () => {
    const limited = new ProcessManager(root, {
      maxActiveProcesses: 1,
      wallTimeLimitMs: 750,
    });
    try {
      const running = await limited.exec({ cmd: "sleep 10", yield_time_ms: 250 });
      expect(running.session_id).toBeTypeOf("number");
      await expect(limited.exec({ cmd: "sleep 10", yield_time_ms: 250 })).rejects.toThrow(
        "at most 1 active processes",
      );
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      const finished = await limited.write({
        session_id: running.session_id,
        chars: "",
        yield_time_ms: 250,
      });
      expect(finished.exit_code).toBeTypeOf("number");
    } finally {
      limited.close();
    }
  });

  it("validates command and process-session inputs", async () => {
    writeFileSync(join(root, "file.txt"), "file");
    await expect(processes.exec({ cmd: "" })).rejects.toThrow("non-empty");
    await expect(processes.exec({ cmd: "true", shell: "zsh" })).rejects.toThrow("bash shell");
    await expect(processes.exec({ cmd: "true", login: true })).rejects.toThrow("login shells");
    await expect(processes.exec({ cmd: "true", workdir: "file.txt" })).rejects.toThrow(
      "workdir must be a directory",
    );
    await expect(processes.exec({ cmd: "true", yield_time_ms: 1 })).rejects.toThrow(
      "yield_time_ms",
    );
    await expect(processes.exec({ cmd: "true", max_output_tokens: 0 })).rejects.toThrow(
      "max_output_tokens",
    );
    await expect(processes.exec({ cmd: "x".repeat(1024 * 1024 + 1) })).rejects.toThrow(
      "cmd is too large",
    );
    await expect(processes.write({ session_id: 999, chars: "" })).rejects.toThrow(
      "unknown command session",
    );
    processes.close();
    processes.close();
    await expect(processes.exec({ cmd: "true" })).rejects.toThrow("closed");
  });
});

describe("nested SDK paths", () => {
  it("creates frozen nested tool objects that dispatch by internal ID", async () => {
    const manager = await CodeModeHostManager.start();
    const session = await manager.openSession();
    try {
      const descriptor = {
        id: "fixture.read",
        sdkPath: ["fixture", "read"],
        modes: ["codex"],
        description: "Read fixture data.",
        kind: "function",
        effect: "read",
        replay: "safe",
        invoke: async (input) => ({ input, ok: true }),
      };
      const bracketDescriptor = {
        ...descriptor,
        id: "fixture.search",
        sdkPath: ["fixture", "issue.search"],
      };
      const broker = new CodeModeBroker(root, [descriptor, bracketDescriptor]);
      const result = await session.exec(
        "text({frozen:Object.isFrozen(tools.fixture), value:await tools.fixture.read({x:1}), bracket:await tools.fixture['issue.search']({x:2}), names:ALL_TOOLS.map(x=>x.name)});",
        "nested-path",
        broker,
        resolveLimits(),
      );
      expect(result.status).toBe("completed");
      const value = JSON.parse(result.output[0].text);
      expect(value).toEqual({
        frozen: true,
        value: { input: { x: 1 }, ok: true },
        bracket: { input: { x: 2 }, ok: true },
        names: ["fixture.read", "fixture.issue.search"],
      });
    } finally {
      await session.close();
      await manager.close();
    }
  });
});
