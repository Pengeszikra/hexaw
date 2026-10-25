export { dumpWasm, inspectWasm } from './dump.js';
export { assembleWasm } from './assemble.js';
export { INSTRUCTIONS, INSTRUCTION_NAMES, INSTRUCTION_OPCODES } from './core/instruction-set.js';
export { encodeInstruction, decodeInstruction, BinaryReader, BinaryError } from './core/instruction-codec.js';
export { decodeBinary, disassembleBinary, assembleBinary } from './core/binary-module.js';
export type { BinaryModule, BinarySection, BinaryBody, BinaryInstruction, BinaryRecord } from './core/binary-module.js';
export type { DumpFormat, DumpOptions, DumpRecord, WasmInspection } from './dump.js';
export { compileHEXAW, disassembleHEXAW, decodeWASM, hexawContext, Debugger, RULES, TYPES } from './core/hexaw-core.js';
export type { ByteAtom, CompiledModule, DecodedModule, Instruction, NumericType, NumericValue } from './core/hexaw-core.js';
