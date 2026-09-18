// Offline interactive demo: npm run build && node scripts/tui-demo.mjs
import { setTimeout as delay } from 'node:timers/promises';
import { AgentSession } from '../dist/session.js';
import { LocalWorkspace } from '../dist/workspace.js';
import { runRepl } from '../dist/repl.js';
import { createLiveRegion, terminalWidth } from '../dist/tui/live.js';
import { welcome } from '../dist/tui/welcome.js';

if (!process.stdin.isTTY || !process.stderr.isTTY) {
  console.error('The demo needs a terminal on stdin and stderr.');
  process.exit(1);
}
const message = (content, toolCalls = []) => ({ role: 'assistant', content, toolCalls });
const llm = {
  async complete() { return { message: message('Offline demo.') }; },
  async stream(request, handlers) {
    const last = request.messages.at(-1);
    if (last?.role !== 'tool') {
      for (const delta of ['我会', '检查当前任务。', ' Testing Unicode: 👩‍💻 中文。']) {
        await delay(300, undefined, { signal: request.signal });
        handlers.onTextDelta(delta);
      }
      return { message: message('我会检查当前任务。 Testing Unicode: 👩‍💻 中文。', [
        { id: `demo-${Date.now()}`, name: 'demo_progress', arguments: {} },
      ]) };
    }
    const content = '演示完成。\nThis response came from an offline stub provider.\nTry another prompt, /help, /session, or Ctrl+C during a run.';
    for (const delta of content.split(/(?<=\s)/)) {
      await delay(80, undefined, { signal: request.signal });
      handlers.onTextDelta(delta);
    }
    return { message: message(content), usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
  },
};
const session = new AgentSession({ cwd: process.cwd(), agent: {
  llm, systemPrompt: 'offline demo', maxTurns: 4, streaming: true,
  workspace: new LocalWorkspace(process.cwd()),
  tools: [{ name: 'demo_progress', description: 'Simulated progress; changes no files.', inputSchema: { type: 'object' },
    async execute(_args, context) {
      for (let i = 1; i <= 3; i++) {
        await delay(400, undefined, { signal: context.signal });
        context.onUpdate?.(`Checking ${i}/3 · 中文 output`);
      }
      return { content: 'Demo checks passed.', isError: false };
    },
  }],
} });
const region = createLiveRegion({ stream: process.stderr, answerStream: process.stdout,
  width: () => terminalWidth(process.stderr), height: () => process.stderr.rows || 24 });
session.subscribe(region.listener);
process.stderr.on('resize', region.resized);
try {
  await runRepl({ session, input: process.stdin, output: process.stderr, stderr: process.stderr, tui: true,
    banner: welcome({ version: 'demo', provider: 'offline', model: 'stub', cwd: session.cwd,
      sessionId: session.id, resumed: false, signedOut: false, width: terminalWidth(process.stderr) }),
  });
} finally {
  process.stderr.off('resize', region.resized);
  region.stop();
}
