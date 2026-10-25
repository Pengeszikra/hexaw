import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HexawSession} from '../packages/cli/dist/session.js';
import {assembleWasm,decodeBinary,disassembleBinary} from '../packages/cli/dist/index.js';

const root=fileURLToPath(new URL('../',import.meta.url)),cli=join(root,'packages/cli/dist/cli.js');
const answer='EXP "answer" 0\nFN 0\nRES\nCONST 0\nEND';
async function fixture(fn,source=answer){const dir=await mkdtemp(join(tmpdir(),'hexaw-assembly-'));try{await writeFile(join(dir,'test.hexaw'),source);const s=new HexawSession(dir);await s.load('test.hexaw');return await fn(s,dir);}finally{await rm(dir,{recursive:true,force:true});}}
const execute=async(s,line)=>(await s.execute(line)).text;
const instructions=s=>s.inspection.records.filter(r=>r.kind==='instruction');
const entry=s=>instructions(s)[0].offset;
const address=n=>n.toString(16);
const native=s=>new WebAssembly.Instance(new WebAssembly.Module(s.bytes)).exports;

test('A accepts successive instructions, echoes exact bytes and advances by their encoded lengths',()=>fixture(async(s,dir)=>{
  const before=s.bytes,start=entry(s);assert.match(await execute(s,'A'),/ASSEMBLE MODE/);assert.equal(s.assemblyAddress,start);
  assert.match(await execute(s,'CONST 20'),new RegExp(`${start.toString(16).toUpperCase().padStart(8,'0')} : 41 14\\s+: CONST 20`));
  assert.equal(s.assemblyAddress,start+2);assert.match(s.prompt,/^A\* /);
  assert.match(await execute(s,'CONST 0x16'),/41 16\s+: CONST 0x16/);assert.equal(s.assemblyAddress,start+4);
  assert.match(await execute(s,'ADD'),/6A\s+: ADD/);assert.match(await execute(s,'END'),/0B\s+: END/);
  assert.equal(s.assembling,true);assert.deepEqual(s.bytes,before);assert.equal(s.dirty,false);
  assert.match(await execute(s,''),/Applied 4 instruction/);assert.equal(s.assembling,false);assert.equal(s.dirty,true);
  assert.equal(native(s).answer(),42);assert.equal(await readFile(join(dir,'test.hexaw'),'utf8'),answer);
  await execute(s,'W answer.wasm');assert.deepEqual(await readFile(join(dir,'answer.wasm')),Buffer.from(s.bytes));
}));

test('assembly accepts incomplete structured code until empty Enter validates the complete draft',()=>fixture(async s=>{
  await execute(s,'A');for(const line of ['BLOCK i32','CONST 42','END','END'])await execute(s,line);
  assert.match(await execute(s,''),/Applied 4 instruction/);assert.equal(native(s).answer(),42);
  assert.deepEqual(instructions(s).map(r=>r.text),['BLOCK i32','CONST 42','END','END']);
}));

test('a final END shortens the function while an inner END preserves the following code',()=>fixture(async(s,dir)=>{
  await execute(s,'A');await execute(s,'CONST 42');await execute(s,'END');await execute(s,'');
  assert.equal(native(s).fn00(0,0),42);assert.deepEqual(instructions(s).map(r=>r.text),['CONST 42','END']);
  await writeFile(join(dir,'nested.hexaw'),'FN 0\nRES\nBLOCK\nNOP\nEND\nCONST 7\nEND');await s.load('nested.hexaw');
  const nop=instructions(s).find(r=>r.text==='NOP');await execute(s,`A ${address(nop.offset)}`);await execute(s,'NOP');await execute(s,'END');await execute(s,'');
  assert.equal(native(s).fn00(),7);assert.deepEqual(instructions(s).map(r=>r.text),['BLOCK void','NOP','END','CONST 7','END']);
},'FN 0\nPAR 0\nPAR 1\nRES\nGET 0\nGET 1\nADD\nRET\nEND'));

test('failed validation retains the draft, original buffer, paused VM and breakpoints for correction',()=>fixture(async s=>{
  const before=s.bytes,start=entry(s);await execute(s,`BP ${address(start)}`);await execute(s,'CALL answer');const vm=s.vm;
  await execute(s,'A');await execute(s,'ADD');const cursor=s.assemblyAddress;
  await assert.rejects(s.execute(''),/Assembly not applied:.*validation[\s\S]*Draft retained/);
  assert.equal(s.assembling,true);assert.equal(s.assemblyAddress,cursor);assert.deepEqual(s.bytes,before);assert.equal(s.vm,vm);assert.ok(s.breakpoints.has(start));
  await execute(s,':UNDO');await execute(s,'CONST 42');await execute(s,'');assert.equal(native(s).answer(),42);assert.equal(s.vm,null);assert.equal(s.breakpoints.size,0);
}));

test('syntax errors, comments, help and draft controls do not move the assembly cursor',()=>fixture(async s=>{
  await execute(s,'A');const start=s.assemblyAddress;
  for(const line of ['BOGUS','CONST','ADD 1',':UNDO extra','CONST "bad'])await assert.rejects(s.execute(line));
  assert.equal(s.assemblyAddress,start);assert.equal(await execute(s,'; comment'),'');assert.equal(await execute(s,'// comment'),'');assert.equal(s.assembling,true);
  assert.match(await execute(s,'?'),/SST inspired/);assert.match(await execute(s,':HELP'),/V128CONST/);
  assert.match(await execute(s,':LIST'),/No draft/);assert.match(await execute(s,':UNDO'),/No draft/);
  await execute(s,'CONST 100000 ; variable-length integer');assert.equal(s.assemblyAddress,start+4);assert.match(await execute(s,':LIST'),/41 A0 8D 06\s+: CONST 100000/);
  await execute(s,':UNDO');assert.equal(s.assemblyAddress,start);await execute(s,'CONST 42 // comment');await execute(s,'');assert.equal(native(s).answer(),42);
}));

test('cancel discards only the draft and a successful assembly is one undoable edit',()=>fixture(async s=>{
  const original=s.bytes;await execute(s,`A ${address(entry(s))} CONST 1`);const edited=s.bytes;
  await execute(s,'CALL answer');const vm=s.vm;await execute(s,'A');await execute(s,'CONST 2');assert.match(await execute(s,':CANCEL'),/1 draft instruction.*discarded/);
  assert.equal(s.assembling,false);assert.deepEqual(s.bytes,edited);assert.equal(s.dirty,true);assert.equal(s.vm,vm);
  await execute(s,'A');for(const line of ['CONST 20','CONST 22','ADD','END'])await execute(s,line);await execute(s,'');const applied=s.bytes;
  await execute(s,'UNDO');assert.deepEqual(s.bytes,edited);await execute(s,'REDO');assert.deepEqual(s.bytes,applied);assert.equal(native(s).answer(),42);
  await execute(s,'UNDO');await execute(s,'UNDO');assert.deepEqual(s.bytes,original);assert.equal(s.dirty,false);
}));

test('A without an address resumes the previous position and FN chooses a body',()=>fixture(async s=>{
  const records=instructions(s),start=records[0].offset;await execute(s,`A ${address(start)}`);await execute(s,'CONST 20');await execute(s,'CONST 22');await execute(s,'');
  await execute(s,'A');assert.equal(s.assemblyAddress,start+4);assert.equal(s.originalInstruction,'ADD');await execute(s,'ADD');await execute(s,'');assert.equal(native(s).fn00(0,0),42);
  await execute(s,'FN 0');await execute(s,'A');assert.equal(s.assemblyAddress,start);await execute(s,':CANCEL');
},'FN 0\nPAR 0\nPAR 1\nRES\nGET 0\nGET 1\nADD\nRET\nEND'));

test('empty assembly sessions and remembered body-end positions leave bytes unchanged',()=>fixture(async s=>{
  const before=s.bytes;await execute(s,'A');assert.match(await execute(s,''),/no instructions/);assert.equal(s.dirty,false);
  await execute(s,'A');await execute(s,'CONST 0');await execute(s,'END');await execute(s,'');assert.deepEqual(s.bytes,before);
  await execute(s,'A');assert.equal(s.assemblyAddress,s.inspection.binary.sections.find(x=>x.id===10).bodies[0].end);
  await execute(s,'');assert.deepEqual(s.bytes,before);
}));

test('growing a function recalculates both LEB size prefixes, rebases addresses and preserves the next body',()=>fixture(async s=>{
  const before=s.bytes,start=entry(s),second=decodeBinary(before).sections.find(s=>s.id===10).bodies[1];
  const originalSecond=before.slice(second.offset,second.end);await execute(s,'A');
  for(let i=0;i<124;i++)await execute(s,'NOP');await execute(s,'CONST 42');await execute(s,'END');
  assert.match(await execute(s,''),/FILE addresses rebased \+02h/);assert.equal(entry(s),start+2);
  const bodies=s.inspection.binary.sections.find(x=>x.id===10).bodies;assert.equal(bodies[0].sizeEncoding.length,2);
  assert.deepEqual(s.bytes.slice(bodies[1].offset,bodies[1].end),originalSecond);assert.equal(native(s).fn00(),42);assert.equal(native(s).fn01(),7);
  assert.match(await execute(s,'U'),new RegExp(entry(s).toString(16).toUpperCase().padStart(8,'0')));
  await execute(s,'UNDO');assert.deepEqual(s.bytes,before);
},'FN 0\nRES\nCONST 0\nEND\nFN 1\nRES\nCONST 7\nEND'));

test('assembly retains untouched instruction encodings and custom-section payloads exactly',()=>fixture(async(s,dir)=>{
  const bytes=assembleWasm('WASM 1\nSECTION TYPE\nBYTES 016000017F\nENDSECTION\nSECTION FUNCTION\nBYTES 0100\nENDSECTION\nSECTION EXPORT\nBYTES 0106616E737765720000\nENDSECTION\nSECTION CODE\nCOUNT 01\nBODY 00\nCONST 0\nNOP ; @encoding 01\nEND\nENDBODY\nENDSECTION\nSECTION CUSTOM\nBYTES 0178DEADBEEF\nENDSECTION');
  // A padded i32.const immediate must survive if another instruction is edited.
  const b=decodeBinary(bytes),layout=disassembleBinary(b).replace('CONST 0 ; @encoding 4100','CONST 0 ; @encoding 418000');
  const padded=assembleWasm(layout);await writeFile(join(dir,'padded.wasm'),padded);await s.load('padded.wasm');
  const custom=Buffer.from(padded.subarray(decodeBinary(padded).sections.at(-1).payload)),nop=instructions(s).find(r=>r.text==='NOP');
  await execute(s,`A ${address(nop.offset)}`);for(const line of ['CONST 42','ADD','END'])await execute(s,line);await execute(s,'');assert.equal(native(s).answer(),42);
  assert.deepEqual(instructions(s)[0].bytes,[0x41,0x80,0]);assert.deepEqual(Buffer.from(s.bytes.subarray(s.inspection.binary.sections.at(-1).payload)),custom);
  await execute(s,'UNDO');assert.deepEqual(s.bytes,padded);
}));

test('prefixed opcodes, exact i64 values and float encodings use the shared instruction codecs',()=>fixture(async s=>{
  await execute(s,'A');assert.match(await execute(s,'FCONST 1.5'),/43 00 00 C0 3F/);await execute(s,'DROP');
  assert.match(await execute(s,'V128CONST 0x00000000000000000000000000000000'),/FD 0C/);await execute(s,'DROP');
  assert.match(await execute(s,'LCONST -9223372036854775808'),/42 80 80 80 80 80 80 80 80 80 7F/);await execute(s,'DROP');await execute(s,'END');
  await execute(s,'');assert.equal(WebAssembly.validate(s.bytes),true);assert.equal(s.inspection.binary.fullyDecoded,true);
},'FN 0\nEND'));

test('assembly mode offers mnemonic completion/F3 recall and treats CALL as an instruction',()=>fixture(async s=>{
  assert.ok(s.completions.includes('CALL'));assert.ok(!s.completions.includes('LCONST'));await execute(s,'A');assert.ok(s.completions.includes('LCONST'));assert.ok(s.completions.includes(':CANCEL'));assert.match(s.help,/F3/);
  assert.equal(s.originalInstruction,'CONST 0');await execute(s,'CALL 0');assert.equal(s.vm,null);assert.equal(s.originalInstruction,'END');await execute(s,'END');assert.equal(s.originalInstruction,null);
  await execute(s,':UNDO');assert.equal(s.originalInstruction,'END');await execute(s,':CANCEL');assert.equal(s.originalInstruction,null);assert.equal(s.prompt,'hexaw> ');
}));

test('A rejects metadata/interior/raw addresses and failed loads preserve an existing draft',()=>fixture(async(s,dir)=>{
  for(const line of ['A 0',`A ${address(entry(s)+1)}`,'A missing'])await assert.rejects(s.execute(line));assert.equal(s.assembling,false);
  await execute(s,'A');await execute(s,'CONST 42');await assert.rejects(s.load('missing.wasm'),/ENOENT/);assert.equal(s.assemblyPending,true);await execute(s,'');assert.equal(native(s).answer(),42);
  await writeFile(join(dir,'raw.bin'),'raw');await s.load('raw.bin');await assert.rejects(s.execute('A'),/No decoded WASM/);
  const empty=new HexawSession(dir);await assert.rejects(empty.execute('A'),/Load a file/);
}));

test('the real CLI accepts an assembly script, reports bytes and saves an executable module',()=>fixture(async(_s,dir)=>{
  const r=spawnSync(process.execPath,[cli,'shell','test.hexaw'],{cwd:dir,input:'A\nCONST 20\nCONST 22\nADD\nEND\n\nW answer.wasm\nCALL answer\nG\nQ\n',encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');assert.match(r.stdout,/41 14\s+: CONST 20/);assert.match(r.stdout,/RESULT: i32 0x2A \(42\)/);assert.doesNotMatch(r.stdout,/\x1b\[/);
  const bytes=await readFile(join(dir,'answer.wasm'));assert.equal(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.answer(),42);
}));

test('assembly errors recover in scripts and EOF cancels uncommitted instructions without saving',()=>fixture(async(_s,dir)=>{
  const recover=spawnSync(process.execPath,[cli,'-i','test.hexaw'],{cwd:dir,input:'A\nBOGUS\nCONST 42\n\nW recovered.wasm\nQ\n',encoding:'utf8',timeout:10000});
  assert.equal(recover.status,1);assert.match(recover.stderr,/Unknown instruction/);assert.equal(new WebAssembly.Instance(new WebAssembly.Module(await readFile(join(dir,'recovered.wasm')))).exports.answer(),42);
  const eof=spawnSync(process.execPath,[cli,'-i','test.hexaw'],{cwd:dir,input:'A\nCONST 42\n',encoding:'utf8',timeout:10000});assert.equal(eof.status,1);assert.match(eof.stdout,/closed at EOF.*1 draft instruction.*discarded/);
  const empty=spawnSync(process.execPath,[cli,'-i','test.hexaw'],{cwd:dir,input:'A\n',encoding:'utf8',timeout:10000});assert.equal(empty.status,0);
  const cancel=spawnSync(process.execPath,[cli,'-i','test.hexaw'],{cwd:dir,input:'A\nCONST 42\n:CANCEL\nCALL answer\nG\nQ\n',encoding:'utf8',timeout:10000});assert.equal(cancel.status,0,cancel.stderr);assert.match(cancel.stdout,/RESULT: i32 0x0 \(0\)/);
}));
