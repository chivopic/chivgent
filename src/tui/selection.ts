/** Inputs that determine whether a local invocation gets the rich interface. */
export interface TuiSelection {
  readonly explicit: boolean;
  readonly simple: boolean;
  readonly interactive: boolean;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly json: boolean;
  readonly serve: boolean;
  readonly connect: boolean;
  readonly term?: string;
}

/**
 * Choose the rich UI only when all three terminal streams belong to a local
 * interactive terminal. Explicit --tui keeps its historical stdout-pipe use.
 */
export function useTui(selection: TuiSelection): boolean {
  if (selection.simple) return false;
  if (selection.explicit) return true;
  return selection.interactive && selection.stdinIsTTY &&
    selection.stdoutIsTTY && selection.stderrIsTTY &&
    !selection.json && !selection.serve && !selection.connect &&
    selection.term !== "dumb";
}

/** ANSI styling is unsafe when disabled by the user or unsupported by TERM. */
export function terminalColorEnabled(
  isTTY: boolean,
  environment: { readonly NO_COLOR?: string; readonly TERM?: string },
): boolean {
  return isTTY && environment.NO_COLOR === undefined && environment.TERM !== "dumb";
}
