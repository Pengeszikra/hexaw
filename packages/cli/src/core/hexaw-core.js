/** HEXAW 0.1 — a small, dependency-free WebAssembly assembler and reversible VM.
 * The rule table is the single source of truth for syntax, opcodes and types.
 * Compilation produces an annotated binary; debugging decodes that binary.
 */
import {INSTRUCTIONS} from './instruction-set.js';
import {BinaryReader,decodeInstruction,encodeInstruction} from './instruction-codec.js';
export const VERSION = '0.4.0';
export const TYPES = Object.freeze({i32:0x7f,i64:0x7e,f32:0x7d,f64:0x7c});
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k,v])=>[v,k]));
const PREFIXES = {i32:'',i64:'L',f32:'F',f64:'D'};
const te = new TextEncoder(), td = new TextDecoder('utf-8',{fatal:true});
export class HexawError extends Error {
  constructor(message,line=0,offset=null){super(message);this.name='HexawError';this.line=line;this.offset=offset;}
}
const fail = (message,line=0)=>{throw new HexawError(message,line);};
export function uleb(value){let v=BigInt(value);if(v<0n)throw new Error('Negative unsigned LEB128');const a=[];do{let b=Number(v&127n);v>>=7n;a.push(b|(v?128:0));}while(v);return a;}
export function sleb(value){let v=BigInt(value),more=true;const a=[];while(more){let b=Number(v&127n);v>>=7n;more=!((v===0n&&!(b&64))||(v===-1n&&(b&64)));a.push(b|(more?128:0));}return a;}
function floatBytes(value,type){const a=new Uint8Array(type==='f32'?4:8);new DataView(a.buffer)[type==='f32'?'setFloat32':'setFloat64'](0,Number(value),true);return [...a];}
export function parseValue(text,type='i32',line=0){
  if(type==='f32'||type==='f64'){
    let s=String(text).replaceAll('_','');
    if(/^[+-]?nan$/i.test(s))return NaN;
    if(/^\+?inf(inity)?$/i.test(s))return Infinity;
    if(/^-inf(inity)?$/i.test(s))return -Infinity;
    if(!s.trim()||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(s))fail(`Invalid ${type} value: ${text}`,line);
    const v=Number(s);return type==='f32'?Math.fround(v):v;
  }
  let s=String(text).replaceAll('_',''),v;
  if(!/^[+-]?(?:0x[0-9a-f]+|\d+)$/i.test(s))fail(`Invalid ${type} integer: ${text}`,line);
  try{const neg=s[0]==='-';s=s.replace(/^[+-]/,'');v=BigInt(s);if(neg)v=-v;}catch{fail(`Invalid integer: ${text}`,line);}
  const bits=type==='i64'?64:32;
  if(v<-(1n<<BigInt(bits-1))||v>=(1n<<BigInt(bits)))fail(`${type} integer out of range: ${text}`,line);
  v=BigInt.asIntN(bits,v);return type==='i64'?v:Number(v);
}
function index(text,line=0){if(!/^\d+$|^0x[0-9a-f]+$/i.test(String(text)))fail(`Expected a nonnegative index, got ${text??'nothing'}`,line);const v=Number(text);if(!Number.isSafeInteger(v)||v<0||v>0xffffffff)fail('Index out of range',line);return v;}
function blockType(text,line){if(text===undefined)return null;const t=String(text).toLowerCase();const v=({i:'i32',l:'i64',f:'f32',d:'f64'})[t]||t;if(!TYPES[v])fail(`Unknown type ${text}; use I32, I64, F32 or F64`,line);return v;}
export const RULES = Object.create(null);
const add=(name,opcode,wasm,kind='simple',extra={})=>RULES[name]=Object.freeze({name,opcode,wasm,kind,...extra});
for(const [name,kind] of Object.entries({FN:'fn',EXP:'export',MEM:'memorydecl',DATA:'data',TABLE:'tabledecl',ELEM:'element'}))RULES[name]=Object.freeze({name,kind,directive:true});
for(const [type,prefix] of Object.entries(PREFIXES))for(const [name,kind] of Object.entries({PAR:'param',LOC:'local',RES:'result',GLB:'global'}))RULES[prefix+name]=Object.freeze({name:prefix+name,type,kind,directive:true});
add('TRAP',0x00,'unreachable');add('NOP',0x01,'nop');
add('BLOCK',0x02,'block','block');add('LOOP',0x03,'loop','block');add('IF',0x04,'if','block');
add('ELSE',0x05,'else');add('END',0x0b,'end');add('BR',0x0c,'br','branch');add('BRIF',0x0d,'br_if','branch');
add('RET',0x0f,'return');add('CALL',0x10,'call','index');add('DROP',0x1a,'drop');add('SELECT',0x1b,'select');
for(const [n,op,wasm] of [['GET',0x20,'local.get'],['SET',0x21,'local.set'],['TEE',0x22,'local.tee'],['GGET',0x23,'global.get'],['GSET',0x24,'global.set']])add(n,op,wasm,'index');
const memRules=[['LOAD',0x28,'i32',4,false],['LLOAD',0x29,'i64',8,false],['FLOAD',0x2a,'f32',4,false],['DLOAD',0x2b,'f64',8,false],['LOAD8S',0x2c,'i32',1,true],['LOAD8U',0x2d,'i32',1,false],['LOAD16S',0x2e,'i32',2,true],['LOAD16U',0x2f,'i32',2,false],['LLOAD8S',0x30,'i64',1,true],['LLOAD8U',0x31,'i64',1,false],['LLOAD16S',0x32,'i64',2,true],['LLOAD16U',0x33,'i64',2,false],['LLOAD32S',0x34,'i64',4,true],['LLOAD32U',0x35,'i64',4,false],['STORE',0x36,'i32',4,false],['LSTORE',0x37,'i64',8,false],['FSTORE',0x38,'f32',4,false],['DSTORE',0x39,'f64',8,false],['STORE8',0x3a,'i32',1,false],['STORE16',0x3b,'i32',2,false],['LSTORE8',0x3c,'i64',1,false],['LSTORE16',0x3d,'i64',2,false],['LSTORE32',0x3e,'i64',4,false]];
for(const [name,opcode,type,width,signed] of memRules){const store=name.includes('STORE'),suffix=(type==='i32'?name:name.slice(1)).toLowerCase().replace(/([su])$/,'_$1');add(name,opcode,`${type}.${suffix}`,'memarg',{type,width,signed,store});}
add('MSIZE',0x3f,'memory.size','memory');add('MGROW',0x40,'memory.grow','memory');
for(const [type,p] of Object.entries(PREFIXES))add(p+'CONST',({i32:0x41,i64:0x42,f32:0x43,f64:0x44})[type],type+'.const','const',{type});
const comparisons=['EQ','NE','LTS','LTU','GTS','GTU','LES','LEU','GES','GEU'];
for(const [type,p,base] of [['i32','',0x45],['i64','L',0x50]]){
  add(p+'EQZ',base,type+'.eqz','numeric',{type,operation:'eqz',arity:1,resultType:'i32'});
  comparisons.forEach((op,i)=>add(p+op,base+1+i,type+'.'+op.toLowerCase().replace(/([su])$/,'_$1'),'numeric',{type,operation:op.toLowerCase(),arity:2,resultType:'i32'}));
}
for(const [type,p,base] of [['f32','F',0x5b],['f64','D',0x61]])['EQ','NE','LT','GT','LE','GE'].forEach((op,i)=>add(p+op,base+i,type+'.'+op.toLowerCase(),'numeric',{type,operation:op.toLowerCase(),arity:2,resultType:'i32'}));
const intOps=['CLZ','CTZ','POPCNT','ADD','SUB','MUL','DIVS','DIVU','REMS','REMU','AND','OR','XOR','SHL','SHRS','SHRU','ROTL','ROTR'];
for(const [type,p,base] of [['i32','',0x67],['i64','L',0x79]])intOps.forEach((op,i)=>add(p+op,base+i,type+'.'+op.toLowerCase().replace(/(div|rem|shr)(s|u)$/,'$1_$2'),'numeric',{type,operation:op.toLowerCase(),arity:i<3?1:2,resultType:type}));
const floatOps=['ABS','NEG','CEIL','FLOOR','TRUNC','NEAREST','SQRT','ADD','SUB','MUL','DIV','MIN','MAX','COPYSIGN'];
for(const [type,p,base] of [['f32','F',0x8b],['f64','D',0x99]])floatOps.forEach((op,i)=>add(p+op,base+i,type+'.'+op.toLowerCase(),'numeric',{type,operation:op.toLowerCase(),arity:i<7?1:2,resultType:type}));
const conversions=[['WRAP',0xa7,'i64','i32','wrap_i64'],['TRUNCF',0xa8,'f32','i32','trunc_f32_s'],['TRUNCFU',0xa9,'f32','i32','trunc_f32_u'],['TRUNCD',0xaa,'f64','i32','trunc_f64_s'],['TRUNCDU',0xab,'f64','i32','trunc_f64_u'],['LEXTEND',0xac,'i32','i64','extend_i32_s'],['LEXTENDU',0xad,'i32','i64','extend_i32_u'],['LTRUNCF',0xae,'f32','i64','trunc_f32_s'],['LTRUNCFU',0xaf,'f32','i64','trunc_f32_u'],['LTRUNCD',0xb0,'f64','i64','trunc_f64_s'],['LTRUNCDU',0xb1,'f64','i64','trunc_f64_u'],['FCONVERT',0xb2,'i32','f32','convert_i32_s'],['FCONVERTU',0xb3,'i32','f32','convert_i32_u'],['FCONVERTL',0xb4,'i64','f32','convert_i64_s'],['FCONVERTLU',0xb5,'i64','f32','convert_i64_u'],['FDEMOTE',0xb6,'f64','f32','demote_f64'],['DCONVERT',0xb7,'i32','f64','convert_i32_s'],['DCONVERTU',0xb8,'i32','f64','convert_i32_u'],['DCONVERTL',0xb9,'i64','f64','convert_i64_s'],['DCONVERTLU',0xba,'i64','f64','convert_i64_u'],['DPROMOTE',0xbb,'f32','f64','promote_f32'],['REINTERPRETF',0xbc,'f32','i32','reinterpret_f32'],['LREINTERPRETD',0xbd,'f64','i64','reinterpret_f64'],['FREINTERPRET',0xbe,'i32','f32','reinterpret_i32'],['DREINTERPRETL',0xbf,'i64','f64','reinterpret_i64']];
for(const [name,opcode,from,type,operation] of conversions)add(name,opcode,type+'.'+operation,'convert',{from,type,operation});
for(const [name,opcode,type,width] of [['EXTEND8',0xc0,'i32',8],['EXTEND16',0xc1,'i32',16],['LEXTEND8',0xc2,'i64',8],['LEXTEND16',0xc3,'i64',16],['LEXTEND32',0xc4,'i64',32]])add(name,opcode,`${type}.extend${width}_s`,'extend',{type,width});
for(const rule of INSTRUCTIONS)if(!RULES[rule.name])RULES[rule.name]=Object.freeze({...rule,kind:'encoded'});
Object.freeze(RULES);
export const OPCODES=Object.freeze(Object.fromEntries(Object.values(RULES).filter(r=>!r.directive&&!r.prefix).map(r=>[r.opcode,r])));
const ALIASES={CON:'CONST',LCON:'LCONST',FCON:'FCONST',DCON:'DCONST',PUSH:'CONST',BR_IF:'BRIF',RETURN:'RET',LOCAL:'LOC'};

function tokenize(source){return source.split(/\r?\n/).map((raw,i)=>{
  const tokens=[];let at=0;
  while(at<raw.length){if(/\s/.test(raw[at])){at++;continue;}if(raw[at]===';'||raw.slice(at,at+2)==='//')break;
    if(raw[at]==='"'){let end=at+1;for(;end<raw.length;end++){if(raw[end]==='\\'){end++;continue;}if(raw[end]==='"')break;}if(end>=raw.length)fail('Unclosed string',i+1);const v=raw.slice(at,end+1);try{tokens.push({text:JSON.parse(v),quoted:true});}catch{fail('Invalid quoted string',i+1);}at=end+1;
    }else{let end=at;while(end<raw.length&&!/\s/.test(raw[end])&&raw[end]!==';'&&raw.slice(end,end+2)!=='//')end++;tokens.push({text:raw.slice(at,end),quoted:false});at=end;}
  }return {raw,line:i+1,tokens};
}).filter(x=>x.tokens.length);}
export function parseHEXAW(source){
  const mod={source,functions:[],globals:[],memory:null,table:null,elements:[],data:[],exports:[]};let fn=null;
  for(const row of tokenize(source)){
    let name=row.tokens[0].text.toUpperCase();name=ALIASES[name]||name;
    const rule=RULES[name],a=row.tokens.slice(1).map(t=>t.text),line=row.line;
    if(!rule)fail(`Unknown instruction ${name}`,line);
    const check=(min,max=min)=>{if(a.length<min||a.length>max)fail(`${name} expects ${min===max?min:`${min}–${max}`} argument${max===1?'':'s'}`,line);};
    if(rule.kind==='fn'){check(1);if(fn)fail('Close the previous function with END',line);const id=index(a[0],line);if(id!==mod.functions.length)fail(`Function indices must be consecutive; expected ${mod.functions.length}`,line);fn={id,line,params:[],locals:[],results:[],ops:[],blocks:[],bodyStarted:false};mod.functions.push(fn);continue;}
    if(rule.kind==='export'){check(2);if(fn)fail('EXP belongs outside a function',line);mod.exports.push({name:String(a[0]),index:index(a[1],line),line});continue;}
    if(rule.kind==='memorydecl'){check(1,2);if(fn||mod.memory)fail('Declare one MEM outside functions',line);const min=index(a[0],line),max=a[1]===undefined?Math.max(min,16):index(a[1],line);if(min>max||max>256)fail('Memory limits: 0 ≤ initial ≤ maximum ≤ 256 pages',line);mod.memory={min,max,line};continue;}
    if(rule.kind==='tabledecl'){check(1,2);if(fn||mod.table)fail('Declare one TABLE outside functions',line);const min=index(a[0],line),max=a[1]===undefined?null:index(a[1],line);if(max!==null&&min>max)fail('TABLE minimum exceeds maximum',line);mod.table={min,max,line};continue;}
    if(rule.kind==='element'){check(2,65536);if(fn)fail('ELEM belongs outside functions',line);mod.elements.push({offset:index(a[0],line),functions:a.slice(1).map(x=>index(x,line)),line});continue;}
    if(rule.kind==='data'){check(2);if(fn)fail('DATA belongs outside a function',line);if(!row.tokens[2]?.quoted)fail('DATA expects a quoted UTF-8 string',line);mod.data.push({offset:index(a[0],line),bytes:te.encode(a[1]),line});continue;}
    if(rule.kind==='global'){check(2);if(fn)fail('GLB belongs outside a function',line);const id=index(a[0],line);if(id!==mod.globals.length)fail(`Expected global index ${mod.globals.length}`,line);mod.globals.push({id,type:rule.type,value:parseValue(a[1],rule.type,line),line});continue;}
    if(!fn)fail(`${name} needs a function; start with FN 00`,line);
    if(['param','local','result'].includes(rule.kind)){
      if(fn.bodyStarted)fail('Put parameters, results and locals before instructions',line);
      if(rule.kind==='result'){check(0);if(fn.results.length)fail('HEXAW 0.1 supports one result per function',line);fn.results.push({type:rule.type,line});}
      else{check(1);const id=index(a[0],line),expected=fn.params.length+fn.locals.length;if(id!==expected)fail(`Expected local index ${expected}`,line);if(rule.kind==='param'&&fn.locals.length)fail('Declare parameters before locals',line);fn[rule.kind==='param'?'params':'locals'].push({id,type:rule.type,line});}continue;
    }
    fn.bodyStarted=true;const op={name,rule,line,args:[],depth:fn.blocks.length};
    if(rule.kind==='encoded'){
      if(name==='CALLIND'&&a.length===1)a.push('0');
      try{op.encoded=encodeInstruction(name,a);}catch(error){fail(error.message,line);}
      op.args=a;
      if(name==='BRTABLE')for(const label of a)if(index(label,line)>fn.blocks.length)fail('Branch depth is outside this function',line);
      if(name==='TRYTABLE'||name==='TRY')fn.blocks.push({name,op,elseSeen:false});
    }
    else if(rule.kind==='const'){check(1);op.value=parseValue(a[0],rule.type,line);op.args=[op.value];}
    else if(['index','branch'].includes(rule.kind)){check(1);op.args=[index(a[0],line)];if(rule.kind==='branch'&&op.args[0]>fn.blocks.length)fail('Branch depth is outside this function',line);}
    else if(rule.kind==='block'){check(0,1);op.blockType=blockType(a[0],line);op.args=op.blockType?[op.blockType]:[];fn.blocks.push({name,op,elseSeen:false});}
    else if(rule.kind==='memarg'){check(0,2);const offset=a[0]===undefined?0:index(a[0],line),align=a[1]===undefined?Math.log2(rule.width):index(a[1],line);if(align>Math.log2(rule.width))fail('Alignment exponent exceeds the natural alignment',line);op.args=[offset,align];}
    else{check(0);if(name==='ELSE'){const b=fn.blocks.at(-1);if(!b||b.name!=='IF'||b.elseSeen)fail('ELSE needs an unmatched IF',line);b.elseSeen=true;op.depth--;}
      if(name==='END'){if(fn.blocks.length){fn.blocks.pop();op.depth--;}else{op.depth=0;op.functionEnd=true;fn.ops.push(op);fn=null;continue;}}
    }fn.ops.push(op);
  }
  if(fn)fail('Missing END for function or block',fn.line);
  if(!mod.functions.length)fail('The module needs at least one function');
  if(mod.functions.length>1024)fail('At most 1024 functions are supported');
  for(const f of mod.functions)for(const op of f.ops){
    if(['GET','SET','TEE'].includes(op.name)&&op.args[0]>=f.params.length+f.locals.length)fail(`Local ${op.args[0]} is not declared`,op.line);
    if(['GGET','GSET'].includes(op.name)&&op.args[0]>=mod.globals.length)fail(`Global ${op.args[0]} is not declared`,op.line);
    if(op.name==='CALL'&&op.args[0]>=mod.functions.length)fail(`Function ${op.args[0]} is not declared`,op.line);
    if((op.rule.kind==='memarg'||op.rule.kind==='memory')&&!mod.memory)fail('Memory instruction requires a MEM declaration',op.line);
  }
  if(mod.data.length&&!mod.memory)fail('DATA requires MEM',mod.data[0].line);
  if(mod.elements.length&&!mod.table)fail('ELEM requires TABLE',mod.elements[0].line);
  for(const element of mod.elements)for(const id of element.functions)if(id>=mod.functions.length)fail('ELEM refers to missing function',element.line);
  for(const d of mod.data)if(d.offset+d.bytes.length>mod.memory.min*65536)fail('DATA lies outside initial memory',d.line);
  const names=new Set();for(const e of mod.exports){if(e.index>=mod.functions.length)fail(`Export refers to missing function ${e.index}`,e.line);if(names.has(e.name))fail(`Duplicate export ${e.name}`,e.line);names.add(e.name);}
  for(const f of mod.functions)if(!mod.exports.some(e=>e.index===f.id)){let name=`fn${String(f.id).padStart(2,'0')}`;while(names.has(name))name+='_';mod.exports.push({name,index:f.id,line:f.line});names.add(name);}
  return mod;
}

/** ByteAtom: {bytes, offset, kind, meaning, value, owner, section, depth, line}. */
export function assemble(mod){
  const parts=[];
  const atom=(bytes,kind,meaning,meta={})=>({bytes:Uint8Array.from(bytes),kind,meaning,owner:'module',section:'header',depth:0,line:0,...meta});
  const uint=(n,meaning,m={})=>atom(uleb(n),'uleb128',meaning,{value:n,...m});
  const val=(type,meaning,m={})=>atom([TYPES[type]],'valtype',meaning,{value:type,...m});
  const str=(s,meaning,m={})=>{const b=te.encode(s);return [uint(b.length,meaning+' length',m),atom(b,'utf8',meaning,{value:s,...m})];};
  const length=xs=>xs.reduce((n,a)=>n+a.bytes.length,0);
  const section=(id,name,content)=>{const m={section:name};parts.push(atom([id],'section',name+' section',m),uint(length(content),name+' section length',m),...content);};
  const constant=(type,value,m)=>[atom([RULES[PREFIXES[type]+'CONST'].opcode],'opcode',type+'.const',m),atom(type[0]==='i'?sleb(value):floatBytes(value,type),type[0]==='i'?'sleb128':type,value.toString(),{value,...m})];
  parts.push(atom([0,97,115,109],'magic','WebAssembly magic'),atom([1,0,0,0],'version','Binary version 1'));
  const types=[],typeMap=new Map();for(const f of mod.functions){const key=f.params.map(p=>p.type).join(',')+'->'+f.results.map(r=>r.type).join(',');if(!typeMap.has(key)){typeMap.set(key,types.length);types.push(f);}f.typeIndex=typeMap.get(key);}
  const t=[uint(types.length,'Type count',{section:'type'})];for(const f of types){const m={section:'type',owner:`fn${f.id}`,line:f.line};t.push(atom([0x60],'functype','Function type',m),uint(f.params.length,'Parameter count',m));for(const p of f.params)t.push(val(p.type,`Parameter ${p.id} type`,{...m,line:p.line}));t.push(uint(f.results.length,'Result count',m));for(const r of f.results)t.push(val(r.type,'Result type',{...m,line:r.line}));}section(1,'type',t);
  section(3,'function',[uint(mod.functions.length,'Function count',{section:'function'}),...mod.functions.map(f=>uint(f.typeIndex,`Function ${f.id} type index`,{section:'function',owner:`fn${f.id}`,line:f.line}))]);
  if(mod.table){const m={section:'table',line:mod.table.line};section(4,'table',[uint(1,'Table count',m),atom([0x70],'valtype','Function reference',m),uint(mod.table.max===null?0:1,'Table limits flags',m),uint(mod.table.min,'Initial table entries',m),...(mod.table.max===null?[]:[uint(mod.table.max,'Maximum table entries',m)])]);}
  if(mod.memory){const m={section:'memory',line:mod.memory.line};section(5,'memory',[uint(1,'Memory count',m),atom([1],'limits','Minimum and maximum present',m),uint(mod.memory.min,'Initial pages',m),uint(mod.memory.max,'Maximum pages',m)]);}
  if(mod.globals.length){const gs=[uint(mod.globals.length,'Global count',{section:'global'})];for(const g of mod.globals){const m={section:'global',owner:`global${g.id}`,line:g.line};gs.push(val(g.type,'Global type',m),atom([1],'mutability','Mutable global',m),...constant(g.type,g.value,m),atom([0xb],'opcode','Initializer end',m));}section(6,'global',gs);}
  const ex=[uint(mod.exports.length,'Export count',{section:'export'})];for(const e of mod.exports){const m={section:'export',owner:`fn${e.index}`,line:e.line};ex.push(...str(e.name,'Export name',m),atom([0],'exportkind','Function export',m),uint(e.index,'Export function index',m));}section(7,'export',ex);
  if(mod.elements?.length){const elements=[uint(mod.elements.length,'Element segment count',{section:'element'})];for(const e of mod.elements){const m={section:'element',line:e.line};elements.push(uint(0,'Active table-0 segment',m),...constant('i32',e.offset,m),atom([0xb],'opcode','Element offset end',m),uint(e.functions.length,'Element count',m),...e.functions.map(id=>uint(id,'Function index',m)));}section(9,'element',elements);}
  const code=[uint(mod.functions.length,'Code body count',{section:'code'})];
  for(const f of mod.functions){const m={section:'code',owner:`fn${f.id}`,line:f.line};const groups=[];for(const l of f.locals){const prev=groups.at(-1);if(prev?.type===l.type)prev.count++;else groups.push({type:l.type,count:1,line:l.line});}
    const body=[uint(groups.length,'Local declaration group count',m)];for(const g of groups)body.push(uint(g.count,'Local count',{...m,line:g.line}),val(g.type,'Local type',{...m,line:g.line}));
    for(const op of f.ops){const r=op.rule,om={...m,line:op.line,depth:op.depth,instruction:op};if(r.kind==='encoded'){body.push(atom(op.encoded,'opcode',r.wasm,om));continue;}body.push(atom([r.opcode],'opcode',r.wasm,om));
      if(r.kind==='const')body.push(atom(r.type[0]==='i'?sleb(op.value):floatBytes(op.value,r.type),r.type[0]==='i'?'sleb128':r.type,`${r.type} constant`,{...om,value:op.value}));
      if(['index','branch'].includes(r.kind))body.push(uint(op.args[0],r.kind==='branch'?'Relative label depth':r.wasm.split('.')[0]+' index',om));
      if(r.kind==='block')body.push(op.blockType?val(op.blockType,'Block result type',om):atom([0x40],'blocktype','Block has no result',om));
      if(r.kind==='memarg')body.push(uint(op.args[1],'Alignment exponent',om),uint(op.args[0],'Memory offset',om));
      if(r.kind==='memory')body.push(uint(0,'Memory index',om));
    }code.push(uint(length(body),'Function body length',m),...body);
  }section(10,'code',code);
  if(mod.data.length){const ds=[uint(mod.data.length,'Data segment count',{section:'data'})];for(const d of mod.data){const m={section:'data',line:d.line};ds.push(uint(0,'Active memory 0 segment',m),...constant('i32',d.offset,m),atom([0xb],'opcode','Offset expression end',m),uint(d.bytes.length,'Data length',m),atom(d.bytes,'utf8','Initial memory bytes',{...m,value:td.decode(d.bytes)}));}section(11,'data',ds);}
  let offset=0;for(let i=0;i<parts.length;i++){parts[i].id=i;parts[i].offset=offset;offset+=parts[i].bytes.length;}const bytes=new Uint8Array(offset);for(const a of parts)bytes.set(a.bytes,a.offset);
  return {bytes,atoms:parts,ir:mod};
}

class Reader {
  constructor(bytes,start=0,end=bytes.length){this.b=bytes;this.p=start;this.end=end;}
  byte(){if(this.p>=this.end)throw new HexawError('Unexpected end of binary',0,this.p);return this.b[this.p++];}
  take(n){if(!Number.isSafeInteger(n)||n<0||this.p+n>this.end)throw new HexawError('Binary field exceeds its section',0,this.p);const a=this.b.slice(this.p,this.p+n);this.p+=n;return a;}
  unsigned(){let v=0n,s=0n;for(let i=0;i<5;i++){const b=this.byte();v|=BigInt(b&127)<<s;if(!(b&128)){if(v>0xffffffffn)throw new HexawError('u32 overflow',0,this.p);return Number(v);}s+=7n;}throw new HexawError('Invalid unsigned LEB128',0,this.p);}
  signed(bits){let v=0n,s=0n,b=0;for(let i=0;i<Math.ceil(bits/7);i++){b=this.byte();v|=BigInt(b&127)<<s;s+=7n;if(!(b&128)){if(b&64)v|=(-1n)<<s;v=BigInt.asIntN(bits,v);return bits===64?v:Number(v);}}throw new HexawError('Invalid signed LEB128',0,this.p);}
  value(type){if(type==='i32')return this.signed(32);if(type==='i64')return this.signed(64);const a=this.take(type==='f32'?4:8);return new DataView(a.buffer)[type==='f32'?'getFloat32':'getFloat64'](0,true);}
  string(){return td.decode(this.take(this.unsigned()));}
  type(){const t=TYPE_NAMES[this.byte()];if(!t)throw new HexawError('This debugger supports i32, i64, f32 and f64 types',0,this.p-1);return t;}
}
export function decodeWASM(input,options={}){
  const inspect=!!options.inspect;
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length>(inspect?64:2)*1024*1024)fail(`Binary import limit: ${inspect?64:2} MiB`);
  if(!WebAssembly.validate(bytes))fail('The browser rejected this WASM binary');
  const r=new Reader(bytes);r.take(8);const types=[],funcTypes=[],functions=[],exports=[],otherExports=[],globals=[],data=[],elements=[],sections=[];let memory=null,table=null;
  while(r.p<r.end){const offset=r.p,id=r.byte(),len=r.unsigned(),end=r.p+len;if(end>r.end)fail('Section exceeds binary');const s=new Reader(bytes,r.p,end);r.p=end;sections.push({id,offset,end,payload:s.p});
    if(id===0)continue;
    if(id===1){const n=s.unsigned();for(let i=0;i<n;i++){if(s.byte()!==0x60)fail('GC/recursive types are outside HEXAW 0.1');const np=s.unsigned(),params=[];for(let j=0;j<np;j++)params.push(s.type());const nr=s.unsigned(),results=[];if(nr>1)fail('Multiple function results are outside HEXAW 0.1');for(let j=0;j<nr;j++)results.push(s.type());types.push({params,results});}}
    else if(id===2){if(s.unsigned())fail('Imported functions, memories and globals are outside HEXAW 0.1');}
    else if(id===3){const n=s.unsigned();for(let i=0;i<n;i++)funcTypes.push(s.unsigned());}
    else if(id===4){if(s.unsigned()!==1||s.byte()!==0x70)fail('Debugger requires one funcref table');const flags=s.unsigned();if(flags>1)fail('Unsupported table limits');table={min:s.unsigned(),max:flags?s.unsigned():null};}
    else if(id===5){const n=s.unsigned();if(n!==1)fail('Exactly one memory is supported');const flags=s.unsigned();if(flags>1||(!inspect&&flags!==1))fail('Debugger requires bounded, unshared 32-bit memory');const min=s.unsigned(),max=flags?s.unsigned():null;if(!inspect&&max>256)fail('Debugger memory limit: 256 pages');memory={min,max};}
    else if(id===6){const n=s.unsigned();for(let i=0;i<n;i++){const type=s.type(),mutable=!!s.byte(),opcode=s.byte(),rr=OPCODES[opcode];if(rr?.kind!=='const'||rr.type!==type)fail('Only constant global initializers are supported');const value=s.value(type);if(s.byte()!==0xb)fail('Unsupported global initializer');globals.push({id:i,type,mutable,value});}}
    else if(id===7){const n=s.unsigned();for(let i=0;i<n;i++){const name=s.string(),kind=s.byte(),idx=s.unsigned();if(kind===0)exports.push({name,index:idx});else if(kind===2)otherExports.push({name,kind,index:idx});else fail('Only function and memory exports are supported');}}
    else if(id===9){const n=s.unsigned();for(let i=0;i<n;i++){if(s.unsigned()!==0||s.byte()!==0x41)fail('Debugger requires active table-0 elements');const offset=s.signed(32)>>>0;if(s.byte()!==0xb)fail('Unsupported element offset expression');const count=s.unsigned(),ids=[];if(count>s.end-s.p)fail('Element count exceeds section');for(let j=0;j<count;j++)ids.push(s.unsigned());elements.push({offset,functions:ids});}}
    else if(id===10){const n=s.unsigned();if(n>1024)fail('Debugger function limit: 1024');for(let i=0;i<n;i++){
      const size=s.unsigned(),bodyEnd=s.p+size;if(bodyEnd>s.end)fail('Function body exceeds code section');const freader=new Reader(bytes,s.p,bodyEnd);s.p=bodyEnd;const sig=types[funcTypes[i]];if(!sig)fail('Unknown function type');const f={id:i,typeIndex:funcTypes[i],params:[...sig.params],results:[...sig.results],locals:[],ops:[],offset:freader.p};const count=freader.unsigned();for(let j=0;j<count;j++){const q=freader.unsigned(),t=freader.type();if(q+f.locals.length+f.params.length>4096)fail('Debugger local limit: 4096 per function');for(let k=0;k<q;k++)f.locals.push(t);}
      const blocks=[];while(freader.p<freader.end){const start=freader.p,opcode=freader.byte();let rule=OPCODES[opcode],encoded=null;if(rule?.kind==='encoded'||opcode>=0xfb&&opcode<=0xfe){const reader=new BinaryReader(bytes,start,freader.end);encoded=decodeInstruction(reader);freader.p=reader.pos;rule=RULES[encoded.name];}if(!rule)throw new HexawError(`Unsupported opcode 0x${opcode.toString(16)}`,0,start);const op={name:rule.name,rule,offset:start,args:encoded?.args||[],depth:blocks.length,line:0};
        if(rule.kind==='encoded'&&(op.name==='TRYTABLE'||op.name==='TRY'))blocks.push(f.ops.length);
        if(rule.kind==='const'){op.value=freader.value(rule.type);op.args=[op.value];}
        if(['index','branch'].includes(rule.kind))op.args=[freader.unsigned()];
        if(rule.kind==='memarg'){const align=freader.unsigned(),off=freader.unsigned();op.args=[off,align];}
        if(rule.kind==='memory'){if(freader.unsigned()!==0)fail('Multiple memories are not supported');}
        if(rule.kind==='block'){const t=freader.byte();if(t!==0x40&&!TYPE_NAMES[t])fail('Type-index block signatures are outside HEXAW 0.1');op.blockType=TYPE_NAMES[t]||null;op.args=op.blockType?[op.blockType]:[];blocks.push(f.ops.length);}
        if(op.name==='ELSE'){const b=blocks.at(-1);if(b===undefined)fail('Unmatched ELSE');f.ops[b].elseIndex=f.ops.length;op.startIndex=b;op.depth--;}
        if(op.name==='END'){if(blocks.length){const b=blocks.pop();op.startIndex=b;op.depth--;f.ops[b].endIndex=f.ops.length;if(f.ops[b].elseIndex!==undefined)f.ops[f.ops[b].elseIndex].endIndex=f.ops.length;}else{op.functionEnd=true;op.depth=0;}}
        op.bytes=bytes.slice(start,freader.p);f.ops.push(op);
      }functions.push(f);
    }}
    else if(id===11){const n=s.unsigned();for(let i=0;i<n;i++){if(s.unsigned()!==0)fail('Only active memory-0 data segments are supported');if(s.byte()!==0x41)fail('Only constant i32 data offsets are supported');const offset=s.signed(32)>>>0;if(s.byte()!==0xb)fail('Unsupported data expression');data.push({offset,bytes:s.take(s.unsigned())});}}
    else fail(`Section ${id} is outside HEXAW 0.1 (tables, start functions and extensions are not supported)`);
    if(s.p!==s.end)throw new HexawError(`Unconsumed bytes in section ${id}`,0,s.p);
  }
  if(!functions.length)fail('This module has no defined functions');
  return {bytes,functions,exports,otherExports,globals,memory,table,elements,data,types,sections};
}
export function compileHEXAW(source){
  const built=assemble(parseHEXAW(source));let nativeModule;
  try{nativeModule=new WebAssembly.Module(built.bytes);}catch(e){const match=String(e.message).match(/@\+(\d+)|offset\s+(\d+)/);const offset=match?Number(match[1]||match[2]):null;const a=offset===null?null:built.atoms.find(a=>offset>=a.offset&&offset<a.offset+a.bytes.length);throw new HexawError(`WASM validation: ${e.message}`,a?.line||0,offset);}
  const decoded=decodeWASM(built.bytes);const opAtoms=new Map(built.atoms.filter(a=>a.kind==='opcode'&&a.instruction).map(a=>[a.offset,a]));
  for(const f of decoded.functions)for(const op of f.ops){const a=opAtoms.get(op.offset);if(a){op.line=a.line;op.atomId=a.id;}}
  return {...built,decoded,nativeModule};
}
export function hexawContext(strings,...values){let source='';for(let i=0;i<strings.length;i++){source+=strings[i];if(i<values.length)source+=String(values[i]);}return compileHEXAW(source);}
/** Import retains the exact original binary, including custom sections and LEB padding. */
export function importWASM(input){
  const decoded=decodeWASM(input),source=disassembleHEXAW(decoded),canonical=compileHEXAW(source),bytes=decoded.bytes,atoms=[];
  for(let i=0;i<decoded.functions.length;i++)for(let j=0;j<decoded.functions[i].ops.length;j++)decoded.functions[i].ops[j].line=canonical.decoded.functions[i].ops[j].line;
  const names={0:'custom',1:'type',2:'import',3:'function',5:'memory',6:'global',7:'export',10:'code',11:'data'};
  const atom=(start,end,kind,meaning,meta={})=>{if(end>start)atoms.push({id:atoms.length,offset:start,bytes:bytes.slice(start,end),kind,meaning,owner:'module',section:'header',depth:0,line:0,...meta});};
  atom(0,4,'magic','WebAssembly magic');atom(4,8,'version','Binary version 1');
  for(const s of decoded.sections){const section=names[s.id]||String(s.id),meta={section};atom(s.offset,s.offset+1,'section',section+' section',meta);atom(s.offset+1,s.payload,'uleb128',section+' section length',meta);
    if(s.id!==10){atom(s.payload,s.end,'payload',section+' section payload (original bytes)',meta);continue;}
    let at=s.payload;
    for(const f of decoded.functions)for(const op of f.ops){const m={...meta,owner:`fn${f.id}`,depth:op.depth,line:op.line,instruction:op};atom(at,op.offset,'structure','Code body / local declarations',meta);atom(op.offset,op.offset+1,'opcode',op.rule.wasm,m);op.atomId=atoms.length-1;const end=op.offset+op.bytes.length;
      if(end>op.offset+1)atom(op.offset+1,end,op.rule.kind==='const'?(op.rule.type[0]==='i'?'sleb128':op.rule.type):op.rule.kind==='block'?'blocktype':'uleb128','Instruction immediate',{...m,value:op.rule.kind==='const'?op.value:op.args.join(', ')});at=end;
    }atom(at,s.end,'structure','Code section metadata',meta);
  }
  return {bytes,atoms,source,decoded,nativeModule:new WebAssembly.Module(bytes),imported:true};
}
export function disassembleHEXAW(mod){
  if(mod.otherExports?.length)fail('Memory exports cannot yet be represented in HEXAW source; use a byte dump to preserve them');
  const lines=['; HEXAW · decoded from WebAssembly'];
  if(mod.memory)lines.push(`MEM ${mod.memory.min} ${mod.memory.max}`);
  if(mod.table)lines.push(`TABLE ${mod.table.min}`+(mod.table.max===null?'':` ${mod.table.max}`));
  for(const e of mod.elements||[])lines.push(`ELEM ${e.offset} ${e.functions.join(' ')}`);
  for(const g of mod.globals){if(!g.mutable)fail('Immutable globals cannot be round-tripped to HEXAW 0.1');lines.push(`${PREFIXES[g.type]}GLB ${g.id} ${formatValue(g.value)}`);}
  for(const d of mod.data){let text;try{text=td.decode(d.bytes);}catch{fail('Non-UTF-8 data cannot be represented by DATA strings in HEXAW 0.1');}lines.push(`DATA ${d.offset} ${JSON.stringify(text)}`);}
  for(const e of mod.exports)lines.push(`EXP ${JSON.stringify(e.name)} ${e.index}`);
  for(const f of mod.functions){lines.push('',`FN ${String(f.id).padStart(2,'0')}`);f.params.forEach((t,i)=>lines.push(`  ${PREFIXES[t]}PAR ${String(i).padStart(2,'0')}`));f.results.forEach(t=>lines.push(`  ${PREFIXES[t]}RES`));f.locals.forEach((t,i)=>lines.push(`  ${PREFIXES[t]}LOC ${String(i+f.params.length).padStart(2,'0')}`));for(const op of f.ops){const args=op.rule.kind==='const'?[formatValue(op.value)]:op.rule.kind==='memarg'?(op.args[0]||op.args[1]!==Math.log2(op.rule.width)?op.args:[]):op.args;lines.push('  '.repeat(op.functionEnd?0:op.depth+1)+op.name+(args.length?' '+args.join(' '):''));}}
  return lines.join('\n')+'\n';
}
export function formatValue(v){if(typeof v==='bigint')return v.toString();if(Number.isNaN(v))return 'NaN';if(v===Infinity)return 'Infinity';if(v===-Infinity)return '-Infinity';if(Object.is(v,-0))return '-0';return String(v);}
export function hex(n,width=2){return Number(n).toString(16).toUpperCase().padStart(width,'0');}
const zero=t=>t==='i64'?0n:0;
function normalize(v,t){if(t==='i64')return BigInt.asIntN(64,BigInt(v));if(t==='i32')return Number(BigInt.asIntN(32,BigInt(v)));if(t==='f32')return Math.fround(v);return Number(v);}
function numeric(rule,a,b){
  const op=rule.operation,type=rule.type,integer=type==='i32'||type==='i64',bits=type==='i64'?64:32;
  if(integer){const A=BigInt(a),B=b===undefined?0n:BigInt(b),U=BigInt.asUintN(bits,A),V=BigInt.asUintN(bits,B),n=BigInt(bits),shift=V&(n-1n);let v;
    switch(op){case'eqz':return Number(A===0n);case'eq':return Number(A===B);case'ne':return Number(A!==B);case'lts':return Number(A<B);case'ltu':return Number(U<V);case'gts':return Number(A>B);case'gtu':return Number(U>V);case'les':return Number(A<=B);case'leu':return Number(U<=V);case'ges':return Number(A>=B);case'geu':return Number(U>=V);
    case'add':v=A+B;break;case'sub':v=A-B;break;case'mul':v=A*B;break;case'divs':if(B===0n)throw new Error('integer divide by zero');if(A===-(1n<<(n-1n))&&B===-1n)throw new Error('integer overflow');v=A/B;break;case'divu':if(V===0n)throw new Error('integer divide by zero');v=U/V;break;case'rems':if(B===0n)throw new Error('integer divide by zero');v=A%B;break;case'remu':if(V===0n)throw new Error('integer divide by zero');v=U%V;break;
    case'and':v=A&B;break;case'or':v=A|B;break;case'xor':v=A^B;break;case'shl':v=A<<shift;break;case'shrs':v=A>>shift;break;case'shru':v=U>>shift;break;case'rotl':v=(U<<shift)|(U>>(n-shift));break;case'rotr':v=(U>>shift)|(U<<(n-shift));break;
    case'clz':{let c=0n;for(let i=n-1n;i>=0n&&!(U&(1n<<i));i--)c++;v=c;break;}case'ctz':{let c=0n;for(let i=0n;i<n&&!(U&(1n<<i));i++)c++;v=c;break;}case'popcnt':{let c=0n,x=U;while(x){x&=x-1n;c++;}v=c;break;}default:throw new Error(`Unimplemented numeric op ${op}`);}
    return normalize(v,type);
  }
  switch(op){case'eq':return Number(a===b);case'ne':return Number(a!==b);case'lt':return Number(a<b);case'gt':return Number(a>b);case'le':return Number(a<=b);case'ge':return Number(a>=b);case'add':return normalize(a+b,type);case'sub':return normalize(a-b,type);case'mul':return normalize(a*b,type);case'div':return normalize(a/b,type);case'abs':return Math.abs(a);case'neg':return -a;case'ceil':return Math.ceil(a);case'floor':return Math.floor(a);case'trunc':return Math.trunc(a);case'nearest':{const f=Math.floor(a),d=a-f;const v=d<0.5?f:d>0.5?f+1:f%2===0?f:f+1;return v===0&&a<0?-0:v;}case'sqrt':return normalize(Math.sqrt(a),type);case'min':return Math.min(a,b);case'max':return Math.max(a,b);case'copysign':{const neg=b<0||Object.is(b,-0);return neg?-Math.abs(a):Math.abs(a);}default:throw new Error(`Unimplemented numeric op ${op}`);}
}
function bigintToF32(value){
  const negative=value<0n;let x=negative?-value:value;
  if(x===0n)return 0;
  const bits=x.toString(2).length,shift=bits-24;
  if(shift<=0)return Math.fround(Number(value));
  let significand=x>>BigInt(shift);const remainder=x-(significand<<BigInt(shift)),half=1n<<BigInt(shift-1);
  if(remainder>half||(remainder===half&&(significand&1n)))significand++;
  const result=Number(significand)*2**shift;return negative?-result:result;
}
function convert(rule,v){
  const op=rule.operation,to=rule.type,from=rule.from;
  if(op.startsWith('reinterpret')){const bytes=new ArrayBuffer(8),d=new DataView(bytes);if(from==='i32'){d.setInt32(0,v,true);return d.getFloat32(0,true);}if(from==='i64'){d.setBigInt64(0,v,true);return d.getFloat64(0,true);}if(from==='f32'){d.setFloat32(0,v,true);return d.getInt32(0,true);}d.setFloat64(0,v,true);return d.getBigInt64(0,true);}
  if(op==='wrap_i64')return normalize(v,'i32');
  if(op==='extend_i32_s')return BigInt(v);if(op==='extend_i32_u')return BigInt(v>>>0);
  if(op.startsWith('trunc_')){if(!Number.isFinite(v))throw new Error('invalid conversion to integer');const x=BigInt(Math.trunc(v)),bits=to==='i64'?64n:32n,unsigned=op.endsWith('_u'),lo=unsigned?0n:-(1n<<(bits-1n)),hi=unsigned?(1n<<bits):(1n<<(bits-1n));if(x<lo||x>=hi)throw new Error('integer overflow');return normalize(x,to);}
  if(op.startsWith('convert_')){const x=op.endsWith('_u')?(from==='i64'?BigInt.asUintN(64,v):v>>>0):v;return from==='i64'&&to==='f32'?bigintToF32(x):normalize(Number(x),to);}
  return normalize(v,to);
}

export class Debugger {
  constructor(module,entry=0,args=[]){this.module=module;this.breakpoints=new Set();this.history=[];this.trace=[];this.steps=0;this.state='ready';this.error=null;this.result=[];this.stack=[];this.frames=[];this.globals=module.globals.map(g=>({type:g.type,value:g.value}));this.memory=new Uint8Array((module.memory?.min||0)*65536);for(const d of module.data){if(d.offset+d.bytes.length>this.memory.length)fail('Data segment is out of memory bounds');this.memory.set(d.bytes,d.offset);}for(const e of module.elements||[])if(!module.table||e.offset+e.functions.length>module.table.min)fail('Element segment is out of table bounds');this.pushFrame(entry,args.map((v,i)=>({type:module.functions[entry]?.params[i],value:v})));}
  get currentFrame(){return this.frames.at(-1);}
  get current(){const f=this.currentFrame;return f?this.module.functions[f.fn].ops[f.pc]:null;}
  pushFrame(id,args){const fn=this.module.functions[id];if(!fn)throw new Error('Unknown function');if(args.length!==fn.params.length)throw new Error(`Function ${id} needs ${fn.params.length} arguments`);if(this.frames.length>=512)throw new Error('Debugger call-depth limit: 512');const locals=args.map((v,i)=>({type:fn.params[i],value:normalize(v.value,fn.params[i])}));for(const t of fn.locals)locals.push({type:t,value:zero(t)});this.frames.push({fn:id,pc:0,base:this.stack.length,locals,controls:[{kind:'function',height:this.stack.length,result:fn.results[0]||null,end:fn.ops.length-1,start:-1}]});}
  pop(type){const v=this.stack.pop();if(!v)throw new Error('Operand stack underflow');if(type&&v.type!==type)throw new Error(`Expected ${type}, got ${v.type}`);return v;}
  push(type,value){this.stack.push({type,value:normalize(value,type)});}
  leaveFunction(){const f=this.currentFrame,fn=this.module.functions[f.fn],values=fn.results.length?[this.pop(fn.results[0])]:[];this.stack.length=f.base;this.frames.pop();this.stack.push(...values);if(!this.frames.length){this.state='finished';this.result=values;}}
  branch(depth){const f=this.currentFrame,target=f.controls.length-1-depth,c=f.controls[target];if(!c)throw new Error('Invalid branch depth');const values=c.kind!=='loop'&&c.result?[this.pop(c.result)]:[];this.stack.length=c.height;this.stack.push(...values);if(c.kind==='function'){this.leaveFunction();return;}if(c.kind==='loop'){f.controls.length=target+1;f.pc=c.start+1;}else{f.controls.length=target;f.pc=c.end+1;}}
  snapshot(){return {frames:structuredClone(this.frames),stack:structuredClone(this.stack),globals:structuredClone(this.globals),steps:this.steps,state:this.state,error:this.error,result:structuredClone(this.result),traceLength:this.trace.length,memoryLength:this.memory.length,writes:[]};}
  step(){
    if(this.state==='finished'||this.state==='trapped')return null;
    const op=this.current;if(!op){this.state='finished';return null;}const prev=this.snapshot();this.history.push(prev);if(this.history.length>2000)this.history.shift();this.state='paused';this.error=null;const f=this.currentFrame,r=op.rule;f.pc++;this.steps++;
    try{
      if(r.kind==='const')this.push(r.type,op.value);
      else if(r.kind==='numeric'){const b=r.arity===2?this.pop(r.type).value:undefined,a=this.pop(r.type).value;this.push(r.resultType,numeric(r,a,b));}
      else if(r.kind==='convert')this.push(r.type,convert(r,this.pop(r.from).value));
      else if(r.kind==='extend')this.push(r.type,BigInt.asIntN(r.width,BigInt(this.pop(r.type).value)));
      else if(r.kind==='memarg'){
        const value=r.store?this.pop(r.type).value:null,addr=(this.pop('i32').value>>>0)+op.args[0];if(addr+r.width>this.memory.length)throw new Error('out of bounds memory access');const d=new DataView(this.memory.buffer);let v;
        if(r.store){prev.writes.push({offset:addr,bytes:this.memory.slice(addr,addr+r.width)});if(r.type==='f32')d.setFloat32(addr,value,true);else if(r.type==='f64')d.setFloat64(addr,value,true);else if(r.width===8)d.setBigInt64(addr,BigInt(value),true);else if(r.width===4)d.setInt32(addr,Number(BigInt.asIntN(32,BigInt(value))),true);else if(r.width===2)d.setInt16(addr,Number(BigInt.asIntN(16,BigInt(value))),true);else d.setInt8(addr,Number(BigInt.asIntN(8,BigInt(value))));}
        else{if(r.type==='f32')v=d.getFloat32(addr,true);else if(r.type==='f64')v=d.getFloat64(addr,true);else if(r.width===8)v=d.getBigInt64(addr,true);else v=d[`get${r.signed?'Int':'Uint'}${r.width*8}`](addr,true);this.push(r.type,v);}
      }
      else if(r.kind==='block'){const condition=op.name==='IF'?this.pop('i32').value:1;f.controls.push({kind:op.name.toLowerCase(),height:this.stack.length,result:op.blockType,start:f.pc-1,end:op.endIndex});if(!condition)f.pc=op.elseIndex===undefined?op.endIndex:op.elseIndex+1;}
      else switch(op.name){
        case'NOP':break;case'TRAP':throw new Error('unreachable executed');
        case'GET':{const v=f.locals[op.args[0]];this.stack.push({...v});break;}
        case'SET':case'TEE':{const idx=op.args[0],v=this.pop(f.locals[idx].type);f.locals[idx]={...v};if(op.name==='TEE')this.stack.push({...v});break;}
        case'GGET':this.stack.push({...this.globals[op.args[0]]});break;
        case'GSET':{const idx=op.args[0];if(!this.module.globals[idx].mutable)throw new Error('Global is immutable');this.globals[idx]=this.pop(this.globals[idx].type);break;}
        case'DROP':this.pop();break;
        case'SELECT':{const c=this.pop('i32').value,b=this.pop(),a=this.pop(b.type);this.stack.push(c?a:b);break;}
        case'BR':this.branch(op.args[0]);break;case'BRIF':if(this.pop('i32').value)this.branch(op.args[0]);break;
        case'BRTABLE':{const selector=this.pop('i32').value>>>0;this.branch(Number(op.args[Math.min(selector,op.args.length-1)]));break;}
        case'ELSE':f.pc=op.endIndex;break;
        case'END':if(op.functionEnd)this.leaveFunction();else{const c=f.controls.pop(),v=c.result?this.pop(c.result):null;this.stack.length=c.height;if(v)this.stack.push(v);}break;
        case'RET':this.leaveFunction();break;
        case'CALL':{const target=this.module.functions[op.args[0]],args=[];for(let i=target.params.length-1;i>=0;i--)args.unshift(this.pop(target.params[i]));this.pushFrame(target.id,args);break;}
        case'CALLIND':{
          if(Number(op.args[1])!==0)throw new Error('Debugger supports table 0');
          const index=this.pop('i32').value>>>0;if(!this.module.table||index>=this.module.table.min)throw new Error('undefined element');
          let id=null;for(const e of this.module.elements||[])if(index>=e.offset&&index<e.offset+e.functions.length)id=e.functions[index-e.offset];
          if(id===null)throw new Error('uninitialized element');const target=this.module.functions[id],expected=this.module.types[Number(op.args[0])];
          if(!expected||target.params.join(',')!==expected.params.join(',')||target.results.join(',')!==expected.results.join(','))throw new Error('indirect call type mismatch');
          const args=[];for(let i=target.params.length-1;i>=0;i--)args.unshift(this.pop(target.params[i]));this.pushFrame(target.id,args);break;
        }
        case'MSIZE':this.push('i32',this.memory.length/65536);break;
        case'MGROW':{const delta=this.pop('i32').value>>>0,old=this.memory.length/65536,max=this.module.memory?.max??0;if(delta+old>max)this.push('i32',-1);else{const mem=new Uint8Array((delta+old)*65536);mem.set(this.memory);this.memory=mem;this.push('i32',old);}break;}
        default:throw new Error(`Unsupported instruction ${op.name}`);
      }
    }catch(e){this.state='trapped';this.error=e.message;}
    const item={step:this.steps,fn:f.fn,offset:op.offset,line:op.line,instruction:op.name+(op.args.length?' '+op.args.map(formatValue).join(' '):''),stack:this.stack.map(v=>({...v})),state:this.state,error:this.error};this.trace.push(item);if(this.trace.length>2000)prev.evictedTrace=this.trace.shift();return item;
  }
  back(){const s=this.history.pop();if(!s)return false;let memory=this.memory;if(memory.length!==s.memoryLength){const next=new Uint8Array(s.memoryLength);next.set(memory.subarray(0,s.memoryLength));memory=next;}for(const w of s.writes)memory.set(w.bytes,w.offset);this.memory=memory;this.frames=s.frames;this.stack=s.stack;this.globals=s.globals;this.steps=s.steps;this.state=s.state;this.error=s.error;this.result=s.result;this.trace.pop();if(s.evictedTrace)this.trace.unshift(s.evictedTrace);return true;}
  run(limit=100000){let count=0;while(this.current&&this.state!=='finished'&&this.state!=='trapped'&&count<limit){if(count&&this.breakpoints.has(this.current.offset))break;this.step();count++;}return {count,state:this.state,result:this.result,limited:count>=limit};}
}
