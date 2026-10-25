import {createInterface} from 'node:readline';
import {HexawSession} from './session.js';

export async function runShell(initialPath?:string):Promise<number>{
  const session=new HexawSession(),terminal=!!(process.stdin.isTTY&&process.stdout.isTTY);
  process.stdout.write('HEXAW interactive monitor · ? help · D dump · U unassemble · A assemble · CALL prepare VM · Q quit\n');
  if(initialPath){process.stdout.write(await session.load(initialPath)+'\n');process.stdout.write((await session.execute('D')).text+'\n');}
  const rl=createInterface({input:process.stdin,output:process.stdout,terminal,historySize:500,removeHistoryDuplicates:true,crlfDelay:Infinity,
    completer(line:string):[string[],string]{const prefix=line.toUpperCase();return [session.completions.filter(command=>command.startsWith(prefix)),line];}});
  const prompt=(preserveCursor=false)=>{if(terminal){rl.setPrompt(session.prompt);rl.prompt(preserveCursor);}};
  let hadErrors=false;
  const cancel=()=>{rl.write(null,{ctrl:true,name:'u'});process.stdout.write('\n'+session.cancelAssembly()+'\n');prompt();};
  const interrupt=()=>{if(session.busy)session.interrupt();else if(session.assembling)cancel();else rl.close();};
  const keypress=(_text:string,key:{name?:string})=>{
    if(session.busy)return;
    if(key?.name==='f1'){process.stdout.write('\n'+session.help);prompt(true);}
    else if(key?.name==='escape'&&session.assembling)cancel();
    else if(key?.name==='f3'&&session.assembling){const instruction=session.originalInstruction;if(instruction!==null){rl.write(null,{ctrl:true,name:'u'});rl.write(instruction);}}
  };
  rl.on('SIGINT',interrupt);process.on('SIGINT',interrupt);if(terminal)process.stdin.on('keypress',keypress);
  try{
    prompt();
    for await(const line of rl){
      try{const result=await session.execute(line);if(result.text)process.stdout.write(result.text.replace(/\n?$/,'\n'));if(result.quit)break;}
      catch(error){hadErrors=true;process.stderr.write(`hexaw: ${(error as Error).message}\n`);}
      prompt();
    }
  }finally{
    if(session.assembling){if(session.assemblyPending)hadErrors=true;process.stdout.write(session.cancelAssembly('closed at EOF')+'\n');}
    rl.close();process.off('SIGINT',interrupt);if(terminal)process.stdin.off('keypress',keypress);
  }
  return !terminal&&hadErrors?1:0;
}
