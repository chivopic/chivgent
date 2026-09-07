import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A throwaway copy of a task's fixture.
 *
 * Every attempt gets its own: attempts write to the workspace, and reusing one
 * would let attempt 2 start from whatever attempt 1 left behind, which turns a
 * pass rate into a sequence of increasingly different tasks.
 */
export interface AttemptWorkspace {
  readonly path: string;
  dispose(): Promise<void>;
}

export async function createAttemptWorkspace(
  fixtureDirectory: string,
  prefix = "chivgent-eval-",
): Promise<AttemptWorkspace> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  if (existsSync(fixtureDirectory)) {
    // A task may legitimately have no fixture: some tasks only ask a question.
    await cp(fixtureDirectory, directory, { recursive: true });
  }
  return {
    path: directory,
    async dispose(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
