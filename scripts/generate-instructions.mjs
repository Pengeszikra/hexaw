// Rebuild the opcode snapshot from the two upstream source files documented below.
// Run: node scripts/generate-instructions.mjs opcode.def binary_reader.rs
// Only Core Wasm 3.0, threads and the five legacy EH opcodes are selected.
import {readFile,writeFile} from 'node:fs/promises';
import {RULES} from '../packages/cli/src/core/hexaw-core.js';
const [wabtPath,readerPath]=process.argv.slice(2);
if(!wabtPath||!readerPath)throw new Error('Provide WABT opcode.def and wasmparser binary_reader.rs');
const wabt=await readFile(wabtPath,'utf8'),reader=await readFile(readerPath,'utf8');
const legacy=new Map(Object.values(RULES).filter(r=>!r.directive&&r.kind!=='encoded').map(r=>[r.wasm,r.name]));
const entries=[];
for(const match of wabt.matchAll(/^WABT_OPCODE\((.+)\)$/gm)){
  const args=match[1].split(',').map(s=>s.trim());
  const [width,prefix,code]=args.slice(5,8).map(Number),wasm=JSON.parse(args[9]);
  if(!(prefix===0&&code<=0xd6||prefix===0xfc&&code<=0x11||prefix===0xfd&&code<=0x113||prefix===0xfe&&code<=0x4e))continue;
  entries.push({prefix,code,wasm,width});
}
entries.push({prefix:0,code:0xd3,wasm:'ref.eq',width:0});
// GC mnemonics are absent from the WABT release table; obtain these from wasmparser.
const gc=reader.slice(reader.indexOf('fn visit_0xfb_operator'),reader.indexOf('fn visit_0xfc_operator'));
for(const match of gc.matchAll(/^            (0x[0-9a-f]+) => ([\s\S]*?)(?=^            (?:0x|_ =>))/gm)){
  const code=Number(match[1]);if(code>0x1e)continue;
  const visit=match[2].match(/visitor\.visit_(\w+)\(/)?.[1];
  if(!visit)throw new Error(`Missing GC operator ${match[1]}`);
  let wasm=visit.replace(/^(struct|array|ref|i31|any|extern)_/,'$1.');
  wasm=wasm.replace('ref.test_non_null','ref.test').replace('ref.test_nullable','ref.test').replace('ref.cast_non_null','ref.cast').replace('ref.cast_nullable','ref.cast');
  entries.push({prefix:0xfb,code,wasm,width:0});
}
function encoding(p,c){
  if(p===0){
    if([2,3,4,6].includes(c))return 'block';
    if([7,8,9,12,13,16,18,20,21,24,32,33,34,35,36,37,38,63,64,210,213,214].includes(c))return 'u32';
    if(c===14)return 'brtable';if(c===17||c===19)return 'u32 u32';
    if(c===28)return 'types';if(c===31)return 'trytable';
    if(c>=40&&c<=62)return 'memarg';
    return ({65:'s32',66:'s64',67:'f32',68:'f64',208:'heap'})[c]||'';
  }
  if(p===0xfb){
    if([0,1,6,7,11,12,13,14,16].includes(c))return 'u32';
    if([2,3,4,5,8,9,10,17,18,19].includes(c))return 'u32 u32';
    if(c>=20&&c<=23)return 'heap';if(c===24||c===25)return 'cast';return '';
  }
  if(p===0xfc)return [8,10,12,14].includes(c)?'u32 u32':c>=8?'u32':'';
  if(p===0xfd){
    if(c<=11||c===92||c===93)return 'memarg';
    if(c===12)return 'v128';if(c===13)return 'shuffle';
    if(c>=21&&c<=34)return 'lane';if(c>=84&&c<=91)return 'memarg lane';return '';
  }
  return c===3?'zero':'memarg';
}
const sat=['TRUNCSATF','TRUNCSATFU','TRUNCSATD','TRUNCSATDU','LTRUNCSATF','LTRUNCSATFU','LTRUNCSATD','LTRUNCSATDU'];
const names=new Set();
for(const e of entries){
  e.name=e.prefix===0xfb&&e.code===21?'REFTESTNULL':e.prefix===0xfb&&e.code===23?'REFCASTNULL':e.prefix===0&&e.code===28?'SELECTT':e.prefix===0&&e.code===14?'BRTABLE':e.prefix===0&&e.code===17?'CALLIND':e.prefix===0xfc&&e.code<8?sat[e.code]:legacy.get(e.wasm)||e.wasm.replace(/[._]/g,'').toUpperCase();
  e.encoding=encoding(e.prefix,e.code);
  e.feature=e.prefix===0xfe?'threads':e.prefix===0xfb?'gc':e.prefix===0xfd?(e.code>=256?'relaxed-simd':'simd'):e.prefix===0xfc?(e.code<8?'nontrapping-conversion':'bulk-memory'):[6,7,9,24,25].includes(e.code)?'legacy-exceptions':e.code<=0xbf&&!([8,10,18,19,20,21,28,31,37,38].includes(e.code))?'mvp':e.code>=0xc0&&e.code<=0xc4?'sign-extension':'core-extensions';
  if(names.has(e.name))throw new Error(`Duplicate mnemonic ${e.name}`);names.add(e.name);
}
entries.sort((a,b)=>a.prefix-b.prefix||a.code-b.code);
// Assert that each upstream entry was actually selected once.
if(entries.filter(e=>!e.prefix&&e.code<=0xbf&&!['core-extensions','legacy-exceptions'].includes(e.feature)).length!==172)throw new Error('Incomplete MVP instruction set');
const markers=['pub fn visit_operator','fn visit_0xfb_operator','fn visit_0xfc_operator','pub(super) fn visit_0xfd_operator','fn visit_0xfe_operator'];
for(let i=0;i<markers.length;i++){
  const prefix=[0,251,252,253,254][i],max=[0xd6,0x1e,0x11,0x113,0x4e][i];
  const body=reader.slice(reader.indexOf(markers[i]),i+1<markers.length?reader.indexOf(markers[i+1]):reader.indexOf('fn read_memarg'));
  for(const m of body.matchAll(/^            (0x[0-9a-f]+) =>/gm))if(Number(m[1])<=max&&!entries.some(e=>e.prefix===prefix&&e.code===Number(m[1])))throw new Error(`Unmapped opcode ${prefix}:${m[1]}`);
}
const header=`/** Opcode facts transcribed from WebAssembly Core 3.0 and the threads proposal.
 * Cross-checked against WebAssembly/wabt include/wabt/opcode.def (13f37e1b)
 * and bytecodealliance/wasm-tools crates/wasmparser/src/binary_reader.rs (0ce22353).
 * Upstream projects: Apache-2.0. No executable upstream code is included.
 * Regenerate with scripts/generate-instructions.mjs; do not edit rows by hand.
 */\n`;
const rows=entries.map(e=>`  ${JSON.stringify([e.prefix,e.code,e.wasm,e.name,e.encoding,e.width,e.feature])}`).join(',\n');
await writeFile(new URL('../packages/cli/src/core/instruction-set.js',import.meta.url),header+`const rows = [\n${rows}\n];\n/** @type {ReadonlyArray<Readonly<{prefix:number,opcode:number,wasm:string,name:string,encoding:string,width:number,feature:string}>>} */\nexport const INSTRUCTIONS=Object.freeze(rows.map(([prefix,opcode,wasm,name,encoding,width,feature])=>Object.freeze({prefix,opcode,wasm,name,encoding,width,feature})));\nexport const INSTRUCTION_NAMES=Object.freeze(Object.fromEntries(INSTRUCTIONS.map(rule=>[rule.name,rule])));\nexport const INSTRUCTION_OPCODES=Object.freeze(Object.fromEntries(INSTRUCTIONS.map(rule=>[rule.prefix+':'+rule.opcode,rule])));\n`);
const reference='# HEXAW instruction reference\n\nPinned profile: WebAssembly Core 3.0, threads/atomics, and five legacy exception opcodes.\n\n'+
  'Generated with the instruction table. `prefix:opcode` uses hexadecimal numbers; prefixed opcodes use unsigned LEB128. Operand schemas are described in [the binary source guide](binary-source.md).\n\n'+
  '| HEXAW | WASM | Prefix:opcode | Operands |\n| --- | --- | --- | --- |\n'+entries.map(e=>`| ${e.name} | ${e.wasm} | ${e.prefix.toString(16)}:${e.code.toString(16)} | ${e.encoding||'—'} |`).join('\n')+'\n';
await writeFile(new URL('../docs/instructions.md',import.meta.url),reference);
console.log(`Generated ${entries.length} instructions`);
