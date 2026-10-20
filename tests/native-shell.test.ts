import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
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
    expect(readOnly.args.join(" ")).toContain(`(deny file-read* (subpath ${JSON.stringify(await realpath(homedir()))}))`);
    expect(readOnly.args.join(" ")).toContain(`(allow file-read* (subpath ${JSON.stringify(await realpath(root))}))`);
    for (const rootPath of ["/Users", "/Volumes"]) {
      const rule = `(deny file-read* (subpath ${JSON.stringify(rootPath)}))`;
      if (existsSync(rootPath)) expect(readOnly.args.join(" ")).toContain(rule);
      else expect(readOnly.args.join(" ")).not.toContain(rule);
    }
    expect(readOnly.args.join(" ")).toContain("(deny file-write*");
    expect(readOnly.args.join(" ")).not.toContain("(allow network*)");
    expect(nativeShellConfig(root, { allowWrites: true, allowNetwork: true, temporaryDirectory: temp, sandboxExecutable: "/bin/echo" }).args.join(" ")).toContain("(allow network*)");
    expect(createNativeShellOperations({ allowNetwork: true }).networkAccess).toBe(true);
    expect(createNativeShellOperations({ allowNetwork: false }).networkAccess).toBe(false);
  });
  it("confines filesystem reads and writes even when network is enabled", async () => {
    const root = await fixture();
    const temp = await mkdtemp(path.join(tmpdir(), "chivgent-native-private-"));
    roots.push(temp);
    const netOnly = nativeShellConfig(root, { allowWrites: true, allowNetwork: true, allowHostAccess: false, temporaryDirectory: temp, sandboxExecutable: "/bin/echo" });
    const netRules = netOnly.args.join(" ");
    expect(netRules).toContain("(allow network*)");
    expect(netRules).toContain(`(deny file-read* (subpath ${JSON.stringify(await realpath(homedir()))}))`);
    expect(netRules).toContain(`(deny file-read* (subpath ${JSON.stringify(await realpath(tmpdir()))}))`);
    expect(netRules).toContain(`(allow file-write* (subpath ${JSON.stringify(await realpath(root))}))`);
    expect(netRules).not.toContain('(allow file-write* (subpath "/dev/null")) (allow file-write*)');

    const hostAccess = nativeShellConfig(root, { allowWrites: true, allowNetwork: true, allowHostAccess: true, temporaryDirectory: temp, sandboxExecutable: "/bin/echo" });
    const hostRules = hostAccess.args.join(" ");
    expect(hostRules).toContain("(allow file-read*)");
    expect(hostRules).toContain("(allow file-write*)");
    expect(hostRules).not.toContain(`(deny file-read* (subpath ${JSON.stringify(await realpath(homedir()))}))`);
  });

  it.skipIf(process.platform !== "darwin")("enforces workspace writes, protected paths, env and network at runtime", async () => {
    const root = await fixture();
    const secret = "native-shell-secret-must-not-leak";
    process.env.CHIVGENT_TEST_SECRET = secret;
    await mkdirProtected(root);
    await mkdir(path.join(root, ".aws"));
    await writeFile(path.join(root, ".aws", "credentials"), "workspace-aws-secret");
    const ops = createNativeShellOperations({ allowWrites: true });
    const run = async (command: string, shell = ops) => {
      let out = "";
      const result = await shell.exec(command, root, { onData: (chunk) => { out += chunk.toString(); } });
      return { ...result, out };
    };
    const server = createServer(socket => {
      socket.on("error", () => undefined);
      socket.end("loopback");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Loopback fixture did not bind a TCP port.");
      const networkCommand = `node -e 'const s=require("node:net").connect(${address.port},"127.0.0.1"); s.on("connect",()=>process.exit(0)); s.on("error",()=>process.exit(1)); setTimeout(()=>process.exit(2),1000)'`;
      expect((await run("echo ok > allowed.txt")).exitCode).toBe(0);
      expect(await readFile(path.join(root, "allowed.txt"), "utf8")).toBe("ok\n");
      expect((await run("cat allowed.txt")).out).toContain("ok");
      const homeFile = path.join(homedir(), ".gitconfig");
      const homeRead = await run(`cat ${JSON.stringify(homeFile)}`);
      expect(homeRead.exitCode).not.toBe(0);
      const homeLink = path.join(root, "home-link");
      await symlink(homeFile, homeLink);
      const homeSymlinkRead = await run("cat home-link");
      expect(homeSymlinkRead.exitCode).not.toBe(0);
      const credentialRead = await run("cat .aws/credentials");
      expect(credentialRead.exitCode).not.toBe(0);
      expect(credentialRead.out).not.toContain("workspace-aws-secret");
      const outside = await fixture();
      await writeFile(path.join(outside, "private.txt"), "outside-workspace-secret");
      const externalRead = await run(`cat ${JSON.stringify(path.join(outside, "private.txt"))}`);
      expect(externalRead.exitCode).not.toBe(0);
      expect(externalRead.out).not.toContain("outside-workspace-secret");
      await symlink(path.join(outside, "private.txt"), path.join(root, "external-link"));
      const symlinkRead = await run("cat external-link");
      expect(symlinkRead.exitCode).not.toBe(0);
      expect(symlinkRead.out).not.toContain("outside-workspace-secret");
      expect((await run("node --version")).exitCode).toBe(0);
      const workspaceAlias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
      await symlink(root, workspaceAlias, "dir");
      const aliasOps = createNativeShellOperations({ allowWrites: true });
      let aliasOutput = "";
      await aliasOps.exec("cat allowed.txt", workspaceAlias, { onData: (chunk) => { aliasOutput += chunk.toString(); } });
      expect(aliasOutput).toContain("ok");
      const readOnly = createNativeShellOperations();
      expect((await readOnly.exec("echo denied > readonly.txt", root, { onData: () => undefined })).exitCode).not.toBe(0);
      expect((await run("echo bad > .git/should-not-exist")).exitCode).not.toBe(0);
      await rm(path.join(root, ".git"), { recursive: true });
      await mkdir(path.join(root, "git-meta"));
      await writeFile(path.join(root, ".git"), "gitdir: git-meta\n");
      expect((await run("echo bad > git-meta/should-not-exist")).exitCode).not.toBe(0);
      const outsideGit = await fixture();
      await rm(path.join(root, "git-meta"), { recursive: true });
      await symlink(outsideGit, path.join(root, "git-meta"), "dir");
      expect((await run("echo bad > git-meta/should-not-exist")).exitCode).not.toBe(0);
      await expect(readFile(path.join(outsideGit, "should-not-exist"), "utf8")).rejects.toThrow();
      expect((await run(`node -e 'process.stdout.write(process.env.CHIVGENT_TEST_SECRET || "")'`)).out).not.toContain(secret);
      const network = await run(networkCommand);
      expect(network.exitCode).not.toBe(0);
      const networkEnabled = createNativeShellOperations({ allowWrites: true, allowNetwork: true });
      expect((await run(networkCommand, networkEnabled)).exitCode).toBe(0);
      const isolatedRead = await run(`cat ${JSON.stringify(path.join(outside, "private.txt"))}`, networkEnabled);
      expect(isolatedRead.exitCode).not.toBe(0);
      expect(isolatedRead.out).not.toContain("outside-workspace-secret");
    } finally {
      delete process.env.CHIVGENT_TEST_SECRET;
      await new Promise<void>(resolve => server.close(() => resolve()));
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
