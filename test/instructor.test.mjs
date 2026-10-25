import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {HexawInstructor,InstructorCancelled,formatInstructorReply,INSTRUCTOR_MODEL,INSTRUCTOR_ENDPOINT} from '../packages/cli/dist/instructor.js';
import {instructorCommand} from '../packages/cli/dist/instructor-shell.js';
import {instructorKnowledge} from '../packages/cli/dist/instructor-knowledge.js';
import {HexawSession} from '../packages/cli/dist/session.js';

const root=fileURLToPath(new URL('../',import.meta.url)),cli=join(root,'packages/cli/dist/cli.js');
const source='EXP "answer" 0\nMEM 1 1\nDATA 0 "MEMORY_SECRET_SENTINEL"\nFN 0\nRES\nCONST 0\nEND';
const body=(overrides={})=>({sentences:['CONST pushes an i32 onto the operand stack.','ADD consumes two i32 values.'],code:'CONST 20\nCONST 22\nADD',learnerTask:'',language:'en',memory:{note:'Learning stack operations.',direction:'Trace CONST and ADD.',assessment:'Unknown.'},...overrides});
const response=(reply=body())=>new Response(JSON.stringify({status:'completed',output:[{type:'reasoning',content:[{type:'reasoning_text',text:'not for display'}]},{type:'message',content:[{type:'output_text',text:JSON.stringify(reply)}]}]}));
async function fixture(fn,code=source){const dir=await mkdtemp(join(tmpdir(),'hexaw-ai-'));try{await writeFile(join(dir,'test.hexaw'),code);const session=new HexawSession(dir);await session.load('test.hexaw');await fn(session,dir);}finally{await rm(dir,{recursive:true,force:true});}}
const execute=async(s,line)=>(await s.execute(line)).text;

test('AI uses the exact TiyF Groq model/Responses contract with HEXAW facts and bounded state',()=>fixture(async(s,dir)=>{
  await execute(s,'CALL answer');await execute(s,'T');let sent;
  const ai=new HexawInstructor({apiKey:'test-only-key',fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);assert.equal(url,INSTRUCTOR_ENDPOINT);assert.equal(options.headers.Authorization,'Bearer test-only-key');assert.equal(options.redirect,'error');return response();}});
  ai.record('CALL answer','success','VM prepared');const result=await ai.ask('Explain CONST and ADD',s.instructorSnapshot());
  assert.equal(sent.model,INSTRUCTOR_MODEL);assert.equal(sent.model,'openai/gpt-oss-120b');assert.equal(sent.store,false);assert.equal(sent.reasoning.effort,'low');assert.equal(sent.text.format.strict,true);assert.equal(sent.max_output_tokens,2048);assert.equal(sent.tools,undefined);
  assert.match(sent.instructions,/HEXAW \/ WEBASSEMBLY KNOWLEDGE BASE/);assert.match(sent.instructions,/ADD = i32.add; opcode 6A/);assert.match(sent.instructions,/571 mapped/);assert.doesNotMatch(sent.instructions,/filter, then map, then reduce/);
  const input=JSON.parse(sent.input[0].content);assert.equal(input.snapshot.vm.stack[0],'i32 0x0 (0)');assert.equal(input.snapshot.buffer.name,'test.hexaw');assert.equal(input.recentCommands[0].command,'CALL answer');
  assert.doesNotMatch(JSON.stringify(sent),/test-only-key|MEMORY_SECRET_SENTINEL/);assert.ok(!JSON.stringify(sent).includes(dir));assert.ok(!formatInstructorReply(result).includes('not for display'));
}));

test('AI notebook, language and unresolved task persist while examples remain distinct from executed commands',()=>fixture(async s=>{
  const sent=[];
  const ai=new HexawInstructor({apiKey:'test',fetchImpl:async(_url,options)=>{sent.push(JSON.parse(JSON.parse(options.body).input[0].content));return response(body({language:'hu',learnerTask:'Léptesd végig az ADD utasítást.',memory:{note:'Verem gyakorlása.',direction:'ADD léptetése.',assessment:''}}));}});
  await ai.ask('Mit csinál az ADD?',s.instructorSnapshot());assert.equal(ai.language,'hu');
  ai.record('R','success','STACK: (empty)');await ai.ask('Mutass egy példát',s.instructorSnapshot());
  assert.equal(sent[1].language,'hu');assert.equal(sent[1].learnerTask,'Léptesd végig az ADD utasítást.');assert.equal(sent[1].memory.note,'Verem gyakorlása.');assert.equal(sent[1].context[1].example,'CONST 20\nCONST 22\nADD');
  assert.deepEqual(sent[1].recentCommands.map(e=>e.command),['R']);assert.equal(s.vm,null);assert.equal(s.dirty,false);
  ai.clear();assert.equal(ai.context.length,0);assert.equal(ai.memory.note,'Verem gyakorlása.');assert.equal(ai.language,'hu');
  ai.reset();assert.deepEqual(ai.memory,{note:'',direction:'',assessment:''});assert.equal(ai.context.length,0);assert.equal(ai.language,'en');assert.deepEqual(ai.recentCommands,[]);
}));

test('AI bounds chat, examples and recent commands and retains good memory when a reply has a bad notebook',()=>fixture(async s=>{
  let invalid=false;const ai=new HexawInstructor({apiKey:'test',fetchImpl:async()=>response(body({code:'CONST 42\n'.repeat(90),...(invalid?{memory:{note:3}}:{})}))});
  for(let i=0;i<8;i++){ai.record('D '+i+'x'.repeat(1500),'success','y'.repeat(2000));await ai.ask('Explain the stack '+i,s.instructorSnapshot());}
  assert.equal(ai.context.length,8);assert.ok(ai.context.reduce((n,e)=>n+(e.example?.length??0),0)<=2000);assert.equal(ai.recentCommands.length,3);assert.ok(ai.recentCommands.every(e=>e.command.length<=1000&&e.output.length<=1200));
  const note=ai.memory;invalid=true;await ai.ask('And then?',s.instructorSnapshot());assert.deepEqual(ai.memory,note);
}));

test('missing keys and invalid questions fail before any network call',()=>fixture(async s=>{
  let calls=0;const ai=new HexawInstructor({apiKey:'',fetchImpl:async()=>{calls++;return response();}});
  assert.equal(ai.configured,false);await assert.rejects(ai.ask('What is ADD?',s.instructorSnapshot()),error=>error.status===503&&/GROQ_API_KEY/.test(error.message));assert.equal(calls,0);
  for(const question of ['', 'x'.repeat(4001)])await assert.rejects(ai.ask(question,s.instructorSnapshot()),error=>error.status===400);assert.equal(calls,0);
  assert.equal(ai.busy,false);assert.deepEqual(ai.memory,{note:'',direction:'',assessment:''});
}));

test('provider failures are sanitized, do not expose keys/error bodies and leave the shell/AI memory usable',()=>fixture(async s=>{
  for(const status of [401,403,429,500]){
    const ai=new HexawInstructor({apiKey:'private-key-sentinel',fetchImpl:async()=>new Response('private-key-sentinel and provider details',{status})});
    await assert.rejects(ai.ask('Explain ADD',s.instructorSnapshot()),error=>{assert.doesNotMatch(error.message,/private-key-sentinel|provider details/);return error.status===(status===429?429:[401,403].includes(status)?503:502);});assert.equal(ai.busy,false);
  }
  const ai=new HexawInstructor({apiKey:'private-key-sentinel',fetchImpl:async()=>{throw Error('private-key-sentinel');}});await assert.rejects(ai.ask('Explain ADD',s.instructorSnapshot()),error=>error.status===502&&!error.message.includes('sentinel'));
  await execute(s,'CALL answer');await execute(s,'G');assert.equal(s.vm.result[0].value,0);
}));

test('malformed/incomplete/oversized responses cannot update AI state',()=>fixture(async s=>{
  const bad=[()=>new Response('not json'),()=>new Response(JSON.stringify({status:'incomplete',output:[]})),()=>response(body({sentences:['one only']})),()=>response(body({language:'not a locale!'})),()=>response(body({code:'x'.repeat(8193)})),()=>response(body({code:'x\n'.repeat(101)})),()=>response(body({learnerTask:'x'.repeat(401)})),()=>new Response('x'.repeat(65537)),()=>new Response('{}',{headers:{'content-length':'65537'}})];
  for(const make of bad){const ai=new HexawInstructor({apiKey:'test',fetchImpl:async()=>make()});await assert.rejects(ai.ask('Explain ADD',s.instructorSnapshot()),error=>error.status===502);assert.equal(ai.busy,false);assert.equal(ai.context.length,0);assert.deepEqual(ai.memory,{note:'',direction:'',assessment:''});}
}));

test('AI refuses oversized snapshots before sending them and caller mutation cannot change an in-flight snapshot',()=>fixture(async s=>{
  let resolve;let input;const ai=new HexawInstructor({apiKey:'test',fetchImpl:async(_url,options)=>{input=JSON.parse(JSON.parse(options.body).input[0].content);return await new Promise(r=>resolve=r);}});
  const huge=s.instructorSnapshot();huge.buffer.diagnostic='x'.repeat(18001);await assert.rejects(ai.ask('Explain',huge),error=>error.status===400);assert.equal(input,undefined);
  const snapshot=s.instructorSnapshot(),promise=ai.ask('Explain CONST',snapshot);snapshot.focus.code[0].text='TRAP';resolve(response());await promise;assert.equal(input.snapshot.focus.code[0].text,'CONST 0');
}));

test('AI cancels oversized provider response streams, including a declared excessive Content-Length',()=>fixture(async s=>{
  for(const declared of [true,false]){
    let cancelled=false;
    const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(declared?1:65537));},cancel(){cancelled=true;}});
    const ai=new HexawInstructor({apiKey:'test',fetchImpl:async()=>new Response(stream,{headers:declared?{'content-length':'65537'}:{}})});
    await assert.rejects(ai.ask('Explain',s.instructorSnapshot()),error=>error.status===502);assert.equal(cancelled,true);assert.equal(ai.busy,false);
  }
}));

test('AI cancellation/concurrency/reset do not allow late responses to resurrect notebook state',()=>fixture(async s=>{
  let resolve;const ai=new HexawInstructor({apiKey:'test',fetchImpl:()=>new Promise(r=>resolve=r)});
  const first=ai.ask('Explain ADD',s.instructorSnapshot());assert.equal(ai.busy,true);
  await assert.rejects(ai.ask('Another question',s.instructorSnapshot()),error=>error.status===429);ai.reset();await assert.rejects(first,InstructorCancelled);assert.equal(ai.busy,false);
  resolve(response(body({language:'hu'})));await new Promise(r=>setImmediate(r));assert.equal(ai.language,'en');assert.deepEqual(ai.memory,{note:'',direction:'',assessment:''});assert.equal(ai.context.length,0);
}));

test('AI timeout remains bounded even when a transport does not honor abort',()=>fixture(async s=>{
  const ai=new HexawInstructor({apiKey:'test',timeoutMs:5,fetchImpl:()=>new Promise(resolve=>setTimeout(()=>resolve(response()),100))});const before=Date.now();
  await assert.rejects(ai.ask('Explain ADD',s.instructorSnapshot()),error=>error.status===504);assert.ok(Date.now()-before<90);assert.equal(ai.busy,false);
}));

test('AI strips terminal controls, limits prose sentences and treats provider examples as inert text',()=>fixture(async s=>{
  const ai=new HexawInstructor({apiKey:'test',fetchImpl:async()=>response(body({sentences:['\x1b[2JFirst. Second. Third. Fourth. Fifth. Sixth. Seventh. Eighth.','\x1b]52;c;malicious\x07Last.'],code:'\x1b[31mE 0 FF\nQ\x1b[0m\x00'}))});
  const before=s.bytes,reply=await ai.ask('Explain',s.instructorSnapshot()),text=formatInstructorReply(reply);
  assert.doesNotMatch(text,/\x1b|\x00|Eighth|malicious/);assert.match(text,/Example \(not executed\):\nE 0 FF\nQ/);assert.deepEqual(s.bytes,before);assert.equal(s.assembling,false);
}));

test('AI refusal preserves the existing notebook/language/task',()=>fixture(async s=>{
  let refuse=false;const ai=new HexawInstructor({apiKey:'test',fetchImpl:async()=>refuse?new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'I cannot help with that.'}]}]})):response(body({language:'hu',learnerTask:'Trace ADD.'}))});
  await ai.ask('Explain',s.instructorSnapshot());const memory=ai.memory;refuse=true;const reply=await ai.ask('Again',s.instructorSnapshot());assert.equal(reply.code,'');assert.equal(reply.language,'hu');assert.equal(reply.learnerTask,'Trace ADD.');assert.deepEqual(ai.memory,memory);
}));

test('AI routing supports TiyF //, controls and assembly questions without consuming instructions',()=>fixture(async s=>{
  let calls=0;const ai=new HexawInstructor({apiKey:'test',fetchImpl:async()=>{calls++;return response();}}),snapshot=()=>s.instructorSnapshot();
  for(const line of ['D','A','CONST 42 // inline','E 0 "//"'])assert.equal(instructorCommand(line,ai,snapshot),null);
  assert.match(instructorCommand('AI HELP',ai,snapshot),/GROQ_API_KEY/);assert.match(instructorCommand('AI STATUS',ai,snapshot),/openai\/gpt-oss-120b/);assert.equal(calls,0);
  await execute(s,'A');await execute(s,'CONST 42');const cursor=s.assemblyAddress,before=s.bytes;assert.match(await instructorCommand('// Mit csinál a CONST?',ai,snapshot),/^AI:/);assert.equal(s.assemblyAddress,cursor);assert.deepEqual(s.bytes,before);
  await instructorCommand(':AI REVIEW',ai,snapshot);assert.equal(s.assembling,true);assert.equal(calls,2);
  assert.match(instructorCommand('AI LANGUAGE hu',ai,snapshot),/hu/);assert.throws(()=>instructorCommand('AI LANGUAGE invalid!',ai,snapshot),/Invalid AI language/);
  assert.match(instructorCommand('AI ERROR',ai,snapshot),/No recent/);assert.match(instructorCommand('AI KNOWLEDGE ADD',ai,snapshot),/ADD = i32.add; opcode 6A/);
  assert.match(instructorCommand('AI CLEAR',ai,snapshot),/notebook.*retained/);assert.match(instructorCommand('AI RESET',ai,snapshot),/reset/);assert.match(instructorCommand('AI CANCEL',ai,snapshot),/No AI/);
}));

test('knowledge comes from the live opcode table and distinguishes HEXAW source from monitor radix/VM coverage',()=>{
  const text=instructorKnowledge('Explain ADD, i64.add, V128CONST and binary encoding');assert.match(text,/571 mapped/);assert.match(text,/ADD = i32.add; opcode 6A/);assert.match(text,/LADD = i64.add; opcode 7C/);assert.match(text,/V128CONST = v128.const; opcode FD:0C/);assert.match(text,/DECIMAL by default/);assert.match(text,/HEX by default/);assert.match(text,/broader than reversible VM/);assert.ok(text.length<18000);
});

test('question-time snapshots distinguish draft/committed code and bound data without copying memory/environment',()=>fixture(async s=>{
  await execute(s,'CALL answer');await execute(s,'T');const before=s.bytes,vm=s.vm;await execute(s,'A');for(let i=0;i<20;i++)await execute(s,'NOP');
  const state=s.instructorSnapshot();assert.equal(state.mode,'assembly');assert.equal(state.draft.instructions,20);assert.equal(state.draft.lines.length,16);assert.equal(state.draft.truncated,true);assert.equal(state.focus.code[0].text,'CONST 0');assert.equal(state.vm.steps,1);assert.equal(state.vm.stack[0],'i32 0x0 (0)');
  assert.doesNotMatch(JSON.stringify(state),/MEMORY_SECRET_SENTINEL|GROQ_API_KEY|\/tmp\//);assert.ok(JSON.stringify(state).length<18000);assert.deepEqual(s.bytes,before);assert.equal(s.vm,vm);
  state.focus.params.push('f64');assert.deepEqual(s.instructorSnapshot().focus.params,[]);
}));

test('snapshots retain exact i64 values and report the actual trapping instruction',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'long.hexaw'),'FN 0\nLRES\nLCONST 9223372036854775807\nEND');await s.load('long.hexaw');await execute(s,'CALL 0');await execute(s,'T');assert.match(s.instructorSnapshot().vm.stack[0],/9223372036854775807/);
  await writeFile(join(dir,'trap.hexaw'),'FN 0\nRES\nCONST 1\nCONST 0\nDIVS\nEND');await s.load('trap.hexaw');await execute(s,'CALL 0');await execute(s,'G');const state=s.instructorSnapshot();assert.equal(state.vm.state,'trapped');assert.equal(state.vm.pc,s.vm.trace.at(-1).offset.toString(16).toUpperCase().padStart(8,'0'));assert.equal(state.vm.next,'DIVS');assert.match(state.vm.error,/divide by zero/);
}));

test('snapshots bound long function signatures and code windows',()=>fixture(async(s,dir)=>{
  await writeFile(join(dir,'many.hexaw'),'FN 0\n'+Array.from({length:100},(_,i)=>'PAR '+i).join('\n')+'\n'+Array(100).fill('NOP').join('\n')+'\nEND');await s.load('many.hexaw');const state=s.instructorSnapshot();assert.equal(state.focus.params.length,16);assert.equal(state.focus.signatureTruncated,true);assert.equal(state.focus.code.length,16);assert.equal(state.focus.totalInstructions,101);assert.ok(JSON.stringify(state).length<18000);
}));

test('real CLI answers during an assembly script without executing AI examples or losing the draft',()=>fixture(async(_s,dir)=>{
  const preload=join(dir,'provider.mjs'),log=join(dir,'requests.jsonl');
  await writeFile(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options)=>{appendFileSync(process.env.HEXAW_TEST_LOG,JSON.stringify({url,body:JSON.parse(options.body)})+'\\n');return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(${JSON.stringify(body({code:'E 0 FF\nQ'}))})}]}]}));};`);
  const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,cli,'shell','test.hexaw'],{cwd:dir,env:{...process.env,GROQ_API_KEY:'test-only',HEXAW_TEST_LOG:log},input:'A\nCONST 20\n// Explain this instruction\nCONST 22\nADD\nEND\n\nCALL answer\nG\nW result.wasm\nQ\n',encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');assert.match(r.stdout,/Example \(not executed\):\nE 0 FF\nQ/);assert.match(r.stdout,/RESULT: i32 0x2A \(42\)/);assert.doesNotMatch(r.stdout,/\x1b/);
  const request=JSON.parse((await readFile(log,'utf8')).trim()),input=JSON.parse(request.body.input[0].content);assert.equal(input.snapshot.mode,'assembly');assert.equal(input.snapshot.draft.instructions,1);assert.deepEqual(input.snapshot.draft.lines,['CONST 20']);
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(await readFile(join(dir,'result.wasm')))).exports.answer(),42);
}));

test('CLI local AI commands work offline and missing credentials do not break later assembly/debugging commands',()=>fixture(async(_s,dir)=>{
  const env={...process.env,GROQ_API_KEY:''};
  const local=spawnSync(process.execPath,[cli,'-i'],{cwd:dir,env,input:'AI HELP\nAI STATUS\nAI KNOWLEDGE ADD\nAI LANGUAGE hu\nAI CLEAR\nAI RESET\nQ\n',encoding:'utf8',timeout:10000});assert.equal(local.status,0,local.stderr);assert.equal(local.stderr,'');assert.match(local.stdout,/GROQ_API_KEY missing/);assert.match(local.stdout,/ADD = i32.add/);
  const missing=spawnSync(process.execPath,[cli,'shell','test.hexaw'],{cwd:dir,env,input:'// What is CONST?\nCALL answer\nG\nQ\n',encoding:'utf8',timeout:10000});assert.equal(missing.status,1);assert.match(missing.stderr,/Set GROQ_API_KEY/);assert.match(missing.stdout,/RESULT: i32 0x0 \(0\)/);
}));

test('CLI AI ERROR receives an empty-Enter validation failure without closing the assembly draft',()=>fixture(async(_s,dir)=>{
  const preload=join(dir,'error-provider.mjs'),log=join(dir,'error-request.json');
  await writeFile(preload,`import {writeFileSync} from 'node:fs';globalThis.fetch=async(_url,options)=>{writeFileSync(process.env.HEXAW_TEST_LOG,options.body);return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(${JSON.stringify(body())})}]}]}));};`);
  const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,cli,'-i','test.hexaw'],{cwd:dir,env:{...process.env,GROQ_API_KEY:'test-only',HEXAW_TEST_LOG:log},input:'A\nADD\n\n:AI ERROR\n:CANCEL\nCALL answer\nG\nQ\n',encoding:'utf8',timeout:10000});
  assert.equal(r.status,1);assert.match(r.stderr,/Assembly not applied/);assert.match(r.stdout,/AI:/);assert.match(r.stdout,/1 draft instruction.*discarded/);assert.match(r.stdout,/RESULT: i32 0x0 \(0\)/);
  const input=JSON.parse(JSON.parse(await readFile(log,'utf8')).input[0].content);assert.equal(input.snapshot.mode,'assembly');assert.equal(input.snapshot.draft.instructions,1);assert.equal(input.recentCommands.at(-1).command,'[empty Enter: apply assembly draft]');assert.equal(input.recentCommands.at(-1).status,'error');
}));
