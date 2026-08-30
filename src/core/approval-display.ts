const UNSAFE_TERMINAL_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return "";
  return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
}

export function escapeApprovalText(value: string): string {
  let escaped = "";
  for (const character of value) {
    if (character === "\n") {
      escaped += character;
    } else if (character === "\\") {
      escaped += "\\\\";
    } else {
      escaped += UNSAFE_TERMINAL_CHARACTER.test(character) ? unicodeEscape(character) : character;
    }
  }
  return escaped;
}
