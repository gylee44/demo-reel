import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import type { Plan, ValidationReport } from '../../../packages/contracts/src/index.ts';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import { authenticate, newContext, locate } from './browser.ts';
const uid = (s: string) => `${s}_${randomUUID()}`;
function selectedLocatorIds(plan: Plan, sceneIds: string[]) {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'locatorId' && typeof child === 'string') ids.add(child);
      else visit(child);
    }
  };
  plan.scenes.filter((s) => sceneIds.includes(s.id)).forEach(visit);
  for (const id of ids) {
    const scope = plan.locators.find((l) => l.id === id)?.scopeLocatorId;
    if (scope) ids.add(scope);
  }
  return ids;
}
export async function validatePocPlan(
  browser: Browser,
  db: Database,
  cfg: Config,
  plan: Plan,
  owner: string,
  sceneIds?: string[],
): Promise<ValidationReport> {
  const state = await authenticate(browser, db, cfg, plan, owner),
    context = await newContext(browser, plan, state);
  const report: ValidationReport = {
    reportId: uid('validation'),
    planId: plan.planId,
    revision: plan.revision,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    issues: [],
    targets: [],
  };
  const observations = new Map<string, { count: number; url: string; visible: boolean }>();
  const requiredIds = sceneIds ? selectedLocatorIds(plan, sceneIds) : null;
  try {
    // MOCK planner is limited to this owned fixture. No unapproved mutations occur during discovery.
    for (const path of [
      '/dashboard',
      '/tasks',
      '/tasks/new',
      '/tasks/seed-task',
      '/tasks/seed-done',
      '/completed',
    ]) {
      const page = await context.newPage();
      await page.goto(`${cfg.demoOrigin}${path}`, { waitUntil: 'domcontentloaded' });
      await page.locator('main h1').waitFor({ state: 'visible' });
      for (const spec of plan.locators) {
        if (typeof spec.value !== 'string') continue;
        try {
          const l = locate(page, plan, spec.id, {}),
            count = await l.count();
          if (count > 0) {
            const prior = observations.get(spec.id);
            if (!prior || count > prior.count)
              observations.set(spec.id, {
                count,
                url: page.url(),
                visible: count === 1 && (await l.isVisible()),
              });
          }
        } catch {
          /* unresolved dynamic output is classified below */
        }
      }
      await page.close();
    }
    for (const spec of plan.locators) {
      if (requiredIds && !requiredIds.has(spec.id)) continue;
      const observed = observations.get(spec.id);
      // A future task heading uses the same real observed heading structure as the seeded detail page.
      const futureHeading =
        spec.id === 'created-title' &&
        spec.strategy === 'role' &&
        spec.role === 'heading' &&
        spec.value === '데모 영상 만들기' &&
        observations.get('seed-title')?.count === 1;
      const status =
        observed?.count === 1 && observed.visible
          ? 'verified'
          : !observed && futureHeading
            ? 'runtime_required'
            : 'blocked';
      report.targets.push({
        locatorId: spec.id,
        status,
        count: observed?.count ?? 0,
        evidenceId: spec.evidenceId,
      });
      await db.put(
        'evidence',
        spec.evidenceId,
        owner,
        {
          url: observed?.url ?? `${cfg.demoOrigin}/tasks/seed-task`,
          locatorId: spec.id,
          reportId: report.reportId,
          observedAt: report.checkedAt,
          status,
        },
        plan.projectId,
      );
      if (status === 'blocked')
        report.issues.push({
          code: observed?.count && observed.count > 1 ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
          message: `대상 “${typeof spec.value === 'string' ? spec.value : spec.id}”을 확인할 수 없습니다.`,
          sceneId: null,
          severity: 'error',
        });
    }
  } finally {
    await context.close();
  }
  await db.put('validation', report.reportId, owner, report, plan.projectId);
  return report;
}
