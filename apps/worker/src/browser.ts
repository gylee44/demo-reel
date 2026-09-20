import { startEgressProxy } from './egress.ts';
export { authenticate } from './authentication.ts';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
  type BrowserContextOptions,
} from 'playwright';
import { mkdir } from 'node:fs/promises';
import type { Config } from '../../api/src/config.ts';
import { AppError } from '../../api/src/security.ts';
import type { AuthRecord } from '../../api/src/models.ts';
import type { Database } from '../../api/src/db.ts';
import {
  resolveValue,
  type Plan,
  type Scene,
  type Condition,
  type Action,
  type Outputs,
} from '../../../packages/contracts/src/index.ts';
import { sceneDuration } from '../../../packages/contracts/src/rules.ts';

export async function launchBrowser(cfg?: Config): Promise<Browser> {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'DISPLAY', 'LANG'].flatMap((k) =>
      process.env[k] ? [[k, process.env[k]!]] : [],
    ),
  );
  const proxy = cfg && !cfg.pocMode ? await startEgressProxy() : null;
  try {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      env,
      ...(proxy
        ? {
            proxy: { server: proxy.url, bypass: '<-loopback>' },
            args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
          }
        : {}),
    });
    browser.on('disconnected', () => proxy?.close());
    return browser;
  } catch (e) {
    proxy?.close();
    throw e;
  }
}
export async function newContext(
  browser: Browser,
  plan: Pick<Plan, 'target'>,
  storageState?: BrowserContextOptions['storageState'],
  recordDir?: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'light',
    serviceWorkers: 'block',
    acceptDownloads: false,
    storageState,
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width: 1280, height: 720 } } } : {}),
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return ['http:', 'https:'].includes(u.protocol) &&
      plan.target.allowedOrigins.includes(u.origin) &&
      !u.username &&
      !u.password
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (ws) => ws.close());
  context.on('page', (page) => page.on('dialog', (dialog) => dialog.dismiss()));
  return context;
}
export function locate(page: Page, plan: Plan, id: string, outputs: Outputs): Locator {
  const spec = plan.locators.find((l) => l.id === id);
  if (!spec) throw new AppError('TARGET_NOT_FOUND', '계획의 대상을 찾을 수 없습니다.');
  const scope = spec.scopeLocatorId ? locate(page, plan, spec.scopeLocatorId, outputs) : page;
  const value = resolveValue(spec.value, outputs);
  switch (spec.strategy) {
    case 'role':
      return scope.getByRole(spec.role as Parameters<Page['getByRole']>[0], {
        name: value,
        exact: spec.exact,
      });
    case 'label':
      // A <label> that wraps its control takes that control's value into its accessible name, so
      // the exact label observed on an empty form stops matching the moment the field is filled —
      // which broke every scene that types into a field and then checks it. Anchor at the start so
      // the typed text is tolerated without letting a longer, different label match.
      return spec.exact
        ? scope.getByLabel(new RegExp('^\\s*' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        : scope.getByLabel(value, { exact: false });
    case 'testId':
      return scope.getByTestId(value);
    case 'css':
      return scope.locator(value);
  }
}
/**
 * What a filled field shows lives in `value`, not in its text: an `<input>` has no text at all, and
 * a `<textarea>` keeps only the markup's original content. Reading text alone therefore makes every
 * `textEquals` that checks a `fill` fail no matter what was typed — which is most of them, since a
 * plan verifies an input by naming the value it just entered.
 */
async function shownText(l: Locator) {
  const tag = await l.evaluate((e) => e.tagName.toLowerCase());
  return (
    tag === 'input' || tag === 'textarea' || tag === 'select'
      ? await l.inputValue()
      : ((await l.textContent()) ?? '')
  ).trim();
}
export async function condition(
  page: Page,
  plan: Plan,
  c: Condition,
  outputs: Outputs,
  timeout = 5000,
): Promise<void> {
  const until = Date.now() + timeout;
  do {
    if (c.type === 'urlMatches') {
      if (page.url() === resolveValue(c.value, outputs)) return;
    } else {
      const l = locate(page, plan, c.locatorId, outputs),
        count = await l.count();
      if (c.type === 'countEquals') {
        if (count === c.value) return;
      } else if (c.type === 'hidden') {
        if (count === 0 || (count === 1 && !(await l.isVisible()))) return;
      } else if (count > 1)
        throw new AppError(
          'TARGET_AMBIGUOUS',
          '같은 대상이 여러 개 발견되었습니다. 범위를 좁혀 주세요.',
        );
      else if (count === 1) {
        if (c.type === 'visible' && (await l.isVisible())) return;
        if (c.type === 'textEquals' && (await shownText(l)) === resolveValue(c.value, outputs))
          return;
      }
    }
    await page.waitForTimeout(80);
  } while (Date.now() < until);
  throw new AppError('PRECONDITION_FAILED', '예상한 화면 또는 데이터 상태를 확인하지 못했습니다.');
}
/**
 * A long wait must still notice a cancelled job or an expired session, and `condition` polls without
 * looking up. Slice the wait so the caller's check runs between slices, and only let the last slice
 * report the failure — anything other than the screen not being there yet is already final.
 */
async function patientCondition(
  page: Page,
  plan: Plan,
  c: Condition,
  outputs: Outputs,
  timeout: number,
  check: () => Promise<void>,
): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    const slice = Math.min(2500, end - Date.now());
    try {
      return await condition(page, plan, c, outputs, Math.max(1, slice));
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'PRECONDITION_FAILED') throw error;
      if (Date.now() >= end) throw error;
    }
    await check();
  }
}
export async function uniqueTarget(
  page: Page,
  plan: Plan,
  id: string,
  outputs: Outputs,
  timeout: number,
) {
  const l = locate(page, plan, id, outputs);
  const end = Date.now() + timeout;
  while ((await l.count()) === 0 && Date.now() < end) await page.waitForTimeout(60);
  const count = await l.count();
  if (count === 0) throw new AppError('TARGET_NOT_FOUND', '화면에서 조작 대상을 찾지 못했습니다.');
  if (count !== 1)
    throw new AppError('TARGET_AMBIGUOUS', '동일한 대상이 여러 개 있어 실행을 멈췄습니다.');
  await l.waitFor({ state: 'visible', timeout });
  if (!(await l.isEnabled()))
    throw new AppError('TARGET_DISABLED', '대상이 비활성화되어 있습니다.');
  return l;
}
export async function installCursor(context: BrowserContext) {
  let lastPosition = { x: 34, y: 34 };
  await context.exposeBinding('__drCursorState', (_source, position?: { x: number; y: number }) => {
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y))
      lastPosition = {
        x: Math.max(0, Math.min(1280, position.x)),
        y: Math.max(0, Math.min(720, position.y)),
      };
    return lastPosition;
  });
  // Keep the serialized page function self-contained: tsx adds a Node-only __name helper
  // to named local functions, which is unavailable in the browser's init-script context.
  await context.addInitScript(async () => {
    if (document.readyState === 'loading')
      await new Promise<void>((resolve) =>
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
      );
    if (document.getElementById('__dr_cursor')) return;
    const position = await (window as any).__drCursorState();
    const cursor = document.createElement('div');
    cursor.id = '__dr_cursor';
    cursor.style.cssText =
      'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483646;pointer-events:none;transform:translate(34px,34px);filter:drop-shadow(0 2px 3px #0006)';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.transform = `translate(${position.x}px,${position.y}px)`;
    cursor.innerHTML =
      '<svg width="26" height="30" viewBox="0 0 26 30"><path d="M3 2L3 23L9 18L14 28L19 25L14 16L23 15Z" fill="white" stroke="#15382a" stroke-width="2"/></svg>';
    document.documentElement.append(cursor);
    window.addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
      void (window as any).__drCursorState({ x: e.clientX, y: e.clientY });
    });
    window.addEventListener('mousedown', (e) => {
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border:3px solid #63cf97;background:#7befac45;border-radius:50%;z-index:2147483645;pointer-events:none;`;
      document.documentElement.append(ring);
      ring.animate(
        [
          { transform: 'scale(.5)', opacity: 1 },
          { transform: 'scale(1.6)', opacity: 0 },
        ],
        { duration: 550 },
      ).onfinish = () => ring.remove();
    });
  });
}
async function moveCursor(page: Page, l: Locator) {
  await l.scrollIntoViewIfNeeded();
  let box = await l.boundingBox();
  if (!box) throw new AppError('TARGET_NOT_FOUND', '대상 위치를 확인하지 못했습니다.');
  const pos = await page.evaluate(() => {
    const e = document.getElementById('__dr_cursor');
    const m = e ? new DOMMatrix(getComputedStyle(e).transform) : null;
    return { x: m?.m41 ?? 34, y: m?.m42 ?? 34 };
  });
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  for (let i = 1; i <= 20; i++) {
    const t = i / 20,
      eased = t * t * (3 - 2 * t);
    await page.mouse.move(pos.x + (x - pos.x) * eased, pos.y + (y - pos.y) * eased);
    await page.waitForTimeout(16);
  }
  box = await l.boundingBox();
  if (!box) throw new AppError('TARGET_NOT_FOUND', '대상이 이동하거나 사라졌습니다.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}
/** Where a scene was looking, in scene time, so the finished clip can lean in on it. */
export type Focus = { atMs: number; x: number; y: number; width: number; height: number };
export type CaptureHooks = {
  check: () => Promise<void>;
  beforeMutation: (a: Action) => Promise<void>;
  afterAction?: (a: Action, page: Page) => Promise<void>;
};
/** A stretch of scene time that is cut out of the clip, measured from the recording sync point. */
export type Elision = { startMs: number; endMs: number };
/**
 * An app that generates something — a plan, a video, a report — makes the user wait far longer than
 * any interaction does, and that wait is the one part of a demonstration nobody wants to watch. So
 * it is neither charged to the scene budget nor kept in the clip: the recording is cut and the
 * result is spliced on, which is what an editor would do by hand. Waiting can then be generous.
 */
const LOADING_WAIT_MS = 120000;
/** Conditions checked after the actions: a result that never lands must not hold the queue open. */
const POSTCONDITION_WAIT_MS = 30000;
/** The entry screen is awaited before recording starts, so a slow first paint costs the clip nothing. */
const ENTRY_WAIT_MS = 30000;
/** Below this a wait reads as the app being responsive, and cutting it would only make the clip jumpy. */
const ELIDE_AFTER_MS = 1500;
/** Keep the head of a long wait, so the viewer sees the app working before the result appears. */
const ELISION_LEAD_MS = 800;
export type WaitOut = <T>(run: () => Promise<T>) => Promise<T>;
async function action(
  page: Page,
  plan: Plan,
  a: Action,
  outputs: Outputs,
  hooks: CaptureHooks,
  mutating: boolean,
  waitOut: WaitOut = (run) => run(),
  onFocus: (box: { x: number; y: number; width: number; height: number }) => void = () => {},
) {
  if (a.type === 'navigate') {
    const target = new URL(resolveValue(a.url, outputs));
    if (!plan.target.allowedOrigins.includes(target.origin))
      throw new AppError('URL_BLOCKED', '승인 범위 밖 URL입니다.');
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: a.timeoutMs });
    return;
  }
  if (a.type === 'assert' || a.type === 'waitFor') {
    // waitFor is the plan saying the app needs a moment; assert is it saying the screen is already
    // there. Only the first is allowed to take its time, and only the first is cut from the clip.
    if (a.type === 'waitFor')
      await waitOut(() =>
        patientCondition(
          page,
          plan,
          a.condition,
          outputs,
          Math.max(a.timeoutMs, LOADING_WAIT_MS),
          hooks.check,
        ),
      );
    else await condition(page, plan, a.condition, outputs, a.timeoutMs);
    // The narration is describing this element, so put it on camera. isVisible() is true for an
    // element sitting below the fold, and of the actions only a click scrolls to its own target,
    // so a scene that just waits for something can otherwise talk about an off-screen element.
    if ('locatorId' in a.condition && a.condition.type === 'visible')
      await locate(page, plan, a.condition.locatorId, outputs)
        .scrollIntoViewIfNeeded({ timeout: 2000 })
        .catch(() => {});
    return;
  }
  if (a.type === 'scroll') {
    await page.mouse.wheel(0, a.deltaY);
    return;
  }
  const l = await uniqueTarget(page, plan, a.locatorId, outputs, a.timeoutMs);
  onFocus(await moveCursor(page, l));
  if (mutating) await hooks.beforeMutation(a);
  if (a.type === 'click') await l.click({ timeout: a.timeoutMs });
  if (a.type === 'fill') {
    await l.fill('', { timeout: a.timeoutMs });
    await l.pressSequentially(resolveValue(a.value, outputs), { delay: 30, timeout: a.timeoutMs });
  }
  if (a.type === 'select')
    await l.selectOption(resolveValue(a.value, outputs), { timeout: a.timeoutMs });
  if (a.type === 'press') await l.press(a.key, { timeout: a.timeoutMs });
}
export async function captureScene(
  browser: Browser,
  plan: Plan,
  scene: Scene,
  storageState: BrowserContextOptions['storageState'],
  outputs: Outputs,
  dir: string,
  audioMs: number,
  hooks: CaptureHooks,
) {
  await mkdir(dir, { recursive: true });
  const context = await newContext(browser, plan, storageState, dir);
  await installCursor(context);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  let actionId: string | null = null;
  const elisions: Elision[] = [];
  const focus: Focus[] = [];
  let elidedMs = 0;
  try {
    await page.goto(resolveValue(scene.entry.url, outputs), {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    for (const c of [...scene.entry.readyConditions, ...scene.preconditions])
      await condition(page, plan, c, outputs, ENTRY_WAIT_MS);
    await page.locator('#__dr_cursor').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const m = document.createElement('div');
      m.id = '__dr_sync';
      m.style.cssText =
        'position:fixed;left:0;top:0;width:64px;height:64px;background:#00ff00;z-index:2147483647';
      document.documentElement.append(m);
    });
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('__dr_sync')?.remove());
    await page.waitForTimeout(120);
    const started = performance.now();
    // Two clocks: recorded time, which the cuts are expressed in, and scene time, which is what the
    // finished clip will show once the cuts are taken out. Everything the plan says — atMs, the
    // budget, the timeouts — is about scene time, because that is the time the viewer spends.
    const recordedMs = () => performance.now() - started;
    const sceneMs = () => recordedMs() - elidedMs;
    const waitOut: WaitOut = async (run) => {
      const from = recordedMs();
      try {
        return await run();
      } finally {
        const spent = recordedMs() - from;
        if (spent > ELIDE_AFTER_MS) {
          const cut = { startMs: from + ELISION_LEAD_MS, endMs: recordedMs() };
          elisions.push(cut);
          elidedMs += cut.endMs - cut.startMs;
        }
      }
    };
    async function waitTo(ms: number) {
      while (sceneMs() < ms) {
        await hooks.check();
        const remaining = ms - sceneMs();
        if (remaining > 0) await page.waitForTimeout(Math.min(300, remaining));
      }
    }
    for (const a of scene.actions) {
      actionId = a.id;
      await waitTo(a.atMs);
      await hooks.check();
      if (sceneMs() >= scene.timing.maxDurationMs)
        throw new AppError('DURATION_EXCEEDED', '장면의 실행 시간이 초과되었습니다.');
      // A waitFor keeps its own generous allowance: the budget it would be clamped to is about how
      // much video the scene may hold, and the waiting is not going to be in the video.
      const bounded =
        a.type === 'waitFor'
          ? a
          : {
              ...a,
              timeoutMs: Math.max(
                1,
                Math.min(a.timeoutMs, scene.timing.maxDurationMs - Math.ceil(sceneMs())),
              ),
            };
      await action(
        page,
        plan,
        bounded,
        outputs,
        hooks,
        scene.effects.writes.length > 0,
        waitOut,
        (box) => focus.push({ atMs: Math.round(sceneMs()), ...box }),
      );
      await hooks.afterAction?.(a, page);
    }
    for (const c of scene.postconditions)
      await waitOut(() =>
        patientCondition(page, plan, c, outputs, POSTCONDITION_WAIT_MS, hooks.check),
      );
    // Clamped, not checked: the actions having run long is a reason to end the clip at the budget,
    // never a reason to throw away a scene that did everything the plan asked of it.
    const actionEndMs = Math.min(
      Math.ceil(sceneMs()),
      scene.timing.maxDurationMs - scene.timing.tailHoldMs,
    );
    const durationMs = sceneDuration(scene, audioMs, Math.max(0, actionEndMs));
    await waitTo(durationMs + 400);
    const result: Record<string, string> = {};
    for (const o of scene.outputs) {
      const l = o.locatorId ? locate(page, plan, o.locatorId, outputs) : null;
      const value =
        o.source === 'currentUrl'
          ? page.url()
          : o.source === 'href'
            ? await l!.getAttribute('href')
            : await l!.textContent();
      if (value === null)
        throw new AppError('PRECONDITION_FAILED', '후속 장면에 필요한 결과를 얻지 못했습니다.');
      if (o.source !== 'text') {
        const u = new URL(value, page.url());
        if (!plan.target.allowedOrigins.includes(u.origin))
          throw new AppError('URL_BLOCKED', '출력 URL이 허용 범위를 벗어났습니다.');
        result[o.name] = u.href;
      } else result[o.name] = value.trim();
    }
    const nextState = await context.storageState(),
      video = page.video()!;
    await context.close();
    return {
      rawPath: await video.path(),
      durationMs,
      elisions,
      focus,
      outputs: result,
      storageState: nextState,
    };
  } catch (error) {
    // Everything unexpected in here used to become ACTION_TIMEOUT, taking the real cause with it:
    // the generic AppError replaces the original before `failure` in the runner ever sees it, so
    // the one place a production failure could be read from went silent. Log it before replacing.
    if (!(error instanceof AppError))
      console.error(`[worker] capture failed scene=${scene.id} action=${actionId}`, error);
    const e =
      error instanceof AppError
        ? error
        : new AppError('ACTION_TIMEOUT', '화면 조작을 제한 시간 안에 마치지 못했습니다.');
    const screenshotPath = `${dir}/failure.png`;
    const video = page.video();
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    await context.close().catch(() => {});
    // What was recorded before the break is still a usable shot of the app, and the runner would
    // rather cut the scene short than hand back a job with no video in it at all.
    const rawPath = await video?.path().catch(() => undefined);
    Object.assign(e, { actionId, screenshotPath, rawPath, elisions });
    throw e;
  }
}
