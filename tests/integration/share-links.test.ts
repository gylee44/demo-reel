import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from '../../apps/api/src/config.ts';
import { Database, createQueue } from '../../apps/api/src/db.ts';
import { createApp } from '../../apps/api/src/app.ts';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
const cfg = { ...config(), pocMode: false },
  db = new Database(cfg.databaseUrl),
  owners: string[] = [];
let queue: Awaited<ReturnType<typeof createQueue>>, app: Awaited<ReturnType<typeof createApp>>;
const headers = (cookie = '') => ({ 'x-demo-reel': '1', cookie, 'idempotency-key': randomUUID() });
/** A visitor is minted by the first request; its owner id is the part of the signed cookie before the signature. */
async function visitor() {
  const r = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: headers() });
  const set = r.cookies.find((c: any) => c.name === 'dr_visitor')!;
  const cookie = `dr_visitor=${set.value}`;
  const id = decodeURIComponent(set.value).split('.')[0];
  owners.push(id);
  return { id, cookie };
}
async function makeJob(owner: string, status = 'succeeded') {
  const plan = samplePlan(),
    jobId = `job_${randomUUID()}`,
    artifactId = `artifact_${randomUUID()}`;
  await db.put('plan_version', `${plan.planId}_${plan.revision}`, owner, plan, plan.projectId);
  await db.put(
    'plan',
    plan.planId,
    owner,
    {
      owner,
      projectId: plan.projectId,
      planId: plan.planId,
      revision: plan.revision,
      state: 'approved',
    },
    plan.projectId,
  );
  await db.put(
    'job',
    jobId,
    owner,
    {
      owner,
      projectId: plan.projectId,
      plan,
      approval: { approvalId: `approval_${randomUUID()}` },
      snapshot: {
        jobId,
        planId: plan.planId,
        revision: plan.revision,
        status,
        version: 1,
        stage: 'verify',
        outputArtifactId: artifactId,
        sceneAttempts: [],
      },
    },
    plan.projectId,
  );
  return { jobId, planId: plan.planId, artifactId };
}
beforeAll(async () => {
  await db.init();
  queue = await createQueue(cfg.databaseUrl);
  app = await createApp(db, queue, cfg);
});
afterAll(async () => {
  for (const o of owners) await db.pool.query('DELETE FROM dr_records WHERE owner=$1', [o]);
  await app.close();
  await queue.stop();
  await db.close();
});
it('lets someone without the cookie read a job the owner shared, and nothing else', async () => {
  const me = await visitor(),
    { jobId, planId } = await makeJob(me.id);
  const minted = await app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${jobId}/shares`,
    headers: headers(me.cookie),
    payload: {},
  });
  expect(minted.statusCode).toBe(200);
  const share = minted.json();
  const opened = await app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${jobId}?${share.job}`,
    headers: headers(),
  });
  expect(opened.statusCode).toBe(200);
  expect(opened.json().status).toBe('succeeded');
  // The result screen also needs the plan, so the job hands over a signature for it.
  expect(opened.json().share.plan).toBeTruthy();
  const plan = await app.inject({
    method: 'GET',
    url: `/api/v1/plans/${planId}?revision=1&${opened.json().share.plan}`,
    headers: headers(),
  });
  expect(plan.statusCode).toBe(200);
});
it('refuses a stranger with no signature at all', async () => {
  const me = await visitor(),
    { jobId } = await makeJob(me.id);
  const r = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: headers() });
  expect(r.statusCode).toBe(404);
});
it('refuses a forged signature and one minted for another record', async () => {
  const me = await visitor(),
    mine = await makeJob(me.id),
    other = await makeJob(me.id);
  const share = (
    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${mine.jobId}/shares`,
      headers: headers(me.cookie),
      payload: {},
    })
  ).json();
  const forged = await app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${mine.jobId}?${share.job.replace(/t=\w/, 't=0')}`,
    headers: headers(),
  });
  expect(forged.statusCode).toBe(403);
  const reused = await app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${other.jobId}?${share.job}`,
    headers: headers(),
  });
  expect(reused.statusCode).toBe(403);
});
it('refuses to mint for a job the caller does not own', async () => {
  const me = await visitor(),
    stranger = await visitor(),
    { jobId } = await makeJob(me.id);
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${jobId}/shares`,
    headers: headers(stranger.cookie),
    payload: {},
  });
  expect(r.statusCode).toBe(404);
});
it('refuses an expired link', async () => {
  const me = await visitor(),
    { jobId } = await makeJob(me.id);
  const share = (
    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/shares`,
      headers: headers(me.cookie),
      payload: {},
    })
  ).json();
  const past = share.job.replace(/e=\d+/, `e=${Date.now() - 1000}`);
  const r = await app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${jobId}?${past}`,
    headers: headers(),
  });
  expect(r.statusCode).toBe(403);
});
