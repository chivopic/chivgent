# Extensions and remote sessions

> Moved out of the top-level README in the README rewrite. Content unchanged unless noted.

## Extensions

An extension is an ES module that default-exports a function. It is called once
at startup with an API that can add a tool, add a slash command, subscribe to
runtime events, and append to the system prompt.

```js
// .chivgent/extensions/word-count.js
export default function (api) {
  api.registerTool({
    name: "word_count",
    description: "Count the words in a workspace file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context) {
      const file = await context.workspace.readTextFile(args.path);
      return {
        content: `${file.content.split(/\s+/).filter(Boolean).length} words`,
        isError: false,
      };
    },
  });

  api.contributeSystemPrompt("Use word_count instead of reading a file to count words.");
}
```

Extensions are loaded from two places:

| Location | Loaded |
| --- | --- |
| `<CHIVGENT_HOME>/extensions/` | Always: it is your own machine's configuration |
| `<workspace>/.chivgent/extensions/` | Only after you trust the project |

Both accept `name.js` and `name/index.js`; nesting stops there. Plain JavaScript
only — compiling TypeScript yourself is cheaper than making chivgent carry a
TypeScript loader. A name already taken by a built-in tool or command is refused,
so an extension cannot shadow `read_file` or `/clear`, and a broken extension is
reported and skipped rather than taking chivgent down with it.

`chivgent --extensions` lists what loaded and what each one registered.

### Project trust

The first time you run chivgent in a project that ships extensions, it describes
what they are and asks once. The answer is stored in `<CHIVGENT_HOME>/trust.json`
against the resolved directory path, and matched by nearest ancestor, so trusting
`~/work` covers every repository under it. `--forget-trust` removes the decision
covering the current workspace.

**Trusting a project means letting its authors run code as you.** An extension
executes inside the chivgent process: it is not bound by the workspace, it does
not need `--allow-shell` to run a command, and it can read your environment
including the API key. That is why the question is asked before anything is
imported, and why the answer is no whenever there is nobody to ask — a CI job or
a piped run never loads a checkout's extensions on its own.


## Remote sessions

A session normally lives and dies with the terminal that started it. `--serve`
keeps it in one process and lets others attach:

```bash
# One terminal
chivgent --serve --allow-writes
# chivgent 0.12.0 serving session 2026-09-06T...
# socket:       ~/.chivgent/sockets/2026-09-06T....sock
# capabilities: --allow-writes

# Another terminal
chivgent --servers                 # list what is running
chivgent --connect <id>            # attach interactively
chivgent --connect <id> "question" # ask once and leave
```

A client holds no state: it sends prompts and renders the event stream the
server broadcasts. Several clients can attach at once — the extra ones watch the
same run as it happens, and any of them can interrupt it, because the run
belongs to the session rather than to whoever started it. A prompt sent while
another is running is refused rather than queued, and a client that disconnects
mid-run does not cancel it.

Each attached client has a pending-send budget that defaults to 4 MiB,
including bytes already queued by its socket. `SessionServerOptions` can set a
different positive safe-integer byte limit. If the next encoded JSONL frame
would exceed that budget, or a single frame is larger than the budget, the
server disconnects that client and reports the reason through its warning
callback. A socket write failure also disconnects only that client. If an
outbound message cannot be encoded, the server reports the encoding failure and
disconnects all currently attached clients so none continue after a missing
event. It does not drop part of the stream and keep a client attached. Other
clients continue receiving the ordered stream, and the session run continues.
Shutdown sends `bye` on a best-effort basis, then destroys attached sockets so
a client that has stopped reading cannot hold server close open.

Attaching does not replay history; the session log already holds that. The
protocol is JSON Lines over a Unix socket, one object per line, the same shape
`--json` writes.

**Whoever can reach the socket has everything the server was started with.** If
it was started with `--allow-shell`, anyone who can connect can make the model
run commands, which is why the server prints its capabilities on startup: the
person attaching cannot see the flags you typed. The boundary is filesystem
permissions — sockets live in an owner-only directory under `CHIVGENT_HOME` —
and there is no TCP listener. For another machine, forward the socket over SSH
so that authentication is SSH's job.

