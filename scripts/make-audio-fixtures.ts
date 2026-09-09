// One-time fixture generation on macOS. Runtime/CI use the committed fixed recordings.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NARRATIONS } from '../packages/contracts/src/sample.ts';
import { hash } from '../apps/api/src/security.ts';
const dir=resolve('fixtures/narration');mkdirSync(dir,{recursive:true});
const scratch=resolve('output/audio-source');mkdirSync(scratch,{recursive:true});
const rate=Number(process.env.FIXTURE_RATE??190);
const manifest:Record<string,unknown>={};
for(const [id,text] of Object.entries(NARRATIONS)){
  let cursor=0;const cues=[];const paths=[];
  for(const [index,sentence] of text.split(/(?<=\.)\s+/u).entries()){
    const path=resolve(scratch,`${id}-${index}.aiff`);
    execFileSync('say',['-v','Yuna','-r',String(rate),'-o',path,sentence]);
    const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-of','json',path],{encoding:'utf8'}));
    const durationMs=Number(metadata.format.duration)*1000;
    cues.push({text:sentence,startMs:Math.round(cursor),endMs:Math.round(cursor+durationMs)});cursor+=durationMs;paths.push(path);
  }
  const out=resolve(dir,`${id}.m4a`);
  execFileSync('ffmpeg',['-y','-v','error',...paths.flatMap(p=>['-i',p]),'-filter_complex',`${paths.map((_,i)=>`[${i}:a]`).join('')}concat=n=${paths.length}:v=0:a=1[a]`,'-map','[a]','-ar','48000','-ac','1','-c:a','aac','-b:a','128k',out]);
  const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-of','json',out],{encoding:'utf8'}));
  manifest[id]={file:`${id}.m4a`,textHash:hash(text),durationMs:Math.ceil(Number(metadata.format.duration)*1000),cues,source:{voice:'macOS Yuna',rate,purpose:'Fixed PoC fixture; not a runtime TTS integration'}};
  console.log(`${id}: ${Number(metadata.format.duration).toFixed(2)} seconds; rate=${rate}`);
}
writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
