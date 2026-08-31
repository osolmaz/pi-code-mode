import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "runtime");
const result = spawnSync(
  "cargo",
  ["build", "--locked", "--release", "--package", "pi-code-mode-host"],
  { cwd: runtime, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const name = platform === "win32" ? "pi-code-mode-host.exe" : "pi-code-mode-host";
const source = join(runtime, "target", "release", name);
const destination = join(root, "dist", "runtime", `${platform}-${arch}`, name);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (platform !== "win32") chmodSync(destination, 0o755);
