import { formatTokens } from "../providers/usage.js";
import { terminalText, fitLine } from "./text.js";
import type { AgentEvent, AgentEventListener } from "../events.js";
import type { OutputStream } from "../render.js";
import { Painter } from "./paint.js";
import { EMPTY_STATE, reduce, type ViewState } from "./state.js";
import { transcriptLines, view } from "./view.js";

/** How often the region redraws on its own, so elapsed time advances. */
const TICK_MS = 1000;
const DEFAULT_WIDTH = 80;

export interface LiveRegionOptions {
  readonly stream: OutputStream;
  /** Re-read on every paint: a resize changes it under us. */
  readonly width: () => number;
  readonly height?: () => number;
  /** Final answers can be redirected independently of terminal chrome. */
  readonly answerStream?: OutputStream;
  readonly now?: () => number;
  readonly tickMs?: number;
}

export interface LiveRegion {
  readonly listener: AgentEventListener;
  /** Erases the region and stops the clock. Safe to call twice. */
  stop(): void;
  /** Drops the diff baseline and repaints, for a resize. */
  resized(): void;
}

/**
 * Drives the live region from the event stream.
 *
 * The three pure pieces do the work — `reduce` holds the state, `view` turns it
 * into lines, `Painter` writes only what changed. This is the wiring between
 * them, and the only part that owns a timer or a stream.
 */
export function createLiveRegion(options: LiveRegionOptions): LiveRegion {
  const clock = options.now ?? (() => Date.now());
  const painter = new Painter({ stream: options.stream });
  let state: ViewState = EMPTY_STATE;
  let timer: NodeJS.Timeout | undefined;

  const paint = (): void => {
    painter.render(view(state, {
      // Leave one cell spare to avoid a terminal's pending autowrap state.
      width: Math.max(1, options.width() - 1),
      height: Math.max(1, (options.height?.() ?? 24) - 2),
      now: clock(),
    }));
  };

  const startClock = (): void => {
    if (timer !== undefined) {
      return;
    }
    timer = setInterval(paint, options.tickMs ?? TICK_MS);
    // Never a reason to keep the process alive: the region describes work that
    // is happening elsewhere.
    timer.unref?.();
  };

  const stopClock = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    listener: (event: AgentEvent): void => {
      if (event.type === "turn_end") {
        // The finished turn moves into the terminal's own scrollback: the
        // region is erased first so the transcript lands where it was, then
        // the region is drawn again below it.
        painter.clear();
        const lines = transcriptLines(options.answerStream === undefined ? event : {
          ...event,
          message: { ...event.message, content: "" },
        });
        if (lines.length > 0) {
          options.stream.write(`${terminalText(lines.join("\n"))}\n`);
        }
        if (options.answerStream !== undefined && event.message.content.trim().length > 0) {
          options.answerStream.write(`${event.message.content}\n`);
        }
      }

      const previous = state;
      state = reduce(state, event, clock());

      if (event.type === "agent_start") {
        startClock();
      }
      if (event.type === "agent_end") {
        stopClock();
        painter.clear();
        // Cancellation can end a streamed turn before turn_end arrives.
        if (previous.run?.text) {
          (options.answerStream ?? options.stream).write(`${terminalText(previous.run.text)}\n`);
        }
        const label = event.status === "completed" ? "Completed"
          : event.status === "aborted" ? "Stopped"
          : event.status === "max_turns" ? "Turn limit reached" : "Failed";
        const parts = [label, `${event.turnCount} turn(s)`];
        if (previous.run !== undefined) {
          parts.push(`${Math.max(0, Math.round((clock() - previous.run.startedAt) / 1000))}s`);
        }
        if (event.usage !== undefined) {
          parts.push(`${formatTokens(event.usage.usage.totalTokens)} tokens${event.usage.complete ? "" : "+"}`);
        }
        options.stream.write(`${fitLine(parts.join(" · "), options.width() - 1)}\n`);
        if (event.error !== undefined) {
          options.stream.write(`${terminalText(event.error)}\n`);
        }
        return;
      }
      paint();
    },

    stop: (): void => {
      stopClock();
      painter.clear();
      state = EMPTY_STATE;
    },

    resized: (): void => {
      if (state.run === undefined) return;
      painter.invalidate(options.width(), options.height?.());
      paint();
    },
  };
}

/**
 * The usable width, or a sane default.
 *
 * `columns` is not merely absent off a terminal — it can be `0`, which `??`
 * lets through and which then collapses every line to the minimum. A width has
 * to be positive to mean anything.
 */
export function terminalWidth(stream: { columns?: number }): number {
  const columns = stream.columns;
  return columns !== undefined && columns > 0 ? columns : DEFAULT_WIDTH;
}
