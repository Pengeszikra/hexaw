# JS-compatible memory

HEXAW modules can now share linear memory and globals with JavaScript.

## `EXPM "name"`
Exports memory 0 (requires `MEM`) as a `WebAssembly.Memory`:

```
MEM 1 4
EXPM "memory"
```
```js
const {exports}=new WebAssembly.Instance(p.nativeModule);
new Float64Array(exports.memory.buffer)[8]=1.5; // visible to HEXAW code
```
Remember that `memory.grow()` detaches old `buffer` objects; re-read `.buffer`.

## `EXPG "name" index`
Exports a global as a `WebAssembly.Global` (`.value` is readable and writable; i64 uses BigInt).

## Typed `DATA`
```
DATA 0   "text"                 ; UTF-8
DATA 8   hex:000000000000F03F   ; raw bytes, in memory order
DATA 16  f64: 1.5 2.5           ; little-endian typed values
DATA 32  i32: 1 -2 3
```
Types: `i8 u8 i16 u16 i32 u32 i64 f32 f64`. The disassembler writes non-text data as `hex:`.

`EXPM`/`EXPG` survive `bytes → HEXAW → bytes` round trips.
