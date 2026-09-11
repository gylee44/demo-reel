import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scene } from '../../../packages/contracts/src/index.ts';
import type { Config } from '../../api/src/config.ts';
import { AppError, hash } from '../../api/src/security.ts';
import { fixedNarration, probe, type Narration } from './media.ts';
import { generateSpeech } from './providers/openai.ts';
export function splitNarration(text: string) {
  const words = text.trim().split(/\s+/);
  const parts: string[] = [];
  for (const word of words) {
    if (word.length > 65)
      throw new AppError('TTS_FAILED', '자막에 맞게 긴 단어 사이에 공백을 넣어 주세요.');
    if (!parts.length || parts[parts.length - 1].length + word.length + 1 > 65) parts.push(word);
    else parts[parts.length - 1] += ' ' + word;
  }
  return parts;
}
export async function narrate(
  scene: Scene,
  cfg: Config,
  dir: string,
  deadline = Date.now() + 120000,
): Promise<Narration> {
  if (cfg.pocMode) return fixedNarration(scene);
  await mkdir(dir, { recursive: true });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const parts = splitNarration(scene.narration.text);
  const cues: Narration['cues'] = [];
  let durationMs = 0;
  for (const [i, text] of parts.entries()) {
    if (Date.now() >= deadline)
      throw new AppError('TTS_FAILED', '음성 생성 시간이 제한을 초과했습니다. 다시 시도해 주세요.');
    const path = join(dir, `speech-${i}.mp3`);
    await writeFile(
      path,
      await generateSpeech(cfg, text, fetch, Math.min(30000, deadline - Date.now())),
      { mode: 0o600 },
    );
    const duration = Math.ceil(Number((await probe(path)).format.duration) * 1000);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      durationMs + duration + scene.timing.tailHoldMs > scene.timing.maxDurationMs
    )
      throw new AppError(
        'DURATION_EXCEEDED',
        '음성이 장면 길이를 초과합니다. 내레이션을 줄여 주세요.',
      );
    cues.push({ text, startMs: durationMs, endMs: durationMs + duration });
    durationMs += duration;
  }
  const file = join(dir, 'narration.m4a');
  await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      ...parts.flatMap((_, i) => ['-i', join(dir, `speech-${i}.mp3`)]),
      '-filter_complex',
      parts.map((_, i) => `[${i}:a]asetpts=PTS-STARTPTS[a${i}];`).join('') +
        parts.map((_, i) => `[a${i}]`).join('') +
        `concat=n=${parts.length}:v=0:a=1[a]`,
      '-map',
      '[a]',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '1',
      file,
    ],
    { timeout: 30000 },
  );
  // Probe the final file; subtitle intervals are bounded to the rendered audio.
  durationMs = Math.ceil(Number((await probe(file)).format.duration) * 1000);
  if (durationMs + scene.timing.tailHoldMs > scene.timing.maxDurationMs)
    throw new AppError('DURATION_EXCEEDED', '내레이션을 줄여 주세요.');
  return {
    file,
    textHash: hash(scene.narration.text),
    durationMs,
    cues: cues.map((c) => ({ ...c, endMs: Math.min(c.endMs, durationMs) })),
    source: { voice: `openai:${cfg.ttsModel}:${cfg.ttsVoice}`, rate: 1 },
  };
}
