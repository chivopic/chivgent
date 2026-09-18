import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal content may contain cursor controls; only our painter owns those. */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

export { stringWidth as displayWidth };

/** Fit terminal cells, preserving whole graphemes (including joined emoji). */
export function fitLine(text: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns));
  const clean = terminalText(text).replace(/\n/g, " ");
  if (width === 0) return "";
  if (stringWidth(clean) <= width) return clean;
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    result += segment;
    used += size;
  }
  return `${result}…`;
}
