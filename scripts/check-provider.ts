/**
 * One real OpenAI call for planning and one for speech. No database, storage, queue or
 * browser: use it to confirm a key, a model and the credit balance actually work before
 * running the full service.
 *   pnpm check:provider
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../apps/api/src/config.ts';
import {
  generateDraft,
  generateSpeech,
  requireOpenAI,
} from '../apps/worker/src/providers/openai.ts';
import { probe } from '../apps/worker/src/media.ts';
import type { Observation } from '../apps/worker/src/discovery.ts';
const cfg = config();
console.log(`계획 모델: ${cfg.plannerModel}\n음성 모델: ${cfg.ttsModel} · ${cfg.ttsVoice}\n`);
requireOpenAI(cfg, true);
const evidenceId = 'evidence_check';
const loc = (id: string, value: string, role: string) => ({
  id,
  strategy: 'role' as const,
  value,
  role,
  exact: true,
  scopeLocatorId: null,
  evidenceId,
});
const observations: Observation[] = [
  {
    id: evidenceId,
    url: 'https://example.org/dashboard',
    title: '업무 관리',
    summary: '업무 목록\n새 업무 추가',
    locators: [
      loc('heading-tasks', '업무 목록', 'heading'),
      loc('link-new', '새 업무 추가', 'link'),
      loc('field-title', '업무 제목', 'textbox'),
      loc('button-save', '저장', 'button'),
      loc('heading-created', '저장되었습니다', 'heading'),
    ],
  },
];
const BILLING = 'https://platform.openai.com/settings/organization/billing';
/**
 * The provider module hides response bodies so secrets never reach a log. That also hides
 * "this model no longer exists", the most common first-run failure, so on error this local
 * tool asks OpenAI which models the key can actually use.
 */
async function diagnose(code: string, model: string) {
  console.error(`   설정한 모델: ${model}`);
  if (code === 'PROVIDER_QUOTA_EXHAUSTED')
    return console.error(
      `   키는 유효하지만 크레딧이 없습니다. 결제를 확인해 주세요:\n   ${BILLING}`,
    );
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${cfg.openaiKey}` },
    });
    if (!r.ok)
      return console.error(
        `   모델 목록도 조회하지 못했습니다 (HTTP ${r.status}). 키를 확인해 주세요.`,
      );
    const ids: string[] = ((await r.json()).data ?? []).map((m: any) => String(m.id));
    const planners = ids.filter((i) => /^gpt-[\d.]/.test(i) && !/tts|audio|image|realtime/.test(i));
    console.error(
      `   이 키로 쓸 수 있는 계획 모델: ${planners.slice(0, 12).join(', ') || '(없음)'}`,
    );
    console.error(
      `   음성 모델: ${
        ids
          .filter((i) => /tts/.test(i))
          .slice(0, 8)
          .join(', ') || '(없음)'
      }`,
    );
  } catch {
    console.error('   모델 목록 조회에 실패했습니다. 네트워크를 확인해 주세요.');
  }
}
console.log('1) 계획 생성 호출 중...');
const started = Date.now();
const draft = await generateDraft(cfg, '업무를 추가하는 흐름을 보여주세요', observations).catch(
  async (error) => {
    console.error(`   ❌ ${error.code ?? ''} ${error.message}`);
    await diagnose(error.code, cfg.plannerModel);
    process.exit(1);
  },
);
console.log(
  `   ✅ ${Date.now() - started}ms · 제목 "${draft.title}" · 장면 ${draft.scenes.length}개`,
);
for (const s of draft.scenes)
  console.log(`      - ${s.id}: ${s.title} (동작 ${s.actions.length}개)`);

console.log('\n2) 음성 생성 호출 중...');
const dir = join(cfg.dataDir, 'provider-check');
await mkdir(dir, { recursive: true });
const t2 = Date.now();
const speech = await generateSpeech(cfg, '데모 릴이 실제 기능을 영상으로 보여줍니다.').catch(
  async (error) => {
    console.error(`   ❌ ${error.code ?? ''} ${error.message}`);
    await diagnose(error.code, cfg.ttsModel);
    process.exit(1);
  },
);
const file = join(dir, 'sample.mp3');
await writeFile(file, speech, { mode: 0o600 });
const seconds = Number((await probe(file)).format.duration);
console.log(`   ✅ ${Date.now() - t2}ms · ${speech.length}바이트 · ${seconds.toFixed(2)}초`);
console.log(`   저장 위치: ${file}\n두 호출 모두 성공했습니다.`);
