import type { LayoutLine } from "./view.js";

/** Refresh period for live-region spinners and shimmer sweeps. */
export const ANIMATION_TICK_MS = 100;

/** One-cell Braille orbital spinner; width stays constant across terminals. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const BOLD_CYAN = "\u001b[1;36m";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function frameStep(elapsedMs: number): number {
  const safe = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.floor(safe / ANIMATION_TICK_MS);
}

/**
 * Selects a spinner glyph deterministically from elapsed time so rapid token
 * deltas never speed up or jitter the animation.
 */
export function spinnerFrame(elapsedMs: number, offset = 0): string {
  const len = SPINNER_FRAMES.length;
  const index = ((frameStep(elapsedMs) + offset) % len + len) % len;
  return SPINNER_FRAMES[index]!;
}

/**
 * Applies a soft cyan highlight sweep over a short status word using only
 * theme-safe SGR attributes so it stays legible on both dark and light themes.
 */
export function shimmerText(text: string, elapsedMs: number): string {
  if (text.length === 0) return "";
  const chars = [...graphemes.segment(text)].map((item) => item.segment);
  if (chars.length === 0) return "";

  const step = frameStep(elapsedMs);
  const cycle = chars.length + 12;
  const pos = (step % cycle) - 2;

  let out = "";
  let activeCode = "";
  let run = "";
  for (let i = 0; i < chars.length; i += 1) {
    const dist = Math.abs(i - pos);
    const code = dist === 0 ? BOLD_CYAN : dist === 1 ? CYAN : DIM;
    if (code === activeCode) {
      run += chars[i]!;
    } else {
      if (run.length > 0) {
        out += `${activeCode}${run}${RESET}`;
      }
      activeCode = code;
      run = chars[i]!;
    }
  }
  if (run.length > 0) {
    out += `${activeCode}${run}${RESET}`;
  }
  return out;
}

/**
 * Colors an already-sanitized, width-fitted layout line without altering its
 * visible text or column width.
 */
export function styleLiveLine(
  line: LayoutLine,
  elapsedMs: number,
  color: boolean,
  animate = true,
): string {
  if (!color) return line.plain;
  switch (line.kind) {
    case "text":
      return line.plain;
    case "overflow":
      return line.plain.length === 0 ? "" : `${DIM}${line.plain}${RESET}`;
    case "plan":
      return `${line.indent}${CYAN}${line.prefix}${RESET}${line.detail.length > 0 ? `${DIM}${line.detail}${RESET}` : ""}`;
    case "tool":
      return `${line.indent}${CYAN}${line.spinner}${RESET}${line.separator}${line.head}${line.tail.length > 0 ? `${DIM}${line.tail}${RESET}` : ""}`;
    case "status": {
      const spinner = line.spinner === undefined ? "" : `${CYAN}${line.spinner}${RESET}${line.gap ?? ""}`;
      const label = line.label === undefined
        ? ""
        : animate
          ? shimmerText(line.label, elapsedMs)
          : `${BOLD_CYAN}${line.label}${RESET}`;
      const rest = line.rest.length > 0 ? `${DIM}${line.rest}${RESET}` : "";
      return `${spinner}${label}${rest}`;
    }
  }
}
