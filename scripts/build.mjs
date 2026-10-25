// Build with Péter Vívó's TS+|> fork. Never fall back to stock tsc.
import {spawnSync} from 'node:child_process';
import {chmod,copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const cli=join(root,'packages/cli');
const compiler=join(root,'node_modules/@pengeszikra/typescript/bin/tspipe.mjs');
const result=spawnSync(process.execPath,[compiler,'--project',join(cli,'tsconfig.json')],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status||1);
await mkdir(join(root,'artifacts'),{recursive:true});
await copyFile(join(cli,'src/core/hexaw-core.d.ts'),join(cli,'dist/core/hexaw-core.d.ts'));
await copyFile(join(root,'LICENSE'),join(cli,'LICENSE'));
await chmod(join(cli,'dist/cli.js'),0o755);
const compilerPackage=JSON.parse(await readFile(join(root,'node_modules/@pengeszikra/typescript/package.json'),'utf8'));
const pkg=JSON.parse(await readFile(join(cli,'package.json'),'utf8'));
await writeFile(join(cli,'dist/build-info.json'),JSON.stringify({name:pkg.name,version:pkg.version,compiler:compilerPackage.name,compilerVersion:compilerPackage.version},null,2)+'\n');
console.log(`Built ${pkg.name}@${pkg.version} with ${compilerPackage.name}@${compilerPackage.version}`);
