import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeShellOperations, nativeShellConfig } from "../src/shell/native.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chivgent-native-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("native Seatbelt shell", () => {
  it("builds a deny-by-default profile with workspace writes opt-in", async () => {
    const root = await fixture();
    const temp = await mkdtemp(path.join(tmpdir(), "chivgent-native-private-"));
    roots.push(temp);
    const readOnly = nativeShellConfig(root, { temporaryDirectory: temp, sandboxExecutable: "/bin/echo" });
    expect(readOnly.shell).toBe("/bin/echo");
    expect(readOnly.args.join(" ")).toContain("(deny file-write*");
    expect(readOnly.args.join(" ")).not.toContain("(allow network*)");
    expect(nativeShellConfig(root, { allowWrites: true, allowNetwork: true, temporaryDirectory: temp, sandboxExecutable: "/bin/echo" }).args.join(" ")).toContain("(allow network*)");
  });

  it.skipIf(process.platform !== "darwin")("enforces workspace writes, protected paths, env and network at runtime", async () => {
    const root = await fixture();
    const secret = "native-shell-secret-must-not-leak";
    process.env.CHIVGENT_TEST_SECRET = secret;
    await mkdirProtected(root);
    const ops = createNativeShellOperations({ allowWrites: true });
    const run = async (command: string) => {
      let out = "";
      const result = await ops.exec(command, root, { onData: (chunk) => { out += chunk.toString(); } });
      return { ...result, out };
    };
    try {
      expect((await run("echo ok > allowed.txt")).exitCode).toBe(0);
      expect(await readFile(path.join(root, "allowed.txt"), "utf8")).toBe("ok\n");
      const readOnly = createNativeShellOperations();
      expect((await readOnly.exec("echo denied > readonly.txt", root, { onData: () => undefined })).exitCode).not.toBe(0);
      expect((await run("echo bad > .git/should-not-exist")).exitCode).not.toBe(0);
      await rm(path.join(root, ".git"), { recursive: true });
      await mkdir(path.join(root, "git-meta"));
      await writeFile(path.join(root, ".git"), "gitdir: git-meta\n");
      expect((await run("echo bad > git-meta/should-not-exist")).exitCode).not.toBe(0);
      const outside = await fixture();
      await rm(path.join(root, "git-meta"), { recursive: true });
      await symlink(outside, path.join(root, "git-meta"), "dir");
      expect((await run("echo bad > git-meta/should-not-exist")).exitCode).not.toBe(0);
      await expect(readFile(path.join(outside, "should-not-exist"), "utf8")).rejects.toThrow();
      expect((await run(`node -e 'process.stdout.write(process.env.CHIVGENT_TEST_SECRET || "")'`)).out).not.toContain(secret);
      const network = await run("node -e 'require(\"node:net\").connect(443,\"1.1.1.1\").on(\"connect\",()=>process.exit(1)).on(\"error\",()=>process.exit(0)); setTimeout(()=>process.exit(1),1000)'");
      expect(network.exitCode).toBe(0);
    } finally {
      delete process.env.CHIVGENT_TEST_SECRET;
    }
  });

  it.skipIf(process.platform !== "darwin")("does not fall back when sandbox-exec is missing", async () => {
    const root = await fixture();
    const ops = createNativeShellOperations({ allowWrites: true, sandboxExecutable: "/missing/chivgent-sandbox-exec" });
    await expect(ops.exec("echo bad > should-not-exist", root, { onData: () => undefined })).rejects.toThrow();
    await expect(readFile(path.join(root, "should-not-exist"), "utf8")).rejects.toThrow();
  });

  it.skipIf(process.platform === "darwin")("fails closed when native Seatbelt is unavailable", async () => {
    const root = await fixture();
    await expect(createNativeShellOperations().exec("echo must-not-run", root, { onData: () => undefined }))
      .rejects.toThrow(/supported only on macOS/);
  });
});

async function mkdirProtected(root: string): Promise<void> {
  await mkdir(path.join(root, ".git"));
}
