import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodeModeBroker,
  CodeModeHostManager,
  SandboxedProcessManager,
  WorkspaceSandbox,
  applyPatch,
  parseApplyPatch,
  resolveLimits,
} from "../src/index.ts";

let root;
let workspace;
let processes;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-full-"));
  workspace = new WorkspaceSandbox(root);
  processes = new SandboxedProcessManager(workspace);
});

afterEach(() => {
  processes?.close();
  workspace?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("writable workspace sandbox", () => {
  it("maps virtual /tmp, writes atomically, and blocks escapes and sensitive paths", async () => {
    await workspace.writeFile("file.txt", "workspace");
    await workspace.writeFile("/tmp/private.txt", "scratch");

    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("workspace");
    expect(workspace.readFile("/tmp/private.txt").toString()).toBe("scratch");
    expect(() => workspace.readFile("../outside")).toThrow("escapes");
    expect(() => workspace.resolve(".env")).toThrow("sensitive path");
  });

  it("covers existing paths, permissions, moves, removals, and symlink write guards", async () => {
    writeFileSync(join(root, "mode.txt"), "mode\n", { mode: 0o744 });
    mkdirSync(join(root, "dir"));
    symlinkSync(join(root, "mode.txt"), join(root, "link.txt"));

    await workspace.writeFile(join(root, "mode.txt"), "changed\n");
    expect(workspace.stat("mode.txt").mode & 0o777).toBe(0o744);
    expect(() => workspace.resolve("link.txt", { write: true })).toThrow("symbolic links");
    await workspace.move("mode.txt", "dir/moved.txt");
    expect(workspace.exists("mode.txt")).toBe(false);
    await workspace.remove("dir", true);
    expect(workspace.exists("dir")).toBe(false);
    await expect(workspace.remove(".", true)).rejects.toThrow("cannot remove");
    expect(() => workspace.resolve("/etc/passwd")).toThrow("escapes");
    expect(() => workspace.resolve("bad\0path")).toThrow("invalid");
    chmodSync(root, 0o700);
  });

  it("rejects invalid roots, cross-area moves, and operations after close", async () => {
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "file");
    expect(() => new WorkspaceSandbox(fileRoot)).toThrow("workspace root must be a directory");

    expect(() => workspace.resolve(0)).toThrow("path must not be empty");
    await workspace.writeFile("/tmp/move.txt", "scratch");
    await expect(workspace.move("/tmp/move.txt", "move.txt")).rejects.toThrow(
      "moves cannot cross sandbox areas",
    );
    await expect(workspace.remove("/tmp", true)).rejects.toThrow("cannot remove");

    workspace.close();
    expect(() => workspace.resolve("closed.txt")).toThrow("workspace sandbox is closed");
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

    await expect(
      applyPatch(
        workspace,
        `*** Begin Patch
*** Update File: one.txt
@@
-new
+broken
*** Delete File: missing.txt
*** End Patch`,
      ),
    ).rejects.toThrow("does not exist");
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("new\n");
  });
  it("parses delete, move, insertion, and malformed Codex patch cases", async () => {
    writeFileSync(join(root, "move.txt"), "first\nlast");
    writeFileSync(join(root, "delete.txt"), "delete\n");
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: move.txt
*** Move to: moved.txt
@@
+before
 first
@@
-last
+after
*** Delete File: delete.txt
*** End Patch`);
    expect(operations).toHaveLength(2);
    await applyPatch(
      workspace,
      `*** Begin Patch
*** Update File: move.txt
*** Move to: moved.txt
@@
+before
 first
@@
-last
+after
*** Delete File: delete.txt
*** End Patch`,
    );
    expect(readFileSync(join(root, "moved.txt"), "utf8")).toBe("before\nfirst\nafter");
    expect(workspace.exists("delete.txt")).toBe(false);

    for (const patch of [
      "bad",
      "*** Begin Patch\n*** End Patch",
      "*** Begin Patch\n*** Unknown: x\n*** End Patch",
      "*** Begin Patch\n*** Add File: x\nplain\n*** End Patch",
      "*** Begin Patch\n*** Update File: moved.txt\nplain\n*** End Patch",
      "*** Begin Patch\n*** Update File: moved.txt\n@@\n?bad\n*** End Patch",
    ]) {
      expect(() => parseApplyPatch(patch)).toThrow();
    }
  });
});

describe("sandboxed command process", () => {
  it("runs workspace commands while denying network sockets and host files", async () => {
    const result = await processes.exec({
      cmd: `printf written > command.txt
python3 - <<'PY'
import socket
try:
    socket.socket()
    print("network-open")
except OSError as error:
    print("network-blocked", error.errno)
try:
    open("/etc/passwd").read()
    print("host-open")
except OSError:
    print("host-blocked")
PY`,
      yield_time_ms: 2_000,
    });

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("network-blocked 1");
    expect(result.output).toContain("host-blocked");
    expect(readFileSync(join(root, "command.txt"), "utf8")).toBe("written");
  });

  it("yields a process, writes standard input, and returns only new output", async () => {
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
    expect(completed.exit_code).toBe(0);
    expect(completed.output).toBe("got:hello\n");
  });

  it("truncates output and covers TTY, abort, and closed-session handling", async () => {
    const truncated = await processes.exec({
      cmd: "python3 -c 'print(\"x\" * 100)'",
      max_output_tokens: 1,
      yield_time_ms: 2_000,
    });
    expect(truncated.output).toContain("output truncated");
    expect(truncated.original_token_count).toBeGreaterThan(1);

    const tty = await processes.exec({ cmd: "printf tty", tty: true, yield_time_ms: 2_000 });
    expect(tty.output).toBe("tty");

    const controller = new AbortController();
    controller.abort();
    await expect(processes.exec({ cmd: "sleep 5" }, controller.signal)).rejects.toThrow();

    const running = await processes.exec({ cmd: "sleep 0.4", yield_time_ms: 250 });
    expect(running.session_id).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(
      processes.write({ session_id: running.session_id, chars: "late" }),
    ).rejects.toThrow("already exited");
    const finished = await processes.write({
      session_id: running.session_id,
      chars: "",
      yield_time_ms: 250,
    });
    expect(finished.exit_code).toBe(0);
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

  it("refuses commands while a sensitive workspace path exists", async () => {
    writeFileSync(join(root, ".env"), "SECRET=value\n");
    await expect(processes.exec({ cmd: "true" })).rejects.toThrow("sensitive path exists");
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
      const broker = new CodeModeBroker(root, [descriptor]);
      const result = await session.exec(
        "text({frozen:Object.isFrozen(tools.fixture), value:await tools.fixture.read({x:1}), names:ALL_TOOLS.map(x=>x.name)});",
        "nested-path",
        broker,
        resolveLimits(),
      );
      expect(result.status).toBe("completed");
      const value = JSON.parse(result.output[0].text);
      expect(value).toEqual({
        frozen: true,
        value: { input: { x: 1 }, ok: true },
        names: ["fixture.read"],
      });
    } finally {
      await session.close();
      await manager.close();
    }
  });
});
