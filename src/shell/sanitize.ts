/**
 * Strips characters that must not reach the transcript or the terminal.
 *
 * Commands print ANSI sequences, progress-bar control codes, and occasionally
 * raw binary. Left alone those corrupt the session JSONL and scramble the
 * terminal, so everything below 0x20 except tab, newline and carriage return is
 * dropped, along with lone surrogates and Unicode format characters.
 */
export function sanitizeShellOutput(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += character;
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    // Lone surrogates survive iteration only when unpaired.
    if (code >= 0xd800 && code <= 0xdfff) {
      continue;
    }
    if (code >= 0xfff9 && code <= 0xfffb) {
      continue;
    }
    result += character;
  }
  return result;
}
