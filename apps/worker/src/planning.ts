import { assertExecutionPolicy } from '../../../packages/contracts/src/policy.ts';
export { assertExecutionPolicy } from '../../../packages/contracts/src/policy.ts';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import type { Project, AuthRecord } from '../../api/src/models.ts';
import { AppError, decrypt } from '../../api/src/security.ts';
import { PlanSchema, type Plan } from '../../../packages/contracts/src/index.ts';
import { samplePlan } from '../../../packages/contracts/src/sample.ts';
import { authenticate } from './authentication.ts';
import { discover, type Observation } from './discovery.ts';
import { generateDraft, requireOpenAI } from './providers/openai.ts';
export async function buildProjectPlan(
  browser: Browser,
  db: Database,
  cfg: Config,
  project: Project,
  authRef?: string,
) {
  if (cfg.pocMode) {
    const p = samplePlan(project.targetUrl, project.projectId, `plan_${randomUUID()}`, authRef);
    p.intent = project.intent;
    return p;
  }
  requireOpenAI(cfg, true);
  const auth = authRef ? await db.get<AuthRecord>('auth', authRef, project.owner) : null;
  if (authRef && (!auth || auth.projectId !== project.projectId))
    throw new AppError('AUTH_FAILED', '대상 앱의 인증 정보가 아닙니다.');
  const target = {
    baseUrl: project.targetUrl,
    allowedOrigins: project.allowedOrigins ?? [new URL(project.targetUrl).origin],
  };
  const authData: Plan['auth'] = auth
    ? { mode: auth.mode, authRef: auth.authRef, expiresAt: auth.expiresAt }
    : { mode: 'none', authRef: null, expiresAt: null };
  const state = await authenticate(browser, db, cfg, { target, auth: authData }, project.owner);
  const observations = await discover(browser, target, state, project.discoveryUrls ?? []);
  // Credentials never enter the provider request, even if the app reflects them into labels or URLs.
  if (auth) {
    const secret = decrypt<any>(auth.ciphertext, cfg.key);
    const values =
      secret.mode === 'form'
        ? [secret.username, secret.password]
        : [
            ...secret.storageState.cookies.map((c: any) => c.value),
            ...secret.storageState.origins.flatMap((o: any) =>
              o.localStorage.map((v: any) => v.value),
            ),
          ];
    if (values.some((value: string) => value && JSON.stringify(observations).includes(value)))
      throw new AppError(
        'SENSITIVE_PAGE',
        '화면 관측에 인증 정보가 포함되어 계획 생성을 중단했습니다.',
      );
  }
  const catalogue = observations.flatMap((o) => o.locators).slice(0, 100);
  if (!catalogue.length)
    throw new AppError(
      'TARGET_NOT_FOUND',
      '화면에서 시연할 대상을 찾지 못했습니다. 탐색 주소를 확인해 주세요.',
    );
  const draft = await generateDraft(
    cfg,
    project.intent,
    observations.map((o) => ({
      ...o,
      locators: o.locators.filter((l) => catalogue.some((c) => c.id === l.id)),
    })),
  );
  const plan = PlanSchema.parse({
    schemaVersion: '0.1',
    planId: `plan_${randomUUID()}`,
    projectId: project.projectId,
    revision: 1,
    title: draft.title,
    intent: project.intent,
    target,
    auth: authData,
    format: {
      width: 1280,
      height: 720,
      targetDurationMs: 60000,
      maxDurationMs: 75000,
      language: 'ko-KR',
    },
    locators: catalogue,
    scenes: draft.scenes,
    createdAt: new Date().toISOString(),
  });
  assertExecutionPolicy(plan);
  for (const observation of observations)
    await db.put('observation', observation.id, project.owner, observation, project.projectId);
  return plan;
}
