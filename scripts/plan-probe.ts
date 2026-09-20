/**
 * 계획 생성만 반복해서 품질을 재는 도구. 녹화를 하지 않으므로 운영 워커의 실행 레인을 쓰지 않고,
 * 한 건에 20~60초면 끝난다. 계획 생성기는 편차가 커서 두세 번으로는 아무것도 말할 수 없으므로,
 * 프롬프트를 고친 뒤에는 이걸로 표본을 충분히 쌓고 판단한다.
 *
 *   DATABASE_URL=... POC_MODE=false npx tsx scripts/plan-probe.ts [횟수] [대상주소]
 *
 * 찍히는 두 가지는 실제로 촬영을 실패시킨 형태다. 장면마다 브라우저가 새로 열리므로
 * 앞 장면이 채운 입력은 다음 장면에 없다 — 폼 입력과 전송 클릭이 갈리면 빈 폼이 제출된다.
 */
import { randomUUID } from 'node:crypto';
import { launchBrowser } from '../apps/worker/src/browser.ts';
import { buildProjectPlan } from '../apps/worker/src/planning.ts';
import { Database } from '../apps/api/src/db.ts';
import { config } from '../apps/api/src/config.ts';
import type { Plan } from '../packages/contracts/src/index.ts';
const runs = Number(process.argv[2] ?? 3);
const targetUrl = process.argv[3] ?? 'https://demo-reel-three.vercel.app';
const intent =
  process.env.PROBE_INTENT ??
  '앱 시연 스튜디오의 연결 화면을 소개해줘. 앱 주소와 보여줄 기능 한 문장을 입력하고 실행 계획 만들기 버튼을 누르는 흐름을 보여줘.';
const cfg = config();
if (cfg.pocMode) throw new Error('POC_MODE=true 면 고정 계획이 나온다. false 로 두고 실행할 것.');
const db = new Database(cfg.databaseUrl);
await db.init();
const browser = await launchBrowser();
const tally = { 정상: 0, 폼갈림: 0, 빈폼제출: 0 };
try {
  for (let i = 1; i <= runs; i++) {
    const started = Date.now();
    const plan = (await buildProjectPlan(browser, db, cfg, {
      projectId: `project_${randomUUID()}`,
      owner: `probe_${randomUUID()}`,
      targetUrl,
      intent,
      allowedOrigins: [new URL(targetUrl).origin],
      createdAt: new Date().toISOString(),
    } as never)) as Plan;
    console.log(
      `\n[${i}/${runs}] ${Math.round((Date.now() - started) / 1000)}초 · 장면 ${plan.scenes.length}개`,
    );
    const typed = new Map<string, string>();
    let 갈림 = false;
    for (const scene of plan.scenes) {
      const entry = scene.entry.url;
      const url = typeof entry === 'string' ? entry : `${entry.sceneId}.${entry.output}`;
      const fills = scene.actions.flatMap((a) =>
        a.type === 'fill' || a.type === 'select' ? [a.locatorId] : [],
      );
      const 누름 = scene.actions.some((a) => a.type === 'click' || a.type === 'press');
      const 잃은것 = [...typed].filter(([id, u]) => u === url && !fills.includes(id));
      if (누름 && 잃은것.length) 갈림 = true;
      for (const id of fills) typed.set(id, url);
      console.log(`  ${scene.id} | ${scene.title}`);
      console.log(`      ${scene.actions.map((a) => a.type).join(' + ') || '(액션 없음)'}`);
      if (누름 && 잃은것.length)
        console.log(`      >>> 앞 장면이 채운 ${잃은것.map(([id]) => id).join(', ')} 없이 누름`);
    }
    const 채운적없음 =
      !plan.scenes.some((s) => s.actions.some((a) => a.type === 'fill')) &&
      plan.scenes.some((s) => s.actions.some((a) => a.type === 'click'));
    const 판정 = 갈림 ? '폼갈림' : 채운적없음 ? '빈폼제출' : '정상';
    tally[판정]++;
    console.log(`  => ${판정}`);
  }
} finally {
  await browser.close();
  await db.close();
}
console.log('\n집계:', JSON.stringify(tally));
