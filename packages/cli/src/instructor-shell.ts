import {HexawInstructor,INSTRUCTOR_MODEL,formatInstructorReply} from './instructor.js';
import type {InstructorSnapshot} from './instructor-context.js';
import {instructorKnowledge} from './instructor-knowledge.js';

export const AI_HELP=`HEXAW / WASM AI mentor — the TiyF instructor on Groq

  AI question / // question  Ask about HEXAW, WASM or the current shell state
  :AI question              Ask from assembly mode without leaving the draft
  AI REVIEW                 Review the current code / draft / VM snapshot
  AI ERROR                  Explain a recent command error or VM trap
  AI LANGUAGE hu            Choose a reply language (BCP 47; e.g. en, hu)
  AI STATUS                 Show provider/configuration status, never the key
  AI KNOWLEDGE [topic]      Read the bundled knowledge offline
  AI CLEAR                  Clear chat, retain the teaching notebook/language
  AI RESET                  Clear chat, notebook, task and remembered language
  AI CANCEL                 Cancel the pending answer; keep the shell state

Model: ${INSTRUCTOR_MODEL}. Set GROQ_API_KEY in the environment before launch.
Node can load it from a local file: node --env-file=.env packages/cli/dist/cli.js -i
Never type API keys into this monitor. No API calls occur until an AI question,
REVIEW or ERROR request. Other shell commands remain available while AI answers
in a terminal. Ctrl-C cancels a pending answer; Q/EOF cancels it when exiting.
Command scripts wait for AI replies in order. Missing keys/provider errors do
not disable assembly or debugging. Replies/examples are text, never executed.
Only bounded question-time code/draft, VM values, three commands, eight chat
entries and a short teaching notebook are sent to Groq; no full binary or MEM.
`;

/** A null result leaves an ordinary monitor/assembly command untouched. */
export function instructorCommand(line:string,ai:HexawInstructor,snapshot:()=>InstructorSnapshot):string|Promise<string>|null {
  const match=/^\s*(?:\/\/|:AI\b|AI\b)(.*)$/i.exec(line);if(!match)return null;
  const text=match[1].trim(),upper=text.toUpperCase();
  // // always means a question (except an empty //, which shows help).
  const question=/^\s*\/\//.test(line);
  if(!text||!question&&upper==='HELP')return AI_HELP;
  if(!question){
    if(upper==='STATUS')return `AI · Groq · ${INSTRUCTOR_MODEL}\n${ai.configured?'GROQ_API_KEY configured':'GROQ_API_KEY missing'} · ${ai.busy?'answer pending':'idle'} · language ${ai.language}\n${ai.context.length} chat entries · notebook ${Object.values(ai.memory).some(Boolean)?'present':'empty'}`;
    if(upper==='CANCEL')return ai.cancel()?'AI request cancelled; shell state preserved':'No AI request is pending';
    if(upper==='CLEAR'){ai.clear();return 'AI chat cleared; teaching notebook and language retained';}
    if(upper==='RESET'){ai.reset();return 'AI chat, notebook, task and language reset; shell state preserved';}
    const language=/^LANGUAGE\s+(\S+)$/i.exec(text);if(language){ai.setLanguage(language[1]);return 'AI reply language: '+ai.language;}
    if(/^KNOWLEDGE(?:\s|$)/i.test(text))return instructorKnowledge(text.slice(9).trim()||'HEXAW assembly stack WASM binary shell');
  }
  const state=snapshot();let prompt=text;
  if(!question&&upper==='REVIEW')prompt='Review the code/draft and VM state in this question-time snapshot. Explain one concrete observation or improvement. Do not claim the draft was applied or executed.';
  if(!question&&upper==='ERROR'){
    if(!state.vm?.error&&!ai.recentCommands.some(c=>c.status==='error'))return 'No recent command error or VM trap; use AI followed by a question';
    prompt='Explain the recent command error and/or VM trap in the supplied snapshot and recentCommands. Distinguish the failing phase and give the smallest useful correction; examples have not been executed.';
  }
  return ai.ask(prompt,state).then(formatInstructorReply);
}
