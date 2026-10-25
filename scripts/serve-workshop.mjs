// Static local development server. No dependencies, build or external services.
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.PORT||8080);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/'||pathname==='/workshop'){res.writeHead(302,{Location:'/workshop/'});res.end();return;}
    const path=resolve(root,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
    if(!path.startsWith(root.endsWith(sep)?root:root+sep)||pathname.split('/').some(x=>x.startsWith('.'))){res.writeHead(404);res.end('Not found');return;}
    if(!(await stat(path)).isFile())throw new Error('Not found');
    res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(await readFile(path));
  }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`HEXAW Workshop: http://127.0.0.1:${port}/workshop/`));
