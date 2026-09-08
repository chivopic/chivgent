import type { AgentEvent } from "../events.js";
import { addUsage, type UsageTotal } from "../providers/usage.js";
import { callTarget } from "../tools/target.js";

/**
 * What the live region knows.
 *
 * Every consumer of the event stream before this one was append-only: an event
 * arrived, it was printed, it was forgotten. This is the first that has to
 * rebuild "what is happening now" from the same stream and keep it correct as
 * more arrives.
 *
 * State is deliberately bounded to the run in progress. A finished turn is
 * flushed to the terminal's own scrollback and dropped from here, so a long
 * session does not grow this object — which is the reason the alternate screen
 * buffer is not taken (see docs/stage-14-tui.md §2.1).
 */
export interface ViewState {
  /** Absent between runs; the live region is then just the prompt. */
  readonly run?: RunState;
}

export interface RunState {
  readonly turn: number;
  readonly maxTurns: number;
  readonly startedAt: number;
  /** Assistant text for the turn in progress. Cleared when the turn ends. */
  readonly text: string;
  /** Tools running right now, in the order they started. */
  readonly running: readonly RunningTool[];
  readonly usage?: UsageTotal;
  readonly status: RunStatus;
}

export type RunStatus = "thinking" | "running-tools";

export interface RunningTool {
  readonly toolCallId: string;
  readonly name: string;
  /** The path or command the call was aimed at, when it has one. */
  readonly target?: string;
  /** The tool's latest progress snapshot. Replaced, never appended to. */
  readonly progress: string;
  readonly startedAt: number;
}

export const EMPTY_STATE: ViewState = {};

function startRun(maxTurns: number, now: number): RunState {
  return {
    turn: 0,
    maxTurns,
    startedAt: now,
    text: "",
    running: [],
    status: "thinking",
  };
}

/**
 * Folds one event into the view state.
 *
 * Pure, and takes `now` rather than reading the clock, so the whole model can
 * be tested without a terminal and without a fake timer.
 */
export function reduce(
  state: ViewState,
  event: AgentEvent,
  now: number,
): ViewState {
  if (event.type === "agent_start") {
    return { run: startRun(event.maxTurns, now) };
  }
  if (event.type === "agent_end") {
    // The run's transcript has already gone to scrollback; nothing is left to
    // keep alive.
    return EMPTY_STATE;
  }

  const run = state.run;
  if (run === undefined) {
    // An event outside a run. Dropping it is right: the live region describes
    // a run, and inventing one from a mid-stream event would show a run whose
    // beginning was never seen.
    return state;
  }

  switch (event.type) {
    case "turn_start":
      return { run: { ...run, turn: event.turn, status: "thinking" } };

    case "message_start":
      return { run: { ...run, status: "thinking" } };

    case "message_update":
      // A DELTA. Appending is the only correct move: replacing would leave the
      // last token and lose the answer.
      return { run: { ...run, text: run.text + event.delta } };

    case "message_end":
      // The authoritative message, after any deltas. Taking it wholesale also
      // covers the non-streaming case, where no delta ever arrived.
      return {
        run: {
          ...run,
          text: event.message.content,
          ...(event.usage === undefined && run.usage === undefined
            ? {}
            : { usage: addUsage(run.usage, event.usage) }),
        },
      };

    case "tool_execution_start": {
      const target = callTarget(event.arguments);
      const tool: RunningTool = {
        toolCallId: event.toolCallId,
        name: event.toolName,
        ...(target === undefined ? {} : { target }),
        progress: "",
        startedAt: now,
      };
      return {
        run: {
          ...run,
          running: [...run.running, tool],
          status: "running-tools",
        },
      };
    }

    case "tool_execution_update":
      // A SNAPSHOT, already truncated to a bounded window by the tool.
      // Appending would stack the same output repeatedly, and because the
      // window has had its front dropped the result would not even be the
      // real output. Replace.
      return {
        run: {
          ...run,
          running: run.running.map((tool) =>
            tool.toolCallId === event.toolCallId
              ? { ...tool, progress: event.content }
              : tool,
          ),
        },
      };

    case "tool_execution_end": {
      const running = run.running.filter(
        (tool) => tool.toolCallId !== event.toolCallId,
      );
      return {
        run: {
          ...run,
          running,
          status: running.length === 0 ? "thinking" : "running-tools",
        },
      };
    }

    case "turn_end":
      // The turn is flushed to scrollback by the caller; what is left alive is
      // only the fact that the run continues.
      return { run: { ...run, text: "", running: [], status: "thinking" } };

    default:
      return state;
  }
}
