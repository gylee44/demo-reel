import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from '../../apps/api/src/config.ts';
import { Database, createQueue } from '../../apps/api/src/db.ts';
import { createApp } from '../../apps/api/src/app.ts';
import { consumeLimit, passwordHash, passwordMatches } from '../../apps/api/src/accounts.ts';
const cfg = { ...config(), pocMode: false },
  db = new Database(cfg.databaseUrl),
  users: string[] = [],
  limitKey = `test-${randomUUID()}`;
let queue: Awaited<ReturnType<typeof createQueue>>, app: Awaited<ReturnType<typeof createApp>>;
const headers = (cookie = '') => ({ 'x-demo-reel': '1', cookie, 'idempotency-key': randomUUID() });
const cookie = (r: any) =>
  r.cookies
    .filter((x: any) => x.value)
    .map((x: any) => `${x.name}=${x.value}`)
    .join('; ');
const password = 'A proper test password 42';
async function signup() {
  const email = `${randomUUID()}@example.test`;
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/account/register',
    headers: headers(),
    payload: { email, password },
  });
  expect(r.statusCode).toBe(201);
  users.push(r.json().user.id);
  return { email, id: r.json().user.id, cookie: cookie(r) };
}
beforeAll(async () => {
  await db.init();
  queue = await createQueue(cfg.databaseUrl);
  app = await createApp(db, queue, cfg);
});
afterAll(async () => {
  for (const id of users) {
    await db.pool.query('DELETE FROM dr_records WHERE owner=$1', [id]);
    await db.pool.query('DELETE FROM dr_users WHERE id=$1', [id]);
  }
  await db.pool.query('DELETE FROM dr_limits WHERE key=$1', [limitKey]);
  await app.close();
  await queue.stop();
  await db.close();
});
it('hashes passwords with independent salts and rejects wrong passwords', async () => {
  const a = await passwordHash(password),
    b = await passwordHash(password);
  expect(a).not.toBe(b);
  expect(a).not.toContain(password);
  expect(await passwordMatches(password, a)).toBe(true);
  expect(await passwordMatches('wrong', a)).toBe(false);
});
it('requires a service account and refuses private target addresses', async () => {
  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: headers(),
    payload: { targetUrl: 'https://example.org', intent: '소개' },
  });
  expect(denied.statusCode).toBe(401);
  const u = await signup();
  for (const targetUrl of ['http://example.org', 'https://127.0.0.1', 'https://169.254.169.254']) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(u.cookie),
      payload: { targetUrl, intent: '소개' },
    });
    expect(r.statusCode).toBe(400);
  }
});
it('isolates projects across accounts and keeps ownership after logging in again', async () => {
  const a = await signup(),
    b = await signup();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: headers(a.cookie),
    payload: {
      targetUrl: 'https://example.org/app',
      intent: '앱 소개',
      discoveryUrls: ['https://example.org/settings'],
    },
  });
  expect(created.statusCode).toBe(201);
  const listA = await app.inject({ url: '/api/v1/projects', headers: headers(a.cookie) });
  expect(listA.json().projects).toHaveLength(1);
  const listB = await app.inject({ url: '/api/v1/projects', headers: headers(b.cookie) });
  expect(listB.json().projects).toEqual([]);
  const foreign = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${created.json().projectId}/auth`,
    headers: headers(b.cookie),
    payload: { mode: 'form', username: 'test', password: 'test' },
  });
  expect(foreign.statusCode).toBe(404);
  const logged = await app.inject({
    method: 'POST',
    url: '/api/v1/account/login',
    headers: headers(),
    payload: { email: a.email, password },
  });
  expect(logged.statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/api/v1/projects', headers: headers(cookie(logged)) })).json()
      .projects,
  ).toHaveLength(1);
  await app.inject({
    method: 'POST',
    url: '/api/v1/account/logout',
    headers: headers(cookie(logged)),
  });
  expect(
    (await app.inject({ url: '/api/v1/projects', headers: headers(cookie(logged)) })).statusCode,
  ).toBe(401);
});
it('revokes previous sessions after a password change', async () => {
  const a = await signup();
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/account/password',
    headers: headers(a.cookie),
    payload: { currentPassword: password, newPassword: 'A new secret password 43' },
  });
  expect(r.statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/api/v1/projects', headers: headers(a.cookie) })).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: '/api/v1/account/me', headers: headers(cookie(r)) })).json().user.id,
  ).toBe(a.id);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/account/login',
        headers: headers(),
        payload: { email: a.email, password },
      })
    ).statusCode,
  ).toBe(401);
});
it('rejects unspecified login targets and unconfigured generation instead of using fixtures', async () => {
  const a = await signup();
  const p = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: headers(a.cookie),
    payload: { targetUrl: 'https://example.org', intent: '사용자 입력 기능' },
  });
  const auth = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${p.json().projectId}/auth`,
    headers: headers(a.cookie),
    payload: { mode: 'form', username: 'someone', password: 'test-password' },
  });
  expect(auth.json().error.code).toBe('AUTH_PROFILE_REQUIRED');
  const plan = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${p.json().projectId}/plans`,
    headers: headers(a.cookie),
    payload: {},
  });
  expect(plan.statusCode).toBe(503);
  expect(plan.json().error.code).toBe('SERVICE_NOT_READY');
});
it('enforces a concurrent request limit atomically', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => consumeLimit(db, limitKey, 2)),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
});
