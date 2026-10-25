# HEXAW binary source and operands

The CLI accepts the original compact `FN` language and the lossless `WASM 1`
layout language. Use the latter for arbitrary Core Wasm metadata and advanced
instruction types. Neither language requires parentheses.

```sh
hexaw module.wasm --source -o module.hexaw
hexaw -b module.hexaw -o rebuilt.wasm
hexaw --bin module.hexaw > rebuilt.wasm
```

## Layout syntax

```text
WASM 1
SECTION TYPE
  BYTES 016000017F
ENDSECTION
SECTION FUNCTION
  BYTES 0100
ENDSECTION
SECTION CODE
  BODY 00
    CONST 42
    END
  ENDBODY
ENDSECTION
```

This example defines a function returning i32. Add an export section to expose
it to a host. Section names are `CUSTOM`, `TYPE`, `IMPORT`, `FUNCTION`, `TABLE`,
`MEMORY`, `GLOBAL`, `EXPORT`, `START`, `ELEMENT`, `CODE`, `DATA`, `DATA-COUNT`, `TAG`;
decimal section IDs are accepted too. The correct binary section order must be
respected (TAG is not ordered by its numeric ID).

Non-code sections contain hexadecimal `BYTES` payloads. This preserves all
imports, types, exports, segments and custom metadata without silently adding,
deleting or renumbering entries. Field-level syntax for this metadata is future
work; instructions themselves always use named mnemonics when known.

`BODY` takes hex local declarations, beginning with the local-group count: `00`
means no locals; `01027F` means one group of two i32 locals. Do not include the
body size. End instructions are explicit: final `END` closes the function;
`ENDBODY` closes the source directive. Code body counts and sizes are computed.

Generated source may contain an original size encoding after SECTION/BODY, a
COUNT directive before bodies, and `; @encoding HEX` after instructions. These
retain padded LEB encodings. Omit them when writing new code. If instruction
tokens change, their stale saved encoding is ignored. Lengths are recalculated;
unchanged lengths preserve their original encodings. Floating-point bit patterns
and non-code payloads remain exact. Arbitrary source edits can invalidate custom
debug offsets or relocations; HEXAW does not rewrite those metadata formats.

## Immediate schemas

The [instruction reference](instructions.md) lists the schema for every opcode.
Operands are positional and separated by whitespace. Indices are decimal unless
prefixed with `0x`; leading zeros do not imply octal.

| Schema | Source example | Meaning |
| --- | --- | --- |
| `u32` | `CALL 130` | Unsigned 32-bit LEB128 index. Two fields retain their binary order. |
| `s32`, `s64` | `LCONST -9223372036854775808` | Signed LEB128 constant; unsigned bit-pattern literals are also accepted. |
| `f32`, `f64` | `FCONST 1.5`, `FCONST bits:0x7FC01234` | Decimal float or exact IEEE bit pattern. Bits use ordinary numeric hex order. |
| `block` | `BLOCK void`, `BLOCK i32`, `BLOCK type:2` | Empty result, value type or function type index (signed 33-bit LEB128). |
| `heap` | `REFNULL func`, `REFNULL type:0` | Abstract heap type or indexed type. |
| `types` | `SELECTT funcref` | Value-type vector; its length is encoded automatically. |
| `brtable` | `BRTABLE 0 1 2` | Branch targets 0 and 1, followed by default target 2. No count operand. |
| `memarg` | `LOAD 8 2 1` | Offset 8, alignment exponent 2, memory index 1. Defaults: zero offset, natural alignment, memory 0. Offsets support 64 bits. |
| `lane` | `I32X4EXTRACTLANE 3` | Single-byte lane index checked against the instruction's lane count. |
| `memarg lane` | `V128LOAD32LANE 0 2 0 3` | Offset, alignment, memory, then lane. Explicit memory index avoids ambiguity. |
| `v128` | `V128CONST 0x000102030405060708090A0B0C0D0E0F` | Sixteen bytes in memory order. |
| `shuffle` | `I8X16SHUFFLE 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15` | Sixteen single-byte indices in range 0..31. |
| `cast` | `BRONCAST 3 0 any type:1` | Nullable flags 0..3, relative label, source heap type, destination heap type. |
| `trytable` | `TRYTABLE void catch:0:1 catch_all:2` | Block type followed by catch descriptors; catch count is automatic. |
| `zero` | `ATOMICFENCE` | Emits the required reserved zero byte without an operand. |

`CALLIND 2 0` encodes type index 2 and table index 0. In compact `FN` syntax,
the table index can be omitted; types are deduplicated in first-function order.
`TABLE 2` declares table 0 with two funcref slots; `ELEM 0 0 1` fills its first
two slots with functions 0 and 1. The binary layout supports arbitrary table
metadata through the original section payload.

Heap names: `func`, `extern`, `any`, `eq`, `i31`, `struct`, `array`, `exn`, `none`,
`nofunc`, `noextern`, `noexn`. Value types include scalar types, `v128`, reference
shorthands, and flat typed references such as `ref:null:type:0` or
`ref:nonnull:func`. Nullable test/cast variants use `REFTESTNULL`/`REFCASTNULL`;
their non-null variants use `REFTEST`/`REFCAST`.

TRYTABLE descriptors are `catch:tag:label`, `catch_ref:tag:label`,
`catch_all:label` and `catch_all_ref:label`.

## Validation and execution

The instruction codecs validate immediate syntax, widths and bounds. The
module-layout reader validates framing and function expression boundaries, not
the full WebAssembly type system. `assembleWasm` and the CLI also use native
WebAssembly validation; features must be supported by the running engine.
Validation does not instantiate a module or run its start function. The
reversible Workshop VM supports a narrower execution subset, including BRTABLE
and CALLIND. Other new opcodes can be assembled and decoded without VM execution.

## Source of the opcode snapshot

The opcode facts are cross-checked against two independent upstream tables:

- [WABT opcode.def](https://github.com/WebAssembly/wabt/blob/main/include/wabt/opcode.def), snapshot blob `13f37e1b323f2525576408376eb3b954c565ffcf`.
- [wasmparser binary_reader.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wasmparser/src/binary_reader.rs), snapshot blob `0ce22353e02c6331e80175e9373036eae5afe181`.
- [WebAssembly Core specification](https://webassembly.github.io/spec/core/) and the [threads proposal](https://github.com/WebAssembly/threads).

Rebuild the table and reference after downloading the pinned upstream files:

```sh
node scripts/generate-instructions.mjs path/to/opcode.def path/to/binary_reader.rs
```

The generator checks that every opcode in the selected profile is mapped and
that mnemonics are unique. Instructions from experimental proposals beyond this
profile (such as stack switching or shared-everything threads) remain unsupported.
