import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { config } from '../../apps/api/src/config.ts';
import { Database, createQueue } from '../../apps/api/src/db.ts';
import { createApp } from '../../apps/api/src/app.ts';
const cfg = { ...config(), pocMode: false },
  db = new Database(cfg.databaseUrl);
let queue: Awaited<ReturnType<typeof createQueue>>,
  app: Awaited<ReturnType<typeof createApp>>,
  origin: string;
const accounts: string[] = [];
test.beforeAll(async () => {
  await db.init();
  queue = await createQueue(cfg.databaseUrl);
  app = await createApp(db, queue, cfg);
  origin = await app.listen({ port: 0, host: '127.0.0.1' });
  cfg.webOrigin = origin;
});
test.afterAll(async () => {
  for (const email of accounts) await db.pool.query('DELETE FROM dr_users WHERE email=$1', [email]);
  await app.close();
  await queue.stop();
  await db.close();
});
test('real service signup, empty app connection form, session restore and logout', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const email = `ui-${randomUUID()}@example.test`;
  accounts.push(email);
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '다시 만나 반가워요.' })).toBeVisible();
  await page.getByRole('button', { name: '처음이라면 계정 만들기' }).click();
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill('New service test password 42');
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('New service test password 42');
  await page.getByRole('button', { name: '가입하고 시작하기' }).click();
  await expect(page.getByRole('heading', { name: /링크 너머의 기능/ })).toBeVisible();
  for (const label of ['앱 주소', '보여줄 기능 한 문장', '테스트 계정 ID', '테스트 비밀번호'])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  await expect(page.getByText('로그인 화면 연결 설정')).toBeVisible();
  await expect(page.getByRole('button', { name: /실행 계획 만들기/ })).toBeDisabled();
  await page.getByRole('button', { name: '로그인 없음', exact: true }).click();
  await expect(page.getByText('로그인 없이 열리는 화면을 연결합니다.')).toBeVisible();
  await page.screenshot({ path: 'output/playwright/qa/service-connect.png', fullPage: true });
  await page.reload();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('heading', { name: '다시 만나 반가워요.' })).toBeVisible();
  expect(errors).toEqual([]);
});
test('mobile login fits the viewport and shows a failed login clearly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.getByLabel('이메일', { exact: true }).fill(`absent-${randomUUID()}@example.test`);
  await page.getByLabel('비밀번호', { exact: true }).fill('A wrong password 99');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('이메일 또는 비밀번호');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'output/playwright/qa/service-login-mobile.png', fullPage: true });
});
