import {createInterface,cursorTo,moveCursor,clearScreenDown} from 'node:readline';
import {HexawSession} from './session.js';
import {HexawInstructor,InstructorCancelled} from './instructor.js';
import {instructorCommand} from './instructor-shell.js';

export async function runShell(initialPath?:string):Promise<number>{
  const session=new HexawSession(),ai=new HexawInstructor(),terminal=!!(process.stdin.isTTY&&process.stdout.isTTY);
  process.stdout.write('HEXAW interactive monitor · ? help · D dump · U unassemble · A assemble · // AI question · Q quit\n');
  if(initialPath){process.stdout.write(await session.load(initialPath)+'\n');process.stdout.write((await session.execute('D')).text+'\n');}
  const rl=createInterface({input:process.stdin,output:process.stdout,terminal,historySize:500,removeHistoryDuplicates:true,crlfDelay:Infinity,
    completer(line:string):[string[],string]{const prefix=line.toUpperCase();return [session.completions.filter(command=>command.startsWith(prefix)),line];}});
  const prompt=(preserveCursor=true)=>{if(terminal){rl.setPrompt(session.prompt);rl.prompt(preserveCursor);}};
  let hadErrors=false,executing=false,closing=false,promptActive=false;
  const jobs=new Set<Promise<void>>(),queued:Array<{text:string;error:boolean}>=[];
  const write=(text:string,error=false)=>{if(text)(error?process.stderr:process.stdout).write(text.replace(/\n?$/,'\n'));};
  const deliver=(text:string,error=false)=>{
    if(closing)return;if(executing){queued.push({text,error});return;}
    if(terminal&&promptActive){const {rows}=rl.getCursorPos();cursorTo(process.stdout,0);if(rows)moveCursor(process.stdout,0,-rows);clearScreenDown(process.stdout);}
    write(text,error);prompt(true);promptActive=true;
  };
  const cancel=()=>{rl.write(null,{ctrl:true,name:'u'});process.stdout.write('\n'+session.cancelAssembly()+'\n');prompt();};
  const interrupt=()=>{if(session.busy)session.interrupt();else if(ai.busy){ai.cancel();deliver('AI request cancelled; shell state preserved');}else if(session.assembling)cancel();else rl.close();};
  const keypress=(_text:string,key:{name?:string})=>{
    if(session.busy)return;
    if(key?.name==='f1'){process.stdout.write('\n'+session.help);prompt(true);}
    else if(key?.name==='escape'&&session.assembling)cancel();
    else if(key?.name==='f3'&&session.assembling){const instruction=session.originalInstruction;if(instruction!==null){rl.write(null,{ctrl:true,name:'u'});rl.write(instruction);}}
  };
  rl.on('SIGINT',interrupt);process.on('SIGINT',interrupt);if(terminal)process.stdin.on('keypress',keypress);
  try{
    prompt();promptActive=true;
    for await(const line of rl){
      executing=true;promptActive=false;const isAI=/^\s*(?:\/\/|:AI\b|AI\b)/i.test(line),recordedLine=session.assembling&&!line.trim()?'[empty Enter: apply assembly draft]':line;
      try{
        const action=instructorCommand(line,ai,()=>session.instructorSnapshot());
        if(action!==null){
          if(typeof action==='string')write(action);
          else if(terminal){
            write('AI is thinking; shell commands remain available. AI CANCEL stops the answer.');
            const job=action.then(text=>deliver(text)).catch(error=>{if(!(error instanceof InstructorCancelled)){hadErrors=true;deliver('hexaw: '+(error as Error).message,true);}}).finally(()=>jobs.delete(job));jobs.add(job);
          }else write(await action);
        }else{
          const result=await session.execute(line);ai.record(recordedLine,'success',result.text);write(result.text);if(result.quit)break;
        }
      }catch(error){if(!(error instanceof InstructorCancelled)){hadErrors=true;write(`hexaw: ${(error as Error).message}`,true);if(!isAI)ai.record(recordedLine,'error',(error as Error).message);}}
      finally{executing=false;for(const entry of queued.splice(0))write(entry.text,entry.error);}
      prompt();promptActive=true;
    }
  }finally{
    closing=true;ai.cancel();await Promise.allSettled(jobs);
    if(session.assembling){if(session.assemblyPending)hadErrors=true;process.stdout.write(session.cancelAssembly('closed at EOF')+'\n');}
    rl.close();process.off('SIGINT',interrupt);if(terminal)process.stdin.off('keypress',keypress);
  }
  return !terminal&&hadErrors?1:0;
}
