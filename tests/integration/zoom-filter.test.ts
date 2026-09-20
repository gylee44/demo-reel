import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zoomFilter } from '../../apps/worker/src/media.ts';
const exec = promisify(execFile);
const focus = [
  { atMs: 3000, x: 900, y: 500, width: 200, height: 60 },
  { atMs: 9000, x: 40, y: 80, width: 300, height: 40 },
];
it('leaves a scene that never pointed at anything alone', () => {
  expect(zoomFilter([])).toBeNull();
  expect(zoomFilter([{ atMs: 1000, x: 10, y: 10, width: 0, height: 0 }])).toBeNull();
});
/**
 * The expression goes into filter_complex, where a bad name does not simply skip the zoom — it
 * fails the render and loses the scene. That happened with `t`, which zoompan does not define.
 */
it('produces an expression ffmpeg actually accepts', async () => {
  const filter = zoomFilter(focus)!;
  expect(filter).toContain('zoompan');
  expect(filter).not.toMatch(/[^a-z]t[,)]/);
  const out = join(tmpdir(), `zoom-${randomUUID()}.mp4`);
  await exec('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1280x720:rate=30:duration=4',
    '-filter_complex',
    `[0:v]scale=1280:720,fps=30,${filter},format=yuv420p[v]`,
    '-map',
    '[v]',
    out,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    out,
  ]);
  expect(stdout.trim()).toBe('1280,720');
}, 60000);
it('keeps the crop inside the frame so no edge shows', () => {
  const filter = zoomFilter([{ atMs: 500, x: 1270, y: 715, width: 40, height: 40 }])!;
  expect(filter).toContain('min(max(');
  expect(filter).toContain('iw-iw/zoom');
  expect(filter).toContain('ih-ih/zoom');
});
