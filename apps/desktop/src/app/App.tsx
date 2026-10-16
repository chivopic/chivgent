import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type JSX } from "react";
import { nextRequestId, shouldSubmitOnEnter } from "./input.js";
import { initialDeskState, phaseLabel, reduceDesk, type TimelineItem } from "./reduce.js";
import { isNearBottom } from "./scroll.js";
import type { HostStatus, HostToMain, IpcResult } from "../protocol/messages.js";

interface DesktopApi {
  initialize(): Promise<IpcResult<HostToMain>>;
  start(payload: { requestId: string; prompt: string }): Promise<IpcResult<HostToMain>>;
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
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const ignoreEnter = useRef(false);
  const runIdRef = useRef<string | null>(null);
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
      if (message.type === "event") {
        dispatch({
          type: "agent",
          runId: message.runId,
          sequence: message.sequence,
          event: message.event,
        });
      } else if (message.type === "error") {
        dispatch({ type: "fail", message: message.message });
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
    if (api === undefined || text.trim().length === 0 || state.phase === "running") {
      return;
    }
    if (state.host.phase !== "ready") {
      return;
    }
    dispatch({ type: "submit", text });
    setDraft("");
    const result = await api.start({ requestId: nextRequestId(), prompt: text });
    if (!result.ok) {
      dispatch({ type: "fail", message: result.message });
      return;
    }
    if (result.value.type === "started") {
      dispatch({ type: "started", runId: result.value.runId });
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
    <div className="desk">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div>
            <div className="wordmark">chivgent</div>
            <div className="brand-note">本地工作台</div>
          </div>
        </div>
        <section className="side-block">
          <h2>项目</h2>
          <div className="side-card">
            <strong>离线演示</strong>
            <p>stub provider。只读工具不读写工作区，也不调用模型。</p>
          </div>
        </section>
        <section className="side-block grow">
          <h2>任务</h2>
          <div className="task current" data-testid="task-row">
            <span className={`dot ${statusTone(state)}`} />
            <span className="task-title">当前会话</span>
            <span className="task-phase" data-testid="run-status">{label}</span>
          </div>
        </section>
        <footer className="host-foot" data-testid="host-status">
          <span className={`dot ${state.host.phase === "ready" ? "ready" : "bad"}`} />
          <span>{hostLabel(state.host)}</span>
        </footer>
      </aside>
      <main className="stage">
        <header className="stage-head">
          <div>
            <h1>当前会话</h1>
            <p>离线 stub · 流式回答与只读工具</p>
          </div>
          <span className={`pill ${statusTone(state)}`} data-testid="phase-pill">{label}</span>
        </header>
        {state.notice !== null && (
          <div className="banner" role="status" data-testid="notice">{state.notice}</div>
        )}
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
            rows={2}
            value={draft}
            placeholder="描述你想让 chivgent 做的事"
            disabled={state.host.phase !== "ready"}
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
            <span className="hint">Enter 发送，Shift+Enter 换行。运行中可以继续写草稿。</span>
            {running ? (
              <button type="button" className="send stop" data-testid="stop" onClick={() => void stop()}>
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                data-testid="send"
                disabled={state.host.phase !== "ready" || draft.trim().length === 0}
              >
                发送
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
      <Mark />
      <h2>从一条消息开始</h2>
      <p>
        回答经过现有 Agent 执行链。你会看到流式文本，以及一次只读工具调用。
        停止会取消这次运行，不会改动文件。
      </p>
    </div>
  );
}

function Mark(props: { small?: boolean }): JSX.Element {
  const raw = useId().replace(/:/g, "");
  const size = props.small ? 22 : 28;
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={raw} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5fc8" />
          <stop offset="0.55" stopColor="#a45cf0" />
          <stop offset="1" stopColor="#6aa8f5" />
        </linearGradient>
      </defs>
      <path fill={`url(#${raw})`} d="M6 8h12l8 8-8 8H6l8-8z" />
    </svg>
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
