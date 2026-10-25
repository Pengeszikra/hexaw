# HEXAW

**A CLI-first, byte-visible assembly dialect for WebAssembly.**

The first goal is deliberately small: run `hexaw example.wasm` in a terminal and
see the original byte offsets, encodings and readable HEXAW instructions.
The same repository also preserves the browser Workshop for later development.

```text
00000023 : 20 00                                           : GET 0
00000025 : 20 01                                           : GET 1
00000027 : 6A                                              : ADD
00000028 : 0F                                              : RET
00000029 : 0B                                              : END
```

HEXAW stands for **HEX + Assembly + WebAssembly**. It grew from the WAX prototype,
renamed to distinguish it from an existing WebAssembly language.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`packages/cli`](packages/cli) | The publishable **`hexaw`** npm package and TypeScript CLI |
| [`packages/cli/src/core`](packages/cli/src/core) | Shared browser-compatible assembler, decoder and reversible interpreter |
| [`workshop`](workshop) | The existing browser editor/debugger, using that same core |
| [`examples`](examples) | Small HEXAW programs |
| [`test`](test) | CLI, binary round-trip and native WASM differential tests |
| [`scripts`](scripts) | Build, offline package test, local Workshop server and publication checks |

Two npm packages share this repository: **`hexaw`** is the installable CLI;
**`hexaw-repository`** contains the repository/Workshop sources. The CLI archive
contains no Workshop or build-time dependencies.

## Develop

Requires Node.js **22.18+**, npm, and Git.

```sh
git clone https://github.com/Pengeszikra/hexaw.git
cd hexaw
npm ci
npm run build
npm test
```

The compiler is pinned to the published
**`@pengeszikra/typescript@7.1.0-pipeline.1`** TS+|> fork. The CLI uses the pipeline
operator in its production decode path and compiles with `tspipe`, with no stock
TypeScript fallback. The shared engine remains browser-compatible JavaScript
with a typed API boundary.

```ts
return input |> asBytes |> validateWasm |> inspectValidated;
```

The package ships the resulting ordinary JavaScript, including the core, so
consumers need neither the fork compiler nor Go at runtime.

## Run the CLI from the checkout

```sh
node packages/cli/dist/cli.js assemble examples/add.hexaw -o artifacts/add.wasm
node packages/cli/dist/cli.js --bin examples/add.hexaw -o artifacts/add.wasm
node packages/cli/dist/cli.js artifacts/add.wasm
node packages/cli/dist/cli.js dump artifacts/add.wasm --source
node packages/cli/dist/cli.js dump artifacts/add.wasm --json
node packages/cli/dist/cli.js dump artifacts/add.wasm --code-only
```

The published executable is `hexaw`. See the [CLI package guide](packages/cli/README.md)
for stdin/stdout usage, raw hex mode, the JavaScript API and coverage limits.

## Interactive DOS-style monitor

```sh
npm run shell -- examples/add.hexaw
```

This builds the checkout and opens `hexaw>` directly. `D` dumps hex/ASCII, `U`
shows HEXAW instructions, and Enter continues the current page. `CALL add 2A 0`
prepares a paused VM; `T`, `P`, `G`, `BP` and `BACK` trace, step over calls,
run, break and rewind. `R` shows stack, locals, globals and PC; `DM` dumps VM
linear memory. `E`, `F` and `A` edit the working binary, `UNDO`/`REDO` undo
edits, and `W file` saves it. Type `?` or F1 for help.

After building, `node packages/cli/dist/cli.js -i [file]` and
`node packages/cli/dist/cli.js shell [file]` open the same monitor. It accepts
scripts through stdin and real terminals with history and completion. See the
[interactive guide](docs/interactive.md) for hex number conventions, examples
and the historical DEBUG/SST references.

## Run the preserved Workshop

```sh
npm run dev:workshop
```

Open **http://127.0.0.1:8080/workshop/**. No frontend build is required.

The Workshop contains the original editor, assembler, byte inspector, stack,
locals/globals, calls, linear memory, breakpoints, reverse stepping, trace and
independent native WASM worker. Its six examples remain runnable. This migration
changes its name and shared-core import path; further UI development is separate.

It must be served from the repository root so its shared engine import resolves.
Do not open `index.html` directly with `file://`.

## Verify the actual npm package

```sh
npm run check
```

This builds with the fork, runs the tests, creates `artifacts/hexaw-0.3.0.tgz`,
installs that exact archive into a fresh offline consumer, and verifies:

- the npm `hexaw` executable and public JavaScript exports;
- WASM → dump and WASM → HEXAW → WASM round trips;
- stdin JSON output and exact byte accounting;
- that the compiler remains a build dependency rather than a runtime dependency.

The core tests additionally compare arithmetic, conversions, control flow,
function calls, memory, traps and undo against the native WebAssembly engine.

## Publish both npm packages

```sh
npm ci
npm login
npm whoami
npm run publish:all -- --dry-run
npm run publish:all
```

`publish:all` verifies matching versions, runs the build, tests and installed
archive checks once, then publishes **hexaw** followed by **hexaw-repository**.
It stops on the first failure. The two npm publications are separate operations;
if the CLI succeeds and the source package fails, finish with
`npm publish --workspaces=false --access public` after correcting the error.
`publish:cli` remains available for publishing only the CLI. Authenticate with
the intended npm maintainer account and complete npm's required authentication.

Once publication succeeds, verify it with:

```sh
npm view hexaw@0.3.0 name version bin
npm view hexaw-repository@0.3.0 name version
```

For the next patch release, update both versions and the lockfile together:

```sh
npm version patch --workspaces --include-workspace-root --no-git-tag-version
```

## Scope of 0.3.0

The shared instruction table maps **571 opcodes**: Core Wasm 3.0, threads/atomics,
and five legacy exception-handling opcodes. This includes all 172 MVP instructions,
SIMD/relaxed SIMD, GC, typed function references, tail calls, exceptions,
nontrapping conversions and bulk memory/table operations. See the generated
[instruction reference](docs/instructions.md).

`hexaw -b source.hexaw -o module.wasm` and `hexaw --bin source.hexaw` compile
HEXAW to WASM; omitted output means binary stdout. The `assemble` command remains
supported. Both the original compact `FN` syntax and the lossless
[binary-layout syntax](docs/binary-source.md) are accepted. `--source` selects
compact syntax only when it reconstructs the exact original binary; otherwise
it uses the layout form. Metadata/custom sections, NaN payloads and padded
encodings survive unedited layout round trips. Non-code section payloads are
preserved as `BYTES`; their fields are not yet rendered as semantic directives.

Input remains limited to 64 MiB. CLI validation uses the running Node.js engine;
its supported features bound which modules it accepts. It never instantiates or
executes a module. The lower-level codecs do not require native feature support.
An unknown instruction preserves the rest of its body as RAW, and decoding
resumes at the next body. `--strict` rejects incomplete decoding.

The reversible debugger additionally executes `BRTABLE` and `CALLIND`, including
their traps and undo. The other new opcodes have assembly/disassembly support;
their interpreter execution is separate future work. The Workshop UI is preserved.

## Credits

Project and direction: **Péter Vívó / Pengeszikra**. Initial implementation,
packaging and tests assisted by **OpenAI Codex**.

MIT licensed. The separately installed TS+|> compiler retains its own Apache-2.0
license and upstream authorship.
