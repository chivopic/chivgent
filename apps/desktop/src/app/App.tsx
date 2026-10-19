import { useEffect, useLayoutEffect, useReducer, useRef, useState, type JSX } from "react";
import { nextRequestId, shouldSubmitOnEnter } from "./input.js";
import { initialDeskState, phaseLabel, reduceDesk, type TimelineItem } from "./reduce.js";
import { isNearBottom } from "./scroll.js";
import type { HostStatus, HostToMain, IpcResult } from "../protocol/messages.js";
import leafMark from "./assets/chivgent-leaf-mark.png";

interface DesktopApi {
  initialize(): Promise<IpcResult<HostToMain>>;
  selectProject(): Promise<IpcResult<HostToMain>>;
  start(payload: { requestId: string; prompt: string; provider?: string; model?: string }): Promise<IpcResult<HostToMain>>;
  interrupt(payload: { requestId: string; runId: string }): Promise<IpcResult<HostToMain>>;
  onEvent(listener: (message: HostToMain) => void): () => void;
  onHostStatus(listener: (status: HostStatus) => void): () => void;
}

declare global {
  interface Window {
    chivgent?: DesktopApi;
  }
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduceDesk, initialDeskState);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [stuck, setStuck] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectPath, setProjectPath] = useState("");
  const [projectError, setProjectError] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState("");
  const [compatibleEndpoint, setCompatibleEndpoint] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const ignoreEnter = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const pendingStartRef = useRef<string | null>(null);
  const eventCursorRef = useRef({ hostInstanceId: "", sessionId: "", sequence: 0, refreshing: false });
  const providerDefaultAppliedRef = useRef(false);
  runIdRef.current = state.runId;

  useEffect(() => {
    const api = window.chivgent;
    if (api === undefined) {
      dispatch({
        type: "host",
        status: { phase: "failed", message: "预加载接口不可用。桌面桥没有暴露给页面。" },
      });
      return;
    }
    const stopEvents = api.onEvent((message) => {
      if (message.type === "initialized") {
        if (!providerDefaultAppliedRef.current) {
          setProvider(message.defaultProvider);
          providerDefaultAppliedRef.current = true;
        }
        setCompatibleEndpoint(message.compatibleBaseURL ?? "");
        setDemoMode(message.capabilities.includes("demo-agent"));
        if (message.historyNotice !== undefined) {
          setProjectError(message.historyNotice);
          dispatch({ type: "fail", message: message.historyNotice });
        }
        if (message.snapshot !== undefined) {
          const cursor = eventCursorRef.current;
          if (cursor.hostInstanceId === message.snapshot.hostInstanceId && cursor.sessionId === message.snapshot.sessionId && message.snapshot.sequence < cursor.sequence) return;
          setProjectPath(message.snapshot.projectPath);
          eventCursorRef.current = { hostInstanceId: message.snapshot.hostInstanceId, sessionId: message.snapshot.sessionId, sequence: message.snapshot.sequence, refreshing: false };
          dispatch({ type: "hydrate", snapshot: message.snapshot });
        }
      } else if (message.type === "runtime-config") {
        setRuntimeConfig(`${message.provider} · ${message.model}${message.baseURL ? ` · ${message.baseURL}` : ""}`);
      } else if (message.type === "started") {
        // Broadcast can arrive before the invoke ACK; claim this run only
        // when it belongs to the currently pending request.
        if (message.requestId === pendingStartRef.current) {
          dispatch({ type: "started", runId: message.runId });
        }
      } else if (message.type === "event") {
        const cursor = eventCursorRef.current;
        if (cursor.hostInstanceId !== "" && (message.hostInstanceId !== cursor.hostInstanceId || message.sessionId !== cursor.sessionId)) {
          if (!cursor.refreshing) {
            cursor.refreshing = true;
            void api.initialize().then((result) => {
              if (!result.ok) dispatch({ type: "fail", message: `无法重新同步会话：${result.message}` });
            }).finally(() => { eventCursorRef.current.refreshing = false; });
          }
          return;
        }
        if (message.sequence <= cursor.sequence) return;
        if (cursor.sequence > 0 && message.sequence !== cursor.sequence + 1) {
          if (!cursor.refreshing) {
            cursor.refreshing = true;
            void api.initialize().then((result) => {
              if (!result.ok) dispatch({ type: "fail", message: `事件缺口后无法重新同步：${result.message}` });
            }).finally(() => { eventCursorRef.current.refreshing = false; });
          }
          return;
        }
        eventCursorRef.current = { ...cursor, sequence: message.sequence };
        dispatch({
          type: "agent",
          hostInstanceId: message.hostInstanceId,
          sessionId: message.sessionId,
          runId: message.runId,
          sequence: message.sequence,
          event: message.event,
        });
      } else if (message.type === "error" && message.runId !== undefined) {
        // Correlate terminal errors with their run; picker errors have no runId.
        dispatch({ type: "run-error", runId: message.runId, message: message.message,
          cancelled: message.code === "cancelled" });
      }
    });
    const stopStatus = api.onHostStatus((status) => {
      dispatch({ type: "host", status });
    });
    void api.initialize().then((result) => {
      if (!result.ok) {
        dispatch({ type: "fail", message: result.message });
      }
    });
    return () => {
      stopEvents();
      stopStatus();
    };
  }, []);

  useEffect(() => {
    const node = composerRef.current;
    if (node === null) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, [draft]);

  useLayoutEffect(() => {
    const node = timelineRef.current;
    if (node !== null && stuck) {
      node.scrollTop = node.scrollHeight;
    }
  }, [state.items, stuck]);

  useEffect(() => {
    const node = composerRef.current;
    if (node === null) {
      return;
    }
    const start = (): void => {
      ignoreEnter.current = true;
    };
    const end = (): void => {
      ignoreEnter.current = true;
      window.setTimeout(() => {
        ignoreEnter.current = false;
      }, 0);
    };
    node.addEventListener("compositionstart", start);
    node.addEventListener("compositionend", end);
    return () => {
      node.removeEventListener("compositionstart", start);
      node.removeEventListener("compositionend", end);
    };
  }, []);

  async function submit(): Promise<void> {
    const text = draft;
    const api = window.chivgent;
    if (api === undefined || projectPath.length === 0 || text.trim().length === 0 || state.phase === "running") {
      return;
    }
    if (state.host.phase !== "ready") {
      return;
    }
    const requestId = nextRequestId();
    pendingStartRef.current = requestId;
    dispatch({ type: "submit", text });
    setDraft("");
    const result = await api.start({ requestId, prompt: text, provider, ...(model.trim() ? { model: model.trim() } : {}) });
    if (pendingStartRef.current !== requestId) return;
    if (!result.ok) {
      if (result.code === "cancelled") dispatch({ type: "cancelled" });
      else dispatch({ type: "fail", message: result.message });
      return;
    }
    if (result.value.type === "started") {
      dispatch({ type: "started", runId: result.value.runId });
    }
  }

  async function chooseProject(): Promise<void> {
    const api = window.chivgent;
    if (api === undefined || running) return;
    const result = await api.selectProject();
    if (!result.ok) {
      if (result.code !== "cancelled") setProjectError(result.message);
      return;
    }
    if (result.value.type === "project-selected") {
      pendingStartRef.current = null;
      setProjectPath(result.value.path);
      eventCursorRef.current = { hostInstanceId: "", sessionId: "", sequence: 0, refreshing: false };
      setRuntimeConfig("");
      setProjectError("");
      dispatch({ type: "reset" });
      void api.initialize();
    }
  }

  async function stop(): Promise<void> {
    const api = window.chivgent;
    const runId = runIdRef.current;
    if (api === undefined || runId === null) {
      return;
    }
    const result = await api.interrupt({ requestId: nextRequestId(), runId });
    if (!result.ok) {
      dispatch({ type: "fail", message: result.message });
    }
  }

  const running = state.phase === "running";
  const label = phaseLabel(state.phase, state.host);

  return (
    <div className={`desk ${state.items.length === 0 ? "desk-home" : "desk-chat"} ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <aside className="sidebar" inert={!sidebarOpen}>
        <div className="brand">
          <Mark />
          <div>
            <div className="wordmark">chivgent</div>
          </div>
          <button className="sidebar-toggle" type="button" aria-label="折叠侧栏" title="折叠侧栏" onClick={() => setSidebarOpen(false)}>‹</button>
        </div>
        <button className="new-task" type="button" onClick={() => void chooseProject()} disabled={running}><span>＋</span> {projectPath ? "切换项目目录" : "选择项目目录"}</button>
        {projectPath && <div className="project-path" title={projectPath}>{projectPath}</div>}
        <section className="side-block grow">
          <h2>最近任务</h2>
          <div className="task current" data-testid="task-row" title="当前会话">
            <span className={`dot ${statusTone(state)}`} />
            <span className="task-copy"><span className="task-title">当前会话</span><span className="task-phase" data-testid="run-status">{label}</span></span>
          </div>
        </section>
        <footer className="sidebar-foot" data-testid="host-status">
          <span className={`dot ${state.host.phase === "ready" ? "ready" : "bad"}`} />
          <span>{hostLabel(state.host)}</span>
        </footer>
      </aside>
      <main className="stage">
        {!sidebarOpen && <button className="reopen-sidebar" type="button" aria-label="展开侧栏" title="展开侧栏" onClick={() => setSidebarOpen(true)}>☰</button>}
        <header className="stage-head">
          <div>
            <h1>当前会话</h1>
            <p>{projectPath || "先选择项目目录"}</p>
          </div>
          <span className={`pill ${statusTone(state)}`} data-testid="phase-pill">{label}</span>
        </header>
        <div className="runtime-settings">
          <label>Provider <select aria-label="Provider" data-testid="provider-select" value={provider} disabled={running} onChange={(event) => { setProvider(event.target.value); setModel(""); }}>
            <option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI compatible</option><option value="openrouter">OpenRouter</option><option value="groq">Groq</option><option value="xai">xAI</option><option value="moonshot">Moonshot</option>
          </select></label>
          <label>Model <input aria-label="Model" data-testid="model-input" value={model} placeholder="沿用 Provider 环境配置" disabled={running} onChange={(event) => setModel(event.target.value)} /></label>
          {provider === "openai-compatible" && <span data-testid="compatible-endpoint">请求端点：{compatibleEndpoint || "未配置 OPENAI_BASE_URL"}</span>}
          {runtimeConfig && <span data-testid="runtime-config">{running ? "当前运行" : "最近使用"}：{runtimeConfig}</span>}
        </div>
        {demoMode && <div className="banner" data-testid="demo-notice" role="status">离线演示：此模式不会读取所选项目文件，也不会连接真实 Provider。</div>}
        {state.notice !== null && (
          <div className="banner" role="status" data-testid="notice">{state.notice}</div>
        )}
        {projectError && <div className="banner" role="alert">{projectError}</div>}
        <div
          className="timeline"
          ref={timelineRef}
          data-testid="timeline"
          onScroll={() => {
            const node = timelineRef.current;
            if (node !== null) {
              setStuck(isNearBottom(node));
            }
          }}
        >
          {state.items.length === 0 ? (
            <Empty />
          ) : (
            state.items.map((item) => (
              <ItemView
                key={item.id}
                item={item}
                open={expanded.has(item.id)}
                onToggle={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(item.id)) {
                      next.delete(item.id);
                    } else {
                      next.add(item.id);
                    }
                    return next;
                  });
                }}
              />
            ))
          )}
        </div>
        {!stuck && state.items.length > 0 && (
          <button
            type="button"
            className="jump"
            data-testid="jump-latest"
            onClick={() => {
              const node = timelineRef.current;
              if (node !== null) {
                node.scrollTop = node.scrollHeight;
              }
              setStuck(true);
            }}
          >
            回到最新
          </button>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={composerRef}
            data-testid="composer"
            aria-label="撰写消息"
            aria-description="Enter 发送，Shift+Enter 换行。"
            title="Enter 发送，Shift+Enter 换行"
            rows={2}
            value={draft}
            placeholder="描述你想让 chivgent 做的事"
            disabled={state.host.phase !== "ready" || !projectPath}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => {
              ignoreEnter.current = true;
            }}
            onCompositionEnd={() => {
              ignoreEnter.current = true;
              window.setTimeout(() => {
                ignoreEnter.current = false;
              }, 0);
            }}
            onKeyDown={(event) => {
              if (
                shouldSubmitOnEnter({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                  ignoreEnter: ignoreEnter.current,
                })
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-bar">
            {running ? (
              <button type="button" className="send stop" data-testid="stop" aria-label="停止当前运行" onClick={() => void stop()}>
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                data-testid="send"
                aria-label="发送消息"
                disabled={state.host.phase !== "ready" || !projectPath || draft.trim().length === 0}
              >
                <span aria-hidden="true">↑</span>
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

function ItemView(props: {
  item: TimelineItem;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { item } = props;
  if (item.kind === "user") {
    return (
      <div className="row user">
        <div className="bubble" data-testid="user-message">{item.text}</div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="row agent">
        <Mark small />
        <div className="answer" data-testid="assistant-message">
          {item.text}
          {item.streaming && <span className="caret" />}
        </div>
      </div>
    );
  }
  const status = item.status === "running" ? "进行中" : item.status === "error" ? "出错" : "完成";
  return (
    <article className="tool" data-testid="tool-activity">
      <button type="button" className="tool-head" onClick={props.onToggle} aria-expanded={props.open}>
        <span className="tool-name">{item.name}</span>
        <span className={`tool-status ${item.status}`}>{status}</span>
      </button>
      {props.open && (
        <div className="tool-body">
          {item.argsText.length > 0 && <pre>{item.argsText}</pre>}
          <pre>{item.output.length > 0 ? item.output : "还没有输出。"}</pre>
        </div>
      )}
    </article>
  );
}

function Empty(): JSX.Element {
  return (
    <div className="empty">
      <Mark small />
      <h2>你想构建什么？</h2>
    </div>
  );
}

function Mark(props: { small?: boolean }): JSX.Element {
  const size = props.small ? 22 : 28;
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden="true">
      <img className="mark-image" src={leafMark} alt="" />
    </span>
  );
}

function hostLabel(status: HostStatus): string {
  if (status.phase === "ready") {
    return "Agent host 已连接";
  }
  if (status.message !== undefined && status.message.length > 0) {
    return status.message;
  }
  if (status.phase === "starting") {
    return "正在连接 Agent host";
  }
  return status.phase === "failed" ? "Agent host 启动失败" : "Agent host 已退出";
}

function statusTone(state: { phase: string; host: HostStatus }): string {
  if (state.host.phase === "failed" || state.host.phase === "exited" || state.phase === "error") {
    return "bad";
  }
  if (state.phase === "running" || state.host.phase === "starting") {
    return "run";
  }
  if (state.phase === "stopped") {
    return "stop";
  }
  return "ready";
}
