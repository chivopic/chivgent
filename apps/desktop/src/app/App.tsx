import { useEffect, useLayoutEffect, useReducer, useRef, useState, type JSX } from "react";
import { nextRequestId, shouldSubmitOnEnter } from "./input.js";
import { initialDeskState, phaseLabel, reduceDesk, type TimelineItem } from "./reduce.js";
import { isNearBottom } from "./scroll.js";
import { MAX_MODEL_LENGTH, MAX_PROMPT_LENGTH, type HostStatus, type HostToMain, type IpcResult } from "../protocol/messages.js";
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
  const [runtimeConfig, setRuntimeConfig] = useState<{ provider: string; model: string; endpoint?: string } | null>(null);
  const [compatibleEndpoint, setCompatibleEndpoint] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [detailPanel, setDetailPanel] = useState<"project" | "settings" | "status" | null>(null);
  const [copyPathFeedback, setCopyPathFeedback] = useState("");
  const detailsDialogRef = useRef<HTMLDialogElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const ignoreEnter = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const pendingStartRef = useRef<string | null>(null);
  const draftRevisionRef = useRef(0);
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
        setRuntimeConfig({ provider: message.provider, model: message.model,
          ...(message.baseURL === undefined ? {} : { endpoint: message.baseURL }) });
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
    const dialog = detailsDialogRef.current;
    if (detailPanel !== null && dialog !== null && !dialog.open) dialog.showModal();
  }, [detailPanel]);

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
    const draftRevision = draftRevisionRef.current;
    const api = window.chivgent;
    if (api === undefined || projectPath.length === 0 || text.trim().length === 0 || state.phase === "running" || pendingStartRef.current !== null) {
      return;
    }
    if (state.host.phase !== "ready") {
      return;
    }
    if (text.length > MAX_PROMPT_LENGTH || model.trim().length > MAX_MODEL_LENGTH) return;
    const requestId = nextRequestId();
    pendingStartRef.current = requestId;
    dispatch({ type: "submit", text });
    let result: IpcResult<HostToMain>;
    try {
      result = await api.start({ requestId, prompt: text, provider, ...(model.trim() ? { model: model.trim() } : {}) });
    } catch (error: unknown) {
      if (pendingStartRef.current === requestId) {
        pendingStartRef.current = null;
        const detail = error instanceof Error ? error.message : "Agent host 没有回应。";
        dispatch({ type: "fail", message: `启动结果未知。请先检查会话状态，再决定是否手动重试。${detail}` });
      }
      return;
    }
    if (pendingStartRef.current !== requestId) return;
    pendingStartRef.current = null;
    if (!result.ok) {
      if (result.code === "cancelled" || result.code === "run_error") {
        // These replies are sent after the host has accepted the run. Do not
        // restore it as an unaccepted draft (for example, missing credentials).
        if (draftRevisionRef.current === draftRevision) setDraft("");
        if (result.code === "cancelled") dispatch({ type: "cancelled" });
        else dispatch({ type: "fail", message: result.message });
      } else if (isDefinitiveStartRejection(result.code)) {
        dispatch({ type: "reject-submit", text, message: result.message });
      } else {
        const message = result.code === "host_unavailable"
          ? `启动结果未知。请先检查会话状态，再决定是否手动重试。${result.message}`
          : result.message;
        dispatch({ type: "fail", message });
      }
      return;
    }
    if (result.value.type === "started") {
      if (draftRevisionRef.current === draftRevision) setDraft("");
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
      setRuntimeConfig(null);
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
        {projectPath && <div className="project-path" title={projectPath}>{projectName(projectPath)}</div>}
        <section className="side-block grow">
          <h2>最近任务</h2>
          <div className="task current" data-testid="task-row" title="当前会话">
            <span className={`dot ${statusTone(state)}`} />
            <span className="task-copy"><span className="task-title">当前会话</span><span className="task-phase" data-testid="run-status">{label}</span></span>
          </div>
        </section>
      </aside>
      <main className="stage">
        {!sidebarOpen && <button className="reopen-sidebar" type="button" aria-label="展开侧栏" title="展开侧栏" onClick={() => setSidebarOpen(true)}>☰</button>}
        <header className="stage-head">
          <div>
            <h1>当前会话</h1>
            {projectPath ? <button className="project-identity" type="button" onClick={() => { setCopyPathFeedback(""); setDetailPanel("project"); }}>
              {projectName(projectPath)} <span aria-hidden="true">⌄</span>
            </button> : <p>先选择项目目录</p>}
          </div>
          <div className="head-actions">
            <button className="quiet-action" type="button" onClick={() => setDetailPanel("settings")}>设置</button>
            <button className="status-action" type="button" data-testid="status-action" aria-label={`连接状态详情：${hostLabel(state.host)}`} title="连接状态详情" onClick={() => setDetailPanel("status")}>
              <span className={`dot ${state.host.phase === "ready" ? "ready" : state.host.phase === "starting" ? "run" : "bad"}`} />
            </button>
            {!sidebarOpen && <span className={`pill ${statusTone(state)}`} data-testid="phase-pill">{label}</span>}
          </div>
        </header>
        {demoMode && <div className="banner" data-testid="demo-notice" role="status">离线演示：此模式不会读取所选项目文件，也不会连接真实 Provider。</div>}
        {state.notice !== null && (
          <div className="banner" role="status" data-testid="notice">{state.notice}</div>
        )}
        {projectError && <div className="banner" role="alert">{projectError}</div>}
        <dialog className="details-dialog" ref={detailsDialogRef} aria-labelledby="details-title" onClose={() => setDetailPanel(null)}>
          {detailPanel === "project" && <>
            <div className="dialog-head"><div><h2 id="details-title">项目详情</h2><p>当前项目目录</p></div><button type="button" className="dialog-close" aria-label="关闭详情" onClick={() => detailsDialogRef.current?.close()}>×</button></div>
            <div className="detail-block"><span className="detail-label">项目名称</span><strong>{projectName(projectPath)}</strong></div>
            <div className="detail-block"><span className="detail-label">完整路径</span><code className="path-value">{projectPath}</code></div>
            <button type="button" className="secondary-action" onClick={() => {
              void navigator.clipboard.writeText(projectPath).then(() => setCopyPathFeedback("已复制完整路径。"), () => setCopyPathFeedback("复制失败，请手动选择上方路径。"));
            }}>复制完整路径</button>
            {copyPathFeedback && <p className="copy-feedback" role={copyPathFeedback.startsWith("复制失败") ? "alert" : "status"}>{copyPathFeedback}</p>}
          </>}
          {detailPanel === "settings" && <>
            <div className="dialog-head"><div><h2 id="details-title">会话设置</h2><p>Provider 和模型的更改仅用于下一轮运行。</p></div><button type="button" className="dialog-close" aria-label="关闭设置" onClick={() => detailsDialogRef.current?.close()}>×</button></div>
            <div className="settings-form">
              <label>Provider <select aria-label="Provider" data-testid="provider-select" value={provider} disabled={running} onChange={(event) => { setProvider(event.target.value); setModel(""); }}>
                <option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI compatible</option><option value="openrouter">OpenRouter</option><option value="groq">Groq</option><option value="xai">xAI</option><option value="moonshot">Moonshot</option>
              </select></label>
              <label>Model <input aria-label="Model" data-testid="model-input" value={model} placeholder="沿用 Provider 环境配置" disabled={running} onChange={(event) => setModel(event.target.value)} /></label>
              {provider === "openai-compatible" && <div className="detail-block" data-testid="compatible-endpoint"><span className="detail-label">请求端点 · OPENAI_BASE_URL</span><code className="path-value">{compatibleEndpoint || "未配置"}</code></div>}
              {runtimeConfig && <div className="detail-block" data-testid="runtime-config"><span className="detail-label">{running ? "当前运行的有效配置" : "最近一次运行的有效配置"}</span><code className="path-value">{runtimeConfig.provider} · {runtimeConfig.model}{runtimeConfig.endpoint ? ` · ${runtimeConfig.endpoint}` : ""}</code></div>}
            </div>
            <div className="dialog-actions"><button type="button" className="secondary-action" onClick={() => detailsDialogRef.current?.close()}>完成</button></div>
          </>}
          {detailPanel === "status" && <>
            <div className="dialog-head"><div><h2 id="details-title">连接状态</h2><p>{hostLabel(state.host)}</p></div><button type="button" className="dialog-close" aria-label="关闭状态详情" onClick={() => detailsDialogRef.current?.close()}>×</button></div>
            <div className="detail-block" data-testid="host-status"><span className="detail-label">Agent host</span><strong>{hostLabel(state.host)}</strong></div>
            {state.host.message && <div className="detail-block"><span className="detail-label">诊断信息</span><code className="path-value">{state.host.message}</code></div>}
          </>}
        </dialog>
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
            onChange={(event) => {
              draftRevisionRef.current += 1;
              setDraft(event.target.value);
            }}
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
          {(draft.length > MAX_PROMPT_LENGTH || model.trim().length > MAX_MODEL_LENGTH) && (
            <div className="composer-limit" data-testid="composer-limit" role="alert">
              {draft.length > MAX_PROMPT_LENGTH
                ? `当前草稿 ${draft.length} / ${MAX_PROMPT_LENGTH} 个字符，请删减后再发送。`
                : `模型名称超过 ${MAX_MODEL_LENGTH} 个字符，请在会话设置中修改。`}
            </div>
          )}
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
                disabled={state.host.phase !== "ready" || !projectPath || draft.trim().length === 0 || draft.length > MAX_PROMPT_LENGTH || model.trim().length > MAX_MODEL_LENGTH || pendingStartRef.current !== null}
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

function isDefinitiveStartRejection(code: string): boolean {
  return ["bad_request", "busy", "history_write_failed", "project_required", "request_conflict", "request_log_full"].includes(code);
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
  const status = item.status === "running" ? "进行中" : item.status === "unknown" ? "结果未知" : item.status === "error" ? "出错" : "完成";
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

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
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
