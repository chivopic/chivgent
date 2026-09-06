import { createInterface } from "node:readline";
import path from "node:path";
import type { OutputStream } from "../render.js";
import {
  canonicalDirectory,
  hasProjectExtensions,
  TrustStore,
  type TrustDecision,
} from "./trust.js";
import { projectExtensionsDirectory } from "./discover.js";

export type TrustOutcome =
  | { readonly trusted: true; readonly reason: "recorded" | "granted" }
  | {
      readonly trusted: false;
      readonly reason: "recorded" | "declined" | "no-tty" | "deferred";
    };

export interface DecideTrustOptions {
  readonly cwd: string;
  readonly store: TrustStore;
  readonly stderr: OutputStream;
  /** Absent when there is nobody to ask, which is itself the answer: no. */
  readonly input?: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly listExtensions: () => Promise<readonly string[]>;
}

function describeConsequences(cwd: string, files: readonly string[]): string {
  const listed = files.map((file) => `  ${path.relative(cwd, file)}`).join("\n");
  return [
    "This project ships chivgent extensions:",
    listed,
    "",
    "Extensions run as code inside chivgent, with your permissions. They are not",
    "limited by the workspace boundary and do not need --allow-shell to run",
    "commands or read your environment. Trusting this project means letting its",
    "authors run code as you.",
    "",
  ].join("\n");
}

async function ask(
  input: NodeJS.ReadableStream,
  output: OutputStream,
  question: string,
): Promise<string> {
  const readline = createInterface({
    input,
    output: output as NodeJS.WritableStream,
    terminal: false,
  });
  try {
    return await new Promise<string>((resolve) => {
      output.write(question);
      readline.once("line", (line) => resolve(line.trim().toLowerCase()));
      readline.once("close", () => resolve(""));
    });
  } finally {
    readline.close();
  }
}

/**
 * Decides whether this project's extensions may be loaded.
 *
 * The decision happens before anything is imported, because importing is
 * already execution. When there is nobody to ask, the answer is no: a CI job
 * or a piped run must never silently execute code from a checkout.
 */
export async function decideTrust(
  options: DecideTrustOptions,
): Promise<TrustOutcome> {
  if (!hasProjectExtensions(options.cwd)) {
    // Nothing to gate: do not bother the user at all.
    return { trusted: false, reason: "recorded" };
  }

  const existing = await options.store.lookup(options.cwd);
  if (existing !== undefined) {
    return existing.decision
      ? { trusted: true, reason: "recorded" }
      : { trusted: false, reason: "recorded" };
  }

  const input = options.input;
  if (input === undefined || input.isTTY !== true) {
    options.stderr.write(
      `Skipping project extensions in ${projectExtensionsDirectory(options.cwd)}: ` +
        "no decision recorded and no terminal to ask. Run chivgent here interactively once, " +
        "or use --no-extensions to silence this.\n",
    );
    return { trusted: false, reason: "no-tty" };
  }

  const files = await options.listExtensions();
  options.stderr.write(describeConsequences(options.cwd, files));

  const parent = path.dirname(await canonicalDirectory(options.cwd));
  const answer = await ask(
    input,
    options.stderr,
    `  [t] trust this project   [p] trust ${parent}   [n] never   [o] not now: `,
  );

  const record = async (
    directory: string,
    decision: TrustDecision,
  ): Promise<void> => {
    try {
      await options.store.set(directory, decision);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      options.stderr.write(`Could not record the trust decision: ${message}\n`);
    }
  };

  switch (answer) {
    case "t":
    case "trust":
    case "y":
    case "yes":
      await record(options.cwd, true);
      return { trusted: true, reason: "granted" };
    case "p":
    case "parent":
      await record(parent, true);
      return { trusted: true, reason: "granted" };
    case "n":
    case "never":
    case "no":
      await record(options.cwd, false);
      return { trusted: false, reason: "declined" };
    default:
      // "not now" and anything unrecognised both mean: do not run it, and ask
      // again next time rather than recording a decision the user did not make.
      options.stderr.write("Not loading project extensions this time.\n");
      return { trusted: false, reason: "deferred" };
  }
}
