const SENSITIVE_NAMES = new Set([
  ".aws",
  ".azure",
  ".direnv",
  ".docker",
  ".env",
  ".envrc",
  ".git-credentials",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "application_default_credentials.json",
  "auth.json",
  "credentials",
  "credentials.json",
  "gcloud",
  "secrets",
  "secrets.json",
  "service-account.json",
  "token",
  "tokens.json",
]);
const SENSITIVE_PREFIXES = [".env.", "id_dsa", "id_ed25519", "id_ecdsa", "id_rsa"];
const SENSITIVE_SUFFIXES = [".key", ".p12", ".pem", ".pfx"];
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/iu;
const AUTHORIZATION_HEADER = /^\s*extraheader\s*=.*authorization\s*:/imu;
const SECRET_KEY = /^\s*(?:password|token|access[_-]?token)\s*=/imu;
const SECRET_QUERY = /[?&](?:password|token|access[_-]?token|api[_-]?key)=/iu;
export const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

export function isGitCredentialConfigPath(path: string): boolean {
  const parts = path
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((part) => part.toLocaleLowerCase());
  const name = parts.at(-1);
  return name === ".gitmodules" || (name === "config" && parts.includes(".git"));
}

export function assertSafeGitConfig(path: string, content: Buffer): void {
  if (!isGitCredentialConfigPath(path)) return;
  const text = content.toString("utf8");
  if (
    URL_USERINFO.test(text) ||
    AUTHORIZATION_HEADER.test(text) ||
    SECRET_KEY.test(text) ||
    SECRET_QUERY.test(text)
  ) {
    throw new Error(`credential-bearing Git configuration is not available in Code Mode: ${path}`);
  }
}

export function assertSafePathParts(path: string): void {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  for (const part of parts) {
    const normalized = part.toLocaleLowerCase();
    if (
      SENSITIVE_NAMES.has(normalized) ||
      SENSITIVE_PREFIXES.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`),
      ) ||
      SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    ) {
      throw new Error(`sensitive path is not available in Code Mode: ${part}`);
    }
  }
}
