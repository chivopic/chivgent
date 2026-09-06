import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShellConfig } from "../src/shell/config.js";
import { OutputAccumulator } from "../src/shell/output.js";
import { sanitizeShellOutput } from "../src/shell/sanitize.js";
import { truncateTail } from "../src/shell/truncate.js";
import { ShellUnavailableError } from "../src/shell/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-shell-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("truncateTail", () => {
  it("returns short content unchanged", () => {
    const result = truncateTail("one\ntwo\n", { maxLines: 10, maxBytes: 100 });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe("one\ntwo\n");
    expect(result.totalLines).toBe(2);
  });

  it("keeps the end rather than the beginning", () => {
    const content = ["a", "b", "c", "d", "e"].join("\n");

    const result = truncateTail(content, { maxLines: 2, maxBytes: 1_000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.content).toBe("d\ne");
    expect(result.outputLines).toBe(2);
    expect(result.totalLines).toBe(5);
  });

  it("stops at the byte limit before the line limit", () => {
    const content = ["aaaa", "bbbb", "cccc"].join("\n");

    const result = truncateTail(content, { maxLines: 100, maxBytes: 6 });

    expect(result.truncatedBy).toBe("bytes");
    expect(result.content).toBe("cccc");
  });

  it("keeps the tail of one oversized line instead of returning nothing", () => {
    const result = truncateTail("x".repeat(50), { maxLines: 10, maxBytes: 10 });

    expect(result.lastLinePartial).toBe(true);
    expect(result.content).toBe("x".repeat(10));
  });

  it("never splits a multi-byte character", () => {
    const result = truncateTail("\u6211".repeat(10), {
      maxLines: 10,
      maxBytes: 8,
    });

    // Two whole characters fit in eight bytes; a third would need nine.
    expect(result.content).toBe("\u6211\u6211");
  });
});

describe("sanitizeShellOutput", () => {
  it("keeps tabs and newlines", () => {
    expect(sanitizeShellOutput("a\tb\nc\r\n")).toBe("a\tb\nc\r\n");
  });

  it("drops ANSI escapes and other control characters", () => {
    expect(sanitizeShellOutput("\u001B[31mred\u001B[0m")).toBe("[31mred[0m");
    expect(sanitizeShellOutput("a\u0000b\u0007c")).toBe("abc");
  });
});

describe("OutputAccumulator", () => {
  it("decodes a multi-byte character split across chunks", () => {
    const accumulator = new OutputAccumulator();
    const bytes = Buffer.from("\u6211", "utf8");

    accumulator.append(bytes.subarray(0, 1));
    accumulator.append(bytes.subarray(1));
    accumulator.finish();

    expect(accumulator.snapshot().content).toBe("\u6211");
  });

  it("counts every line even after dropping the front", () => {
    const accumulator = new OutputAccumulator({ maxLines: 2, maxBytes: 1_000 });

    for (const line of ["one", "two", "three", "four"]) {
      accumulator.append(Buffer.from(`${line}\n`, "utf8"));
    }
    accumulator.finish();

    const snapshot = accumulator.snapshot();
    expect(snapshot.truncation.totalLines).toBe(4);
    expect(snapshot.content).toBe("three\nfour\n");
  });

  it("writes the full output to a file once it truncates", async () => {
    const directory = await temporaryDirectory();
    const accumulator = new OutputAccumulator({
      maxLines: 2,
      maxBytes: 1_000,
      tempDirectory: directory,
    });

    for (let index = 1; index <= 10; index += 1) {
      accumulator.append(Buffer.from(`line ${index}\n`, "utf8"));
    }
    accumulator.finish();
    const snapshot = accumulator.snapshot();
    await accumulator.close();

    expect(snapshot.fullOutputPath).toBeDefined();
    const full = await readFile(snapshot.fullOutputPath as string, "utf8");
    expect(full.split("\n").filter(Boolean)).toHaveLength(10);
    expect(full).toContain("line 1\n");
  });

  it("does not spill a small output to disk", () => {
    const accumulator = new OutputAccumulator({ maxLines: 10, maxBytes: 100 });

    accumulator.append(Buffer.from("small\n", "utf8"));
    accumulator.finish();

    expect(accumulator.snapshot().fullOutputPath).toBeUndefined();
  });

  it("keeps memory bounded while the total keeps growing", () => {
    const accumulator = new OutputAccumulator({ maxLines: 5, maxBytes: 100 });
    const chunk = Buffer.from(`${"x".repeat(99)}\n`, "utf8");

    for (let index = 0; index < 200; index += 1) {
      accumulator.append(chunk);
    }
    accumulator.finish();

    const snapshot = accumulator.snapshot();
    expect(snapshot.truncation.totalLines).toBe(200);
    // The rolling window is capped at twice the byte limit.
    expect(snapshot.truncation.outputBytes).toBeLessThanOrEqual(100);
  });
});

describe("resolveShellConfig", () => {
  it("refuses Windows with an explanation instead of half working", () => {
    expect(() => resolveShellConfig("win32")).toThrow(ShellUnavailableError);
    expect(() => resolveShellConfig("win32")).toThrow(/WSL/);
  });

  it("resolves a shell on this platform", () => {
    const config = resolveShellConfig("linux");

    expect(config.args).toEqual(["-c"]);
    expect(config.shell.length).toBeGreaterThan(0);
  });
});
