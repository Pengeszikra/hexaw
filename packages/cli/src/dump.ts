import {compileHEXAW,decodeWASM,disassembleHEXAW,hex} from './core/hexaw-core.js';
import type {DecodedModule} from './core/hexaw-core.js';
import {decodeBinary,disassembleBinary} from './core/binary-module.js';

export type DumpFormat='dump'|'source'|'json'|'hex';
export interface DumpOptions {format?:DumpFormat;codeOnly?:boolean;strict?:boolean}
export interface DumpRecord {offset:number;bytes:number[];kind:string;section:string;owner:string;text:string;depth:number}
export interface WasmInspection {
  bytes:Uint8Array;
  /** The debugger model is available for its supported execution subset. */
  decoded:DecodedModule|null;
  /** The opcode decoder supports the full documented instruction profile. */
  binary:ReturnType<typeof decodeBinary>|null;
  records:DumpRecord[];
  diagnostic:string|null;
}
function asBytes(input:Uint8Array|ArrayBuffer):Uint8Array {
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length>64*1024*1024)throw new Error('Binary input limit: 64 MiB');return bytes;
}
function validateWasm(bytes:Uint8Array):Uint8Array {
  if(!WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>))throw new Error('Invalid WebAssembly binary (or a feature unsupported by this Node.js engine)');return bytes;
}
function rawRecords(bytes:Uint8Array):DumpRecord[]{
  const records:DumpRecord[]=[];for(let offset=0;offset<bytes.length;offset+=16)records.push({offset,bytes:[...bytes.subarray(offset,offset+16)],kind:'raw',section:'module',owner:'module',text:'RAW',depth:0});return records;
}
function inspectValidated(bytes:Uint8Array):WasmInspection {
  let decoded:DecodedModule|null=null;try{decoded=decodeWASM(bytes,{inspect:true});}catch{}
  try{const binary=decodeBinary(bytes);return {bytes,decoded,binary,records:binary.records,diagnostic:binary.diagnostics.join('; ')||null};}
  catch(error){return {bytes,decoded,binary:null,records:rawRecords(bytes),diagnostic:error instanceof Error?error.message:String(error)};}
}
/** The production path is built with the TS+|> fork. */
export function inspectWasm(input:Uint8Array|ArrayBuffer):WasmInspection {
  return input |> asBytes |> validateWasm |> inspectValidated;
}
function formatHex(inspection:WasmInspection):string {
  const lines=['; HEXAW · raw WebAssembly hex dump','; offset   : bytes                                           : ASCII'];
  for(const r of rawRecords(inspection.bytes))lines.push(`${hex(r.offset,8)} : ${r.bytes.map(b=>hex(b)).join(' ').padEnd(47)} : ${r.bytes.map(b=>b>=32&&b<=126?String.fromCharCode(b):'.').join('')}`);
  return lines.join('\n')+'\n';
}
function formatInspection(inspection:WasmInspection,options:DumpOptions):string {
  const format=options.format??'dump',complete=inspection.binary?.fullyDecoded??false;
  if(format==='hex')return formatHex(inspection);
  if((options.strict||options.codeOnly||format==='source')&&!complete)throw new Error(`Cannot decode this module as HEXAW: ${inspection.diagnostic}. Use --format hex for its exact bytes.`);
  if(format==='source'){
    // Keep the familiar compact syntax when it reconstructs the exact module.
    if(inspection.decoded)try{
      const source=disassembleHEXAW(inspection.decoded),rebuilt=compileHEXAW(source).bytes;
      if(rebuilt.length===inspection.bytes.length&&rebuilt.every((b,i)=>b===inspection.bytes[i]))return source;
    }catch{}
    return disassembleBinary(inspection.binary!);
  }
  const records=options.codeOnly?inspection.records.filter(r=>r.kind==='instruction'):inspection.records;
  if(format==='json')return JSON.stringify({format:'hexaw-dump',version:1,size:inspection.bytes.length,decoded:complete,diagnostic:inspection.diagnostic,records},null,2)+'\n';
  const header=[`; HEXAW · ${inspection.bytes.length} bytes · ${complete?'decoded WebAssembly':'partial decoding / raw byte preservation'}`];
  if(inspection.diagnostic)header.push(`; Decoder limit: ${inspection.diagnostic}`,'; Unsupported instructions retain RAW bytes until the next function boundary.');
  header.push('; offset   : bytes                                           : instruction / structure');
  return header.concat(records.map(r=>`${hex(r.offset,8)} : ${r.bytes.map(b=>hex(b)).join(' ').padEnd(47)} : ${'  '.repeat(r.depth)}${r.text}`)).join('\n')+'\n';
}
export function dumpWasm(input:Uint8Array|ArrayBuffer,options:DumpOptions={}):string {
  return input |> inspectWasm |> ((inspection:WasmInspection)=>formatInspection(inspection,options));
}
