import {BinaryError,BinaryReader,decodeInstruction,encodeInstruction,readValueType,unsignedLEB} from './instruction-codec.js';

/** @typedef {ReturnType<typeof decodeInstruction> & {depth:number}} BinaryInstruction */
/** @typedef {{offset:number,end:number,sizeEncoding:Uint8Array,locals:Uint8Array,ops:BinaryInstruction[],tail:Uint8Array|null}} BinaryBody */
/** @typedef {{id:number,offset:number,payload:number,end:number,sizeEncoding:Uint8Array,countEncoding?:Uint8Array,bodies:BinaryBody[]}} BinarySection */
/** @typedef {{offset:number,bytes:number[],kind:string,section:string,owner:string,text:string,depth:number}} BinaryRecord */
/** @typedef {{bytes:Uint8Array,sections:BinarySection[],records:BinaryRecord[],diagnostics:string[],fullyDecoded:boolean}} BinaryModule */

export const SECTION_NAMES=Object.freeze(['custom','type','import','function','table','memory','global','export','start','element','code','data','data-count','tag']);
const header=Uint8Array.from([0,97,115,109,1,0,0,0]);
const hex=bytes=>[...bytes].map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join('');
function concat(parts){const size=parts.reduce((n,p)=>n+p.length,0);if(size>64*1024*1024)throw new BinaryError('Binary output limit: 64 MiB');const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return bytes;}
function parseHex(tokens){const text=tokens.join('');if(text.length%2||!/^[0-9a-f]*$/i.test(text))throw new BinaryError('BYTES expects pairs of hexadecimal digits');return Uint8Array.from(text.match(/../g)||[],x=>parseInt(x,16));}
function preservedSize(size,original){if(original?.length){try{const r=new BinaryReader(original);if(r.u32()===size&&r.pos===r.end)return original;}catch{}}return unsignedLEB(size);}
function chunkRecords(bytes,start,end,section,owner,text){const out=[];for(let offset=start;offset<end;offset+=16)out.push({offset,bytes:[...bytes.subarray(offset,Math.min(offset+16,end))],kind:'raw',section,owner,text,depth:0});return out;}

/** Decode every known opcode while retaining uninterpreted section payloads verbatim.
 * @param {Uint8Array|ArrayBuffer} input @returns {BinaryModule} */
export function decodeBinary(input){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length>64*1024*1024)throw new BinaryError('Binary input limit: 64 MiB');
  const r=new BinaryReader(bytes);if(!r.take(8).every((b,i)=>b===header[i]))throw new BinaryError('Invalid core WebAssembly header',0);
  const sections=[],records=[{offset:0,bytes:[...bytes.subarray(0,4)],kind:'magic',section:'header',owner:'module',text:'MAGIC "\\0asm"',depth:0},{offset:4,bytes:[...bytes.subarray(4,8)],kind:'version',section:'header',owner:'module',text:'VERSION 1',depth:0}],diagnostics=[];
  while(r.pos<r.end){
    const offset=r.pos,id=r.byte(),lengthStart=r.pos,length=r.u32(),payload=r.pos,end=payload+length;
    if(id>13)throw new BinaryError(`Unknown section ${id}`,offset);
    const s=new BinaryReader(bytes,payload,end),name=SECTION_NAMES[id],section={id,offset,payload,end,sizeEncoding:bytes.subarray(lengthStart,payload),bodies:[]};r.pos=end;sections.push(section);
    records.push({offset,bytes:[id],kind:'section',section:name,owner:'module',text:`SECTION ${name.toUpperCase()}`,depth:0},{offset:lengthStart,bytes:[...section.sizeEncoding],kind:'uleb128',section:name,owner:'module',text:`SIZE ${length}`,depth:0});
    if(id!==10){for(const record of chunkRecords(bytes,payload,end,name,'module',`${name.toUpperCase()} PAYLOAD`))records.push(record);continue;}
    const count=s.u32();if(count>s.end-s.pos)throw new BinaryError('Function body count exceeds code section',s.pos);
    section.countEncoding=bytes.subarray(payload,s.pos);
    records.push({offset:payload,bytes:[...section.countEncoding],kind:'uleb128',section:name,owner:'module',text:`BODY COUNT ${count}`,depth:0});
    for(let i=0;i<count;i++){
      const sizeAt=s.pos,size=s.u32(),bodyStart=s.pos,bodyEnd=bodyStart+size;if(bodyEnd>s.end)throw new BinaryError('Function body exceeds code section',sizeAt);
      const bodyReader=new BinaryReader(bytes,bodyStart,bodyEnd),owner=`body${String(i).padStart(2,'0')}`,groups=bodyReader.u32();if(groups>bodyReader.end-bodyReader.pos)throw new BinaryError('Local group count exceeds body',bodyReader.pos);
      for(let j=0;j<groups;j++){bodyReader.u32();readValueType(bodyReader);}
      const body={offset:bodyStart,end:bodyEnd,sizeEncoding:bytes.subarray(sizeAt,bodyStart),locals:bytes.subarray(bodyStart,bodyReader.pos),ops:[],tail:null};section.bodies.push(body);s.pos=bodyEnd;
      records.push({offset:sizeAt,bytes:[...body.sizeEncoding],kind:'uleb128',section:name,owner,text:`BODY ${i} SIZE ${size}`,depth:0},...chunkRecords(bytes,bodyStart,bodyReader.pos,name,owner,`BODY ${i} LOCALS`));
      let depth=0,finished=false;
      while(bodyReader.pos<bodyReader.end){
        const at=bodyReader.pos;
        try{
          if(finished)throw new BinaryError('Instructions after function END',at);
          const op=decodeInstruction(bodyReader),code=op.rule.prefix?null:op.rule.opcode;
          if(code===11){if(depth)depth--;else finished=true;}
          else if(code===24){if(!depth)throw new BinaryError('DELEGATE outside a block',at);depth--;}
          op.depth=[5,7,25].includes(code)?Math.max(0,depth-1):depth;
          body.ops.push(op);records.push({offset:op.offset,bytes:[...op.bytes],kind:'instruction',section:name,owner,text:op.text,depth:op.depth});
          if([2,3,4,6,31].includes(code))depth++;
        }catch(error){
          const message=`Body ${i}, offset 0x${at.toString(16)}: ${error.message}`;diagnostics.push(message);body.tail=bytes.subarray(at,bodyEnd);for(const record of chunkRecords(bytes,at,bodyEnd,name,owner,'RAW · '+message))records.push(record);bodyReader.pos=bodyEnd;
        }
      }
      if(!body.tail&&!finished)throw new BinaryError('Function body has no final END',bodyEnd);
    }
    if(s.pos!==s.end)throw new BinaryError('Unconsumed code section bytes',s.pos);
  }
  return {bytes,sections,records,diagnostics,fullyDecoded:diagnostics.length===0};
}

/** The layout form preserves metadata and exact encodings alongside editable mnemonics.
 * @param {BinaryModule} module */
export function disassembleBinary(module){
  const lines=['; HEXAW binary layout · editable instructions, original section payloads','WASM 1'];
  for(const section of module.sections){
    lines.push('',`SECTION ${SECTION_NAMES[section.id].toUpperCase()} ${hex(section.sizeEncoding)}`);
    if(section.id!==10){for(let at=section.payload;at<section.end;at+=32)lines.push('  BYTES '+hex(module.bytes.subarray(at,Math.min(at+32,section.end))));}
    else{
      lines.push('  COUNT '+hex(section.countEncoding));
      for(const body of section.bodies){
        lines.push(`  BODY ${hex(body.locals)} ${hex(body.sizeEncoding)}`);
        for(const op of body.ops)lines.push('    '+'  '.repeat(op.depth)+op.text+' ; @encoding '+hex(op.bytes));
        if(body.tail)for(let at=0;at<body.tail.length;at+=32)lines.push('    BYTES '+hex(body.tail.subarray(at,at+32)));
        lines.push('  ENDBODY');
      }
    }lines.push('ENDSECTION');
  }return lines.join('\n')+'\n';
}
/** @param {string} source */
export function isBinarySource(source){return /^\s*WASM\s+/im.test(source.replace(/;[^\n]*|\/\/[^\n]*/g,''));}
/** @param {string} source */
export function assembleBinary(source){
  let started=false,section=null,body=null;const sections=[];
  const flushBody=()=>{const bytes=concat([body.locals,...body.parts]);section.parts.push(concat([preservedSize(bytes.length,body.sizeEncoding),bytes]));body=null;section.bodyCount++;};
  for(const [index,raw] of source.split(/\r?\n/).entries()){
    const line=index+1,text=raw.replace(/;.*$|\/\/.*$/,'').trim();if(!text)continue;
    const [head,...args]=text.split(/\s+/),name=head.toUpperCase();
    try{
      if(!started){if(name!=='WASM'||args.length!==1||args[0]!=='1')throw new BinaryError('Binary layout must start with WASM 1');started=true;continue;}
      if(name==='SECTION'){
        if(section||args.length<1||args.length>2)throw new BinaryError('SECTION needs a name and optional original size encoding');
        const id=/^\d+$/.test(args[0])?Number(args[0]):SECTION_NAMES.indexOf(args[0].toLowerCase());if(id<0||id>13)throw new BinaryError('Unknown section name');
        section={id,parts:[],bodyCount:0,sizeEncoding:args[1]?parseHex([args[1]]):null,countEncoding:null};continue;
      }
      if(!section)throw new BinaryError('Expected SECTION');
      if(name==='ENDSECTION'){
        if(args.length||body)throw new BinaryError('Close BODY with ENDBODY before ENDSECTION');
        const payload=concat(section.id===10?[preservedSize(section.bodyCount,section.countEncoding),...section.parts]:section.parts);
        sections.push(concat([[section.id],preservedSize(payload.length,section.sizeEncoding),payload]));section=null;continue;
      }
      if(name==='COUNT'){
        if(section.id!==10||body||section.countEncoding||section.bodyCount||args.length!==1)throw new BinaryError('COUNT belongs before code bodies');
        section.countEncoding=parseHex(args);const r=new BinaryReader(section.countEncoding);r.u32();if(r.pos!==r.end)throw new BinaryError('COUNT must be one LEB128 encoding');continue;
      }
      if(name==='BODY'){
        if(section.id!==10||body||args.length<1||args.length>2)throw new BinaryError('BODY needs local declaration bytes and optional original size encoding');
        body={locals:parseHex([args[0]]),sizeEncoding:args[1]?parseHex([args[1]]):null,parts:[]};continue;
      }
      if(name==='ENDBODY'){if(!body||args.length)throw new BinaryError('Unmatched ENDBODY');flushBody();continue;}
      if(name==='BYTES'){if(!args.length)throw new BinaryError('BYTES requires hex data');if(section.id===10&&!body)throw new BinaryError('Code bytes belong inside BODY');(body||section).parts.push(parseHex(args));continue;}
      if(!body)throw new BinaryError('Instructions belong inside BODY');
      let encoded=encodeInstruction(name,args);
      const saved=/;\s*@encoding\s+([0-9a-f]+)\s*$/i.exec(raw);
      if(saved){
        const original=parseHex([saved[1]]);
        try{const r=new BinaryReader(original),op=decodeInstruction(r),canonical=encodeInstruction(op.name,op.args);if(r.pos===r.end&&canonical.length===encoded.length&&canonical.every((b,i)=>b===encoded[i]))encoded=original;}catch{}
      }
      body.parts.push(encoded);
    }catch(error){throw new BinaryError(error.message,error.offset??null,line);}
  }
  if(!started||section||body)throw new BinaryError('Incomplete binary layout');
  const bytes=concat([header,...sections]);decodeBinary(bytes);return bytes;
}
