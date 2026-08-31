import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function executableName(): string {
  return process.platform === "win32" ? "pi-code-mode-host.exe" : "pi-code-mode-host";
}

function assertExecutable(path: string): string {
  accessSync(path, constants.R_OK | constants.X_OK);
  const real = realpathSync(path);
  if (!statSync(real).isFile()) throw new Error(`Code Mode host is not a file: ${real}`);
  return real;
}

export function resolveHostBinary(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["PI_CODE_MODE_HOST"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) throw new Error("PI_CODE_MODE_HOST must be an absolute path");
    return assertExecutable(configured);
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(moduleDirectory, "../..");
  const platform = `${process.platform}-${process.arch}`;
  const name = executableName();
  const candidates = [
    join(packageRoot, "dist", "runtime", platform, name),
    join(packageRoot, "runtime", "target", "release", name),
    join(packageRoot, "runtime", "target", "debug", name),
  ];
  for (const candidate of candidates) {
    try {
      return assertExecutable(candidate);
    } catch {
      continue;
    }
  }
  throw new Error(
    `Code Mode host is not installed for ${platform}; run npm run build:host or set PI_CODE_MODE_HOST`,
  );
}
