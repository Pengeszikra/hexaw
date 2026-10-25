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

Requires Node.js **22.18 or later**. Advanced WASM features require support in the
running Node.js engine.

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
hexaw -b example.hexaw -o example.wasm
hexaw --bin example.hexaw > example.wasm
hexaw --interactive example.wasm
hexaw shell

hexaw --help
hexaw --version
```

Output is always plain text unless assembling a binary. Successful commands exit
with status 0, invalid input/I/O failures with 1, and command-line usage errors
with 2. Diagnostics go to stderr. A named output file is replaced atomically only
after successful processing; the input path cannot also be the output path.

## Interactive monitor

`hexaw -i [file]`, `hexaw --interactive [file]` and `hexaw shell [file]` open a
DEBUG/SST-inspired monitor. D dumps hex/ASCII, U lists HEXAW instructions, and
Enter continues the current view. Addresses/counts are hexadecimal by default;
`0d42` selects decimal. Use `?`/F1 for help, arrows for history, Tab for completion
and Q to exit. Examples:

```text
D 0 L 20
U
CALL add 2A 0
T
R
BACK
G
```

CALL prepares a paused reversible VM; T/P/G trace, step over and run; BP/BC
manage breakpoints; BACK reverses execution. DM displays VM linear memory, while
D/U use file offsets. E/F/A edit the working binary, UNDO/REDO reverse edits,
W filename saves, and SOURCE filename exports HEXAW. The VM executes its
documented subset; all mapped opcodes remain available for disassembly. Loading
never executes native code or a start function. Ctrl-C interrupts execution.

`A [address]` enters continuous assembly. Type one HEXAW instruction per line;
Enter shows its hex bytes and advances the FILE address. An empty Enter applies
the complete validated draft as one undoable edit. `:UNDO` removes the last draft
line; Esc/Ctrl-C/`:CANCEL` discard the draft. F1 lists mnemonics, F3 recalls the
original instruction, and Tab completes mnemonics. The one-line
`A address mnemonic operands` form remains available. Instruction operands use
source radix (decimal or `0x`), and END is an instruction, not an exit command.
See `examples/assembly.hexaw` and `examples/assembly.commands` in the repository.

Command scripts work through stdin; errors are reported but do not end the
session, and scripts exit nonzero if a command failed. From the repository,
`npm run shell -- examples/add.hexaw` builds and starts the monitor directly.
See the [complete interactive guide](https://github.com/Pengeszikra/hexaw/blob/main/docs/interactive.md).

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
import { dumpWasm, assembleWasm, inspectWasm } from 'hexaw';
import { readFile } from 'node:fs/promises';

const bytes = await readFile('example.wasm');
console.log(dumpWasm(bytes));
const source = dumpWasm(bytes, { format: 'source' });
const rebuiltBytes = assembleWasm(source);
const inspection = inspectWasm(bytes);
console.log(inspection.records); // offset, bytes, kind, section, owner, text, depth
```

Type declarations are included. The shared assembler and reversible interpreter
are also available from `hexaw/core`; the browser Workshop uses the same engine.

## Instruction coverage and binary output

The shared table maps **571 opcodes**: the complete Core Wasm 3.0 instruction set,
threads/atomics, and five legacy exception opcodes. Every instruction has a
HEXAW mnemonic and an immediate codec, including multi-byte opcode identifiers.
The [complete instruction table](https://github.com/Pengeszikra/hexaw/blob/main/docs/instructions.md)
lists names, opcodes and operands. SIMD names retain their lane shapes, for
example `I32X4ADD` and `I8X16SHUFFLE`.

`-b`/`--bin` assemble UTF-8 source. With `-o`, output is written atomically to
that file; otherwise the raw WASM bytes go to stdout. Formatting options such as
`--json` cannot be combined with binary output. `assemble ... -o ...` is retained.

Compact `FN` syntax is preserved and now includes `BRTABLE`, `CALLIND`, `TABLE`
and `ELEM`, plus instructions that fit its scalar declarations. Advanced types,
imports and other module metadata use the bracket-free **WASM 1 layout syntax**.
`--source` emits compact source when byte-exact reconstruction is possible;
otherwise it emits layout source. Both forms compile with `assembleWasm` and
`--bin`. `compileHEXAW`/`hexaw/core` retain the compact assembler/debugger API.

Layout source preserves non-code section payloads with `BYTES` directives and
renders code as mnemonics. Unedited round trips retain custom sections, NaN bit
patterns, padded LEB128, local groups and original indices. Editing an instruction
updates its encoding, body length and code-section length automatically.
See the [layout/operand guide](https://github.com/Pengeszikra/hexaw/blob/main/docs/binary-source.md).

The low-level `encodeInstruction`, `decodeInstruction`, `BinaryReader`,
`decodeBinary`, `disassembleBinary` and `assembleBinary` APIs are exported too.
`inspectWasm().binary` exposes the full opcode model; `.decoded` is the narrower
debugger model and may be null even when all opcodes decode successfully.

Unknown instructions preserve bytes through the end of their body; decoding
resumes at the next body. `--strict` rejects incomplete decoding. The CLI's 64 MiB
limit and native Node.js validation remain. Validation never instantiates or
runs a module, including its start function. The codecs can inspect features
unsupported by the local engine; the CLI accepts only engine-valid modules.

The reversible interpreter now executes `BRTABLE` and `CALLIND` as well as its
original scalar subset. Assembly/disassembly support for an opcode does not imply
that the Workshop interpreter executes it.

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
