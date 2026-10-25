import { compileHEXAW, decodeWASM, disassembleHEXAW, formatValue, hex } from './core/hexaw-core.js';
import type { DecodedModule, Instruction } from './core/hexaw-core.js';

export type DumpFormat = 'dump' | 'source' | 'json' | 'hex';
export interface DumpOptions { format?: DumpFormat; codeOnly?: boolean; strict?: boolean }
export interface DumpRecord {
  offset: number;
  bytes: number[];
  kind: string;
  section: string;
  owner: string;
  text: string;
  depth: number;
}
export interface WasmInspection {
  bytes: Uint8Array;
  decoded: DecodedModule | null;
  records: DumpRecord[];
  diagnostic: string | null;
}
const sectionNames: Record<number, string> = {
  0:'custom',1:'type',2:'import',3:'function',4:'table',5:'memory',6:'global',7:'export',
  8:'start',9:'element',10:'code',11:'data',12:'data-count',13:'tag',
};

function asBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Binary input limit: 64 MiB');
  return bytes;
}
function validateWasm(bytes: Uint8Array): Uint8Array {
  // Validation does not instantiate a memory or execute a module's start function.
  if (!WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>)) {
    throw new Error('Invalid WebAssembly binary (or a feature unsupported by this Node.js engine)');
  }
  return bytes;
}
function instructionText(op: Instruction): string {
  const args = op.rule.kind === 'const' ? [formatValue(op.value!)] : op.args;
  return op.name + (args.length ? ' ' + args.join(' ') : '');
}
function rawRecords(bytes: Uint8Array, start=0, end=bytes.length, section='module', owner='module', text='RAW'): DumpRecord[] {
  const records: DumpRecord[] = [];
  for (let offset=start; offset<end; offset+=16) {
    records.push({offset,bytes:Array.from(bytes.subarray(offset,Math.min(offset+16,end))),kind:'raw',section,owner,text,depth:0});
  }
  return records;
}
function recordsFor(module: DecodedModule): DumpRecord[] {
  const bytes=module.bytes;
  const records: DumpRecord[] = [
    {offset:0,bytes:Array.from(bytes.subarray(0,4)),kind:'magic',section:'header',owner:'module',text:'MAGIC "\\0asm"',depth:0},
    {offset:4,bytes:Array.from(bytes.subarray(4,8)),kind:'version',section:'header',owner:'module',text:'VERSION 1',depth:0},
  ];
  for (const s of module.sections) {
    const section=sectionNames[s.id]||`section-${s.id}`;
    records.push({offset:s.offset,bytes:[s.id],kind:'section',section,owner:'module',text:`SECTION ${section.toUpperCase()}`,depth:0});
    records.push({offset:s.offset+1,bytes:Array.from(bytes.subarray(s.offset+1,s.payload)),kind:'uleb128',section,owner:'module',text:`SIZE ${s.end-s.payload}`,depth:0});
    if (s.id!==10) { for (const record of rawRecords(bytes,s.payload,s.end,section,'module',`${section.toUpperCase()} PAYLOAD`)) records.push(record); continue; }
    let offset=s.payload;
    for (const fn of module.functions) {
      const owner=`fn${String(fn.id).padStart(2,'0')}`;
      const first=fn.ops[0]?.offset??fn.offset;
      for (const record of rawRecords(bytes,offset,first,section,owner,`FN ${String(fn.id).padStart(2,'0')} · BODY / LOCALS`)) records.push(record);
      for (const op of fn.ops) {
        records.push({offset:op.offset,bytes:Array.from(op.bytes),kind:'instruction',section,owner,text:instructionText(op),depth:op.depth});
        offset=op.offset+op.bytes.length;
      }
    }
    for (const record of rawRecords(bytes,offset,s.end,section,'module','CODE METADATA')) records.push(record);
  }
  return records;
}
function inspectValidated(bytes: Uint8Array): WasmInspection {
  try {
    const decoded=decodeWASM(bytes,{inspect:true});
    return {bytes,decoded,records:recordsFor(decoded),diagnostic:null};
  } catch (error) {
    const diagnostic=error instanceof Error?error.message:String(error);
    return {bytes,decoded:null,records:rawRecords(bytes),diagnostic};
  }
}

/** Uses the TS+|> fork's unary pipeline in the actual production decode path. */
export function inspectWasm(input: Uint8Array | ArrayBuffer): WasmInspection {
  return input |> asBytes |> validateWasm |> inspectValidated;
}
function formatHex(inspection: WasmInspection): string {
  const lines=['; HEXAW · raw WebAssembly hex dump','; offset   : bytes                                           : ASCII'];
  for (const r of rawRecords(inspection.bytes)) {
    const ascii=r.bytes.map(b=>b>=32&&b<=126?String.fromCharCode(b):'.').join('');
    lines.push(`${hex(r.offset,8)} : ${r.bytes.map(b=>hex(b)).join(' ').padEnd(47)} : ${ascii}`);
  }
  return lines.join('\n')+'\n';
}
function formatInspection(inspection: WasmInspection, options: DumpOptions): string {
  const format=options.format??'dump';
  if (format==='hex') return formatHex(inspection);
  if ((options.strict||options.codeOnly||format==='source')&&!inspection.decoded) {
    throw new Error(`Cannot decode this module as HEXAW: ${inspection.diagnostic}. Use --format hex for its exact bytes.`);
  }
  if (format==='source') {
    if (inspection.decoded!.memory?.max===null) throw new Error('HEXAW source currently requires an explicit memory maximum. The default dump preserves the original memory declaration.');
    const source=disassembleHEXAW(inspection.decoded!);
    try { compileHEXAW(source); }
    catch (error) { throw new Error(`Cannot emit assemblable HEXAW source: ${error instanceof Error?error.message:String(error)}. Use the default dump to retain the original bytes.`); }
    return source;
  }
  const records=options.codeOnly?inspection.records.filter(r=>r.kind==='instruction'):inspection.records;
  if (format==='json') return JSON.stringify({format:'hexaw-dump',version:1,size:inspection.bytes.length,decoded:!!inspection.decoded,diagnostic:inspection.diagnostic,records},null,2)+'\n';
  const header=[`; HEXAW · ${inspection.bytes.length} bytes · ${inspection.decoded?'decoded WebAssembly':'raw byte preservation'}`];
  if (inspection.diagnostic) header.push(`; Decoder limit: ${inspection.diagnostic}`, '; Unsupported features are shown as RAW bytes, not guessed instructions.');
  header.push('; offset   : bytes                                           : instruction / structure');
  const lines=records.map(r=>`${hex(r.offset,8)} : ${r.bytes.map(b=>hex(b)).join(' ').padEnd(47)} : ${'  '.repeat(r.depth)}${r.text}`);
  return header.concat(lines).join('\n')+'\n';
}
/** A dump always accounts for the original bytes; source output is canonical text. */
export function dumpWasm(input: Uint8Array | ArrayBuffer, options: DumpOptions = {}): string {
  return input |> inspectWasm |> ((inspection: WasmInspection) => formatInspection(inspection,options));
}
