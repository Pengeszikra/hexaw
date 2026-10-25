// The bounded notebook/chat design follows TiyF's MIT-licensed instructor.
// https://github.com/Pengeszikra/terminal-is-your-friend
export interface InstructorMemory {note:string;direction:string;assessment:string}
export interface InstructorChat {kind:'question'|'answer';text:string;example?:string}
export interface InstructorCommand {command:string;status:'success'|'error';output:string}
export interface InstructorSnapshot {
  version:string;
  mode:'monitor'|'assembly';
  buffer:{loaded:boolean;name:string|null;bytes:number;modified:boolean;validWasm:boolean;diagnostic:string;definedBodies:number;exportsKnown:boolean;exports:string[]};
  focus:{body:number;params:string[]|null;results:string[]|null;signatureTruncated:boolean;code:Array<{offset:string;bytes:string;text:string}>;totalInstructions:number}|null;
  draft:{start:string;next:string;instructions:number;lines:string[];truncated:boolean}|null;
  vm:{state:string;steps:number;pc:string|null;next:string|null;stack:string[];locals:string[];globals:string[];result:string[];stackDepth:number;localCount:number;globalCount:number;resultCount:number;error:string|null;frames:number;memoryBytes:number}|null;
  breakpoints:string[];
}
export const memoryLimits={note:500,direction:200,assessment:200} as const;
export const emptyMemory=():InstructorMemory=>({note:'',direction:'',assessment:''});
export const clip=(text:string,limit:number):string=>text.length>limit?text.slice(0,limit-14)+'\n[truncated]':text;
export function readMemory(value:unknown):InstructorMemory|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const fields=value as Record<string,unknown>;
  for(const [key,limit] of Object.entries(memoryLimits))if(typeof fields[key]!=='string'||(fields[key] as string).length>limit)return null;
  return {note:(fields.note as string).trim(),direction:(fields.direction as string).trim(),assessment:(fields.assessment as string).trim()};
}
