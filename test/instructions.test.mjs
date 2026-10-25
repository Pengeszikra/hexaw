import test from 'node:test';
import assert from 'node:assert/strict';
import wabtFactory from 'wabt';
import {INSTRUCTIONS,INSTRUCTION_NAMES,encodeInstruction,decodeInstruction,BinaryReader,decodeBinary,disassembleBinary,assembleBinary,assembleWasm,compileHEXAW,dumpWasm,Debugger} from '../packages/cli/dist/index.js';

const wabt=await wabtFactory();
const features=Object.fromEntries(Object.keys(wabt.FEATURES).map(name=>[name,true]));
function wat(source){const mod=wabt.parseWat('fixture.wat',source,features);try{mod.resolveNames();mod.validate(features);return Uint8Array.from(mod.toBinary({canonicalize_lebs:true,write_debug_names:false}).buffer);}finally{mod.destroy();}}
const asHex=bytes=>Buffer.from(bytes).toString('hex');
const opcodeHex=rule=>rule.prefix?rule.prefix.toString(16)+(rule.opcode<128?rule.opcode.toString(16).padStart(2,'0'):((rule.opcode&127)|128).toString(16)+(rule.opcode>>7).toString(16).padStart(2,'0')):rule.opcode.toString(16).padStart(2,'0');
function immediateFixture(rule){
  const args=[],hex=[];
  for(const kind of rule.encoding.split(' ').filter(Boolean)){
    if(kind==='u32'){args.push('130');hex.push('8201');}
    if(kind==='s32'){args.push('-65');hex.push('bf7f');}
    if(kind==='s64'){args.push('-9223372036854775808');hex.push('8080808080808080807f');}
    if(kind==='f32'){args.push('bits:0x7fc01234');hex.push('3412c07f');}
    if(kind==='f64'){args.push('bits:0x7ff8000000001234');hex.push('341200000000f87f');}
    if(kind==='heap'||kind==='block'){args.push('type:130');hex.push('8201');}
    if(kind==='zero')hex.push('00');
    if(kind==='v128'){args.push('0x000102030405060708090a0b0c0d0e0f');hex.push('000102030405060708090a0b0c0d0e0f');}
    if(kind==='shuffle'){args.push(...Array.from({length:16},(_,i)=>String(i)));hex.push('000102030405060708090a0b0c0d0e0f');}
    if(kind==='lane'){args.push('1');hex.push('01');}
    if(kind==='memarg'){args.push('4294967296',String(Math.log2(rule.width)),'130');hex.push((64+Math.log2(rule.width)).toString(16),'8201','8080808010');}
    if(kind==='brtable'){args.push('130','1','2');hex.push('0282010102');}
    if(kind==='types'){args.push('i32','ref:null:type:130');hex.push('027f638201');}
    if(kind==='cast'){args.push('3','130','func','type:130');hex.push('038201708201');}
    if(kind==='trytable'){args.push('type:130','catch:130:2','catch_ref:3:4','catch_all:5','catch_all_ref:6');hex.push('8201040082010201030402050306');}
  }return {args,hex:hex.join('')};
}
test('the pinned profile contains all MVP opcodes and unambiguous modern mnemonics',()=>{
  assert.equal(INSTRUCTIONS.length,571);assert.equal(new Set(INSTRUCTIONS.map(r=>r.name)).size,571);
  assert.equal(new Set(INSTRUCTIONS.map(r=>r.prefix+':'+r.opcode)).size,571);
  assert.equal(INSTRUCTIONS.filter(r=>r.feature==='mvp').length,172);
  assert.deepEqual([0,251,252,253,254].map(p=>INSTRUCTIONS.filter(r=>r.prefix===p).length),[199,31,18,256,67]);
  assert.equal(INSTRUCTION_NAMES.BRTABLE.opcode,14);assert.equal(INSTRUCTION_NAMES.CALLIND.opcode,17);
});
for(const rule of INSTRUCTIONS)test(`opcode ${rule.prefix.toString(16)}:${rule.opcode.toString(16)} ${rule.wasm} ↔ ${rule.name}`,()=>{
  const fixture=immediateFixture(rule),expected=opcodeHex(rule)+fixture.hex;
  assert.equal(asHex(encodeInstruction(rule.name,fixture.args)),expected);
  const bytes=Uint8Array.from(Buffer.from(expected,'hex')),reader=new BinaryReader(bytes),decoded=decodeInstruction(reader);
  assert.equal(decoded.name,rule.name);assert.equal(reader.pos,bytes.length);
  assert.equal(asHex(encodeInstruction(decoded.name,decoded.args)),expected);
});

const cases=[
  ['branch table','(module (func (export "run") (param i32) (result i32) block block local.get 0 br_table 0 1 end i32.const 11 return end i32.const 22))',['BRTABLE'],11,[0]],
  ['indirect call','(module (type $t (func (param i32) (result i32))) (table 2 funcref) (func $inc (type $t) local.get 0 i32.const 1 i32.add) (elem (i32.const 0) $inc) (func (export "run") (param i32) (result i32) local.get 0 i32.const 0 call_indirect (type $t)))',['CALLIND'],10,[9]],
  ['saturating conversion','(module (func (export "run") (result i32) f32.const nan i32.trunc_sat_f32_s))',['TRUNCSATF'],0],
  ['bulk memory','(module (memory 1) (data "a\\00\\ff") (func (export "run") (result i32) i32.const 0 i32.const 0 i32.const 3 memory.init 0 data.drop 0 i32.const 3 i32.const 65 i32.const 2 memory.fill i32.const 5 i32.const 0 i32.const 3 memory.copy i32.const 5 i32.load8_u))',['MEMORYINIT','DATADROP','MEMORYFILL','MEMORYCOPY'],97],
  ['references and typed select','(module (func (export "run") (result i32) ref.null func ref.null func i32.const 1 select (result funcref) ref.is_null))',['REFNULL','SELECTT','REFISNULL'],1],
  ['table operations','(module (table 2 funcref) (func $f) (elem func $f) (func (export "run") (result i32) i32.const 0 i32.const 0 i32.const 1 table.init 0 elem.drop 0 i32.const 1 ref.null func table.set 0 i32.const 0 i32.const 1 i32.const 1 table.copy 0 0 i32.const 0 ref.null func i32.const 1 table.fill 0 ref.null func i32.const 1 table.grow 0 drop i32.const 0 table.get 0 drop table.size 0))',['TABLEINIT','ELEMDROP','TABLESET','TABLECOPY','TABLEFILL','TABLEGROW','TABLEGET','TABLESIZE'],3],
  ['multiple values and block parameters','(module (func (export "run") (result i32) i32.const 7 block (param i32) (result i32 i64) i64.const 8 end drop))',['BLOCK'],7],
  ['SIMD','(module (func (export "run") (result i32) v128.const i32x4 1 2 3 4 v128.const i32x4 2 2 2 2 i32x4.add i32x4.extract_lane 0))',['V128CONST','I32X4ADD','I32X4EXTRACTLANE'],3],
  ['SIMD memory lanes','(module (memory 1) (func (export "run") (result i32) i32.const 0 v128.const i32x4 1 2 3 4 v128.store32_lane 2 i32.const 0 i32.load))',['V128STORE32LANE'],3],
  ['relaxed SIMD','(module (func (export "run") (result i32) v128.const i32x4 0 0 0 0 v128.const i32x4 0 0 0 0 i8x16.relaxed_swizzle i8x16.extract_lane_u 0))',['I8X16RELAXEDSWIZZLE'],0],
  ['tail call','(module (func $id (param i32) (result i32) local.get 0) (func (export "run") (result i32) i32.const 9 return_call $id))',['RETURNCALL'],9],
  ['memory64','(module (memory i64 1) (func (export "run") (result i32) i64.const 0 i32.const 11 i32.store i64.const 0 i32.load))',['STORE','LOAD'],11],
  ['multiple memories','(module (memory 1) (memory 1) (func (export "run") (result i32) i32.const 0 i32.const 12 i32.store 1 i32.const 0 i32.load 1))',['STORE','LOAD'],12],
  ['threads and atomics','(module (memory 1 1 shared) (func (export "run") (result i32) i32.const 0 i32.const 5 i32.atomic.store atomic.fence i32.const 0 i32.const 2 i32.atomic.rmw.add))',['ATOMICFENCE','I32ATOMICSTORE','I32ATOMICRMWADD'],5],
  ['exception handling','(module (tag $e (param i32)) (func (export "run") (result i32) block (result i32) try_table (catch $e 0) i32.const 17 throw $e end unreachable end))',['TRYTABLE','THROW'],17],
];
for(const [name,text,names,result,args=[]] of cases)test(`WABT oracle: ${name} compiles, decodes and reconstructs exact bytes`,()=>{
  const bytes=wat(text),module=decodeBinary(bytes);assert.equal(module.fullyDecoded,true,module.diagnostics.join('\n'));
  const instructions=module.records.filter(r=>r.kind==='instruction');for(const name of names)assert.ok(instructions.some(r=>r.text.split(' ')[0]===name),name);
  assert.deepEqual(module.records.flatMap(r=>r.bytes),[...bytes]);
  const source=disassembleBinary(module);assert.deepEqual(assembleBinary(source),bytes);
  if(WebAssembly.validate(bytes)){
    assert.deepEqual(assembleWasm(dumpWasm(bytes,{format:'source'})),bytes);
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(assembleWasm(source))).exports.run(...args),result);
  }else assert.throws(()=>assembleWasm(source),/WASM validation/);
});

test('GC struct instructions use real prefixed opcodes and preserve type metadata',()=>{
  // Independent binary fixture: struct type 0, function type 1, new/get field 0.
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,1,9,2,95,1,127,1,96,0,1,127,3,2,1,1,10,13,1,11,0,65,42,251,0,0,251,2,0,0,11]);
  assert.ok(WebAssembly.validate(bytes));const module=decodeBinary(bytes);assert.equal(module.fullyDecoded,true);
  assert.match(disassembleBinary(module),/STRUCTNEW 0/);assert.match(disassembleBinary(module),/STRUCTGET 0 0/);
  assert.deepEqual(assembleWasm(dumpWasm(bytes,{format:'source'})),bytes);
});
test('modern scalar instructions are also usable directly in compact FN source',()=>{
  const bytes=assembleWasm('FN 0\nRES\nFCONST NaN\nTRUNCSATF\nEND');assert.equal(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.fn00(),0);
  assert.match(dumpWasm(bytes,{codeOnly:true}),/TRUNCSATF/);
});
test('typed function references encode type indices and execute through CALLREF',()=>{
  // Independent binary fixture with a declarative element and a typed function reference.
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,1,10,2,96,1,127,1,127,96,0,1,127,3,3,2,0,1,7,7,1,3,114,117,110,0,1,9,5,1,3,0,1,0,10,15,2,4,0,32,0,11,8,0,65,9,210,0,20,0,11]);
  const module=decodeBinary(bytes);assert.equal(module.fullyDecoded,true);const source=disassembleBinary(module);assert.match(source,/CALLREF 0/);assert.deepEqual(assembleBinary(source),bytes);
  if(WebAssembly.validate(bytes)){const rebuilt=assembleWasm(source);assert.equal(new WebAssembly.Instance(new WebAssembly.Module(rebuilt)).exports.run(),9);}
  else assert.throws(()=>assembleWasm(source),/WASM validation/);
});
test('BRTABLE executes every selector including negative default, and rewinds',()=>{
  const p=compileHEXAW('FN 0\nPAR 0\nRES\nBLOCK\nBLOCK\nGET 0\nBRTABLE 0 1\nEND\nCONST 11\nRET\nEND\nCONST 22\nEND');
  const native=new WebAssembly.Instance(p.nativeModule).exports.fn00;
  for(const n of [0,1,2,-1,2147483647]){const vm=new Debugger(p.decoded,0,[n]);vm.run();assert.equal(vm.error,null);assert.equal(vm.result[0].value,native(n));while(vm.back()){}vm.run();assert.equal(vm.result[0].value,native(n));}
});
test('CALLIND validates signatures, bounds and null elements, and rewinds calls',()=>{
  const p=compileHEXAW('TABLE 3\nELEM 0 0 1\nFN 0\nPAR 0\nRES\nGET 0\nCONST 1\nADD\nEND\nFN 1\nEND\nFN 2\nPAR 0\nPAR 1\nRES\nGET 0\nGET 1\nCALLIND 0\nEND');
  const native=new WebAssembly.Instance(p.nativeModule).exports.fn02;
  for(const index of [0,1,2,3,-1]){const vm=new Debugger(p.decoded,2,[41,index]);vm.run();if(index===0){assert.equal(vm.result[0].value,native(41,index));while(vm.back()){}vm.run();assert.equal(vm.result[0].value,42);}else{assert.equal(vm.state,'trapped');assert.throws(()=>native(41,index),WebAssembly.RuntimeError);assert.ok(vm.back());assert.equal(vm.error,null);}}
});
test('source edits invalidate saved encodings and recompute body and section sizes',()=>{
  const bytes=wat('(module (func (export "run") (result i32) i32.const 1))');
  const source=disassembleBinary(decodeBinary(bytes)).replace('CONST 1 ;','CONST 100000 ;');
  const rebuilt=assembleWasm(source);assert.notDeepEqual(rebuilt,bytes);assert.equal(new WebAssembly.Instance(new WebAssembly.Module(rebuilt)).exports.run(),100000);
});
test('out-of-bounds element initializers fail during debugger and native instantiation',()=>{
  const p=compileHEXAW('TABLE 1\nELEM 1 0\nFN 0\nEND');assert.throws(()=>new WebAssembly.Instance(p.nativeModule),WebAssembly.RuntimeError);assert.throws(()=>new Debugger(p.decoded),/Element segment/);
});
test('padded LEB128, NaN payloads, custom sections and local groups survive source round trips',()=>{
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,125,3,2,1,0,0,4,1,120,255,0,10,0x8b,0,0x81,0,0x87,0,0,67,0x34,0x12,0xc0,0x7f,11]);
  assert.ok(WebAssembly.validate(bytes));const source=dumpWasm(bytes,{format:'source'});assert.match(source,/bits:0x7fc01234/);assert.deepEqual(assembleWasm(source),bytes);
});
test('malformed, overflowing and truncated instruction operands fail without guessing',()=>{
  for(const bytes of [[0xfc,0x80],[0x41,0xff,0xff,0xff,0xff,0x1f],[0x0e,0xff,0xff,0xff,0xff,0x0f],[0xfd,0x15,16],[0xfe,3,1],[0xfb,24,4],[0x1f,0x40,1,4]])assert.throws(()=>decodeInstruction(new BinaryReader(Uint8Array.from(bytes))));
  for(const [name,args] of [['BRTABLE',[]],['CALLIND',['0']],['I8X16EXTRACTLANEU',['16']],['LOAD',['0','3']],['CONST',['4294967296']],['REFNULL',['unknown']],['V128CONST',['0x00']],['ATOMICFENCE',['0']],['TRYTABLE',['void','catch:0']]])assert.throws(()=>encodeInstruction(name,args),name);
});
test('unknown instructions preserve the rest of that body and resume at the next body',()=>{
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,10,8,2,3,0,255,11,2,0,11]);
  const module=decodeBinary(bytes);assert.equal(module.fullyDecoded,false);assert.equal(module.diagnostics.length,1);assert.ok(module.records.some(r=>r.owner==='body01'&&r.text==='END'));assert.deepEqual(module.records.flatMap(r=>r.bytes),[...bytes]);
});
test('invalid layout source reports its line and never produces a partial module',()=>{
  assert.throws(()=>assembleBinary('WASM 1\nSECTION CODE\nBODY 00\nBOGUS\nENDBODY\nENDSECTION'),e=>e.line===4&&/Unknown instruction/.test(e.message));
  for(const source of ['WASM 2','WASM 1\nSECTION TYPE\nBYTES xyz\nENDSECTION','WASM 1\nSECTION CODE\nEND','WASM 1\nSECTION TYPE','WASM 1\nSECTION CODE\nBODY 00\nENDBODY\nENDSECTION'])assert.throws(()=>assembleBinary(source));
});
