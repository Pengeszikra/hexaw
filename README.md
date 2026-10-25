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

The repository root is private in npm. **Only `packages/cli` publishes as
`hexaw`**; the Workshop is kept in GitHub and excluded from the npm archive.

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
node packages/cli/dist/cli.js artifacts/add.wasm
node packages/cli/dist/cli.js dump artifacts/add.wasm --source
node packages/cli/dist/cli.js dump artifacts/add.wasm --json
node packages/cli/dist/cli.js dump artifacts/add.wasm --code-only
```

The published executable is `hexaw`. See the [CLI package guide](packages/cli/README.md)
for stdin/stdout usage, raw hex mode, the JavaScript API and coverage limits.

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

This builds with the fork, runs the tests, creates `artifacts/hexaw-0.1.0.tgz`,
installs that exact archive into a fresh offline consumer, and verifies:

- the npm `hexaw` executable and public JavaScript exports;
- WASM → dump and WASM → HEXAW → WASM round trips;
- stdin JSON output and exact byte accounting;
- that the compiler remains a build dependency rather than a runtime dependency.

The core tests additionally compare arithmetic, conversions, control flow,
function calls, memory, traps and undo against the native WebAssembly engine.

## Publish the first npm version

The manifest is prepared for the **unscoped `hexaw`** package, version **0.1.0**.
Neither a GitHub repository nor a successful dry run reserves an npm name; the
name is claimed only after a successful npm publication. Registry availability
can change before that publication.

From this checkout:

```sh
npm ci
npm run check
npm publish --workspace packages/cli --access public --dry-run

npm login
npm whoami
npm run publish:cli
```

`publish:cli` publishes only the CLI workspace. Its `prepublishOnly` hook runs
the build, tests and real archive smoke test. Authenticate with the intended npm
maintainer account and complete any npm-required 2FA/browser step. No credentials
belong in this repository.

Once publication succeeds, verify it with:

```sh
npm view hexaw@0.1.0 name version bin
npx --yes hexaw@0.1.0 --version
```

Each name/version pair is immutable on npm. Bump `packages/cli/package.json` for
subsequent releases, update the lockfile and rerun the package checks.

## Scope of 0.1.0

The decoder recognizes **175 scalar instructions**. It can emit editable source
for the assembler's supported subset. For a valid binary outside that subset,
the default/JSON dump preserves all bytes as explicitly marked `RAW` records,
including a decoder diagnostic; `--strict` rejects that fallback. Modern WASM
extensions are not silently presented as decoded HEXAW instructions.

The debugger's narrower execution and memory limits remain documented in the
Workshop field guide. The initial release prioritizes a useful, installable CLI.

## Credits

Project and direction: **Péter Vívó / Pengeszikra**. Initial implementation,
packaging and tests assisted by **OpenAI Codex**.

MIT licensed. The separately installed TS+|> compiler retains its own Apache-2.0
license and upstream authorship.
