import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Database } from '../../apps/api/src/db.ts';
import { config } from '../../apps/api/src/config.ts';
import { encrypt, AppError } from '../../apps/api/src/security.ts';
import { createDemoApp, resetDemo, DEMO_CREDENTIALS } from '../../apps/demo/src/app.ts';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
import {
  launchBrowser,
  authenticate,
  newContext,
  captureScene,
  uniqueTarget,
  installCursor,
  condition,
} from '../../apps/worker/src/browser.ts';
import {
  fixedNarration,
  syncOffset,
  renderScene,
  compose,
  probe,
} from '../../apps/worker/src/media.ts';
import { validatePlan } from '../../apps/worker/src/runner.ts';
import type { AuthRecord } from '../../apps/api/src/models.ts';
const cfg = config(),
  db = new Database(cfg.databaseUrl),
  owner = `test_${randomUUID()}`;
let browser: Awaited<ReturnType<typeof launchBrowser>>,
  demo: Awaited<ReturnType<typeof createDemoApp>>,
  plan: ReturnType<typeof samplePlan>;
beforeAll(async () => {
  await db.init();
  demo = await createDemoApp(db, cfg);
  const address = await demo.listen({ port: 0, host: '127.0.0.1' });
  cfg.demoOrigin = new URL(address).origin;
  plan = samplePlan(
    cfg.demoOrigin,
    `project_${randomUUID()}`,
    `plan_${randomUUID()}`,
    `auth_${randomUUID()}`,
  );
  const auth: AuthRecord = {
    authRef: plan.auth.authRef!,
    owner,
    projectId: plan.projectId,
    mode: 'form',
    ciphertext: encrypt({ mode: 'form', ...DEMO_CREDENTIALS }, cfg.key),
    expiresAt: plan.auth.expiresAt!,
  };
  await db.put('auth', auth.authRef, owner, auth, plan.projectId);
  await resetDemo(db);
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await demo?.close();
  await db.pool.query('DELETE FROM dr_records WHERE owner=$1', [owner]);
  await db.close();
});
it('logs in in a real browser and carries HttpOnly cookies to a new context', async () => {
  const state = await authenticate(browser, db, cfg, plan, owner);
  expect(typeof state).toBe('object');
  const context = await newContext(browser, plan, state),
    page = await context.newPage();
  await page.goto(`${cfg.demoOrigin}/dashboard`);
  await page.getByRole('heading', { name: '프로젝트 현황' }).waitFor();
  expect(await page.getByRole('heading', { name: '프로젝트 현황' }).count()).toBe(1);
  await context.close();
});
it('preserves the visible cursor position across full-page navigation', async () => {
  const state = await authenticate(browser, db, cfg, plan, owner),
    context = await newContext(browser, plan, state);
  await installCursor(context);
  const page = await context.newPage();
  await page.goto(cfg.demoOrigin + '/dashboard');
  await page.locator('#__dr_cursor').waitFor();
  await page.mouse.move(410, 240);
  await page.waitForTimeout(100);
  await page.goto(cfg.demoOrigin + '/tasks');
  await page.locator('#__dr_cursor').waitFor();
  const point = await page.locator('#__dr_cursor').evaluate((e) => {
    const m = new DOMMatrix(getComputedStyle(e).transform);
    return { x: m.m41, y: m.m42 };
  });
  expect(point).toEqual({ x: 410, y: 240 });
  await context.close();
});
it('observes real DOM without creating new test data and marks future headings conditional', async () => {
  const before = (await db.pool.query('SELECT count(*)::int AS n FROM dr_demo_tasks')).rows[0].n;
  const report = await validatePlan(browser, db, cfg, plan, owner);
  expect(report.issues).toEqual([]);
  expect(report.targets.find((t) => t.locatorId === 'created-title')?.status).toBe(
    'runtime_required',
  );
  expect((await db.pool.query('SELECT count(*)::int AS n FROM dr_demo_tasks')).rows[0].n).toBe(
    before,
  );
});
it('revalidates only recaptured scenes when an unrelated completed scene has changed', async () => {
  await db.pool.query("UPDATE dr_demo_tasks SET done=true WHERE id='seed-task'");
  try {
    const full = await validatePlan(browser, db, cfg, plan, owner);
    expect(full.targets.find((t) => t.locatorId === 'complete-task')?.status).toBe('blocked');
    const partial = await validatePlan(browser, db, cfg, plan, owner, ['overview']);
    expect(partial.issues).toEqual([]);
    expect(partial.targets.map((t) => t.locatorId).sort()).toEqual([
      'all-tasks',
      'dashboard',
      'tasks-heading',
    ]);
  } finally {
    await db.pool.query("UPDATE dr_demo_tasks SET done=false WHERE id='seed-task'");
  }
});
it('blocks browser subrequests outside the configured origin', async () => {
  const state = await authenticate(browser, db, cfg, plan, owner),
    context = await newContext(browser, plan, state),
    page = await context.newPage();
  await page.goto(cfg.demoOrigin + '/dashboard');
  const failures: string[] = [];
  page.on('requestfailed', (r) => failures.push(r.failure()?.errorText ?? ''));
  const result = await page.evaluate(async () => {
    try {
      await fetch('http://169.254.169.254/latest/meta-data');
      return 'leaked';
    } catch {
      return 'blocked';
    }
  });
  expect(result).toBe('blocked');
  expect(failures.some((f) => f.includes('BLOCKED_BY_CLIENT'))).toBe(true);
  await context.close();
});
it('rejects zero matches and ambiguous targets without choosing the first', async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.setContent('<button>동일 버튼</button><button>동일 버튼</button>');
  const p = structuredClone(plan);
  p.locators[0] = { ...p.locators[0], strategy: 'role', role: 'button', value: '동일 버튼' };
  await expect(uniqueTarget(page, p, p.locators[0].id, {}, 150)).rejects.toMatchObject({
    code: 'TARGET_AMBIGUOUS',
  });
  p.locators[0].value = '없는 버튼';
  await expect(uniqueTarget(page, p, p.locators[0].id, {}, 150)).rejects.toMatchObject({
    code: 'TARGET_NOT_FOUND',
  });
  await context.close();
});
it('rejects expired authentication before opening protected pages', async () => {
  const expired = { ...plan, auth: { ...plan.auth, authRef: 'missing_auth' } };
  await expect(authenticate(browser, db, cfg, expired, owner)).rejects.toMatchObject({
    code: 'AUTH_EXPIRED',
  });
});
it('records real UI, finds the video sync point, burns Korean captions and produces valid MP4', async () => {
  const state = await authenticate(browser, db, cfg, plan, owner),
    scene = structuredClone(plan.scenes[0]),
    dir = join(cfg.dataDir, 'browser-media-test', randomUUID());
  // A separate short interaction schedule tests media plumbing; production fixtures keep their original timings.
  scene.actions = scene.actions.map((a, i) => ({ ...a, atMs: 100 + i * 900 }));
  const narration = await fixedNarration(scene),
    captured = await captureScene(browser, plan, scene, state, {}, dir, narration.durationMs, {
      check: async () => {},
      beforeMutation: async () => {
        throw new Error('Unexpected mutation');
      },
    });
  const offset = await syncOffset(captured.rawPath);
  expect(offset).toBeGreaterThan(0.6);
  expect(offset).toBeLessThan(5);
  const rendered = await renderScene(
    browser,
    captured.rawPath,
    scene,
    narration,
    captured.durationMs,
    join(dir, 'render'),
    { knownOffset: offset },
  );
  const final = await compose(
    [{ path: rendered.path, durationMs: rendered.durationMs }],
    join(dir, 'final.mp4'),
    false,
  );
  expect(final.video.width).toBe(1280);
  expect(final.video.height).toBe(720);
  expect(final.video.r_frame_rate).toBe('30/1');
  expect(final.audio.codec_name).toBe('aac');
  expect(final.durationMs).toBeGreaterThan(narration.durationMs);
  expect((await readFile(join(dir, 'render/caption-0.png'))).length).toBeGreaterThan(1000);
  const raw = await probe(captured.rawPath);
  expect(raw.streams[0].width).toBe(1280);
  // A waiting stretch is cut out and the two sides spliced together, so the clip keeps the length
  // the narration asks for while consuming that much less of the recording.
  const cut = { startMs: 400, endMs: 1400 };
  const spliced = await renderScene(
    browser,
    captured.rawPath,
    scene,
    narration,
    captured.durationMs,
    join(dir, 'spliced'),
    { knownOffset: offset, elisions: [cut] },
  );
  expect(Math.abs(spliced.durationMs - rendered.durationMs)).toBeLessThan(250);
  expect((await probe(spliced.path)).streams[0].width).toBe(1280);
  // ...and the source it no longer has is really gone: cut away more than the scene may hold as a
  // frozen frame and the render refuses, which it could only know by accounting for the cut.
  await expect(
    renderScene(
      browser,
      captured.rawPath,
      scene,
      narration,
      captured.durationMs,
      join(dir, 'over'),
      {
        knownOffset: offset,
        elisions: [{ startMs: 0, endMs: captured.durationMs + scene.timing.maxFreezeMs }],
      },
    ),
  ).rejects.toMatchObject({ code: 'DURATION_EXCEEDED' });
}, 120000);
it('waits out a slow screen without spending the scene on it, and cuts the wait from the clip', async () => {
  const fault = async (slowTasksMs: number) =>
    expect(
      (
        await demo.inject({
          method: 'POST',
          url: '/__test/fault',
          headers: { 'x-demo-fixture': 'reset-v1' },
          payload: { slowTasksMs },
        })
      ).statusCode,
    ).toBe(200);
  const state = await authenticate(browser, db, cfg, plan, owner),
    scene = structuredClone(plan.scenes[0]),
    dir = join(cfg.dataDir, 'browser-media-test', randomUUID());
  // Open the list and wait for its heading. The fixture holds the task fetch for four seconds, so
  // the app is on a loading screen for most of the scene — the shape of every generate-and-wait UI.
  scene.actions = [
    { ...scene.actions[0], atMs: 200, timeoutMs: 5000 },
    {
      id: 'await_list',
      atMs: 600,
      timeoutMs: 3000,
      type: 'waitFor',
      condition: { type: 'visible', locatorId: 'tasks-heading' },
    } as (typeof scene.actions)[number],
  ];
  const narration = await fixedNarration(scene);
  await fault(4000);
  let captured;
  try {
    captured = await captureScene(browser, plan, scene, state, {}, dir, narration.durationMs, {
      check: async () => {},
      beforeMutation: async () => {
        throw new Error('Unexpected mutation');
      },
    });
  } finally {
    await fault(0);
  }
  // The action's own 3s timeout would have lost the scene; waiting is allowed to take longer.
  const cut = captured.elisions.reduce((sum, e) => sum + (e.endMs - e.startMs), 0);
  expect(cut).toBeGreaterThan(2000);
  // And the wait is not in the scene's time: the clip still runs to the narration, not past it.
  expect(captured.durationMs).toBe(narration.durationMs + scene.timing.tailHoldMs);
}, 120000);
it('does not silently use fixed audio for edited narration', async () => {
  const scene = structuredClone(plan.scenes[0]);
  scene.narration.text = '다른 설명';
  await expect(fixedNarration(scene)).rejects.toMatchObject({ code: 'TTS_FAILED' });
});
it('journals uncertainty when execution stops after a real create action; no duplicate retry occurs', async () => {
  await resetDemo(db);
  const state = await authenticate(browser, db, cfg, plan, owner),
    scene = structuredClone(plan.scenes[1]);
  scene.actions = scene.actions.map((a, i) => ({ ...a, atMs: i * 100 }));
  let effect = 'none';
  await expect(
    captureScene(
      browser,
      plan,
      scene,
      state,
      {},
      join(cfg.dataDir, 'browser-crash-test', randomUUID()),
      1000,
      {
        check: async () => {},
        beforeMutation: async () => {
          effect = 'unknown';
          await db.put('test_journal', owner, owner, { effect });
        },
        afterAction: async (a) => {
          if (a.id === 'create_save')
            throw new AppError('WORKER_INTERRUPTED', 'Injected stop after actual submission');
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'WORKER_INTERRUPTED' });
  expect(effect).toBe('unknown');
  expect((await db.get<any>('test_journal', owner, owner)).effect).toBe('unknown');
  expect(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM dr_demo_tasks WHERE title='데모 영상 만들기'",
      )
    ).rows[0].n,
  ).toBe(1);
}, 30000);

it('checks a filled field by its value, which is where a fill actually lands', async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.setContent(
    '<input id="addr"><textarea id="intent"></textarea><p id="note">고치지 않은 문단</p>',
  );
  const addr = 'https://example-app.test/',
    intent = '사용자 등록 후 기본 대시보드가 뜨는지 보여주기';
  await page.locator('#addr').fill(addr);
  await page.locator('#intent').fill(intent);
  const probe = {
    ...plan,
    locators: ['addr', 'intent', 'note'].map((n) => ({
      id: `loc_${n}`,
      strategy: 'css' as const,
      value: `#${n}`,
      role: null,
      exact: false,
      scopeLocatorId: null,
      evidenceId: plan.locators[0].evidenceId,
    })),
  };
  // Reading text here would see '' for the input and the empty markup for the textarea, so a plan
  // that verifies its own fill — which is what a planner writes — could never pass.
  for (const [locatorId, value] of [
    ['loc_addr', addr],
    ['loc_intent', intent],
    ['loc_note', '고치지 않은 문단'],
  ] as const)
    await expect(
      condition(page, probe, { type: 'textEquals', locatorId, value }, {}, 1000),
    ).resolves.toBeUndefined();
  await expect(
    condition(
      page,
      probe,
      { type: 'textEquals', locatorId: 'loc_addr', value: '다른 값' },
      {},
      500,
    ),
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  await context.close();
}, 30000);
