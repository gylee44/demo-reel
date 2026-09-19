import { test, expect } from '@playwright/test';
import { config } from '../../apps/api/src/config.ts';
import { Database, createQueue } from '../../apps/api/src/db.ts';
import { createApp } from '../../apps/api/src/app.ts';
const cfg = { ...config(), pocMode: false },
  db = new Database(cfg.databaseUrl);
let queue: Awaited<ReturnType<typeof createQueue>>,
  app: Awaited<ReturnType<typeof createApp>>,
  origin: string;
test.beforeAll(async () => {
  await db.init();
  queue = await createQueue(cfg.databaseUrl);
  app = await createApp(db, queue, cfg);
  origin = await app.listen({ port: 0, host: '127.0.0.1' });
  cfg.webOrigin = origin;
});
test.afterAll(async () => {
  await app.close();
  await queue.stop();
  await db.close();
});
test('the studio opens without signing in and keeps the visitor across a reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  // Nothing stands between a first visit and the studio.
  await expect(page.getByRole('heading', { name: /링크 너머의 기능/ })).toBeVisible();
  await expect(page.getByLabel('이메일', { exact: true })).toHaveCount(0);
  for (const label of ['앱 주소', '보여줄 기능 한 문장', '테스트 계정 ID', '테스트 비밀번호'])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  await expect(page.getByText('로그인 화면 연결 설정')).toBeVisible();
  await expect(page.getByRole('button', { name: /실행 계획 만들기/ })).toBeDisabled();
  await page.getByRole('button', { name: '로그인 없음', exact: true }).click();
  await expect(page.getByText('로그인 없이 열리는 화면을 연결합니다.')).toBeVisible();
  await page.screenshot({ path: 'output/playwright/qa/service-connect.png', fullPage: true });
  const before = (await page.context().cookies()).find((c) => c.name === 'dr_visitor')?.value;
  expect(before).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('heading', { name: /링크 너머의 기능/ })).toBeVisible();
  // The same visitor comes back, so their projects and videos stay theirs.
  expect((await page.context().cookies()).find((c) => c.name === 'dr_visitor')?.value).toBe(before);
  expect(errors).toEqual([]);
});
test('the studio fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: /링크 너머의 기능/ })).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'output/playwright/qa/service-mobile.png', fullPage: true });
});
