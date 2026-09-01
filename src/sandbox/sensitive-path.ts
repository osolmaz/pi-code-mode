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
