# The interactive HEXAW monitor

The monitor brings DOS DEBUG-style short commands to HEXAW, with the reversible
VM available for SST-style tracing. It uses a line-oriented prompt with history
and completion. Batch dumping and `--bin` remain available.

## Start from the repository

```sh
npm run shell -- examples/add.hexaw
```

The `preshell` script builds with the TS+|> fork first. No global CLI installation
is needed. If development dependencies are missing, run `npm ci` once.
After building, the equivalent direct commands are:

```sh
node packages/cli/dist/cli.js --interactive examples/add.hexaw
node packages/cli/dist/cli.js -i
node packages/cli/dist/cli.js shell examples/monitor.hexaw
```

The installed package accepts `hexaw -i [file]` and `hexaw shell [file]`.
WASM and raw files are loaded as bytes. A `.hexaw` file is assembled into the
working buffer. Loading, dumping, validation and source export never instantiate
a native module or execute its start function.

## First session

Enter these at `hexaw>` after opening `examples/add.hexaw`:

```text
D 0 L 20
U
FN
CALL add 2A 0
T
R
BACK
BP 27
G
U 27 L 3
G
Q
```

`CALL` prepares a paused VM. `G` stops before ADD at FILE offset 27h. The next
`G` resumes and finishes with 42. Enter on an empty line repeats the last view
at its next page; `-` shows its previous page. Up/down recall history, Tab
completes commands and F1 shows help. Ctrl-C interrupts a running trace; at an
idle prompt it exits. In assembly mode, Ctrl-C/Esc cancel the draft and return
to the monitor. Ctrl-D / EOF exits. `hexaw*>` marks unsaved edits.

## Commands

| Command | Operation |
| --- | --- |
| `L file` | Load WASM, HEXAW or raw binary. Quote filenames containing spaces. |
| `D [start [end \| L length]]` | Hex/ASCII file dump; default page 80h bytes. |
| `U [start [end \| L length]]` | HEXAW from known instruction boundaries; default page 20h bytes. |
| Enter, `+`, `NEXT`, `-`, `PREV` | Page through the current D/U/DM view. |
| `I`, `FN [body/export]` | Section directory; body directory/code navigation. |
| `S start end\|L length bytes` | Search bytes or quoted UTF-8 text. |
| `E address bytes` | Replace bytes in the working buffer. |
| `F start end\|L length bytes` | Fill a range with a repeated pattern. |
| `A [address]` | Enter successive instructions with immediate hex feedback; empty Enter applies. |
| `A address mnemonic operands` | Replace one instruction; validate and recompute WASM lengths. |
| `UNDO`, `REDO` | Undo/redo byte and assembly edits. |
| `W file` | Atomically save the working binary to an explicit filename. |
| `SOURCE [file]`, `V` | Show/export assemblable source; report validation status. |
| `H a b` | Hex sum/difference and decimal equivalents. |
| `CALL [entry] [args]` | Initialize the paused VM; entry is an export or function index. |
| `T [count]`, `P`, `G [limit]` | Step into, step over CALL/CALLIND, run to breakpoint/end/budget. |
| `BACK [count]`, `Z [count]` | Reverse execution, including stack, locals, globals, calls and memory writes. |
| `R`, `K` | Typed VM state and PC; active call frames. |
| `DM [start [end \| L length]]` | Dump VM linear memory. |
| `BP [offset]`, `BC offset\|*` | Set/list breakpoints; clear one/all. |
| `?`, `HELP`, `Q` | Help; exit. |

## Addresses and numbers

Monitor addresses, ranges, counts and integer CALL arguments are **hexadecimal**.
`D 10 L 10` displays 16 bytes from offset 16. `D 10 1F` means the same thing:
end addresses are inclusive. `L10` is accepted too. Use `0d16` for explicit
decimal or `0x10` for explicit hex. WASM files have flat offsets, not segments.

Instruction operands after `A` retain HEXAW source conventions: decimal by
default, or `0x` for hex. Thus `A 27 CONST 42` writes decimal 42 at hexadecimal
offset 27. The one-line form must replace an existing instruction and leave a
valid module. Continuous assembly validates the complete draft on exit.
Float CALL arguments use decimal, Infinity or NaN. Integer arguments retain
their exact bits, including i64 values.

Byte lists accept one/two hex digits per byte or quoted UTF-8 strings. Both
quote styles work; double a quote to include it in a string.

```text
S 0 L 2A "add"
H FF 1
```

`D`, `U`, `A` and breakpoints use **FILE offsets** into the binary. `DM` uses
**MEM offsets** into VM linear memory. Output labels the address space. `R`'s
PC is a FILE offset. `FN` uses defined code-body indices; export names are
available for modules represented by the debugger model.

## Continuous assembly: `A`

```sh
npm run shell -- examples/assembly.hexaw
```

Type `A`, then enter instructions one at a time:

```text
A
CONST 20
CONST 22
ADD
END

CALL answer
G
```

**Press Enter on an empty line after END.** Each instruction's machine bytes
appear immediately, for example `41 14` for `CONST 20`, `41 16` for `CONST 22`,
and `6A` for `ADD`. The `A 000000xx>` prompt advances by the actual encoded
length; `A*` means it contains draft instructions. The example returns 42.
`END` is an actual WASM instruction; it does not exit assembly mode.

`A address` chooses an existing instruction boundary using a hexadecimal FILE
offset. Bare `A` resumes the last assembly position, initially the first defined
function's first instruction. `FN body` or `FN export` selects another function
for a subsequent bare `A`. Each entered line replaces one original instruction;
additional lines grow that function once its original instructions are exhausted.
The function's final END removes any remaining original instructions, allowing
a shorter replacement. An inner block's END keeps the following code; a partial
patch without a final END also retains untouched instructions. Another function
is never overwritten. Use a loaded `.hexaw` skeleton to set up FN/PAR/RES/LOC declarations;
assembly mode accepts the 571 instruction mnemonics, not module declarations.

| While assembling | Action |
| --- | --- |
| Empty Enter | Validate and apply the entire draft as one undoable edit. |
| `:UNDO` | Remove the most recently entered instruction and move the cursor back. |
| `:LIST` | Display the current draft with offsets, bytes and instructions. |
| `:CANCEL`, Esc, Ctrl-C | Discard the draft and return to the monitor. |
| `?`, `:HELP`, F1 | Show assembly help and the mnemonic list. |
| F3 | Recall the original instruction at this position for editing. |
| Tab, up/down | Complete mnemonics/assembly controls; recall input history. |

Intermediate stack/type/block states may be incomplete. The working buffer and
VM remain unchanged until empty Enter succeeds. Syntax errors keep the cursor
at the same address. A validation error retains the draft: use `:UNDO` to correct
it or `:CANCEL` to abandon it, then retry empty Enter. After applying it, monitor
`UNDO`/`REDO` undo/redo the entire assembly edit; `W file` saves the binary.

Operands keep HEXAW source radix: `CONST 42` means decimal 42, `CONST 0x2A`
means the same. `CALL 0` inside assembly mode assembles a call instruction;
leave the mode before using monitor CALL/T/G. Comments beginning with `;`, `//`
or `#` do not end the draft. An actually empty/whitespace-only line does.

FILE addresses shown during entry are provisional: changed body or section
lengths can require longer LEB128 size prefixes. Applying the draft reports its
final range and any rebase. `U` then starts at the final address. Drafts are
limited to 10000h encoded bytes and individual input lines to 10000h characters.
EOF discards an open draft; scripts exit nonzero if instructions were pending.

The complete scripted example runs from the repository root:

```sh
node packages/cli/dist/cli.js shell < examples/assembly.commands
```

It assembles 42, runs it, then undoes the whole edit and runs the original 0.

## Memory and reverse tracing

```sh
npm run shell -- examples/monitor.hexaw
```

```text
CALL main
DM 0 L 10
G
DM 0 L 10
BACK 4
DM 0 L 10
```

The module calls `inc` indirectly, stores 42 and returns it. `BACK 4` rewinds
the final END, LOAD, CONST and STORE, restoring the original `HEXAW` data.
Explore the call with `T`/`P` and inspect call frames with `K`.

## Editing and execution limits

`E`, `F` and `A` change a working copy; `W file` saves it. Loading another file
or quitting discards unsaved edits. Byte edits may temporarily invalidate the
buffer; D/search/edit undo still work. `V` reports its status. One-line `A`
validates a replacement before committing it; continuous `A` validates its
whole draft on empty Enter. Each applied edit/undo/redo resets the VM and clears
breakpoints, avoiding stale instruction addresses.

Byte-edit history has a 16 MiB budget, evicting oldest edits as needed. Execution
history separately retains the most recent 2,000 VM steps. Display/fill ranges
are limited to 10000h bytes per command. Search lists up to 256 matches. The
usual input limit is 64 MiB. Assembly edits recalculate body and section sizes;
custom debug offsets and relocations are not rewritten (see binary-source.md).

The VM executes its scalar subset, BRTABLE and CALLIND. The 571-opcode decoder
supports broader inspection and assembly. Imports, start functions or advanced
types may prevent preparing a VM; there is no native execution fallback. VM
memory needs an explicit maximum of at most 256 pages. G/P default to a budget
of 100,000 instructions and yield to Ctrl-C. `G 10` runs at most 16 instructions.

## Command scripts

```sh
node packages/cli/dist/cli.js shell < examples/monitor.commands
```

The same commands work through stdin, without terminal escapes or prompts.
Commands execute in order, including asynchronous loads. Errors go to stderr;
later commands continue and a script exits nonzero if any command failed. EOF
exits cleanly; Q is optional. The monitor uses stdin for commands and loads data
through filenames; `-` remains reserved for batch binary/source input.

## Historical references

The reference behavior comes from [DOS DEBUG's documented commands](https://pushbx.org/ecm/doc/msdebug.htm)
and [SST 2.0's original manual](https://bitsavers.org/pdf/victor/victor9000/Victor_9000_Various_Disk_Tools_Manuals.pdf#page=71).
The combined PDF contains the January 14, 1988 SST 2.0 manual under the name
*Scroll Symbolic Tracer*, including reversible tracing. Murray Sargent describes
SST's use with David Weise in his [first-person retrospective](https://devblogs.microsoft.com/math-in-office/its-been-so-fine/).
The earlier [SST 1.3 archive listing](https://vetusware.com/download/SST%20Debugger%201.3/?id=13154)
uses *Scroll Screen Tracer*. HEXAW adopts the interaction ideas with WASM-specific
commands and address spaces.

SST's `A [address]` is documented on printed pages 7-3 through 7-8
([the entry/byte-output example is PDF page 144](https://bitsavers.org/pdf/victor/victor9000/Victor_9000_Various_Disk_Tools_Manuals.pdf#page=144)).
It prompts with a segment:offset address, shows machine code after each entered
instruction, and advances to the next address. Two consecutive Enter keys
(the instruction's Enter followed by an empty Enter) return to command mode.
F1 lists mnemonics, F3 recalls the current instruction, and Esc leaves assembly
mode. Unlike SST's direct writes to x86 memory, HEXAW stages a draft so structured
WASM can be validated and its length fields rebuilt together. HEXAW's Esc/Ctrl-C
discard that draft; successful edits are retained in the monitor undo history.
