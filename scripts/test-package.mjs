// Verify the actual publishable archive in a fresh, offline consumer project.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileHEXAW} from '../packages/cli/dist/core/hexaw-core.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const npmPath=process.env.npm_execpath;
if(!npmPath)throw new Error('Run with npm run test:package');
function run(command,args,cwd=root,options={}){
  const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000,...options});
  if(r.error)throw r.error;
  assert.equal(r.status,0,`${command} ${args.join(' ')}\n${r.stdout||''}\n${r.stderr||''}`);
  return (r.stdout||'').trim();
}
await mkdir(join(root,'artifacts'),{recursive:true});
const packed=JSON.parse(run(process.execPath,[npmPath,'pack','--workspace','packages/cli','--ignore-scripts','--json','--pack-destination',join(root,'artifacts')]));
assert.equal(packed.length,1);
const pkg=packed[0];assert.equal(pkg.name,'hexaw');
const files=pkg.files.map(f=>f.path);
for(const path of ['dist/cli.js','dist/index.js','dist/index.d.ts','dist/dump.js','dist/core/hexaw-core.js','dist/core/hexaw-core.d.ts','dist/build-info.json','README.md','LICENSE'])assert.ok(files.includes(path),`Missing ${path}`);
assert.ok(files.every(p=>!p.startsWith('src/')&&!p.startsWith('node_modules/')&&!p.startsWith('workshop/')));
assert.equal(pkg.bundled.length,0);
const temporary=await mkdtemp(join(tmpdir(),'hexaw-package-'));
try{
  await writeFile(join(temporary,'package.json'),JSON.stringify({private:true,type:'module'}));
  const archive=join(root,'artifacts',pkg.filename);
  run(process.execPath,[npmPath,'install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',archive],temporary);
  assert.equal(run(process.execPath,[npmPath,'exec','--offline','--','hexaw','--version'],temporary),pkg.version);
  const source='EXP "add" 0\nFN 0\nPAR 0\nPAR 1\nRES\nGET 0\nGET 1\nADD\nRET\nEND';
  const original=compileHEXAW(source).bytes;
  const wasm=join(temporary,'add.wasm');await writeFile(wasm,original);
  const bin=join(temporary,'node_modules/hexaw/dist/cli.js');
  const dumped=run(process.execPath,[bin,wasm],temporary);assert.match(dumped,/6A\s+: ADD/);
  const text=run(process.execPath,[bin,'dump',wasm,'--source'],temporary);assert.match(text,/FN 00/);
  const recovered=join(temporary,'recovered.hexaw');await writeFile(recovered,text);
  const rebuilt=join(temporary,'rebuilt.wasm');run(process.execPath,[bin,'assemble',recovered,'-o',rebuilt],temporary);
  assert.deepEqual(await readFile(rebuilt),Buffer.from(original));
  const json=JSON.parse(run(process.execPath,[bin,'dump','-','--json'],temporary,{input:Buffer.from(original)}));
  assert.equal(json.size,original.length);assert.equal(json.decoded,true);
  const api='import {dumpWasm,compileHEXAW,hexawContext,inspectWasm} from "hexaw"; import {Debugger} from "hexaw/core"; const p=compileHEXAW("FN 0\\nRES\\nCONST 42\\nEND"); if(new Debugger(p.decoded).run().result[0].value!==42)throw Error("result"); if(!dumpWasm(p.bytes).includes("CONST 42"))throw Error("dump"); if(!inspectWasm(p.bytes).decoded)throw Error("decode"); console.log("API OK")';
  assert.equal(run(process.execPath,['--input-type=module','-e',api],temporary),'API OK');
  const info=JSON.parse(await readFile(join(temporary,'node_modules/hexaw/dist/build-info.json'),'utf8'));
  assert.equal(info.compiler,'@pengeszikra/typescript');assert.equal(info.compilerVersion,'7.1.0-pipeline.1');
  console.log(`PASS ${pkg.name}@${pkg.version}: ${pkg.files.length} packaged files, offline installation, npm executable, CLI dump, source round trip, stdin JSON, public API and TS+|> build identity.`);
  console.log(`Archive: ${archive}`);
}finally{await rm(temporary,{recursive:true,force:true});}
