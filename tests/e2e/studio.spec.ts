import { test, expect } from '@playwright/test';
import { Database } from '../../apps/api/src/db.ts';
import { config } from '../../apps/api/src/config.ts';
import type { InternalJob, Artifact } from '../../apps/api/src/models.ts';
test.beforeEach(async ({ request }) => {
  const r = await request.post('http://127.0.0.1:4001/__test/reset', {
    headers: { 'x-demo-fixture': 'reset-v1' },
  });
  expect(r.ok()).toBeTruthy();
});
test('review, edit, approve, queue, record and play the real three-scene demo', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('보여줄 기능 한 문장').fill('업무를 추가하고 완료하는 기능을 보여주세요.');
  // The form opens on the choice that asks for nothing, so the credentials are a click away.
  await page.getByRole('button', { name: '테스트 계정', exact: true }).click();
  await page.getByLabel('테스트 계정 ID', { exact: true }).fill('demo@demo-reel.test');
  await page.getByLabel('테스트 비밀번호', { exact: true }).fill('demo-reel-poc');
  await expect(page.getByRole('heading', { name: /링크 너머의 기능/ })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/qa/connect.png', fullPage: true });
  await page.getByRole('button', { name: /실행 계획 만들기/ }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('demo-reel:operation')))
    .not.toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: '이렇게 보여드릴게요.' })).toBeVisible();
  await page.getByLabel('장면 제목', { exact: true }).fill('대시보드 핵심 기능');
  await expect(page.getByRole('button', { name: /이 계획으로 영상 만들기/ })).toBeDisabled();
  await page.getByRole('button', { name: '저장하고 검증', exact: true }).click();
  await expect(page.getByRole('button', { name: /이 계획으로 영상 만들기/ })).toBeEnabled();
  await page.screenshot({ path: 'output/playwright/qa/review.png', fullPage: true });
  const jobResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/jobs') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /이 계획으로 영상 만들기/ }).click();
  const job = await (await jobResponse).json();
  // State lives in the DB; refreshing must reconnect to the same approved job without creating a new one.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('demo-reel:job')))
    .not.toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: '실제 기능이 담긴 영상입니다.' })).toBeVisible({
    timeout: 150000,
  });
  const video = page.getByLabel('생성된 데모 영상');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(45);
  expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeLessThanOrEqual(75);
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    await v.play();
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.screenshot({ path: 'output/playwright/qa/result.png', fullPage: true });
  const db = new Database(config().databaseUrl);
  try {
    const stored = await db.get<InternalJob>('job', job.jobId);
    expect(stored?.snapshot.sceneAttempts).toHaveLength(3);
    expect(stored?.snapshot.sceneAttempts.every((a) => a.status === 'succeeded')).toBe(true);
    expect(await db.get('auth', stored!.plan.auth.authRef!, stored!.owner)).toBeNull();
    const artifact = await db.get<Artifact>(
      'artifact',
      stored!.snapshot.outputArtifactId!,
      stored!.owner,
    );
    expect(artifact?.mimeType).toBe('video/mp4');
  } finally {
    await db.close();
  }
  expect(errors).toEqual([]);
});
test('shows invalid authentication without starting a recording', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('보여줄 기능 한 문장').fill('업무를 추가하고 완료하는 기능을 보여주세요.');
  // The form opens on the choice that asks for nothing, so the credentials are a click away.
  await page.getByRole('button', { name: '테스트 계정', exact: true }).click();
  await page.getByLabel('테스트 계정 ID', { exact: true }).fill('demo@demo-reel.test');
  await page.getByLabel('테스트 비밀번호', { exact: true }).fill('demo-reel-poc');
  await page.getByLabel('테스트 비밀번호', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: /실행 계획 만들기/ }).click();
  await expect(page.getByRole('alert')).toContainText('테스트 계정을 확인');
  await expect(page.getByRole('heading', { name: /링크 너머의 기능/ })).toBeVisible();
});
test('rejects invalid plan input and keeps recording disabled', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('보여줄 기능 한 문장').fill('업무를 추가하고 완료하는 기능을 보여주세요.');
  // The form opens on the choice that asks for nothing, so the credentials are a click away.
  await page.getByRole('button', { name: '테스트 계정', exact: true }).click();
  await page.getByLabel('테스트 계정 ID', { exact: true }).fill('demo@demo-reel.test');
  await page.getByLabel('테스트 비밀번호', { exact: true }).fill('demo-reel-poc');
  await page.getByRole('button', { name: /실행 계획 만들기/ }).click();
  await expect(page.getByRole('heading', { name: '이렇게 보여드릴게요.' })).toBeVisible();
  await page.getByLabel('장면 제목', { exact: true }).fill('');
  await page.getByRole('button', { name: '저장하고 검증', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('입력값 또는 계획 형식');
  await expect(page.getByRole('button', { name: /이 계획으로 영상 만들기/ })).toBeDisabled();
});
