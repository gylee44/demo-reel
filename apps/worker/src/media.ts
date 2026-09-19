import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Browser } from 'playwright';
import type { Config } from '../../api/src/config.ts';
import type { Database } from '../../api/src/db.ts';
import type { Artifact } from '../../api/src/models.ts';
import { hash, AppError } from '../../api/src/security.ts';
import type { Scene } from '../../../packages/contracts/src/index.ts';
import type { Elision } from './browser.ts';
import { totalDuration } from '../../../packages/contracts/src/rules.ts';
import { uploadArtifact } from '../../../packages/runtime/src/storage.ts';
const exec = promisify(execFile);
export type Cue = { text: string; startMs: number; endMs: number };
export type Narration = {
  file: string;
  textHash: string;
  durationMs: number;
  cues: Cue[];
  source: { voice: string; rate: number };
};
export async function probe(path: string) {
  const { stdout } = await exec(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
export async function fixedNarration(scene: Scene): Promise<Narration> {
  const manifest = JSON.parse(await readFile(resolve('fixtures/narration/manifest.json'), 'utf8'));
  const fixture = Object.values(manifest as Record<string, Narration>).find(
    (n) => n.textHash === hash(scene.narration.text),
  );
  if (!fixture || fixture.textHash !== hash(scene.narration.text))
    throw new AppError(
      'TTS_FAILED',
      '고정 음원을 사용하는 PoC입니다. 기본 내레이션으로 복원하거나 실제 TTS를 연결해야 합니다.',
    );
  const path = resolve('fixtures/narration', fixture.file),
    meta = await probe(path),
    durationMs = Math.ceil(Number(meta.format.duration) * 1000);
  if (durationMs + scene.timing.tailHoldMs > scene.timing.maxDurationMs)
    throw new AppError('DURATION_EXCEEDED', '음성이 장면 최대 길이를 초과합니다.');
  return { ...fixture, file: path, durationMs };
}
/** Locate the recorded green sync marker in media time instead of assuming wall time == video PTS. */
export async function syncOffset(rawPath: string): Promise<number> {
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      rawPath,
      '-vf',
      'fps=25,crop=8:8:4:4,scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  );
  let last = -1,
    count = 0;
  for (let i = 0; i < stdout.length; i += 3)
    if (stdout[i] < 45 && stdout[i + 1] > 205 && stdout[i + 2] < 65) {
      last = i / 3;
      count++;
    }
  if (last < 0 || count < 4)
    throw new AppError('RENDER_FAILED', '녹화 시작 동기화 표시를 확인하지 못했습니다.');
  return (last + 1) / 25 + 0.12;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export async function captionPng(browser: Browser, text: string, path: string, aiVoice = false) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 138 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(
      `<html lang="ko"><head><meta charset="UTF-8"><style>*{box-sizing:border-box}html,body{margin:0;background:transparent;width:1280px;height:138px}body{display:flex;justify-content:center;align-items:flex-end;padding:12px 75px 21px;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans CJK KR","Apple SD Gothic Neo",sans-serif}.caption{color:#fff;background:rgba(19,35,28,.93);padding:12px 22px;border-radius:9px;font-size:23px;font-weight:500;line-height:1.48;text-align:center;max-width:1130px;word-break:keep-all;box-shadow:0 3px 12px #0002}</style></head><body>${aiVoice ? '<span style="position:absolute;right:75px;top:1px;font-size:12px;color:white;background:#173b2ce8;border-radius:4px;padding:2px 7px">AI 내레이션</span>' : ''}<div class="caption">${escape(text)}</div></body></html>`,
    );
    await page.evaluate(() => document.fonts.ready);
    const fits = await page
      .locator('.caption')
      .evaluate((e) => e.getBoundingClientRect().height <= 105);
    if (!fits)
      throw new AppError('RENDER_FAILED', '자막이 화면 영역을 초과합니다. 문장을 나눠 주세요.');
    await page.screenshot({ path, omitBackground: true });
  } finally {
    await context.close();
  }
}
export type RenderOptions = {
  knownOffset?: number;
  /** Stretches of recorded scene time to cut out, measured from the sync point. */
  elisions?: Elision[];
  /** Overridden only by the fallback render, where holding the last frame beats having no clip. */
  maxFreezeMs?: number;
};
/** Sorted, non-overlapping, positive-length cuts: overlapping ones would trim each other's source. */
function mergeCuts(elisions: Elision[]): Elision[] {
  const merged: Elision[] = [];
  for (const cut of [...elisions].sort((a, b) => a.startMs - b.startMs)) {
    if (cut.endMs <= cut.startMs) continue;
    const last = merged[merged.length - 1];
    if (last && cut.startMs <= last.endMs) last.endMs = Math.max(last.endMs, cut.endMs);
    else merged.push({ ...cut });
  }
  return merged;
}
/**
 * The recording with the cuts taken out, as one filter chain ending in [kept]. Each kept stretch is
 * trimmed from its own copy of the input — a stream can only be consumed once, hence the split — is
 * normalised to the output format before concat, which will not join streams that disagree, and is
 * rebased to zero so the pieces butt up against each other instead of leaving the gap behind.
 */
function keptVideo(offset: number, cuts: Elision[]): string[] {
  const at = (ms: number) => (offset + ms / 1000).toFixed(3);
  if (!cuts.length) return [`[0:v]trim=start=${offset.toFixed(3)},setpts=PTS-STARTPTS[kept]`];
  const spans = cuts.map((cut, i) => ({
    start: i ? at(cuts[i - 1].endMs) : offset.toFixed(3),
    end: at(cut.startMs),
  }));
  spans.push({ start: at(cuts[cuts.length - 1].endMs), end: '' });
  const keep = spans.filter((s) => !s.end || Number(s.end) > Number(s.start));
  return [
    `[0:v]split=${keep.length}${keep.map((_, i) => `[p${i}]`).join('')}`,
    ...keep.map(
      (s, i) =>
        `[p${i}]trim=start=${s.start}${s.end ? `:end=${s.end}` : ''},setpts=PTS-STARTPTS,fps=30,scale=1280:720,format=yuv420p[g${i}]`,
    ),
    `${keep.map((_, i) => `[g${i}]`).join('')}concat=n=${keep.length}:v=1:a=0[kept]`,
  ];
}
export async function renderScene(
  browser: Browser,
  rawPath: string,
  scene: Scene,
  narration: Narration,
  durationMs: number,
  dir: string,
  { knownOffset, elisions = [], maxFreezeMs = scene.timing.maxFreezeMs }: RenderOptions = {},
) {
  await mkdir(dir, { recursive: true });
  const offset = knownOffset ?? (await syncOffset(rawPath)),
    metadata = await probe(rawPath);
  const cuts = mergeCuts(elisions);
  const cutMs = cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
  const sourceMs = (Number(metadata.format.duration) - offset) * 1000 - cutMs;
  if (durationMs - sourceMs > maxFreezeMs)
    throw new AppError(
      'DURATION_EXCEEDED',
      '원본 영상이 부족해 제한된 정지 화면 길이를 초과합니다.',
    );
  const pngs = [];
  for (const [i, cue] of narration.cues.entries()) {
    const path = join(dir, `caption-${i}.png`);
    await captionPng(browser, cue.text, path, narration.source.voice.startsWith('openai:'));
    pngs.push(path);
  }
  const sec = (durationMs / 1000).toFixed(3),
    output = join(dir, 'clip.mp4');
  const filter = [
    ...keptVideo(offset, cuts),
    `[kept]scale=1280:720,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=${maxFreezeMs / 1000},trim=duration=${sec}[v0]`,
  ];
  for (let i = 0; i < pngs.length; i++)
    filter.push(
      `[v${i}][${i + 2}:v]overlay=0:582:enable='between(t,${(narration.cues[i].startMs / 1000).toFixed(3)},${(narration.cues[i].endMs / 1000).toFixed(3)})'[v${i + 1}]`,
    );
  filter.push(`[1:a]aresample=48000,apad,atrim=duration=${sec},asetpts=PTS-STARTPTS[a]`);
  await exec(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      rawPath,
      '-i',
      narration.file,
      ...pngs.flatMap((p) => ['-loop', '1', '-i', p]),
      '-filter_complex',
      filter.join(';'),
      '-map',
      `[v${pngs.length}]`,
      '-map',
      '[a]',
      '-t',
      sec,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      output,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 180000 },
  );
  const rendered = await probe(output);
  return {
    path: output,
    durationMs: Math.round(Number(rendered.format.duration) * 1000),
    trimStartMs: Math.round(offset * 1000),
  };
}
export async function compose(
  clips: { path: string; durationMs: number }[],
  output: string,
  enforcePocLength = true,
) {
  const duration = totalDuration(
    clips.map((c) => c.durationMs),
    enforcePocLength ? 75000 : 180000,
  );
  if (enforcePocLength && duration < 45000)
    throw new AppError(
      'DURATION_EXCEEDED',
      'PoC 영상의 목표 길이는 45~75초입니다. 장면 구성을 확인해 주세요.',
    );
  await mkdir(resolve(output, '..'), { recursive: true });
  await exec(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      ...clips.flatMap((c) => ['-i', c.path]),
      '-filter_complex',
      `${clips.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${clips.length}:v=1:a=1[v][a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      output,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 180000 },
  );
  const meta = await probe(output),
    video = meta.streams.find((s: any) => s.codec_type === 'video'),
    audio = meta.streams.find((s: any) => s.codec_type === 'audio');
  if (
    !video ||
    video.width !== 1280 ||
    video.height !== 720 ||
    video.codec_name !== 'h264' ||
    video.r_frame_rate !== '30/1' ||
    audio?.codec_name !== 'aac' ||
    Math.abs(Number(meta.format.duration) * 1000 - duration) > 250
  )
    throw new AppError('RENDER_FAILED', '완성 영상의 규격 또는 길이 검증에 실패했습니다.');
  return {
    path: output,
    durationMs: Math.round(Number(meta.format.duration) * 1000),
    video,
    audio,
  };
}
export async function storeArtifact(
  db: Database,
  cfg: Config,
  owner: string,
  jobId: string,
  kind: Artifact['kind'],
  source: string,
  durationMs?: number,
) {
  const artifactId = `artifact_${randomUUID()}`,
    ext = source.split('.').pop()!;
  const dir = join(cfg.dataDir, 'artifacts');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${artifactId}.${ext}`);
  await copyFile(source, path);
  if (!(await stat(path)).size)
    throw new AppError('RENDER_FAILED', '빈 결과 파일이 생성되었습니다.');
  const bytes = await readFile(path),
    record: Artifact = {
      artifactId,
      owner,
      jobId,
      kind,
      path,
      mimeType:
        ext === 'mp4'
          ? 'video/mp4'
          : ext === 'png'
            ? 'image/png'
            : ext === 'webm'
              ? 'video/webm'
              : 'audio/mp4',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      durationMs,
    };
  if (!cfg.pocMode) record.objectKey = await uploadArtifact(cfg, record);
  await db.put('artifact', artifactId, owner, record);
  return record;
}
export async function writeManifest(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
