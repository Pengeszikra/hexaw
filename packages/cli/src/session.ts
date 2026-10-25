import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {assembleWasm} from './assemble.js';
import {inspectWasm,dumpWasm} from './dump.js';
import type {WasmInspection,DumpRecord} from './dump.js';
import {Debugger,formatValue,parseValue,hex} from './core/hexaw-core.js';
import type {NumericType,NumericValue,StackValue} from './core/hexaw-core.js';
import {BinaryReader,decodeInstruction,encodeInstruction} from './core/instruction-codec.js';
import {disassembleBinary,SECTION_NAMES} from './core/binary-module.js';

const MAX_INPUT=64*1024*1024,MAX_PAGE=0x10000,MAX_UNDO=16*1024*1024;
export const SHELL_HELP=`HEXAW interactive monitor — DEBUG / SST inspired

  L file                      Load WASM, .hexaw source, or a raw binary
  D [start [end | L length]]   Dump FILE bytes as hex + ASCII (default 80h)
  U [start [end | L length]]   Unassemble known instructions (default 20h bytes)
  Enter / + / NEXT            Continue the last D / U / DM view
  - / PREV                    Previous page
  I                          List WASM sections
  FN [body index / export]    List function bodies, or focus their code
  S start end|L length list   Search bytes or quoted UTF-8 text
  E address list             Enter bytes or quoted UTF-8 text
  F start end|L length list   Fill with a repeating byte pattern
  A address mnemonic args    Replace one instruction; recompute WASM sizes
  UNDO / REDO                Undo / redo a byte or assembly edit
  W file                     Write the working binary atomically
  SOURCE [file]              Show / save assemblable HEXAW source
  V                          Validate the working buffer without running it
  H number number            Hex sum, difference and decimal values

  CALL [function / export] [args]  Prepare the reversible VM, paused
  T [count]                  Trace instructions (default 1)
  P                          Step over a CALL / CALLIND
  G [limit]                  Run to breakpoint, finish or step budget
  BACK [count] / Z [count]    Reverse instruction execution
  R                          Show PC, operand stack, locals and globals
  K                          Show call frames
  DM [start [end | L length]] Dump VM linear memory (separate address space)
  BP [file offset]           List / set breakpoints
  BC offset|*                Clear one / all breakpoints
  ? / HELP                   Help (also F1 in a terminal)
  Q / QUIT                   Exit

Monitor addresses, ranges, counts and integer CALL arguments are HEX by default.
Use 0d42 for decimal. End addresses are inclusive; lengths must be positive.
Instruction operands in A follow HEXAW source syntax (decimal, or 0x-prefixed).
Quoted strings accept doubled quote marks. Loading never runs a start function.
`;
export const SHELL_COMMANDS=['L','D','U','NEXT','PREV','I','FN','S','E','F','A','UNDO','REDO','W','SOURCE','V','H','CALL','T','P','G','BACK','Z','R','K','DM','BP','BC','HELP','QUIT'];
interface Word {value:string;quoted:boolean}
interface Edit {offset:number;before:Uint8Array;after:Uint8Array;beforeRevision:number;afterRevision:number}
interface View {kind:'D'|'U'|'DM';start:number;length:number}
export interface CommandResult {text:string;quit?:boolean}

/** DOS-style quotes: two consecutive delimiters represent one literal delimiter. */
function words(line:string):Word[]{
  const out:Word[]=[];let at=0;
  while(at<line.length){
    if(/\s/.test(line[at])){at++;continue;}if(line[at]===';'||line[at]==='#')break;
    const quote=line[at];
    if(quote==='"'||quote==="'"){
      at++;let value='',closed=false;
      while(at<line.length){if(line[at]===quote){if(line[at+1]===quote){value+=quote;at+=2;continue;}at++;closed=true;break;}value+=line[at++];}
      if(!closed)throw new Error('Unclosed quoted string');
      if(at<line.length&&!/\s/.test(line[at])&&line[at]!==';')throw new Error('Put whitespace after a quoted string');
      out.push({value,quoted:true});
    }else{let end=at;while(end<line.length&&!/\s/.test(line[end])&&line[end]!==';')end++;out.push({value:line.slice(at,end),quoted:false});at=end;}
  }return out;
}
function number(text:string):number {
  const decimal=/^0d(\d+)$/i.exec(text),hexadecimal=/^(?:0x)?([0-9a-f]+)$/i.exec(text);
  const n=decimal?Number(decimal[1]):hexadecimal?Number.parseInt(hexadecimal[1],16):NaN;
  if(!Number.isSafeInteger(n)||n<0||n>0xffffffff)throw new Error(`Invalid monitor number ${text}; use hex or 0d42 for decimal`);return n;
}
function count(text:string|undefined,fallback:number,max=0x100000):number {const n=text===undefined?fallback:number(text);if(n<1||n>max)throw new Error(`Count must be 1..${hex(max)}h`);return n;}
function range(args:Word[],fallbackStart:number,fallbackLength:number,limit:number,required=false):{start:number;end:number;length:number;used:number}{
  if(required&&args.length<2)throw new Error('Provide start and end, or start L length');
  const start=args[0]?number(args[0].value):fallbackStart;let length=fallbackLength,used=args.length?1:0;
  if(args[1]){
    if(args[1].value.toUpperCase()==='L'){if(!args[2])throw new Error('L needs a length');length=count(args[2].value,fallbackLength,0xffffffff);used=3;}
    else if(/^L[0-9a-f]+$/i.test(args[1].value)){length=count(args[1].value.slice(1),fallbackLength,0xffffffff);used=2;}
    else{const last=number(args[1].value);if(last<start)throw new Error('End precedes start');length=last-start+1;used=2;}
  }
  if(start>limit||start+length>0x100000000)throw new Error('Range is outside the address space');
  return {start,end:Math.min(limit,start+length),length,used};
}
function byteList(args:Word[]):Uint8Array {
  if(!args.length)throw new Error('Provide hex bytes or quoted text');const parts:Buffer[]=[];
  for(const word of args){if(word.quoted)parts.push(Buffer.from(word.value,'utf8'));else{if(!/^(?:0x)?[0-9a-f]{1,2}$/i.test(word.value))throw new Error(`Invalid byte ${word.value}`);parts.push(Buffer.from([Number.parseInt(word.value.replace(/^0x/i,''),16)]));}}
  const bytes=Buffer.concat(parts);if(!bytes.length)throw new Error('Byte list is empty');return bytes;
}
function exactly(args:Word[],min:number,max=min):void {if(args.length<min||args.length>max)throw new Error(`Expected ${min===max?min:`${min}..${max}`} argument(s); type ? for help`);}
function dumpRows(bytes:Uint8Array,start:number,end:number):string {
  const lines:string[]=[];for(let at=start;at<end;at+=16){const chunk=bytes.subarray(at,Math.min(at+16,end)),left=[...chunk.subarray(0,8)].map(b=>hex(b)).join(' ').padEnd(23),right=[...chunk.subarray(8)].map(b=>hex(b)).join(' ').padEnd(23),ascii=[...chunk].map(b=>b>=32&&b<127?String.fromCharCode(b):'.').join('');lines.push(`${hex(at,8)}  ${left}-${right}  ${ascii}`);}return lines.join('\n');
}
async function atomicWrite(path:string,data:string|Uint8Array):Promise<void>{
  const temporary=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);
  try{await writeFile(temporary,data,{flag:'wx'});await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
function scalar(value:StackValue):string {
  if(value.type==='i32'||value.type==='i64'){const bits=value.type==='i64'?64:32;return `${value.type} 0x${BigInt.asUintN(bits,BigInt(value.value)).toString(16).toUpperCase()} (${formatValue(value.value)})`;}
  return `${value.type} ${formatValue(value.value)}`;
}
function argument(text:string,type:NumericType):NumericValue {
  if(type==='f32'||type==='f64')return parseValue(text,type);
  const negative=text.startsWith('-'),unsigned=text.replace(/^[+-]/,''),decimal=/^0d(\d+)$/i.exec(unsigned);
  if(!decimal&&!/^(?:0x)?[0-9a-f]+$/i.test(unsigned))throw new Error(`Invalid integer argument ${text}`);
  const n=BigInt(decimal?decimal[1]:'0x'+unsigned.replace(/^0x/i,''))*(negative?-1n:1n);return parseValue(n.toString(),type);
}

/** State and commands are separate from readline so scripts and terminal use agree. */
export class HexawSession {
  private buffer=new Uint8Array(0);
  private loaded=false;
  private revision=0;
  private savedRevision=0;
  private nextRevision=0;
  private undoEdits:Edit[]=[];
  private redoEdits:Edit[]=[];
  private dCursor=0;
  private uCursor=0;
  private mCursor=0;
  private lastView:View|null=null;
  private stopped=false;
  private moduleDiagnostic='';
  private code:DumpRecord[]=[];
  readonly breakpoints=new Set<number>();
  inspection:WasmInspection|null=null;
  vm:Debugger|null=null;
  filename:string|null=null;
  busy=false;
  constructor(readonly cwd=process.cwd()){}
  get bytes():Uint8Array{return this.buffer.slice();}
  get dirty():boolean{return this.revision!==this.savedRevision;}
  interrupt():void {this.stopped=true;}
  private requireBuffer():void {if(!this.loaded)throw new Error('Load a file first: L filename');}
  private requireVM():Debugger {if(!this.vm)throw new Error('Prepare a paused VM first: CALL function [args]');return this.vm;}
  private refresh(resetViews=true):void {
    this.inspection=null;this.moduleDiagnostic='';
    try{this.inspection=inspectWasm(this.buffer);}catch(error){this.moduleDiagnostic=(error as Error).message;}
    this.code=this.inspection?.records.filter(r=>r.kind==='instruction')??[];
    this.vm=null;this.breakpoints.clear();this.mCursor=0;
    if(resetViews){this.dCursor=0;this.uCursor=this.instructions()[0]?.offset??0;this.lastView=null;}
    else{this.dCursor=Math.min(this.dCursor,this.buffer.length);this.uCursor=Math.min(this.uCursor,this.buffer.length);if(this.lastView?.kind==='DM')this.lastView=null;}
  }
  private instructions():DumpRecord[]{return this.code;}
  async load(path:string):Promise<string>{
    const filename=resolve(this.cwd,path),input=await readFile(filename);if(input.length>MAX_INPUT)throw new Error('Input limit: 64 MiB');
    let bytes:Uint8Array=input;
    if(extname(filename).toLowerCase()==='.hexaw'){
      let source:string;try{source=new TextDecoder('utf-8',{fatal:true}).decode(input);}catch{throw new Error('HEXAW source must be UTF-8');}bytes=assembleWasm(source);
    }
    this.buffer=Uint8Array.from(bytes);this.filename=filename;this.loaded=true;this.revision=0;this.savedRevision=0;this.nextRevision=0;this.undoEdits=[];this.redoEdits=[];this.refresh();
    return `Loaded ${JSON.stringify(path)} · ${hex(bytes.length)}h (${bytes.length}) bytes\n${this.validation()}`;
  }
  private validation():string {
    this.requireBuffer();
    if(!this.inspection)return 'Raw buffer · '+this.moduleDiagnostic;
    return `Valid WASM · ${this.instructions().length} decoded instructions`+(this.inspection.diagnostic?`\nDecoder: ${this.inspection.diagnostic}`:'');
  }
  private view(kind:View['kind'],args:Word[],fallbackLength?:number):string {
    this.requireBuffer();const data=kind==='DM'?this.requireVM().memory:this.buffer,cursor=kind==='D'?this.dCursor:kind==='DM'?this.mCursor:this.uCursor;
    const q=range(args,cursor,fallbackLength??(kind==='U'?0x20:0x80),data.length);exactly(args,0,q.used);
    if(q.length>MAX_PAGE)throw new Error(`Display limit: ${hex(MAX_PAGE)}h bytes per page`);
    if(kind==='U'){
      const instructions=this.instructions();if(!this.inspection?.binary)throw new Error('This buffer has no decoded WASM code');
      let low=0,high=instructions.length;while(low<high){const mid=(low+high)>>>1;if(instructions[mid].offset<q.start)low=mid+1;else high=mid;}
      const first=instructions[low];if(!first){this.uCursor=this.buffer.length;return 'End of decoded code';}
      const end=args.length<2?Math.min(this.buffer.length,first.offset+q.length):q.end;
      const selected:DumpRecord[]=[];for(let i=low;i<instructions.length&&instructions[i].offset<end;i++)selected.push(instructions[i]);
      if(!selected.length)return 'No instruction starts in this range';
      this.uCursor=selected.at(-1)!.offset+selected.at(-1)!.bytes.length;this.lastView={kind,start:first.offset,length:q.length};
      const pc=this.vm?.state==='trapped'?this.vm.trace.at(-1)?.offset:this.vm?.current?.offset;
      return ['FILE · HEXAW instructions'+(first.offset!==q.start?` · aligned to ${hex(first.offset,8)}`:''),...selected.map(r=>`${pc===r.offset?'>':' '}${this.breakpoints.has(r.offset)?'*':' '} ${hex(r.offset,8)}  ${r.bytes.map(b=>hex(b)).join(' ').padEnd(23)}  ${'  '.repeat(Math.min(r.depth,16))}${r.depth>16?'… ':''}${r.text}`)].join('\n');
    }
    if(kind==='D')this.dCursor=q.end;else this.mCursor=q.end;this.lastView={kind,start:q.start,length:q.length};
    return `${kind==='DM'?'MEM · VM linear memory':'FILE · working binary'}${this.dirty&&kind==='D'?' · modified':''}\n${q.start===q.end?'(end of buffer)':dumpRows(data,q.start,q.end)}`;
  }
  private page(previous:boolean):string {
    if(!this.lastView)return this.view('D',[]);const {kind,start,length}=this.lastView;
    return this.view(kind,previous?[{value:hex(Math.max(0,start-length)),quoted:false}]:[],length);
  }
  private edit(next:Uint8Array):string {
    let start=0;while(start<this.buffer.length&&start<next.length&&this.buffer[start]===next[start])start++;
    if(start===this.buffer.length&&start===next.length)return 'No bytes changed';
    let oldEnd=this.buffer.length,newEnd=next.length;while(oldEnd>start&&newEnd>start&&this.buffer[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
    const before=this.buffer.slice(start,oldEnd),after=next.slice(start,newEnd);if(before.length+after.length>MAX_UNDO)throw new Error('This edit exceeds the 16 MiB undo budget');
    const record={offset:start,before,after,beforeRevision:this.revision,afterRevision:++this.nextRevision};this.undoEdits.push(record);this.redoEdits=[];
    let historySize=this.undoEdits.reduce((n,e)=>n+e.before.length+e.after.length,0);while(historySize>MAX_UNDO&&this.undoEdits.length>1){const dropped=this.undoEdits.shift()!;historySize-=dropped.before.length+dropped.after.length;}
    this.buffer=Uint8Array.from(next);this.revision=record.afterRevision;this.refresh(false);return `Modified FILE ${hex(start,8)} · ${before.length} → ${after.length} bytes · VM reset. W filename saves.`;
  }
  private undo(redo:boolean):string {
    const from=redo?this.redoEdits:this.undoEdits,to=redo?this.undoEdits:this.redoEdits,record=from.pop();if(!record)return redo?'Nothing to redo':'Nothing to undo';
    const remove=redo?record.before:record.after,insert=redo?record.after:record.before;
    const next=new Uint8Array(this.buffer.length-remove.length+insert.length);next.set(this.buffer.subarray(0,record.offset));next.set(insert,record.offset);next.set(this.buffer.subarray(record.offset+remove.length),record.offset+insert.length);
    this.buffer=next;this.revision=redo?record.afterRevision:record.beforeRevision;to.push(record);this.refresh(false);return `${redo?'Redid':'Undid'} edit at FILE ${hex(record.offset,8)} · VM reset`;
  }
  private registers():string {
    const vm=this.requireVM(),current=vm.current,frame=vm.currentFrame,fault=vm.state==='trapped'?vm.trace.at(-1):null;
    return [`STATE=${vm.state}  FN=${frame?hex(frame.fn):'--'}  PC=${fault?hex(fault.offset,8):current?hex(current.offset,8):'--------'}  STEPS=${hex(vm.steps)}h (${vm.steps})`,
      'STACK: '+(vm.stack.length?vm.stack.map((v,i)=>`[${hex(i)}] ${scalar(v)}`).join(' | '):'(empty)'),
      'LOCALS: '+(frame?.locals.length?frame.locals.map((v,i)=>`[${hex(i)}] ${scalar(v)}`).join(' | '):'(none)'),
      'GLOBALS: '+(vm.globals.length?vm.globals.map((v,i)=>`[${hex(i)}] ${scalar(v)}`).join(' | '):'(none)'),
      ...(vm.result.length?['RESULT: '+vm.result.map(scalar).join(' | ')]:[]),...(vm.error?['TRAP: '+vm.error]:[]),
      ...(fault?[`FAULT ${hex(fault.offset,8)}  ${fault.instruction}`]:current?[`NEXT ${hex(current.offset,8)}  ${current.name}${current.args.length?' '+current.args.map(value=>typeof value==='string'?value:formatValue(value)).join(' '):''}`]:[])].join('\n');
  }
  private start(args:Word[]):string {
    this.requireBuffer();const module=this.inspection?.decoded;if(!module)throw new Error('This module can be inspected, but is outside the reversible VM execution subset');
    if(module.memory&&(module.memory.max===null||module.memory.min>256||module.memory.max>256))throw new Error('VM requires bounded memory with a maximum of 256 pages; D/U still work');
    const name=args[0]?.value,exported=name===undefined?undefined:module.exports.find(e=>e.name===name),entry=exported?.index??(name===undefined?0:number(name)),fn=module.functions[entry];
    if(!fn)throw new Error('Unknown function or export');if(args.length-1>fn.params.length||Math.max(0,args.length-1)!==fn.params.length)throw new Error(`Function ${hex(entry)} needs ${fn.params.length} argument(s)`);
    const values=fn.params.map((type,i)=>argument(args[i+1].value,type));const vm=new Debugger(module,entry,values);vm.breakpoints=this.breakpoints;this.vm=vm;this.mCursor=0;
    return 'VM prepared, paused before the first instruction\n'+this.registers();
  }
  private async run(mode:'T'|'P'|'G',args:Word[]):Promise<string>{
    const vm=this.requireVM();exactly(args,0,mode==='P'?0:1);const limit=count(args[0]?.value,mode==='T'?1:100000),depth=vm.frames.length,call=mode==='P'&&['CALL','CALLIND'].includes(vm.current?.name??'');let executed=0;
    this.stopped=false;this.busy=true;
    try{
      while(vm.current&&vm.state!=='finished'&&vm.state!=='trapped'&&executed<limit&&!this.stopped){
        if(executed&&mode!=='T'&&vm.breakpoints.has(vm.current.offset))break;
        vm.step();executed++;
        if(mode==='P'&&(!call||vm.frames.length<=depth))break;
        if(executed%256===0)await yieldEventLoop();
      }
    }finally{this.busy=false;}
    const last=vm.trace.at(-1),reason=this.stopped?'Interrupted':vm.state==='trapped'?'Trapped':vm.state==='finished'?'Finished':mode!=='T'&&vm.current&&vm.breakpoints.has(vm.current.offset)?'Breakpoint':mode!=='T'&&executed===limit?'Step budget reached':'Paused';
    return `${reason} · ${executed} instruction(s)\n${last?`LAST ${hex(last.offset,8)}  ${last.instruction}\n`:''}${this.registers()}`;
  }
  async execute(line:string):Promise<CommandResult>{
    const tokens=words(line);if(!tokens.length){if(line.trim())return {text:''};return {text:this.page(false)};}
    const command=tokens[0].value.toUpperCase(),args=tokens.slice(1);let text='';
    switch(command){
      case'?':case'HELP':exactly(args,0);text=SHELL_HELP;break;
      case'Q':case'QUIT':case'EXIT':exactly(args,0);return {text:this.dirty?'Exited with unsaved working-buffer edits':'',quit:true};
      case'L':case'LOAD':exactly(args,1);text=await this.load(args[0].value);break;
      case'D':case'U':case'DM':text=this.view(command,args);break;
      case'+':case'NEXT':exactly(args,0);text=this.page(false);break;
      case'-':case'PREV':exactly(args,0);text=this.page(true);break;
      case'V':exactly(args,0);this.requireBuffer();text=this.validation();break;
      case'I':case'SECTIONS':{
        exactly(args,0);this.requireBuffer();const sections=this.inspection?.binary?.sections;if(!sections)throw new Error('No decoded WASM sections');
        text=sections.length?sections.slice(0,256).map(s=>`${hex(s.offset,8)}  ${SECTION_NAMES[s.id].toUpperCase().padEnd(12)} payload=${hex(s.payload,8)} size=${hex(s.end-s.payload)}h`).join('\n'):'No sections (empty module)';if(sections.length>256)text+='\n(first 256 sections)';break;
      }
      case'FN':{
        exactly(args,0,1);this.requireBuffer();const bodies=this.inspection?.binary?.sections.find(s=>s.id===10)?.bodies??[];
        if(!args.length){text=bodies.length?bodies.slice(0,256).map((b,i)=>`BODY ${hex(i)}  FILE ${hex(b.ops[0]?.offset??b.offset,8)}  ${b.ops.length} instructions`+(this.inspection?.decoded?.exports.filter(e=>e.index===i).map(e=>`  ${JSON.stringify(e.name)}`).join('')??'')).join('\n'):'No defined function bodies';if(bodies.length>256)text+='\n(first 256 bodies)';}
        else{const exported=this.inspection?.decoded?.exports.find(e=>e.name===args[0].value),index=exported?.index??number(args[0].value),body=bodies[index];if(!body)throw new Error('Unknown body index or export');text=this.view('U',[{value:hex(body.ops[0]?.offset??body.offset),quoted:false}]);}break;
      }
      case'S':case'F':{
        this.requireBuffer();const q=range(args,0,0,this.buffer.length,true),pattern=byteList(args.slice(q.used));if(q.start+q.length>this.buffer.length)throw new Error('Range extends beyond the buffer');
        if(command==='S'){
          const bytes=Buffer.from(this.buffer.buffer,this.buffer.byteOffset,this.buffer.byteLength),matches:number[]=[];let at=q.start;
          while(at<q.end&&matches.length<256){const found=bytes.indexOf(pattern,at);if(found<0||found+pattern.length>q.end)break;matches.push(found);at=found+1;}
          text=matches.length?matches.map(at=>hex(at,8)).join('\n')+(matches.length===256?'\n(first 256 matches)':''):'No matches';
        }else{if(q.length>MAX_PAGE)throw new Error('Fill limit: 10000h bytes per edit');const next=this.buffer.slice();for(let i=q.start;i<q.end;i++)next[i]=pattern[(i-q.start)%pattern.length];text=this.edit(next);}break;
      }
      case'E':{
        this.requireBuffer();if(args.length<2)throw new Error('Use E address byte-list');const address=number(args[0].value),bytes=byteList(args.slice(1));if(bytes.length>MAX_PAGE||address+bytes.length>this.buffer.length)throw new Error('Patch is outside the buffer or exceeds 10000h bytes');const next=this.buffer.slice();next.set(bytes,address);text=this.edit(next);break;
      }
      case'A':{
        this.requireBuffer();if(args.length<2)throw new Error('Use A file-offset mnemonic operands');const address=number(args[0].value),original=this.inspection?.binary;if(!original)throw new Error('No decoded WASM module');
        const module=structuredClone(original),body=module.sections.flatMap(s=>s.bodies).find(b=>b.ops.some(op=>op.offset===address));if(!body)throw new Error('Address must be a known instruction boundary');
        const encoded=encodeInstruction(args[1].value,args.slice(2).map(w=>w.value)),replacement=decodeInstruction(new BinaryReader(encoded)),index=body.ops.findIndex(op=>op.offset===address);
        body.ops[index]={...replacement,offset:address,depth:body.ops[index].depth};const next=assembleWasm(disassembleBinary(module));text=this.edit(next);break;
      }
      case'UNDO':case'REDO':exactly(args,0);this.requireBuffer();text=this.undo(command==='REDO');break;
      case'W':case'WRITE':{
        exactly(args,1);this.requireBuffer();await atomicWrite(resolve(this.cwd,args[0].value),this.buffer);this.savedRevision=this.revision;text=`Wrote ${this.buffer.length} bytes to ${JSON.stringify(args[0].value)}`;break;
      }
      case'SOURCE':{
        exactly(args,0,1);this.requireBuffer();const source=dumpWasm(this.buffer,{format:'source'});
        if(args[0]){await atomicWrite(resolve(this.cwd,args[0].value),source);text=`Wrote HEXAW source to ${JSON.stringify(args[0].value)}`;}else{if(source.length>1024*1024)throw new Error('Use SOURCE filename for source larger than 1 MiB');text=source;}break;
      }
      case'H':{
        exactly(args,2);const a=BigInt(number(args[0].value)),b=BigInt(number(args[1].value)),difference=a-b;text=`SUM=${(a+b).toString(16).toUpperCase()}h  DIFFERENCE=${difference<0n?'-':''}${(difference<0n?-difference:difference).toString(16).toUpperCase()}h\nDECIMAL ${a} ${b}`;break;
      }
      case'CALL':text=this.start(args);break;
      case'T':case'P':case'G':text=await this.run(command,args);break;
      case'BACK':case'Z':{
        exactly(args,0,1);const vm=this.requireVM(),n=count(args[0]?.value,1);let undone=0;while(undone<n&&vm.back())undone++;text=`Rewound ${undone} instruction(s)\n`+this.registers();break;
      }
      case'R':exactly(args,0);text=this.registers();break;
      case'K':{
        exactly(args,0);const vm=this.requireVM();text=vm.frames.length?vm.frames.map((f,i)=>`[${hex(i)}] FN ${hex(f.fn)}  PC ${vm.module.functions[f.fn].ops[f.pc]?hex(vm.module.functions[f.fn].ops[f.pc].offset,8):'--------'}`).reverse().join('\n'):'No active frames';break;
      }
      case'BP':{
        exactly(args,0,1);this.requireBuffer();if(args.length){const address=number(args[0].value);if(!this.instructions().some(op=>op.offset===address))throw new Error('Breakpoint must be at an instruction boundary');this.breakpoints.add(address);text=`Breakpoint ${hex(address,8)}`;}
        else text=this.breakpoints.size?[...this.breakpoints].sort((a,b)=>a-b).map(n=>hex(n,8)).join('\n'):'No breakpoints';break;
      }
      case'BC':exactly(args,1);if(args[0].value==='*')this.breakpoints.clear();else this.breakpoints.delete(number(args[0].value));text='Breakpoints updated';break;
      default:throw new Error(`Unknown monitor command ${tokens[0].value}; type ? for help`);
    }return {text};
  }
}
