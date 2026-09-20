import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import { hash } from '../../api/src/security.ts';
import type { Plan, ValidationReport } from '../../../packages/contracts/src/index.ts';
import { newContext, locate } from './browser.ts';
import { authenticate } from './authentication.ts';
import { validatePocPlan } from './poc-validation.ts';
import type { Observation } from './discovery.ts';
/**
 * Every scene re-opens its entry URL, so nothing a scene types survives into the next one. A plan
 * that fills a form in one scene and presses its button in another therefore submits an empty form
 * — and that only shows up minutes into a recording, as a precondition that never comes true. The
 * planner writes this shape often, so say it here, while the plan is still cheap to change.
 */
export function discardedFills(plan: Plan): ValidationReport['issues'] {
  const issues: ValidationReport['issues'] = [];
  const typed = new Map<string, { sceneId: string; url: string }>();
  for (const scene of plan.scenes) {
    // An entry URL is either a literal or a reference to an earlier scene's output; two scenes that
    // name the same reference open the same screen, so both forms need an identity of their own.
    const url =
      typeof scene.entry.url === 'string'
        ? scene.entry.url
        : `${scene.entry.url.sceneId}.${scene.entry.url.output}`;
    const here = new Set(
      scene.actions.flatMap((a) => (a.type === 'fill' || a.type === 'select' ? [a.locatorId] : [])),
    );
    if (scene.actions.some((a) => a.type === 'click' || a.type === 'press')) {
      const lost = [...typed.values()].find((t) => t.url === url);
      const stale = [...typed].some(([id, t]) => t.url === url && !here.has(id));
      if (lost && stale)
        issues.push({
          code: 'SCENE_STATE_NOT_CARRIED',
          message: `${lost.sceneId} 장면에서 입력한 내용은 이 장면이 같은 화면을 다시 열면서 지워집니다. 입력과 그 입력을 쓰는 클릭은 한 장면에 두세요.`,
          sceneId: scene.id,
          severity: 'warning',
        });
    }
    for (const id of here) typed.set(id, { sceneId: scene.id, url });
  }
  return issues;
}
export async function validatePlan(
  browser: Browser,
  db: Database,
  cfg: Config,
  plan: Plan,
  owner: string,
  sceneIds?: string[],
): Promise<ValidationReport> {
  if (cfg.pocMode) return validatePocPlan(browser, db, cfg, plan, owner, sceneIds);
  const report: ValidationReport = {
    reportId: `validation_${randomUUID()}`,
    planId: plan.planId,
    revision: plan.revision,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    targets: [],
    issues: [],
  };
  report.issues.push(...discardedFills(plan));
  const state = await authenticate(browser, db, cfg, plan, owner);
  const context = await newContext(browser, plan, state);
  const pages = new Map<string, Page>();
  const selected = plan.scenes.filter((s) => !sceneIds || sceneIds.includes(s.id));
  const serialized = JSON.stringify(selected);
  const required = new Set(
    plan.locators.filter((l) => serialized.includes(`"${l.id}"`)).map((l) => l.id),
  );
  for (const id of required) {
    let scope = plan.locators.find((l) => l.id === id)?.scopeLocatorId;
    while (scope) {
      required.add(scope);
      scope = plan.locators.find((l) => l.id === scope)?.scopeLocatorId;
    }
  }
  try {
    for (const id of required) {
      const spec = plan.locators.find((l) => l.id === id)!;
      const evidence = await db.get<Observation>('observation', spec.evidenceId, owner);
      const original = evidence?.locators.find((l) => l.id === id);
      let count = 0,
        visible = false,
        status: 'verified' | 'runtime_required' | 'blocked' = 'blocked';
      if (
        evidence &&
        original &&
        hash(original) === hash(spec) &&
        plan.target.allowedOrigins.includes(new URL(evidence.url).origin)
      ) {
        let page = pages.get(evidence.url);
        try {
          if (!page) {
            page = await context.newPage();
            await page.goto(evidence.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            pages.set(evidence.url, page);
          }
          if (page.url() !== evidence.url) throw Error('Unexpected redirect');
          const locator = locate(page, plan, id, {});
          count = await locator.count();
          visible = count === 1 && (await locator.isVisible());
          status = count > 1 ? 'blocked' : visible ? 'verified' : 'runtime_required';
        } catch {
          status = 'blocked';
        }
      }
      report.targets.push({ locatorId: id, status, count, evidenceId: spec.evidenceId });
      if (status === 'blocked')
        report.issues.push({
          code: count > 1 ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
          message:
            count > 1
              ? '같은 대상이 여러 개 있습니다. 앱에서 고유한 label 또는 testId를 지정해 주세요.'
              : '관측 근거와 일치하는 대상을 확인하지 못했습니다. 탐색 화면을 다시 지정해 계획을 생성해 주세요.',
          sceneId: null,
          severity: 'error',
        });
    }
    // Validation navigates and reads only; it never rehearses unapproved mutations.
    for (const scene of selected)
      if (typeof scene.entry.url === 'string') {
        const page = await context.newPage();
        try {
          await page.goto(scene.entry.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (page.url() !== scene.entry.url)
            report.issues.push({
              code: 'PRECONDITION_FAILED',
              message: '장면 진입 주소가 다른 화면으로 이동합니다. 주소 또는 인증을 확인해 주세요.',
              sceneId: scene.id,
              severity: 'error',
            });
        } catch {
          report.issues.push({
            code: 'PRECONDITION_FAILED',
            message: '장면 진입 화면에 접근하지 못했습니다.',
            sceneId: scene.id,
            severity: 'error',
          });
        } finally {
          await page.close();
        }
      }
  } finally {
    await context.close();
  }
  await db.put('validation', report.reportId, owner, report, plan.projectId);
  return report;
}
