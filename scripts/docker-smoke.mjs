import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BashTool } from "../dist/tools/bash.js";

const root = await mkdtemp(path.join(tmpdir(), "chivgent-sandbox-smoke-"));
process.env.CHIVGENT_TEST_SECRET = "must-not-leak-into-container";
const tool = new BashTool({ cwd: root, approve: async () => true });

try {
  await writeFile(path.join(root, "writable.txt"), "before");
  const result = await tool.execute({
    command: "pwd; echo after > writable.txt; cat writable.txt; printenv CHIVGENT_TEST_SECRET || true",
    timeout: 20,
  }, { workspace: {} });

  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /\/workspace/);
  assert.match(result.content, /after/);
  assert.doesNotMatch(result.content, /must-not-leak/);

  const network = await tool.execute({
    command: "node -e 'const s=require(\"node:net\").connect(443,\"1.1.1.1\"); s.on(\"connect\",()=>process.exit(1)); s.on(\"error\",()=>process.exit(0)); setTimeout(()=>process.exit(1),2000)'",
    timeout: 10,
  }, { workspace: {} });
  assert.equal(network.isError, false, `sandbox unexpectedly had network access: ${network.content}`);
  process.stdout.write("Docker sandbox smoke passed (writable workspace; no host env secret; outbound network blocked).\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
