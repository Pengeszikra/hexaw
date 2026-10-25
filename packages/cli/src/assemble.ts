import {compileHEXAW} from './core/hexaw-core.js';
import {assembleBinary,isBinarySource} from './core/binary-module.js';

/** Assemble either the compact FN syntax or the binary-layout syntax. */
export function assembleWasm(source:string):Uint8Array<ArrayBuffer> {
  const bytes=isBinarySource(source)?assembleBinary(source):compileHEXAW(source).bytes;
  // Compile/validate only: never instantiate or execute source code.
  try { new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>); }
  catch(error) { throw new Error(`WASM validation: ${error instanceof Error?error.message:String(error)}. This Node.js engine must support the features used by the module.`); }
  return bytes as Uint8Array<ArrayBuffer>;
}
