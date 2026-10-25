import {INSTRUCTION_NAMES,INSTRUCTION_OPCODES} from './instruction-set.js';

export class BinaryError extends Error {
  /** @param {string} message @param {number|null} offset @param {number} line */
  constructor(message,offset=null,line=0){super(message);this.name='BinaryError';this.offset=offset;this.line=line;}
}
export function unsignedLEB(value,bits=32){
  let n=BigInt(value);if(n<0n||n>=(1n<<BigInt(bits)))throw new BinaryError(`Unsigned ${bits}-bit integer out of range`);
  const bytes=[];do{const b=Number(n&127n);n>>=7n;bytes.push(b|(n?128:0));}while(n);return bytes;
}
export function signedLEB(value,bits=32){
  let n=BigInt(value);if(n<-(1n<<BigInt(bits-1))||n>=(1n<<BigInt(bits-1)))throw new BinaryError(`Signed ${bits}-bit integer out of range`);
  const bytes=[];for(;;){const b=Number(n&127n);n>>=7n;const more=!((n===0n&&!(b&64))||(n===-1n&&(b&64)));bytes.push(b|(more?128:0));if(!more)return bytes;}
}
export class BinaryReader {
  /** @param {Uint8Array} bytes @param {number} start @param {number} end */
  constructor(bytes,start=0,end=bytes.length){this.bytes=bytes;this.pos=start;this.end=end;if(start<0||end>bytes.length||start>end)throw new BinaryError('Invalid binary range',start);}
  take(size){if(!Number.isSafeInteger(size)||size<0||size>this.end-this.pos)throw new BinaryError('Unexpected end of binary',this.pos);const out=this.bytes.subarray(this.pos,this.pos+size);this.pos+=size;return out;}
  byte(){return this.take(1)[0];}
  leb(bits=32,signed=false){
    const start=this.pos;let n=0n,shift=0n;
    for(let i=0;i<Math.ceil(bits/7);i++){
      const b=this.byte();n|=BigInt(b&127)<<shift;shift+=7n;
      if(!(b&128)){
        if(signed&&(b&64))n|=(-1n)<<shift;
        const min=signed?-(1n<<BigInt(bits-1)):0n,max=1n<<BigInt(signed?bits-1:bits);
        if(n<min||n>=max)throw new BinaryError(`LEB128 exceeds ${signed?'signed':'unsigned'} ${bits} bits`,start);
        return bits>53?n:Number(n);
      }
    }
    throw new BinaryError('Unterminated or oversized LEB128',start);
  }
  u32(){return Number(this.leb());}
}
const heaps=Object.freeze({func:-16,extern:-17,any:-18,eq:-19,i31:-20,struct:-21,array:-22,exn:-23,none:-15,nofunc:-13,noextern:-14,noexn:-12});
const heapNames=Object.fromEntries(Object.entries(heaps).map(([name,value])=>[value,name]));
const types=Object.freeze({i32:0x7f,i64:0x7e,f32:0x7d,f64:0x7c,v128:0x7b,funcref:0x70,externref:0x6f,anyref:0x6e,eqref:0x6d,i31ref:0x6c,structref:0x6b,arrayref:0x6a,exnref:0x69,nullref:0x71,nullfuncref:0x73,nullexternref:0x72,nullexnref:0x74});
const typeNames=Object.fromEntries(Object.entries(types).map(([name,value])=>[value,name]));
function integer(token,bits=32,signed=false){
  const s=String(token??'').replaceAll('_','');
  if(!/^[+-]?(?:0x[0-9a-f]+|\d+)$/i.test(s))throw new BinaryError(`Expected an integer, got ${token??'nothing'}`);
  const n=(s[0]==='-'?-1n:1n)*BigInt(s.replace(/^[+-]/,''));
  if(n<(signed?-(1n<<BigInt(bits-1)):0n)||n>=(1n<<BigInt(bits)))throw new BinaryError(`Integer out of ${bits}-bit range: ${token}`);
  return signed?BigInt.asIntN(bits,n):n;
}
function readHeap(r){const n=r.leb(33,true);if(n>=0)return `type:${n}`;if(heapNames[n]===undefined)throw new BinaryError(`Unknown heap type ${n}`,r.pos);return heapNames[n];}
function encodeHeap(token){const s=String(token).toLowerCase();if(s in heaps)return signedLEB(heaps[s],33);if(s.startsWith('type:'))return signedLEB(integer(s.slice(5)),33);throw new BinaryError(`Unknown heap type ${token}`);}
export function readValueType(r){const b=r.byte();if(typeNames[b])return typeNames[b];if(b===0x63||b===0x64)return `ref:${b===0x63?'null':'nonnull'}:${readHeap(r)}`;throw new BinaryError(`Unknown value type 0x${b.toString(16)}`,r.pos-1);}
function encodeType(token){
  const s=String(token).toLowerCase();if(types[s]!==undefined)return [types[s]];
  const m=/^ref:(null|nonnull):(.+)$/.exec(s);if(m)return [m[1]==='null'?0x63:0x64,...encodeHeap(m[2])];
  throw new BinaryError(`Unknown value type ${token}`);
}
function readBlock(r){
  const at=r.pos,b=r.byte();if(b===0x40)return 'void';if(typeNames[b]||b===0x63||b===0x64){r.pos=at;return readValueType(r);}
  r.pos=at;const index=r.leb(33,true);if(index<0)throw new BinaryError('Invalid block type',at);return `type:${index}`;
}
function encodeBlock(token){const s=String(token).toLowerCase();return s==='void'?[0x40]:s.startsWith('type:')?signedLEB(integer(s.slice(5)),33):encodeType(s);}
function floatBytes(token,bits){
  const text=String(token),raw=/^bits:0x([0-9a-f]+)$/i.exec(text);
  const bytes=new Uint8Array(bits/8),view=new DataView(bytes.buffer);
  if(raw){if(raw[1].length!==bits/4)throw new BinaryError(`Expected ${bits/4} hex digits in float bit pattern`);if(bits===32)view.setUint32(0,Number(BigInt('0x'+raw[1])),true);else view.setBigUint64(0,BigInt('0x'+raw[1]),true);}
  else{
    let value;if(/^[+-]?nan$/i.test(text))value=NaN;else if(/^\+?inf(?:inity)?$/i.test(text))value=Infinity;else if(/^-inf(?:inity)?$/i.test(text))value=-Infinity;
    else{if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))throw new BinaryError(`Invalid floating-point constant ${text}`);value=Number(text);}
    if(bits===32)view.setFloat32(0,value,true);else view.setFloat64(0,value,true);
  }return [...bytes];
}
function readFloat(r,bits){const bytes=r.take(bits/8),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const n=bits===32?BigInt(view.getUint32(0,true)):view.getBigUint64(0,true);return `bits:0x${n.toString(16).padStart(bits/4,'0')}`;}
function maxLane(rule){const shape=/^[if]\d+x(\d+)/.exec(rule.wasm);return shape?Number(shape[1]):16/rule.width;}
function checkLane(rule,n){if(n>=maxLane(rule))throw new BinaryError(`Lane index must be below ${maxLane(rule)}`);return n;}
function readMemarg(r,rule){const flags=r.u32();if(flags>=128)throw new BinaryError('Invalid memory alignment flags',r.pos);const memory=flags&64?r.u32():0,align=flags&63;if(align>Math.log2(rule.width))throw new BinaryError('Alignment exceeds natural alignment',r.pos);return [String(r.leb(64)),String(align),String(memory)];}
function encodeMemarg(args,rule){const offset=integer(args[0]??0,64),align=Number(integer(args[1]??Math.log2(rule.width))),memory=Number(integer(args[2]??0));if(align>Math.log2(rule.width))throw new BinaryError('Alignment exceeds natural alignment');if(rule.prefix===0xfe&&align!==Math.log2(rule.width))throw new BinaryError('Atomic memory operations require natural alignment');return [...unsignedLEB(align|(memory?64:0)),...(memory?unsignedLEB(memory):[]),...unsignedLEB(offset,64)];}

/** All operands are flat tokens. No parentheses or host execution are involved.
 * @param {string} name @param {Array<string|number|bigint>} args */
export function encodeInstruction(name,args=[]){
  const rule=INSTRUCTION_NAMES[String(name).toUpperCase()];if(!rule)throw new BinaryError(`Unknown instruction ${name}`);
  const tokens=args.map(String),out=rule.prefix?[rule.prefix,...unsignedLEB(rule.opcode)]:[rule.opcode];let at=0;
  const next=()=>{if(at>=tokens.length)throw new BinaryError(`${rule.name} is missing an operand`);return tokens[at++];};
  const uint=()=>unsignedLEB(integer(next()));
  for(const kind of rule.encoding.split(' ').filter(Boolean)){
    if(kind==='u32')out.push(...uint());
    else if(kind==='s32'||kind==='s64'){const bits=Number(kind.slice(1));out.push(...signedLEB(integer(next(),bits,true),bits));}
    else if(kind==='f32'||kind==='f64')out.push(...floatBytes(next(),Number(kind.slice(1))));
    else if(kind==='heap')out.push(...encodeHeap(next()));
    else if(kind==='block')out.push(...encodeBlock(tokens.length?next():'void'));
    else if(kind==='zero')out.push(0);
    else if(kind==='v128'){const value=next();if(!/^0x[0-9a-f]{32}$/i.test(value))throw new BinaryError('V128CONST expects 0x followed by 16 bytes in memory order');out.push(...value.slice(2).match(/../g).map(x=>parseInt(x,16)));}
    else if(kind==='shuffle'){for(let i=0;i<16;i++){const lane=Number(integer(next(),8));if(lane>31)throw new BinaryError('Shuffle index must be below 32');out.push(lane);}}
    else if(kind==='lane')out.push(checkLane(rule,Number(integer(next(),8))));
    else if(kind==='memarg'){const trailing=rule.encoding.endsWith(' lane')?1:0,count=Math.min(3,tokens.length-at-trailing);if(count<0)throw new BinaryError('Missing lane operand');out.push(...encodeMemarg(tokens.slice(at,at+count),rule));at+=count;}
    else if(kind==='brtable'){if(at===tokens.length)throw new BinaryError('BRTABLE needs at least a default label');out.push(...unsignedLEB(tokens.length-at-1));while(at<tokens.length)out.push(...uint());}
    else if(kind==='types'){out.push(...unsignedLEB(tokens.length-at));while(at<tokens.length)out.push(...encodeType(next()));}
    else if(kind==='cast'){const flags=Number(integer(next(),8));if(flags>3)throw new BinaryError('Cast flags must be 0..3');out.push(flags,...uint(),...encodeHeap(next()),...encodeHeap(next()));}
    else if(kind==='trytable'){
      out.push(...encodeBlock(next()),...unsignedLEB(tokens.length-at));
      while(at<tokens.length){const [name,...operands]=next().split(':'),tag=['catch','catch_ref','catch_all','catch_all_ref'].indexOf(name);if(tag<0||operands.length!==(tag<2?2:1))throw new BinaryError('Invalid TRYTABLE catch operand');out.push(tag);for(const operand of operands)out.push(...unsignedLEB(integer(operand)));}
    }else throw new BinaryError(`Unimplemented immediate schema ${kind}`);
  }
  if(at!==tokens.length)throw new BinaryError(`${rule.name} has unexpected operands`);
  return Uint8Array.from(out);
}
/** @param {BinaryReader} reader */
export function decodeInstruction(reader){
  const start=reader.pos,first=reader.byte(),prefix=first>=0xfb&&first<=0xfe?first:0,opcode=prefix?reader.u32():first;
  const rule=INSTRUCTION_OPCODES[prefix+':'+opcode];if(!rule)throw new BinaryError(`Unknown opcode ${prefix?'0x'+prefix.toString(16)+':':''}0x${opcode.toString(16)}`,start);
  const args=[];
  for(const kind of rule.encoding.split(' ').filter(Boolean)){
    if(kind==='u32')args.push(String(reader.u32()));
    else if(kind==='s32'||kind==='s64')args.push(String(reader.leb(Number(kind.slice(1)),true)));
    else if(kind==='f32'||kind==='f64')args.push(readFloat(reader,Number(kind.slice(1))));
    else if(kind==='heap')args.push(readHeap(reader));
    else if(kind==='block')args.push(readBlock(reader));
    else if(kind==='zero'){if(reader.byte()!==0)throw new BinaryError('ATOMICFENCE requires a zero reserved byte',reader.pos-1);}
    else if(kind==='v128')args.push('0x'+[...reader.take(16)].map(b=>b.toString(16).padStart(2,'0')).join(''));
    else if(kind==='shuffle'){for(const n of reader.take(16)){if(n>31)throw new BinaryError('Shuffle index exceeds 31',reader.pos-1);args.push(String(n));}}
    else if(kind==='lane')args.push(String(checkLane(rule,reader.byte())));
    else if(kind==='memarg')args.push(...readMemarg(reader,rule));
    else if(kind==='brtable'){const count=reader.u32();if(count>=reader.end-reader.pos)throw new BinaryError('BRTABLE count exceeds remaining bytes',reader.pos);for(let i=0;i<=count;i++)args.push(String(reader.u32()));}
    else if(kind==='types'){const count=reader.u32();if(count>reader.end-reader.pos)throw new BinaryError('SELECTT count exceeds remaining bytes',reader.pos);for(let i=0;i<count;i++)args.push(readValueType(reader));}
    else if(kind==='cast'){const flags=reader.byte();if(flags>3)throw new BinaryError('Invalid cast flags',reader.pos-1);args.push(String(flags),String(reader.u32()),readHeap(reader),readHeap(reader));}
    else if(kind==='trytable'){
      args.push(readBlock(reader));const count=reader.u32();if(count>reader.end-reader.pos)throw new BinaryError('TRYTABLE count exceeds remaining bytes',reader.pos);
      for(let i=0;i<count;i++){const tag=reader.byte();if(tag>3)throw new BinaryError('Invalid catch kind',reader.pos-1);const operands=tag<2?[reader.u32(),reader.u32()]:[reader.u32()];args.push(['catch','catch_ref','catch_all','catch_all_ref'][tag]+':'+operands.join(':'));}
    }
  }
  return {rule,name:rule.name,args,offset:start,end:reader.pos,bytes:reader.bytes.subarray(start,reader.pos),text:rule.name+(args.length?' '+args.join(' '):'')};
}
