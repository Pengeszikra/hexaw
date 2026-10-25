import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.env.npm_execpath)throw new Error('Publish through npm');
const r=spawnSync(process.execPath,[process.env.npm_execpath,'run','check'],{cwd:root,stdio:'inherit'});
if(r.error)throw r.error;
process.exitCode=r.status??1;
