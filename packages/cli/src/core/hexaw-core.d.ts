/** Typed boundary around the shared, browser-compatible assembly/debug engine. */
export type NumericType = 'i32' | 'i64' | 'f32' | 'f64';
export type NumericValue = number | bigint;
export interface Rule {
  readonly name: string;
  readonly opcode?: number;
  readonly wasm?: string;
  readonly kind: string;
  readonly directive?: boolean;
  readonly type?: NumericType;
  readonly width?: number;
  readonly store?: boolean;
  readonly signed?: boolean;
}
export interface Instruction {
  name: string;
  rule: Rule;
  offset: number;
  args: Array<NumericValue | string>;
  value?: NumericValue;
  blockType?: NumericType | null;
  depth: number;
  line: number;
  bytes: Uint8Array;
  functionEnd?: boolean;
  endIndex?: number;
  elseIndex?: number;
  atomId?: number;
}
export interface DecodedFunction {
  id: number;
  typeIndex: number;
  params: NumericType[];
  results: NumericType[];
  locals: NumericType[];
  ops: Instruction[];
  offset: number;
}
export interface Section {
  id: number;
  offset: number;
  payload: number;
  end: number;
}
export interface DecodedModule {
  bytes: Uint8Array;
  functions: DecodedFunction[];
  exports: Array<{ name: string; index: number }>;
  otherExports: Array<{ name: string; kind: number; index: number }>;
  globals: Array<{ id: number; type: NumericType; value: NumericValue; mutable: boolean }>;
  memory: { min: number; max: number | null } | null;
  data: Array<{ offset: number; bytes: Uint8Array }>;
  types: Array<{ params: NumericType[]; results: NumericType[] }>;
  sections: Section[];
}
export interface ByteAtom {
  id: number;
  offset: number;
  bytes: Uint8Array;
  kind: string;
  meaning: string;
  value?: NumericValue | string;
  owner: string;
  section: string;
  depth: number;
  line: number;
  instruction?: Instruction;
}
export interface AssembledModule {
  bytes: Uint8Array;
  atoms: ByteAtom[];
  ir?: unknown;
}
export interface CompiledModule extends AssembledModule {
  source?: string;
  decoded: DecodedModule;
  nativeModule: WebAssembly.Module;
  imported?: boolean;
}
export interface StackValue { type: NumericType; value: NumericValue }
export interface TraceItem {
  step: number;
  fn: number;
  offset: number;
  line: number;
  instruction: string;
  stack: StackValue[];
  state: string;
  error: string | null;
}
export const VERSION: string;
export const TYPES: Readonly<Record<NumericType, number>>;
export const RULES: Readonly<Record<string, Rule>>;
export const OPCODES: Readonly<Record<number, Rule>>;
export class HexawError extends Error {
  line: number;
  offset: number | null;
  constructor(message: string, line?: number, offset?: number | null);
}
export function compileHEXAW(source: string): CompiledModule;
export function parseHEXAW(source: string): unknown;
export function assemble(ir: unknown): AssembledModule;
export function decodeWASM(input: Uint8Array | ArrayBuffer, options?: { inspect?: boolean }): DecodedModule;
export function importWASM(input: Uint8Array | ArrayBuffer): CompiledModule;
export function disassembleHEXAW(module: DecodedModule): string;
export function hexawContext(strings: TemplateStringsArray, ...values: unknown[]): CompiledModule;
export function parseValue(text: string, type?: NumericType, line?: number): NumericValue;
export function formatValue(value: NumericValue): string;
export function hex(value: number, width?: number): string;
export function uleb(value: NumericValue): number[];
export function sleb(value: NumericValue): number[];
export class Debugger {
  constructor(module: DecodedModule, entry?: number, args?: NumericValue[]);
  readonly current: Instruction | null;
  readonly currentFrame: { fn: number; pc: number; locals: StackValue[] } | undefined;
  module: DecodedModule;
  state: string;
  error: string | null;
  steps: number;
  stack: StackValue[];
  globals: StackValue[];
  memory: Uint8Array;
  frames: Array<{ fn: number; pc: number; locals: StackValue[] }>;
  history: unknown[];
  trace: TraceItem[];
  result: StackValue[];
  breakpoints: Set<number>;
  step(): TraceItem | null;
  back(): boolean;
  run(limit?: number): { count: number; state: string; result: StackValue[]; limited: boolean };
}
