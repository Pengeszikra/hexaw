import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HexawSession} from '../packages/cli/dist/session.js';
import {compileHEXAW,assembleWasm} from '../packages/cli/dist/index.js';

const root=fileURLToPath(new URL('../',import.meta.url)),cli=join(root,'packages/cli/dist/cli.js');
const add='EXP "add" 0\nFN 0\nPAR 0\nPAR 1\nRES\nGET 0\nGET 1\nADD\nRET\nEND';
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'hexaw-session-'));try{const file=join(dir,'add test.hexaw');await writeFile(file,add);const session=new HexawSession(dir);await session.load(file);return await fn(session,dir);}finally{await rm(dir,{recursive:true,force:true});}}
const execute=async(session,command)=>(await session.execute(command)).text;

test('D follows DOS hexadecimal ranges, inclusive ends and Enter pagination',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'raw.bin'),Uint8Array.from({length:256},(_,i)=>i));await s.load('raw.bin');
  assert.match(await execute(s,'d 10 L 10'),/00000010  10 11 12 13 14 15 16 17-18 19 1A 1B 1C 1D 1E 1F/);
  assert.match(await execute(s,''),/00000020  20 21/);assert.match(await execute(s,'-'),/00000010  10 11/);
  const row=await execute(s,'D 0d16 1F');assert.equal(row.split('\n').length,2);assert.match(row,/00000010/);
  assert.match(await execute(s,'D FF L1'),/FF/);assert.match(await execute(s,''),/end of buffer/);
}));
test('monitor aliases, quoted filenames, doubled quotes and comments are parsed',()=>fixture(async(s,dir)=>{
  await execute(s,'L "add test.hexaw" ; a comment');assert.match(await execute(s,'U'),/ADD/);
  await writeFile(join(dir,'raw.bin'),Buffer.alloc(64));await execute(s,"L 'raw.bin'");
  await execute(s,'E 0 "a""b"');assert.equal(Buffer.from(s.bytes.subarray(0,3)).toString(),'a"b');
  assert.equal(await execute(s,'; comment'),'');await assert.rejects(s.execute('E 0 "unfinished'),/Unclosed/);
}));
test('U starts at decoded boundaries, lists sections and navigates function bodies',()=>fixture(async s=>{
  const text=await execute(s,'U 24');assert.doesNotMatch(text,/00000024/);assert.match(text,/aligned to 00000025/);assert.match(text,/GET 1/);
  assert.match(await execute(s,'FN'),/BODY 00.*add/);assert.match(await execute(s,'FN add'),/GET 0/);
  assert.match(await execute(s,'I'),/TYPE.*payload=/);assert.match(await execute(s,'V'),/Valid WASM/);
  await assert.rejects(s.execute('U FFFFFFFF'),/outside/);
}));
test('CALL pauses without executing, hexadecimal arguments and BACK restore state',()=>fixture(async s=>{
  assert.match(await execute(s,'CALL add 2A 0'),/paused before the first/);assert.equal(s.vm.steps,0);assert.equal(s.vm.current.name,'GET');
  assert.match(await execute(s,'T'),/Paused/);assert.equal(s.vm.stack[0].value,42);assert.equal(s.vm.steps,1);
  await execute(s,'BACK');assert.equal(s.vm.steps,0);assert.deepEqual(s.vm.stack,[]);
  assert.match(await execute(s,'G'),/RESULT: i32 0x2A \(42\)/);assert.equal(s.vm.state,'finished');
  await execute(s,'Z');assert.equal(s.vm.state,'paused');assert.equal(s.vm.current.name,'RET');
  await execute(s,'CALL add 0d42 0');await execute(s,'G');assert.equal(s.vm.result[0].value,42);
}));
test('breakpoints stop before execution and G resumes past the current breakpoint',()=>fixture(async s=>{
  const address=s.inspection.records.find(r=>r.text==='ADD').offset.toString(16);await execute(s,`BP ${address}`);await execute(s,'CALL add 2A 0');
  assert.match(await execute(s,'G'),/Breakpoint/);assert.equal(s.vm.current.name,'ADD');assert.equal(s.vm.steps,2);
  assert.match(await execute(s,'U 27 L1'),/>\*.*ADD/);await execute(s,'G');assert.equal(s.vm.result[0].value,42);
  assert.match(await execute(s,'BP'),/00000027/);await execute(s,'BC *');assert.equal(s.breakpoints.size,0);
  await assert.rejects(s.execute('BP 24'),/boundary/);
}));
test('P steps over a direct call and K shows current call frames',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'calls.hexaw'),'FN 0\nRES\nCALL 1\nCONST 1\nADD\nEND\nFN 1\nRES\nCONST 41\nEND');await s.load('calls.hexaw');await execute(s,'CALL 0');
  await execute(s,'P');assert.equal(s.vm.frames.length,1);assert.equal(s.vm.current.name,'CONST');assert.equal(s.vm.stack[0].value,41);assert.match(await execute(s,'K'),/FN 00/);
  await execute(s,'G');assert.equal(s.vm.result[0].value,42);await execute(s,'BACK 3');assert.equal(s.vm.frames.length,1);
}));
test('P steps over CALLIND and honors breakpoints inside callees',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'indirect.hexaw'),'TABLE 1\nELEM 0 1\nFN 0\nRES\nCONST 0\nCALLIND 0\nEND\nFN 1\nRES\nCONST 42\nEND');await s.load('indirect.hexaw');await execute(s,'CALL 0');await execute(s,'T');await execute(s,'P');assert.equal(s.vm.current.name,'END');assert.equal(s.vm.stack[0].value,42);
  const callee=s.inspection.decoded.functions[1].ops[0].offset.toString(16);await execute(s,`BP ${callee}`);await execute(s,'CALL 0');await execute(s,'T');assert.match(await execute(s,'P'),/Breakpoint/);assert.equal(s.vm.frames.length,2);
}));
test('byte edits, fill, search and undo/redo do not touch the loaded file',()=>fixture(async(s,dir)=>{
  const path=join(dir,'raw.bin'),original=Buffer.alloc(64);await writeFile(path,original);await s.load(path);
  await execute(s,'D 10 L 10');await execute(s,'E 10 41 42 "CD"');assert.match(await execute(s,''),/00000020/);assert.deepEqual([...s.bytes.subarray(16,20)],[65,66,67,68]);assert.equal(s.dirty,true);assert.deepEqual(await readFile(path),original);
  assert.equal(await execute(s,'S 0 L40 "ABCD"'),'00000010');await execute(s,'F 20 27 61 62');assert.equal(Buffer.from(s.bytes.subarray(32,40)).toString(),'abababab');
  await execute(s,'UNDO');assert.ok(s.bytes.subarray(32,40).every(b=>b===0));await execute(s,'REDO');assert.equal(Buffer.from(s.bytes.subarray(32,40)).toString(),'abababab');
  await execute(s,'W "saved raw.bin"');assert.equal(s.dirty,false);assert.deepEqual(await readFile(join(dir,'saved raw.bin')),Buffer.from(s.bytes));
  await execute(s,'UNDO');assert.equal(s.dirty,true);await execute(s,'REDO');assert.equal(s.dirty,false);
}));
test('A replaces an instruction, recomputes lengths, validates and clears stale VM state',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'answer.hexaw'),'FN 0\nRES\nCONST 1\nEND');await s.load('answer.hexaw');const offset=s.inspection.records.find(r=>r.text==='CONST 1').offset.toString(16),before=s.bytes;
  await execute(s,`BP ${offset}`);await execute(s,'CALL 0');await execute(s,`A ${offset} CONST 100000`);assert.equal(s.vm,null);assert.equal(s.breakpoints.size,0);assert.ok(s.bytes.length>before.length);
  await execute(s,'CALL 0');await execute(s,'G');assert.equal(s.vm.result[0].value,100000);
  const changed=s.bytes;await assert.rejects(s.execute(`A ${offset} DROP`),/validation/);assert.deepEqual(s.bytes,changed);
  await execute(s,'UNDO');assert.deepEqual(s.bytes,before);await execute(s,'REDO');assert.deepEqual(s.bytes,changed);
  await execute(s,'SOURCE edited.hexaw');assert.deepEqual(assembleWasm(await readFile(join(dir,'edited.hexaw'),'utf8')),s.bytes);
}));
test('failed commands preserve buffers and writes are all-or-nothing',()=>fixture(async(s,dir)=>{
  const before=s.bytes;for(const command of ['E FFFF 00','F 0 L0 00','S 0 LFFFF 00','A 24 ADD','CALL missing','D 0 L10001','H bad! 1','W','E 0 GG','D 0 1 extra'])await assert.rejects(s.execute(command));assert.deepEqual(s.bytes,before);
  await assert.rejects(s.execute('L absent.wasm'),/ENOENT/);assert.deepEqual(s.bytes,before);
  await assert.rejects(s.execute('W absent/output.wasm'),/ENOENT/);assert.deepEqual(s.bytes,before);
  const sentinel=join(dir,'keep.bin');await writeFile(sentinel,'keep');await assert.rejects(s.execute('SOURCE "absent/output.hexaw"'));assert.equal(await readFile(sentinel,'utf8'),'keep');
}));
test('E can inspect an invalid working buffer and UNDO restores valid WASM',()=>fixture(async s=>{
  await execute(s,'CALL add 0 0');await execute(s,'E 0 FF');assert.equal(s.inspection,null);assert.equal(s.vm,null);assert.match(await execute(s,'D 0 L1'),/FF/);assert.match(await execute(s,'V'),/Raw buffer/);await assert.rejects(s.execute('U'),/decoded/);
  await execute(s,'UNDO');assert.match(await execute(s,'V'),/Valid WASM/);
}));
test('DM is VM memory, D is the file, and reversed stores restore memory',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'memory.hexaw'),'MEM 1 1\nFN 0\nCONST 0\nCONST 42\nSTORE8\nEND');await s.load('memory.hexaw');await execute(s,'CALL 0');await execute(s,'T 3');assert.equal(s.vm.memory[0],42);
  assert.match(await execute(s,'DM 0 L1'),/MEM.*\n00000000  2A/);assert.match(await execute(s,'D 0 L1'),/FILE.*\n00000000  00/);
  await execute(s,'BACK');assert.equal(s.vm.memory[0],0);
}));
test('VM traps are inspectable and reversible',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'trap.hexaw'),'FN 0\nRES\nCONST 1\nCONST 0\nDIVS\nEND');await s.load('trap.hexaw');await execute(s,'CALL');assert.match(await execute(s,'G'),/TRAP: integer divide by zero/);assert.match(await execute(s,'R'),/FAULT [0-9A-F]+  DIVS/);assert.match(await execute(s,`U ${s.vm.trace.at(-1).offset.toString(16)} L1`),/>\s+[0-9A-F]+.*DIVS/);await execute(s,'BACK');assert.equal(s.vm.error,null);assert.equal(s.vm.stack.length,2);
}));
test('run budgets and interruption keep infinite loops controllable',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'loop.hexaw'),'FN 0\nLOOP\nBR 0\nEND\nEND');await s.load('loop.hexaw');await execute(s,'CALL 0');assert.match(await execute(s,'G 10'),/Step budget reached · 16 instruction/);assert.equal(s.vm.steps,16);
  const run=s.execute('G F4240');setImmediate(()=>s.interrupt());assert.match((await run).text,/Interrupted/);assert.ok(s.vm.steps<1000000);assert.equal(s.busy,false);
}));
test('raw and advanced WASM files remain inspectable without VM execution',()=>fixture(async(s,dir)=>{
  const advanced=Uint8Array.from([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,23,1,21,0,253,12,...new Array(16).fill(0),26,11]);await writeFile(join(dir,'simd.wasm'),advanced);await s.load('simd.wasm');assert.match(await execute(s,'U'),/V128CONST/);assert.match(await execute(s,'SOURCE'),/V128CONST/);
  await writeFile(join(dir,'raw.bin'),'not wasm');await s.load('raw.bin');assert.match(await execute(s,'D'),/not wasm/);await assert.rejects(s.execute('CALL'),/VM execution subset/);
}));
test('CALL enforces VM memory bounds before allocating linear memory',()=>fixture(async(s,dir)=>{
  const p=compileHEXAW('MEM 1 1\nFN 0\nEND'),mem=p.decoded.sections.find(s=>s.id===5),bytes=Uint8Array.from([...p.bytes.slice(0,mem.offset),5,3,1,0,1,...p.bytes.slice(mem.end)]);await writeFile(join(dir,'unbounded.wasm'),bytes);await s.load('unbounded.wasm');assert.match(await execute(s,'D'),/FILE/);await assert.rejects(s.execute('CALL'),/bounded memory/);assert.equal(s.vm,null);
}));
test('loading and source export never execute a start function',()=>fixture(async(s,dir)=>{
  const p=compileHEXAW('FN 0\nTRAP\nEND'),code=p.decoded.sections.find(s=>s.id===10),bytes=Uint8Array.from([...p.bytes.slice(0,code.offset),8,1,0,...p.bytes.slice(code.offset)]);await writeFile(join(dir,'start.wasm'),bytes);await s.load('start.wasm');assert.match(await execute(s,'U'),/TRAP/);assert.match(await execute(s,'SOURCE'),/WASM 1/);await assert.rejects(s.execute('CALL'),/VM execution subset/);
}));
test('H hex arithmetic and float/integer CALL argument conventions are explicit',()=>fixture(async(s,dir)=>{
  assert.match(await execute(s,'H FF 1'),/SUM=100h.*DIFFERENCE=FEh/);assert.match(await execute(s,'H 0d10 A'),/SUM=14h/);
  await writeFile(join(dir,'typed.hexaw'),'FN 0\nLPAR 0\nLRES\nGET 0\nEND\nFN 1\nDPAR 0\nDRES\nGET 0\nEND');await s.load('typed.hexaw');await execute(s,'CALL 0 -2A');await execute(s,'G');assert.equal(s.vm.result[0].value,-42n);await execute(s,'CALL 1 1.5');await execute(s,'G');assert.equal(s.vm.result[0].value,1.5);
}));
test('CLI monitor accepts queued script input, quoted paths, EOF and quit without ANSI',()=>fixture(async(_s,dir)=>{
  for(const args of [['-i'],['--interactive'],['shell']]){const r=spawnSync(process.execPath,[cli,...args],{cwd:dir,input:'L "add test.hexaw"\nU\nCALL add 2A 0\nG\nBACK\nQ\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/RESULT: i32 0x2A \(42\)/);assert.match(r.stdout,/Rewound 1/);assert.doesNotMatch(r.stdout,/\x1b\[/);assert.equal(r.stderr,'');}
  const eof=spawnSync(process.execPath,[cli,'-i','add test.hexaw'],{cwd:dir,input:'U\n',encoding:'utf8',timeout:10000});assert.equal(eof.status,0,eof.stderr);assert.match(eof.stdout,/ADD/);
}));
test('CLI recovers from monitor command errors but scripts exit nonzero',()=>fixture(async(_s,dir)=>{
  const r=spawnSync(process.execPath,[cli,'-i','add test.hexaw'],{cwd:dir,input:'BOGUS\nU\nQ\n',encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/Unknown monitor command/);assert.match(r.stdout,/ADD/);
  for(const args of [['-i','-'],['-i','--bin'],['shell','--json'],['-i','-o','out'],['dump','-i'],['assemble','-i'],['shell','--code-only']]){const bad=spawnSync(process.execPath,[cli,...args],{input:'Q\n',encoding:'utf8',timeout:10000});assert.equal(bad.status,2,args.join(' '));}
}));
