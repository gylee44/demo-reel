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
/**
 * Fills in the two plan fields that follow from the draft itself rather than from judgement, which
 * are the ones the model most often leaves inconsistent: a scene that reads another scene's output
 * must name it in dependsOn, and recovery predicates belong only to verify_before_repeat. Declaring
 * them here does not change what the plan does, and saves a retry that often fails the same way.
 */
function declareDerivableFields(scenes: any[]) {
  const preceding = new Map<string, any>();
  for (const scene of scenes) {
    const referenced: { sceneId: string; output: string }[] = [];
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(walk);
      const node = value as Record<string, unknown>;
      if (typeof node.sceneId === 'string' && typeof node.output === 'string')
        referenced.push({ sceneId: node.sceneId, output: node.output });
      Object.values(node).forEach(walk);
    };
    walk({ ...scene, dependsOn: undefined });
    for (const { sceneId, output } of referenced) {
      const source = preceding.get(sceneId);
      if (!source) continue;
      if (!scene.dependsOn.includes(sceneId)) scene.dependsOn.push(sceneId);
      // The reference is only valid if the earlier scene publishes that name. The model often reads
      // a page URL it never declared, and the current URL is what such a reference means.
      if (!source.outputs.some((o: any) => o.name === output))
        source.outputs.push({ name: output, source: 'currentUrl', locatorId: null });
    }
    // The rule binds both ways: recovery predicates exist exactly when the policy is
    // verify_before_repeat. Drop predicates the policy does not call for, and when the policy asks
    // for predicates the model did not supply, fall back to the policy that never auto-repeats.
    if (scene.retryPolicy === 'verify_before_repeat') {
      if (!scene.recoveryConditions) scene.retryPolicy = 'manual_reset';
    } else scene.recoveryConditions = null;
    preceding.set(scene.id, scene);
  }
}
/**
 * The catalogue carries a few page-structure selectors so a scene can check that a screen is up.
 * They are not controls: a fill aimed at the form element itself simply waits out its timeout, which
 * is how a real run lost a scene. The schema cannot see this, so report it like a validation error.
 */
const STRUCTURE = new Set(['form', 'main', 'h1', 'header', 'body']);
/**
 * A scene runs as long as its narration, so the finished video is the narration end to end plus a
 * tail per scene. Compose rejects anything under 45 seconds, which is the required output spec, and
 * by then every scene has been recorded and rendered. Measure it here, where a retry costs one call.
 */
const SPOKEN_CHARS_PER_SECOND = 6;
const TARGET_SECONDS = 52;
function narrationTooShort(plan: Plan): string[] {
  const characters = plan.scenes.reduce((sum, s) => sum + s.narration.text.length, 0);
  const seconds = characters / SPOKEN_CHARS_PER_SECOND + plan.scenes.length;
  if (seconds >= TARGET_SECONDS) return [];
  const needed = Math.ceil((TARGET_SECONDS - seconds) * SPOKEN_CHARS_PER_SECOND);
  return [
    `The narration totals ${characters} characters across ${plan.scenes.length} scenes, about ${Math.round(seconds)} seconds of speech, and a video under 45 seconds is rejected. Add at least ${needed} more characters of narration, spread over the scenes or in an extra scene, keeping each scene within its own budget.`,
  ];
}
function interactionsOnPageStructure(plan: Plan): string[] {
  const structural = new Set(
    plan.locators
      .filter((l) => l.strategy === 'css' && typeof l.value === 'string' && STRUCTURE.has(l.value))
      .map((l) => l.id),
  );
  const problems: string[] = [];
  for (const scene of plan.scenes)
    for (const action of scene.actions)
      if (
        ['fill', 'click', 'select', 'press'].includes(action.type) &&
        'locatorId' in action &&
        structural.has(action.locatorId)
      )
        problems.push(
          `Scene ${scene.id} action ${action.id}: ${action.type} targets the page-structure locator ${action.locatorId}. Only a form control can be typed into or clicked; use the locator for the field or button itself, and keep structure locators for readyConditions and visibility checks.`,
        );
  return problems;
}
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
  const visible = observations.map((o) => ({
    ...o,
    locators: o.locators.filter((l) => catalogue.some((c) => c.id === l.id)),
  }));
  // The model does not always satisfy the plan schema; the cross-field rules (scene dependencies,
  // recovery predicates) are the ones it misses. Feeding the rejections back is far cheaper than
  // failing a job the user already waited a minute for.
  let draft: Awaited<ReturnType<typeof generateDraft>> | undefined;
  let plan: Plan | undefined;
  let corrections: string[] | undefined;
  // Three attempts fit the 600s queue expiry now that low reasoning effort lands a plan in about
  // 40 seconds, and the checks below reject in ways a retry can actually act on.
  for (let attempt = 0; attempt < 3 && !plan; attempt++) {
    draft = await generateDraft(cfg, project.intent, visible, fetch, corrections);
    declareDerivableFields(draft.scenes);
    const candidate = {
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
    };
    const parsed = PlanSchema.safeParse(candidate);
    if (parsed.success) {
      const unusable = [
        ...interactionsOnPageStructure(parsed.data),
        ...narrationTooShort(parsed.data),
      ];
      if (!unusable.length) {
        plan = parsed.data;
        break;
      }
      corrections = unusable;
    } else
      corrections = parsed.error.issues.map((i) =>
        i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
      );
    console.error(`[worker] plan draft rejected (attempt ${attempt + 1})`, corrections);
  }
  if (!plan)
    throw new AppError(
      'PLAN_GENERATION_FAILED',
      '계획을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
  assertExecutionPolicy(plan);
  for (const observation of observations)
    await db.put('observation', observation.id, project.owner, observation, project.projectId);
  return plan;
}
