import { it, expect, vi } from 'vitest';
import { isPublicAddress, publicUrl, resolvePublic } from '../../packages/runtime/src/network.ts';
import { generateDraft, generateSpeech } from '../../apps/worker/src/providers/openai.ts';
import { splitNarration } from '../../apps/worker/src/narration.ts';
import { config } from '../../apps/api/src/config.ts';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
import { assertExecutionPolicy } from '../../apps/worker/src/planning.ts';
it.each([
  '127.0.0.1',
  '10.0.0.1',
  '172.16.1.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '::1',
  '::',
  'fc00::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '2001:db8::1',
])('blocks non-public address %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
it('accepts public IPs and HTTPS URLs', () => {
  expect(isPublicAddress('8.8.8.8')).toBe(true);
  expect(publicUrl('https://example.org/app').pathname).toBe('/app');
});
it.each([
  'http://example.org',
  'https://127.1',
  'https://user:pass@example.org',
  'https://[::1]',
  'https://example.org:8443',
  'file:///etc/passwd',
])('rejects target %s', (url) => expect(() => publicUrl(url)).toThrow());
it('rejects mixed DNS answers and pins one verified answer', async () => {
  await expect(
    resolvePublic(
      'example.org',
      vi.fn().mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    resolvePublic('example.org', vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])),
  ).resolves.toEqual({ address: '8.8.8.8', family: 4 });
});
it('does not call any provider without a key or model', async () => {
  const request = vi.fn();
  const cfg = { ...config(), openaiKey: '', plannerModel: '' };
  await expect(generateDraft(cfg, 'test', [], request)).rejects.toMatchObject({
    code: 'PROVIDER_NOT_CONFIGURED',
  });
  await expect(generateSpeech(cfg, 'test', request)).rejects.toMatchObject({
    code: 'PROVIDER_NOT_CONFIGURED',
  });
  expect(request).not.toHaveBeenCalled();
});
it('uses structured outputs and rejects refusal/incomplete/invalid provider responses', async () => {
  const cfg = { ...config(), openaiKey: 'test-only-key', plannerModel: 'configured-model' };
  const scenes = samplePlan('https://example.org', 'p', 'plan').scenes;
  const request = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify({ title: '관측 기반', scenes }) },
              ],
            },
          ],
        }),
      ),
    );
  expect((await generateDraft(cfg, '기능', [], request)).title).toBe('관측 기반');
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.store).toBe(false);
  expect(body.text.format.strict).toBe(true);
  expect(body.input).not.toContain('test-only-key');
  for (const result of [
    { status: 'incomplete' },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
    { status: 'completed', output: [] },
  ])
    await expect(
      generateDraft(
        cfg,
        '기능',
        [],
        vi.fn().mockResolvedValue(new Response(JSON.stringify(result))),
      ),
    ).rejects.toMatchObject({ code: 'PLAN_GENERATION_FAILED' });
});
it('maps provider errors without exposing response secrets', async () => {
  await expect(
    generateSpeech(
      { ...config(), openaiKey: 'test' },
      'hello',
      vi.fn().mockResolvedValue(new Response('sensitive', { status: 429 })),
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
});
it('splits Korean speech into bounded subtitle segments and rejects unbreakable overflow', () => {
  const text = '사용자가 입력한 기능을 실제 화면으로 보여줍니다. '.repeat(8).trim();
  const pieces = splitNarration(text);
  expect(pieces.every((x) => x.length <= 65)).toBe(true);
  expect(pieces.join(' ')).toBe(text);
  expect(() => splitNarration('가'.repeat(70))).toThrow();
});
it('refuses mutation actions mislabeled as read-only', () => {
  const plan = samplePlan('https://example.org', 'p', 'plan');
  plan.scenes[1].effects.writes = [];
  plan.scenes[1].retryPolicy = 'read_only';
  expect(() => assertExecutionPolicy(plan)).toThrow();
});
