#!/usr/bin/env node
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname,join,resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dumpWasm} from './dump.js';
import type {DumpFormat} from './dump.js';
import {assembleWasm} from './assemble.js';

const HELP=`HEXAW — WebAssembly, close to the bytes.

Usage:
  hexaw [dump] <file.wasm|-> [options]
  hexaw -b <file.hexaw|-> [-o <file.wasm|->]
  hexaw assemble <file.hexaw|-> -o <file.wasm|->

Dump options:
  -b, --bin                Assemble HEXAW to a WASM binary (default: stdout)
  -o, --output <file>       Write a file instead of stdout
  -f, --format <format>    dump (default), source, json, hex
      --source             Emit editable HEXAW, without byte columns
      --json               Emit machine-readable, lossless byte records
      --code-only          List decoded instructions only
      --strict             Fail instead of preserving unsupported code as RAW
      --no-color           Accepted; output is always plain text
  -h, --help               Show this help
  -V, --version            Print the package version

Examples:
  hexaw add.wasm
  hexaw dump add.wasm --source > add.hexaw
  cat add.wasm | hexaw dump - --json
  hexaw assemble add.hexaw -o add.wasm
  hexaw -b add.hexaw -o add.wasm
  hexaw --bin add.hexaw > add.wasm

The opcode table covers Core Wasm 3.0, threads/atomics and legacy exceptions.
Both compact FN source and WASM 1 binary-layout source can be assembled.
Native validation requires this Node.js engine to support the module's features.
Validation never instantiates or executes the input program.
`;
class UsageError extends Error {}
interface Options {command:'dump'|'assemble';input:string;output:string|null;format:DumpFormat;codeOnly:boolean;strict:boolean}
function parseArgs(args:string[]):Options|'help'|'version' {
  if(args.length===0) return 'help';
  const opts:Options={command:'dump',input:'',output:null,format:'dump',codeOnly:false,strict:false};
  let explicitCommand=false,endOptions=false,binary=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(!endOptions&&arg==='--'){endOptions=true;continue;}
    if(!endOptions&&(arg==='-h'||arg==='--help')) return 'help';
    if(!endOptions&&(arg==='-V'||arg==='--version')) return 'version';
    if(!endOptions&&(arg==='-b'||arg==='--bin')){binary=true;continue;}
    if(!endOptions&&(arg==='-o'||arg==='--output'||arg==='-f'||arg==='--format')){
      const value=args[++i];if(!value)throw new UsageError(`${arg} needs a value`);
      if(arg==='-o'||arg==='--output')opts.output=value;
      else{if(!['dump','source','json','hex'].includes(value))throw new UsageError(`Unknown format ${value}`);opts.format=value as DumpFormat;}
      continue;
    }
    if(!endOptions&&arg==='--source'){opts.format='source';continue;}
    if(!endOptions&&arg==='--json'){opts.format='json';continue;}
    if(!endOptions&&arg==='--code-only'){opts.codeOnly=true;continue;}
    if(!endOptions&&arg==='--strict'){opts.strict=true;continue;}
    if(!endOptions&&arg==='--no-color')continue;
    if(!endOptions&&arg!=='-'&&arg.startsWith('-'))throw new UsageError(`Unknown option ${arg}`);
    if(!endOptions&&!opts.input&&!explicitCommand&&(arg==='dump'||arg==='assemble')){opts.command=arg;explicitCommand=true;continue;}
    if(opts.input)throw new UsageError(`Unexpected argument ${arg}`);
    opts.input=arg;
  }
  if(!opts.input)throw new UsageError('Provide an input filename, or - for stdin');
  if(binary){if(explicitCommand&&opts.command==='dump')throw new UsageError('--bin cannot be combined with the dump command');opts.command='assemble';}
  if(opts.command==='assemble'&&!opts.output&&!binary)throw new UsageError('assemble requires -o <file.wasm|->');
  if(opts.command==='assemble'&&(opts.format!=='dump'||opts.codeOnly||opts.strict))throw new UsageError('Dump formatting options do not apply to assemble');
  if(opts.command==='dump'&&opts.codeOnly&&opts.format!=='dump'&&opts.format!=='json')throw new UsageError('--code-only applies to dump or json output');
  if(opts.input!=='-'&&opts.output&&opts.output!=='-'&&resolve(opts.input)===resolve(opts.output))throw new UsageError('Input and output must be different files');
  return opts;
}
async function readInput(path:string):Promise<Uint8Array>{
  if(path!=='-'){
    const bytes=await readFile(path);if(bytes.length>64*1024*1024)throw new Error('Input limit: 64 MiB');return bytes;
  }
  if(process.stdin.isTTY)throw new UsageError('Pipe input to stdin when using -');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>64*1024*1024)throw new Error('Input limit: 64 MiB');chunks.push(bytes);}
  return Buffer.concat(chunks);
}
async function writeOutput(path:string|null,data:string|Uint8Array):Promise<void>{
  if(!path||path==='-'){await new Promise<void>((ok,fail)=>process.stdout.write(data,error=>error?fail(error):ok()));return;}
  const destination=resolve(path),temporary=join(dirname(destination),`.${basename(destination)}.${randomUUID()}.tmp`);
  try{await writeFile(temporary,data,{flag:'wx'});await rename(temporary,destination);}
  catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
async function main():Promise<void>{
  const options=process.argv.slice(2) |> parseArgs;
  if(options==='help'){process.stdout.write(HELP);return;}
  if(options==='version'){const pkg=JSON.parse(await readFile(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')) as {version:string};process.stdout.write(pkg.version+'\n');return;}
  const bytes=await readInput(options.input);
  if(options.command==='assemble'){
    let source:string;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('HEXAW input must be UTF-8 text');}
    const output=source |> assembleWasm;
    await writeOutput(options.output,output);
  }else{
    const output=bytes |> ((input)=>dumpWasm(input,{format:options.format,codeOnly:options.codeOnly,strict:options.strict}));
    await writeOutput(options.output,output);
  }
}
process.stdout.on('error',(error:NodeJS.ErrnoException)=>{if(error.code==='EPIPE')process.exit(0);});
main().catch((error:unknown)=>{
  const e=error as Error & {code?:string;line?:number};
  if(e.code==='EPIPE')return;
  process.stderr.write(`hexaw: ${e.line?`line ${e.line}: `:''}${e.message}\n`);
  process.exitCode=error instanceof UsageError?2:1;
});
