import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/app/reduce.js", () => ({
  initialDeskState: {
    host: { phase: "ready" },
    phase: "error",
    runId: null,
    notice: "Agent host 已退出。进行中的运行结果未知。",
    items: [{
      kind: "tool",
      id: "run-1-call-1",
      runId: "run-1",
      toolCallId: "call-1",
      name: "read_file",
      argsText: "",
      output: "执行结果未知，需要检查工作区。",
      status: "unknown",
    }],
    lastSequence: 2,
    sequenceGap: false,
    hostInstanceId: "host-1",
    sessionId: "session-1",
  },
  phaseLabel: () => "出错",
  reduceDesk: (state: unknown) => state,
}));

import { App } from "../src/app/App.js";

describe("desktop tool status rendering", () => {
  it("shows a recovered unknown tool as unknown, not running or completed", () => {
    const html = renderToStaticMarkup(createElement(App));
    const card = html.match(/<article class="tool"[^]*?<\/article>/)?.[0];
    expect(card).toContain("结果未知");
    expect(card).not.toContain("进行中");
    expect(card).not.toContain(">完成<");
  });
});
