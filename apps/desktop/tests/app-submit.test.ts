import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, mounted: false }));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  function useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [hooks.slots[index] as T, (value: T | ((previous: T) => T)) => {
      hooks.slots[index] = typeof value === "function" ? (value as (previous: T) => T)(hooks.slots[index] as T) : value;
    }] as const;
  }
  return {
    ...actual,
    useState,
    useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S) {
      const [state, setState] = useState(initial);
      return [state, (action: A) => setState((previous: S) => reducer(previous, action))];
    },
    useRef<T>(initial: T) {
      const [ref] = useState(() => ({ current: initial }));
      return ref;
    },
    useEffect(effect: () => void) { if (!hooks.mounted) hooks.effects.push(effect); },
    useLayoutEffect() {},
  };
});

import { App } from "../src/app/App.js";
import { initialDeskState, reduceDesk } from "../src/app/reduce.js";
import { validateMainToHost } from "../src/protocol/messages.js";

interface StartPayload { requestId: string; prompt: string; provider?: string; model?: string }
interface TestApi {
  start: (payload: StartPayload) => Promise<any>;
  initialize: () => Promise<any>;
  selectProject: () => Promise<any>;
  saveProviderProfile: (payload: any) => Promise<any>;
  interrupt: () => Promise<any>;
  onEvent: (listener: (message: any) => void) => () => void;
  onHostStatus: (listener: (status: any) => void) => () => void;
}

describe("App submit flow", () => {
  let api: TestApi;
  let respond: (payload: StartPayload) => Promise<any>;
  let publishEvent: (message: any) => void;
  let publishStatus: (status: any) => void;

  beforeEach(() => {
    hooks.slots = [];
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.mounted = false;
    let eventListener: ((message: any) => void) | undefined;
    let statusListener: ((status: any) => void) | undefined;
    publishEvent = (message) => eventListener?.(message);
    publishStatus = (status) => statusListener?.(status);
    respond = async () => ({ ok: true, value: { type: "started", runId: "accepted-run" } });
    api = {
      start: vi.fn(async (payload: StartPayload) => {
        const validated = validateMainToHost({ type: "start", ...payload });
        if (typeof validated === "string") return { ok: false, code: "bad_request", message: validated };
        return respond(payload);
      }),
      initialize: vi.fn(async () => {
        statusListener?.({ phase: "ready" });
        eventListener?.({ type: "initialized", requestId: "boot", protocolVersion: 1, hostInstanceId: "test-host", capabilities: ["real-agent"], defaultProvider: "openai", snapshot: { hostInstanceId: "test-host", sessionId: "test-session", projectPath: "/tmp/test-project", sequence: 0, events: [], runs: [], incomplete: false, corruption: null } });
        return { ok: true, value: { type: "initialized" } };
      }),
      selectProject: vi.fn(async () => ({ ok: false, code: "cancelled", message: "cancelled" })),
      saveProviderProfile: vi.fn(async (payload) => ({ ok: true, value: { type: "provider-profile-saved", requestId: payload.requestId, profile: { provider: payload.provider, model: payload.model, ...(payload.baseURL ? { baseURL: payload.baseURL } : {}), configured: true } } })),
      interrupt: vi.fn(async () => ({ ok: true, value: { type: "interrupted" } })),
      onEvent: vi.fn((listener) => { eventListener = listener; return () => {}; }),
      onHostStatus: vi.fn((listener) => { statusListener = listener; return () => {}; }),
    };
    vi.stubGlobal("window", { chivgent: api });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers explicit host recovery that only initializes and restores a snapshot", async () => {
    let tree = await renderApp();
    publishStatus({ phase: "exited", message: "Agent host 已退出。进行中的运行结果未知。" });
    tree = await renderApp();
    const recover = findByLabel(tree, "重新连接并恢复会话");
    expect(recover).not.toBeNull();
    await recover.props.onClick();
    expect(api.initialize).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("keeps a prompt after a history write rejection and allows a corrected retry", async () => {
    respond = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "history_write_failed", message: "历史保存失败，未开始运行。" })
      .mockResolvedValueOnce({ ok: true, value: { type: "started", runId: "accepted-run" } });
    const original = "Please fix the parser issue.";
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: original } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();

    expect(find(tree, "composer").props.value).toBe(original);
    expect(find(tree, "notice").props.children).toContain("历史保存失败");
    expect(find(tree, "user-message")).toBeNull();

    const corrected = "Please fix the parser issue near the closing brace.";
    find(tree, "composer").props.onChange({ target: { value: corrected } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(find(tree, "composer").props.value).toBe("");
    expect(find(tree, "user-message").props.children).toBe(corrected);
  });

  it("warns at 32001 characters and leaves the prompt unchanged without sending", async () => {
    let tree = await renderApp();
    const prompt = "x".repeat(32_001);
    find(tree, "composer").props.onChange({ target: { value: prompt } });
    tree = await renderApp();
    expect(find(tree, "composer-limit").props.children).toContain("32000");
    expect(find(tree, "send").props.disabled).toBe(true);
    expect(find(tree, "composer").props.value).toBe(prompt);
    expect(api.start).not.toHaveBeenCalled();
    expect(validateMainToHost({ type: "start", requestId: "edge", prompt: "x".repeat(32_000) })).toMatchObject({ type: "start" });
    expect(validateMainToHost({ type: "start", requestId: "edge", prompt })).toBe("prompt exceeds 32000 characters.");
  });

  it("submits the 32000-character prompt through the App callback", async () => {
    let tree = await renderApp();
    const prompt = "x".repeat(32_000);
    find(tree, "composer").props.onChange({ target: { value: prompt } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
  });

  it("submits a 160-character model through the App callback", async () => {
    let tree = await renderApp();
    findByText(tree, "设置").props.onClick();
    tree = await renderApp();
    findByLabel(tree, "Model").props.onChange({ target: { value: "m".repeat(160) } });
    tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "valid prompt" } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: "valid prompt", model: "m".repeat(160) }));
    expect(validateMainToHost({ type: "start", requestId: "edge", prompt: "ok", model: "m".repeat(160) })).toMatchObject({ type: "start" });
  });

  it("does not overwrite a model edited by the user when initialization is resynchronized", async () => {
    let tree = await renderApp();
    findByText(tree, "设置").props.onClick();
    tree = await renderApp();
    findByLabel(tree, "Model").props.onChange({ target: { value: "user-selected-model" } });
    tree = await renderApp();
    publishEvent({ type: "initialized", requestId: "resync", protocolVersion: 1, hostInstanceId: "test-host", capabilities: ["real-agent"], defaultProvider: "openai", providerProfiles: [{ provider: "openai", model: "saved-default-model", configured: true }] });
    tree = await renderApp();
    expect(findByLabel(tree, "Model").props.value).toBe("user-selected-model");
  });

  it("allows updating a saved profile without resending its API key", async () => {
    let tree = await renderApp();
    publishEvent({ type: "initialized", requestId: "profile", protocolVersion: 1, hostInstanceId: "test-host", capabilities: ["real-agent"], defaultProvider: "openai", providerProfiles: [{ provider: "openai", model: "old-model", configured: true }] });
    tree = await renderApp();
    findByText(tree, "设置").props.onClick();
    tree = await renderApp();
    findByLabel(tree, "Model").props.onChange({ target: { value: "new-model" } });
    tree = await renderApp();
    const save = findByText(tree, "保存 Provider 配置");
    expect(save.props.disabled).toBe(false);
    await save.props.onClick();
    tree = await renderApp();
    expect(api.saveProviderProfile).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "new-model" }));
    expect(api.saveProviderProfile.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
  });

  it("restores the environment endpoint when switching back to the compatible Provider", async () => {
    let tree = await renderApp();
    publishEvent({ type: "initialized", requestId: "resync", protocolVersion: 1, hostInstanceId: "test-host", capabilities: ["real-agent"], defaultProvider: "openai", compatibleBaseURL: "http://127.0.0.1:43127/v1" });
    tree = await renderApp();
    findByText(tree, "设置").props.onClick();
    tree = await renderApp();
    findByLabel(tree, "Provider").props.onChange({ target: { value: "openai-compatible" } });
    tree = await renderApp();
    expect(findByLabel(tree, "兼容 endpoint").props.value).toBe("http://127.0.0.1:43127/v1");
    findByLabel(tree, "Provider").props.onChange({ target: { value: "deepseek" } });
    tree = await renderApp();
    findByLabel(tree, "Provider").props.onChange({ target: { value: "openai-compatible" } });
    tree = await renderApp();
    expect(findByLabel(tree, "兼容 endpoint").props.value).toBe("http://127.0.0.1:43127/v1");
  });

  it("gives a pre-send warning at 161 model characters", async () => {
    let tree = await renderApp();
    findByText(tree, "设置").props.onClick();
    tree = await renderApp();
    findByLabel(tree, "Model").props.onChange({ target: { value: "m".repeat(161) } });
    tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "valid prompt" } });
    tree = await renderApp();
    expect(find(tree, "composer-limit").props.children).toContain("160");
    expect(find(tree, "send").props.disabled).toBe(true);
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    expect(api.start).not.toHaveBeenCalled();
    expect(find(tree, "composer").props.value).toBe("valid prompt");
  });

  it("does not replace a newer draft while a rejected start is pending", async () => {
    let finish!: (value: any) => void;
    respond = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "original prompt" } });
    tree = await renderApp();
    const pending = findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "newer draft" } });
    finish({ ok: false, code: "history_write_failed", message: "历史保存失败，未开始运行" });
    await pending;
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("newer draft");
  });

  it("clears only the submitted draft after acceptance and preserves a newer draft", async () => {
    let finish!: (value: any) => void;
    respond = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "accepted prompt" } });
    tree = await renderApp();
    const pending = findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "draft for next run" } });
    finish({ ok: true, value: { type: "started", runId: "accepted-run" } });
    await pending;
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("draft for next run");
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("sends only once when submit is triggered twice before the first acknowledgement", async () => {
    let finish!: (value: any) => void;
    respond = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "one run only" } });
    tree = await renderApp();
    const form = findType(tree, "form");
    form.props.onSubmit({ preventDefault() {} });
    form.props.onSubmit({ preventDefault() {} });
    expect(api.start).toHaveBeenCalledTimes(1);
    finish({ ok: true, value: { type: "started", runId: "accepted-run" } });
    await renderApp();
  });

  it("keeps an unknown-timeout draft visible without automatically retrying", async () => {
    respond = vi.fn(async () => ({ ok: false, code: "host_unavailable", message: "Agent host 没有在时限内回应。" }));
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "uncertain prompt" } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("uncertain prompt");
    expect(find(tree, "notice").props.children).toContain("结果未知");
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("keeps a broadcast-accepted run active when the invoke promise later rejects", async () => {
    let fail!: (error: Error) => void;
    respond = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "accepted before invoke failure" } });
    tree = await renderApp();
    const pending = findType(tree, "form").props.onSubmit({ preventDefault() {} });
    const requestId = (api.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].requestId as string;

    publishEvent({ type: "started", requestId, runId: "accepted-run", replayed: false });
    tree = await renderApp();
    fail(new Error("invoke timed out after host accepted"));
    await pending;
    tree = await renderApp();
    expect(find(tree, "run-status").props.children).toBe("运行中");
    expect(find(tree, "composer").props.value).toBe("");

    publishEvent({ type: "event", hostInstanceId: "test-host", sessionId: "test-session", runId: "accepted-run", sequence: 1, event: { type: "agent_end", status: "completed" } });
    tree = await renderApp();
    expect(find(tree, "run-status").props.children).toBe("已完成");
    expect(find(tree, "notice")).toBeNull();
  });

  it("keeps a broadcast-accepted run active after a host_unavailable result", async () => {
    let finish!: (value: any) => void;
    respond = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "accepted prompt" } });
    tree = await renderApp();
    const pending = findType(tree, "form").props.onSubmit({ preventDefault() {} });
    const requestId = (api.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].requestId as string;
    tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "newer draft" } });
    tree = await renderApp();
    publishEvent({ type: "started", requestId, runId: "accepted-run", replayed: false });
    finish({ ok: false, code: "host_unavailable", message: "Agent host 没有在时限内回应。" });
    await pending;
    tree = await renderApp();
    expect(find(tree, "run-status").props.children).toBe("运行中");
    expect(find(tree, "composer").props.value).toBe("newer draft");

    publishEvent({ type: "event", hostInstanceId: "test-host", sessionId: "test-session", runId: "accepted-run", sequence: 1, event: { type: "agent_end", status: "completed" } });
    tree = await renderApp();
    expect(find(tree, "run-status").props.children).toBe("已完成");
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("ignores an old start acknowledgement after switching projects", async () => {
    let finish!: (value: any) => void;
    respond = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    let tree = await renderApp();
    api.initialize = vi.fn(async () => ({ ok: true, value: { type: "initialized" } }));
    find(tree, "composer").props.onChange({ target: { value: "accepted prompt" } });
    tree = await renderApp();
    const pending = findType(tree, "form").props.onSubmit({ preventDefault() {} });
    const requestId = (api.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].requestId as string;
    publishEvent({ type: "started", requestId, runId: "accepted-run", replayed: false });
    publishEvent({ type: "event", hostInstanceId: "test-host", sessionId: "test-session", runId: "accepted-run", sequence: 1, event: { type: "agent_end", status: "completed" } });
    tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "draft for another project" } });
    tree = await renderApp();
    api.selectProject = vi.fn(async () => ({ ok: true, value: { type: "project-selected", path: "/tmp/other-project" } }));
    findByClass(tree, "new-task").props.onClick();
    tree = await renderApp();

    finish({ ok: true, value: { type: "started", runId: "accepted-run" } });
    await pending;
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("draft for another project");
    expect(find(tree, "run-status").props.children).toBe("就绪");
  });

  it("keeps an unknown draft when IPC rejects and clears the pending state", async () => {
    respond = vi.fn(async () => { throw new Error("invoke timed out"); });
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "invoke uncertain" } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("invoke uncertain");
    expect(find(tree, "notice").props.children).toContain("结果未知");
    expect(find(tree, "send").props.disabled).toBe(false);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("does not restore an accepted run's prompt after a later run error", async () => {
    let tree = await renderApp();
    find(tree, "composer").props.onChange({ target: { value: "accepted before credentials failed" } });
    tree = await renderApp();
    await findType(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("");
    publishEvent({ type: "error", requestId: "accepted-request", runId: "accepted-run", code: "run_error", message: "缺少模型凭证。" });
    tree = await renderApp();
    expect(find(tree, "composer").props.value).toBe("");
    expect(find(tree, "notice").props.children).toContain("缺少模型凭证");
  });

  it("ignores a rejection action after the run has been acknowledged", () => {
    const submitted = reduceDesk(initialDeskState, { type: "submit", text: "already accepted" });
    const started = reduceDesk(submitted, { type: "started", runId: "run-accepted" });
    expect(reduceDesk(started, { type: "reject-submit", text: "already accepted", message: "late rejection" })).toBe(started);
  });
});

async function renderApp(): Promise<any> {
  hooks.cursor = 0;
  let tree = App();
  for (const effect of hooks.effects.splice(0)) effect();
  hooks.mounted = true;
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  hooks.cursor = 0;
  tree = App();
  return tree;
}

function find(node: any, testId: string): any | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (node.props?.["data-testid"] === testId) return node;
  if (typeof node.type === "function") return find(node.type(node.props), testId);
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, testId);
    if (result !== null) return result;
  }
  return null;
}

function findType(node: any, type: string): any | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (node.type === type) return node;
  if (typeof node.type === "function") return findType(node.type(node.props), type);
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = findType(child, type);
    if (result !== null) return result;
  }
  return null;
}

function findByText(node: any, text: string): any | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (node.props?.children === text) return node;
  if (typeof node.type === "function") return findByText(node.type(node.props), text);
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = findByText(child, text);
    if (result !== null) return result;
  }
  return null;
}

function findByLabel(node: any, label: string): any | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (node.props?.["aria-label"] === label) return node;
  if (typeof node.type === "function") return findByLabel(node.type(node.props), label);
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = findByLabel(child, label);
    if (result !== null) return result;
  }
  return null;
}

function findByClass(node: any, className: string): any | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (node.props?.className === className) return node;
  if (typeof node.type === "function") return findByClass(node.type(node.props), className);
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = findByClass(child, className);
    if (result !== null) return result;
  }
  return null;
}
