# HEXAW's AI instructor

The shell uses the same provider, model and teaching design as
[Terminal Is Your Friend](https://github.com/Pengeszikra/terminal-is-your-friend):
Groq's `openai/gpt-oss-120b`, the Responses API with structured output, short
answers, remembered reply language and a compact teaching notebook. Its bundled
knowledge is about **HEXAW and WebAssembly**, with exact opcode identities and
immediate schemas taken from the assembler's current 571-entry table. No new
runtime package dependencies are required.

## Configure and start

Set `GROQ_API_KEY` in your terminal environment, then start normally:

```sh
npm run shell -- examples/assembly.hexaw
```

The installed command is `hexaw -i [file]`. The key belongs in the host
environment, never in an `AI` command or program. The key set on TiyF's Vercel
server is not automatically available to a local CLI process; use your Groq key
locally. Credentials are sent only as the Authorization header to the fixed
`https://api.groq.com/openai/v1/responses` endpoint, with redirects disabled.

Alternatively copy `.env.example` to `.env`, set the value in that ignored file,
build once and let Node load it:

```sh
npm run build
node --env-file=.env packages/cli/dist/cli.js -i examples/assembly.hexaw
```

`npm run shell` does not automatically read `.env`; use the explicit Node form
above or export the variable first. `AI STATUS` reports configuration without
printing the key. `AI HELP` and `AI KNOWLEDGE` work without credentials/network.
Startup makes no AI request. Requests use the configured Groq account's limits.

## Ask in either monitor or assembly mode

```text
// Miért 41 2A a CONST 42 bináris kódja?
AI Mi a különbség a FILE és MEM címek között?
A
CONST 20
:AI Mi van most a veremben, ha ezt majd lefuttatom?
CONST 22
ADD
END

CALL answer
G
AI REVIEW
```

The example opens `examples/assembly.hexaw`. The empty Enter after END applies
the draft. Questions beginning with `//`, `AI` or `:AI` do not encode
instructions, commit/abort a draft, reset the VM or move the assembly cursor.
An inline `CONST 42 // comment` remains an assembly comment. Unlike ordinary
comments, a **standalone** `// question` in the shell addresses the instructor,
as in TiyF; use `;` or `#` for standalone non-AI comments. Bare `//` shows help.

The mentor normally answers in 2–3 sentences, up to seven when useful. It follows
the language of natural-language questions and retains that language for later
reviews/error explanations. Code and diagnostics alone do not switch languages.
`AI LANGUAGE hu` explicitly selects Hungarian; `AI LANGUAGE en` selects English.
Examples are displayed separately as **not executed**. Enter useful suggestions
yourself using the appropriate HEXAW source, A mode or monitor command.

## Commands

| Command | Purpose |
| --- | --- |
| `AI question`, `// question`, `:AI question` | Ask with current bounded code/state context. |
| `AI REVIEW` | Review the current code/draft/VM snapshot. |
| `AI ERROR` | Explain a recent failed command or VM trap. |
| `AI LANGUAGE tag` | Set a BCP 47 reply language. |
| `AI STATUS`, `AI HELP` | Local configuration/status and help. |
| `AI KNOWLEDGE [topic]` | Read relevant bundled facts and opcode records offline. |
| `AI CANCEL` | Cancel the pending answer without changing the program. |
| `AI CLEAR` | Clear recent AI conversation; retain notebook, task and language. |
| `AI RESET` | Clear conversation, notebook, task, recent command context and language. |

Inside a real terminal an AI request runs in the background: keep dumping,
assembling and stepping while it answers. There is one pending request per shell.
The reply uses the **question-time snapshot**, so later edits/runs are not part
of that answer. Answers redraw the prompt while preserving partially typed
input. `AI CANCEL` cancels a pending request. Ctrl-C interrupts an active VM run
first, otherwise cancels a pending AI answer, otherwise cancels an assembly
draft, otherwise exits as before. Esc cancels an assembly draft. Q/EOF abort
pending AI requests. No automatic idle, review or error requests consume quota.

Through redirected stdin, AI questions are awaited in order, like other commands.
A missing key, invalid provider output, network failure, timeout or quota error
is reported on stderr; subsequent commands continue. Scripts exit nonzero after
an error. An AI outage does not disable the local assembler or debugger.

## Context and knowledge

Each shell owns its own session-only memory. It is never written to disk or
shared between processes. The request includes:

- Up to eight chat entries, separating unexecuted examples from conversation.
- A teaching note of at most 500 characters, direction and assessment of at most
  200 each, the current assigned task and reply language.
- The last three actual shell commands and their success/error output, clipped
  to 1,000/1,200 characters per command/output.
- Module filename (basename), byte count, validity and decoder status; a window
  of at most 16 instructions with bounded encodings and a bounded signature.
- Assembly draft status and the last 16 draft lines, with total count and
  truncation markers. These remain distinct from committed code.
- VM state, step count, actual PC/fault, bounded typed stack/local/global/result
  values, counts, call depth, memory size and up to 24 breakpoint addresses.

The snapshot is capped at 18,000 characters. The complete binary, custom/data
payloads, linear-memory contents, filesystem, environment and API key are not
included. Actual source/command snippets can still contain user-entered data;
that bounded context is sent to Groq only for an explicit question/review/error.
Requests use `store: false`. This setting is not a claim about the provider's
broader data-retention policies.

The bundled curriculum covers typed stack operations, compact declarations,
structured control flow, branch depth, calls/tables, linear memory, signed and
unsigned LEB128, module layout, modern instruction families and reverse tracing.
Relevant cards and exact opcode facts are selected locally for each question;
there is no embeddings service or automatic web/file retrieval. VM execution
coverage and native-engine validation requirements are explicitly distinguished
from the broader decoder/assembler coverage. The AI has no execution tools.

Source: [instructor-knowledge.ts](../packages/cli/src/instructor-knowledge.ts).
Project facts follow [interactive.md](interactive.md),
[binary-source.md](binary-source.md) and the live opcode table. WASM reference:
[WebAssembly Core specification](https://webassembly.github.io/spec/core/).
Transport reference: [Groq Responses API](https://console.groq.com/docs/responses-api)
and [structured outputs](https://console.groq.com/docs/structured-outputs).

The provider/context implementation is adapted from TiyF's MIT-licensed
`server/instructor.mjs`, `server/instructor-context.mjs` and
`src/instructor-memory.ts`. Both projects are by Péter Vívó (Pengeszikra), with
implementation assisted by OpenAI Codex. The TiyF mentor's fictional archive
persona remains secondary to technical explanations and is identified as fiction.
