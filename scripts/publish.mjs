// Publish the CLI and the repository/Workshop source package in a fixed order.
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const npm=process.env.npm_execpath;
if(!npm)throw new Error('Run with npm run publish:all');
const extra=process.argv.slice(2);
if(extra.some(arg=>arg!=='--dry-run'))throw new Error('The supported optional argument is --dry-run');
const repository=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const cli=JSON.parse(await readFile(new URL('../packages/cli/package.json',import.meta.url),'utf8'));
if(repository.private||cli.private)throw new Error('Both publication targets must be public npm packages');
if(repository.version!==cli.version)throw new Error(`Versions differ: ${repository.name}@${repository.version}, ${cli.name}@${cli.version}. Bump both before publishing.`);
function run(args){const r=spawnSync(process.execPath,[npm,...args],{cwd:root,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
run(['run','check']);
// check has already built and tested the exact files, including the npm archive.
run(['publish','--workspace','packages/cli','--access','public','--ignore-scripts',...extra]);
run(['publish','--workspaces=false','--access','public','--ignore-scripts',...extra]);
