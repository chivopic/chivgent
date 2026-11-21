import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const bytes = await readFile(path.join(root, "evals-web", "tasks.json"), "utf8");
const suite = JSON.parse(bytes);
const { values } = parseArgs({ options: {
  backend: { type: "string", default: "fixture" },
  model: { type: "string", default: "deepseek-flash" },
  attempts: { type: "string", default: "1" },
  task: { type: "string", multiple: true },
  json: { type: "string" },
  "dry-run": { type: "boolean" },
} });
const attempts = Number(values.attempts);
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw Error("--attempts must be 1–10.");

const tasks = suite.filter((t) => Boolean(t.fixture) === (values.backend === "fixture"));
for (const id of values.task ?? []) {
  if (!tasks.some((t) => t.id === id)) throw Error(`Unknown task for this backend: ${id}`);
}
const selected = tasks.filter((t) => !values.task || values.task.includes(t.id));
const cli = process.env.CHIVGENT_EVAL_CLI ?? path.join(root, "dist", "cli.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = promisify(execFile);
const [revision, status, builtPrompt] = await Promise.all([
  git("git", ["rev-parse", "HEAD"], { cwd: root }).catch(() => ({ stdout: "unknown" })),
  git("git", ["status", "--porcelain"], { cwd: root }).catch(() => undefined),
  readFile(path.join(path.dirname(cli), "prompts.js")).catch((error) => {
    if (values["dry-run"] && error.code === "ENOENT") return undefined;
    throw error;
  }),
]);
const metadata = {
  suiteSha256: hash(JSON.stringify(selected)),
  promptSha256: builtPrompt === undefined ? null : hash(builtPrompt),
  git: revision.stdout.trim(),
  dirty: status === undefined ? null : status.stdout.trim().length > 0,
  backend: values.backend, model: values.model, attempts, tasks: selected.map((t) => t.id),
};
const pattern = (expression) => new RegExp(expression, "iu");
const matches = (expressions, text) => expressions.every((e) => pattern(e).test(text));
for (const task of selected) {
  for (const expression of [...task.facts, ...(task.exclude ?? []), ...(task.evidence ?? []), ...(task.source ? [task.source] : [])]) pattern(expression);
}
if (values["dry-run"]) {
  console.log(JSON.stringify(metadata, null, 2));
  process.exit(0);
}

const workspace = await mkdtemp(path.join(tmpdir(), "chivgent-web-eval-"));
const reports = [];
const requests = new Map();
let server;
try {
  let endpoint = values.backend;
  if (endpoint === "fixture") {
    server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const task = selected.find((t) => url.pathname === `/${t.id}/search`);
      if (!task || !url.searchParams.get("q") || url.searchParams.get("format") !== "json") {
        res.writeHead(400).end();
        return;
      }
      requests.set(task.id, (requests.get(task.id) ?? 0) + 1);
      const { status = 200, results } = task.fixture;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ results }));
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${server.address().port}`;
  }

  const jobs = selected.flatMap((task) => Array.from({ length: attempts }, (_, i) => ({ task, attempt: i + 1 })));
  await Promise.all(Array.from({ length: values.backend === "fixture" ? 1 : 3 }, async () => {
    for (let job; (job = jobs.shift());) {
      const before = requests.get(job.task.id) ?? 0;
      const result = await evaluate(job.task, job.attempt, endpoint);
      if (job.task.fixture) {
        result.backendRequests = (requests.get(job.task.id) ?? 0) - before;
        result.fixturePassed = result.fact && (result.citation ?? true) &&
          result.backendRequests === 1 && result.searches.length === 1 && result.shellCalls === 0 &&
          result.searches[0].error === ((job.task.fixture.status ?? 200) !== 200);
      }
      reports.push(result);
      console.log(`${result.id} #${result.attempt} ${result.status} fact=${result.fact} citation=${result.citation ?? "-"} searches=${result.searches.length} shell=${result.shellCalls}`);
    }
  }));
  reports.sort((a, b) => a.id.localeCompare(b.id) || a.attempt - b.attempt);
  const summary = {
    runs: reports.length,
    completed: reports.filter((r) => r.status === "completed").length,
    factual: reports.filter((r) => r.fact).length,
    supportedCitations: reports.filter((r) => r.citation === true).length,
    citationTasks: reports.filter((r) => r.citation !== undefined).length,
    searchCalls: reports.flatMap((r) => r.searches).length,
    shellCalls: reports.reduce((sum, report) => sum + report.shellCalls, 0),
    usefulRetrievals: reports.filter((r) => r.retrievedEvidence).length,
    unexpectedSearchOnControl: reports.filter((r) => r.id === "stable" && r.searches.length > 0).length,
    toolErrors: reports.flatMap((r) => r.searches).filter((result) => result.error).length,
    ...(values.backend === "fixture" ? { fixturePassed: reports.filter((r) => r.fixturePassed).length } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (values.json) await writeFile(values.json, JSON.stringify({ ...metadata, summary, reports }, null, 2) + "\n");
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(workspace, { recursive: true, force: true });
}

async function evaluate(task, attempt, endpoint) {
  const args = [
    cli,
    "--provider", "deepseek", "--model", values.model, "--no-session", "--no-extensions",
    "--json", "--max-turns", "5", "--permission-mode", "ask-first",
  ];
  if (endpoint === "off") {
    args.push("--no-web-search");
  } else if (endpoint !== "deepseek") {
    args.push("--web-search", task.fixture ? `${endpoint}/${task.id}` : endpoint,
      "--approve-web-search");
  }
  const ask = task.fixture || task.id === "stable"
    ? task.question
    : task.question + " Answer briefly in the question's language. If web search is available, use at most two focused searches, prioritizing the named official source. Include only URLs supported by the retrieved evidence. Say when the evidence is insufficient.";
  const started = Date.now();
  const environment = { ...process.env };
  if (task.fixture) delete environment.CHIVGENT_WEB_SEARCH_TOKEN;
  const child = spawn(process.execPath, [...args, ask], {
    cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => child.once("error", reject).once("close", resolve));
  const events = stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  const final = events.findLast((e) => e.type === "agent_end");
  const answer = final?.messages.findLast((m) => m.role === "assistant")?.content ?? "";
  const shellCalls = events.filter((e) => e.type === "tool_execution_start" && e.toolName === "bash").length;
  const searches = events.filter((e) => e.type === "tool_execution_end" && e.toolName === "web_search")
    .map((e) => ({
      error: e.isError,
      headline: e.content.split("\n", 1)[0],
      results: e.content.split("\n").flatMap((line) => {
        const data = line.match(/^\d+\. (\{.*\})$/)?.[1];
        return data ? [JSON.parse(data)] : [];
      }),
    }));
  const fact = final?.status === "completed" && matches(task.facts, answer)
    && (task.exclude ?? []).every((e) => !pattern(e).test(answer));
  const normalUrl = (url) => {
    const parsed = new URL(url.replace(/[.,;]+$/, ""));
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_") || (parsed.hostname === "www.apple.com" && ["afid", "cid"].includes(key))) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.href.replace(/\/$/, "");
  };
  const urls = new Set();
  for (const url of answer.match(/https?:\/\/[^\s\x60)\]<>]+/gu) ?? []) {
    if (URL.canParse(url)) urls.add(normalUrl(url));
  }
  const sources = task.source
    ? searches.flatMap((s) => s.results).filter((r) => pattern(task.source).test(r.url))
    : [];
  const evidence = (hits) => matches(task.evidence ?? task.facts, hits.map((r) => `${r.title} ${r.snippet}`).join("\n"));
  const status = final?.status ?? "error";
  return {
    id: task.id, attempt, status, fact, searches, shellCalls, answer, elapsedMs: Date.now() - started,
    ...(task.source === undefined ? {} : {
      citation: Boolean(fact && evidence(sources.filter((r) => urls.has(normalUrl(r.url))))),
      retrievedEvidence: evidence(sources),
    }),
    ...(final?.usage ? { usage: final.usage } : {}),
    ...(status === "completed" ? {} : { code, error: final?.error ?? stderr.split("\n", 1)[0] }),
  };
}
