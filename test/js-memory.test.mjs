import test from 'node:test';
import assert from 'node:assert/strict';
import {compileHEXAW,decodeWASM,disassembleHEXAW} from '../packages/cli/src/core/hexaw-core.js';


test('EXPM exports linear memory as WebAssembly.Memory',()=>{
  const p=compileHEXAW(`MEM 1 2\nEXPM "memory"\nFN 0\n  RES\n  CONST 1\n  END\nEXP "one" 0\n`);
  const inst=new WebAssembly.Instance(p.nativeModule);
  assert.ok(inst.exports.memory instanceof WebAssembly.Memory);
  assert.equal(inst.exports.memory.buffer.byteLength,65536);
  assert.equal(inst.exports.memory.grow(1),1);
});

test('JS writes are visible to HEXAW functions',()=>{
  const p=compileHEXAW(`MEM 1\nEXPM "memory"\nFN 0\n  PAR 0\n  RES\n  GET 0\n  LOAD 0 2\n  END\nEXP "rd" 0\n`);
  const inst=new WebAssembly.Instance(p.nativeModule);
  new Int32Array(inst.exports.memory.buffer)[4]=1234;
  assert.equal(inst.exports.rd(16),1234);
});

test('typed and hex DATA',()=>{
  const p=compileHEXAW(`MEM 1\nEXPM "m"\nDATA 0 hex:000000000000F03F\nDATA 16 f64: 1.5 2.5\nDATA 32 i32: 1 -2 3\nDATA 48 u16: 1 2\nFN 0\n  END\n`);
  const dv=new DataView(new WebAssembly.Instance(p.nativeModule).exports.m.buffer);
  assert.equal(dv.getFloat64(0,true),1);
  assert.equal(dv.getFloat64(16,true),1.5);
  assert.equal(dv.getFloat64(24,true),2.5);
  assert.deepEqual([dv.getInt32(32,true),dv.getInt32(36,true),dv.getInt32(40,true)],[1,-2,3]);
  assert.equal(dv.getUint16(50,true),2);
});

test('EXPG exports a global',()=>{
  const p=compileHEXAW(`MEM 1\nDGLB 0 2.5\nGLB 1 7\nEXPG "scale" 0\nEXPG "count" 1\nFN 0\n  END\n`);
  const e=new WebAssembly.Instance(p.nativeModule).exports;
  assert.ok(e.scale instanceof WebAssembly.Global);
  assert.equal(e.scale.value,2.5);
  e.count.value=9;
  assert.equal(e.count.value,9);
});

test('round trip bytes → HEXAW → bytes',()=>{
  const src=`MEM 1 4\nDGLB 0 2.5\nDATA 0 hex:00FF10\nDATA 8 "hi"\nEXPG "g" 0\nEXPM "memory"\nFN 0\n  RES\n  CONST 1\n  END\nEXP "one" 0\n`;
  const a=compileHEXAW(src);
  const text=disassembleHEXAW(decodeWASM(a.bytes));
  assert.match(text,/EXPM "memory"/);
  assert.match(text,/EXPG "g" 0/);
  assert.match(text,/DATA 0 hex:00FF10/);
  const e=new WebAssembly.Instance(compileHEXAW(text).nativeModule).exports;
  assert.ok(e.memory instanceof WebAssembly.Memory);
  assert.equal(e.g.value,2.5);
});

test('errors',()=>{
  assert.throws(()=>compileHEXAW(`EXPM "m"\nFN 0\n  END\n`),/needs a MEM/);
  assert.throws(()=>compileHEXAW(`MEM 1\nEXPM "m"\nEXPM "m"\nFN 0\n  END\n`),/Duplicate/);
  assert.throws(()=>compileHEXAW(`MEM 1\nEXPG "g" 3\nFN 0\n  END\n`),/missing global/);
  assert.throws(()=>compileHEXAW(`MEM 1\nDATA 0 hex:ABC\nFN 0\n  END\n`),/even/);
  assert.throws(()=>compileHEXAW(`MEM 1\nDATA 0 q9: 1\nFN 0\n  END\n`),/Unknown DATA type/);
});
