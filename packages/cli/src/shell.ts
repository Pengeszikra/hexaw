import {createInterface} from 'node:readline';
import {HexawSession,SHELL_COMMANDS,SHELL_HELP} from './session.js';

export async function runShell(initialPath?:string):Promise<number>{
  const session=new HexawSession(),terminal=!!(process.stdin.isTTY&&process.stdout.isTTY);
  process.stdout.write('HEXAW interactive monitor · ? help · D dump · U unassemble · CALL prepare VM · Q quit\n');
  if(initialPath){process.stdout.write(await session.load(initialPath)+'\n');process.stdout.write((await session.execute('D')).text+'\n');}
  const rl=createInterface({input:process.stdin,output:process.stdout,terminal,historySize:500,removeHistoryDuplicates:true,crlfDelay:Infinity,
    completer(line:string):[string[],string]{const prefix=line.toUpperCase();return [SHELL_COMMANDS.filter(command=>command.startsWith(prefix)),line];}});
  const prompt=()=>{if(terminal){rl.setPrompt(session.dirty?'hexaw*> ':'hexaw> ');rl.prompt();}};
  let hadErrors=false;
  const interrupt=()=>{if(session.busy)session.interrupt();else rl.close();};
  const keypress=(_text:string,key:{name?:string})=>{if(key?.name==='f1'&&!session.busy){process.stdout.write('\n'+SHELL_HELP);prompt();}};
  rl.on('SIGINT',interrupt);process.on('SIGINT',interrupt);if(terminal)process.stdin.on('keypress',keypress);
  try{
    prompt();
    for await(const line of rl){
      try{const result=await session.execute(line);if(result.text)process.stdout.write(result.text.replace(/\n?$/,'\n'));if(result.quit)break;}
      catch(error){hadErrors=true;process.stderr.write(`hexaw: ${(error as Error).message}\n`);}
      prompt();
    }
  }finally{rl.close();process.off('SIGINT',interrupt);if(terminal)process.stdin.off('keypress',keypress);}
  return !terminal&&hadErrors?1:0;
}
