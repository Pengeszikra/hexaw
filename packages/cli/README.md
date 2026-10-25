# HEXAW

**WebAssembly, close to the bytes.**

HEXAW is a CLI that turns WebAssembly binaries into an assembly-style dump:

```text
offset   : bytes                                           : instruction
00000023 : 20 00                                           : GET 0
00000025 : 20 01                                           : GET 1
00000027 : 6A                                              : ADD
00000028 : 0F                                              : RET
00000029 : 0B                                              : END
```

The default dump includes the complete binary, with module headers and section
payloads as well as instructions. Every displayed offset refers to the original
file. Use `--source` for editable HEXAW text, or `--code-only` to focus on code.

## Install and use

Requires Node.js **22.18 or later**. Once version 0.1.0 has been published:

```sh
npm install -g hexaw
hexaw example.wasm
```

Or, without a global installation:

```sh
npx hexaw example.wasm
```

```sh
# Editable assembly text.
hexaw dump example.wasm --source -o example.hexaw

# Exact original byte records, with instruction and section annotations.
hexaw dump example.wasm --json > example.dump.json

# Only decoded instructions, with offsets and bytes.
hexaw dump example.wasm --code-only

# A plain hex + ASCII view, independent of decoder coverage.
hexaw dump example.wasm --format hex

# Unix pipelines: - means stdin, and output defaults to stdout.
cat example.wasm | hexaw dump - --json

# Assemble a supported HEXAW program into a real WASM module.
hexaw assemble example.hexaw -o example.wasm

hexaw --help
hexaw --version
```

Output is always plain text unless assembling a binary. Successful commands exit
with status 0, invalid input/I/O failures with 1, and command-line usage errors
with 2. Diagnostics go to stderr. A named output file is replaced atomically only
after successful processing; the input path cannot also be the output path.

## A first HEXAW function

```text
EXP "add" 00

FN 00
  PAR 00
  PAR 01
  RES
  GET 00
  GET 01
  ADD
  RET
END
```

The default numeric type is i32. Prefix `L` selects i64, `F` f32, and `D` f64:
`LPAR`, `LRES`, `LCONST`, `LADD`, `FADD`, `DADD`. Locals are accessed with
type-independent `GET`/`SET`/`TEE`. Indices are decimal, including `00`; use `0x`
for hexadecimal numeric literals. Comments start with `;` or `//`.

## JavaScript and TypeScript API

```js
import { dumpWasm, compileHEXAW, inspectWasm } from 'hexaw';
import { readFile } from 'node:fs/promises';

const bytes = await readFile('example.wasm');
console.log(dumpWasm(bytes));
const source = dumpWasm(bytes, { format: 'source' });
const module = compileHEXAW(source);
const inspection = inspectWasm(bytes);
console.log(inspection.records); // offset, bytes, kind, section, owner, text, depth
```

Type declarations are included. The shared assembler and reversible interpreter
are also available from `hexaw/core`; the browser Workshop uses the same engine.

## First-release coverage

- **175 scalar instructions**, i32/i64/f32/f64, locals, direct calls, mutable
  constant-initialized globals, blocks, loops, if/else and relative branches.
- Memory loads/stores, including narrow accesses; one 32-bit, unshared memory.
  Dump inspection can read memories without an explicit maximum and does not
  allocate their linear memory. The assembler and debugger have stricter bounds.
- Valid binaries outside the decoder subset remain usable in the default and
  JSON dumps: they are explicitly identified as `RAW`, with the reason included.
  Use `--strict` to reject this fallback. No unknown bytes are guessed as opcodes.
- External imports, tables, indirect calls, SIMD, GC, references, multi-value,
  `br_table`, bulk memory and other extensions are not decoded in 0.1.0.
- `--source` requires an encodable module: one result per function/block, mutable
  globals, UTF-8 data and bounded memory within assembler limits. Text output is
  canonical; custom sections and original noncanonical encodings are not retained
  when reassembling it. Use the default/JSON/hex dump to preserve original bytes.
- Binary input limit: 64 MiB. WASM validation uses the executing Node.js engine.
  Validation never instantiates or runs a module, including its start function.

## Built with TS+|>

The CLI is written in TypeScript using Péter Vívó's unary pipeline operator fork,
[`@pengeszikra/typescript@7.1.0-pipeline.1`](https://github.com/Pengeszikra/TypeScript).
It is used in the actual decode path:

```ts
return input |> asBytes |> validateWasm |> inspectValidated;
```

The npm archive contains ordinary, precompiled JavaScript and no runtime
dependencies. Installing HEXAW does not install the compiler or Go.

Repository and Workshop source: [Pengeszikra/hexaw](https://github.com/Pengeszikra/hexaw).

Project direction: **Péter Vívó**. Initial implementation assisted by **OpenAI Codex**.
MIT licensed.
