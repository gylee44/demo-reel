import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { config } from '../apps/api/src/config.ts';
import { Database } from '../apps/api/src/db.ts';
import type { Artifact, InternalJob, Operation } from '../apps/api/src/models.ts';
import type {
  Approval,
  Job,
  Plan,
  RecoveryPreview,
  ValidationReport,
} from '../packages/contracts/src/index.ts';
import { hash } from '../apps/api/src/security.ts';
import { probe } from '../apps/worker/src/media.ts';
import { DEMO_CREDENTIALS } from '../apps/demo/src/app.ts';

// Uses a dedicated PoC database. It resets only this project's owned demo fixture.
const cfg = config();
assert(cfg.pocMode, 'PoC fixture mode must be enabled');
assert.equal(cfg.demoOrigin, 'http://127.0.0.1:4001', 'PoC driver manages localhost services');
const apiOrigin = 'http://127.0.0.1:4000';
const dir = resolve(cfg.dataDir, 'poc');
await mkdir(dir, { recursive: true });
const db = new Database(cfg.databaseUrl);
const children = new Set<ChildProcess>();
const report: Record<string, any> = {
  startedAt: new Date().toISOString(),
  expected: {
    repeats: 'Three identical semantic plans succeed from the same seeded data',
    recovery: 'Only overview is recaptured; two clip IDs and hashes remain unchanged',
    crash: 'Exit 86 after task save; one task, unknown outcome, no automatic replay',
  },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  repeats: [],
  status: 'running',
};
async function save() {
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 180000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await pause(500);
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}
async function listening(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(700) })).ok;
  } catch {
    return false;
  }
}
async function start(name: 'api' | 'demo' | 'worker', extra: Record<string, string> = {}) {
  const log = createWriteStream(join(dir, `${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, ['--import', 'tsx', `apps/${name}/src/main.ts`], {
    env: { ...process.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  child.once('close', () => {
    children.delete(child);
    log.end();
  });
  const port = { api: 4000, demo: 4001, worker: 4002 }[name];
  await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${name} exited before ready; see ${name}.log`);
    return (await listening(`http://127.0.0.1:${port}/health`)) ? true : undefined;
  }, 30000);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  await exited;
  clearTimeout(timeout);
}
function client() {
  let cookie = '';
  return async <T = any>(path: string, body?: unknown, expected?: number): Promise<T> => {
    const response = await fetch(apiOrigin + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-reel': '1',
        Origin: cfg.webOrigin,
        Cookie: cookie,
        'Idempotency-Key': randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const session = response.headers.getSetCookie()[0];
    if (session) cookie = session.split(';')[0];
    const data = await response.json();
    if (expected) assert.equal(response.status, expected, JSON.stringify(data));
    else assert(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return data as T;
  };
}
async function fixture(path: 'reset' | 'fault', body: unknown = {}) {
  const response = await fetch(`${cfg.demoOrigin}/__test/${path}`, {
    method: 'POST',
    headers: { 'x-demo-fixture': 'reset-v1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, `Fixture ${path} failed`);
}
async function prepare() {
  const request = client();
  const project = await request('/projects', {
    targetUrl: cfg.demoOrigin,
    intent: '업무를 추가하고 완료하는 흐름',
  });
  const auth = await request(`/projects/${project.projectId}/auth`, {
    mode: 'form',
    ...DEMO_CREDENTIALS,
  });
  const queued = await request(`/projects/${project.projectId}/plans`, { authRef: auth.authRef });
  const op = await until(async () => {
    const item = await request<Operation>(`/operations/${queued.operationId}`);
    assert.notEqual(item.status, 'failed', JSON.stringify(item.error));
    return item.status === 'succeeded' ? item : undefined;
  }, 60000);
  const { plan, effectsHash } = await request<{ plan: Plan; effectsHash: string }>(
    `/plans/${op.planId}`,
  );
  const approval = await request<Approval>(`/plans/${plan.planId}/approvals`, {
    revision: plan.revision,
    reportId: op.reportId,
    acceptedEffectsHash: effectsHash,
  });
  const semanticPlan = {
    ...plan,
    planId: null,
    projectId: null,
    createdAt: null,
    auth: { mode: plan.auth.mode },
    locators: plan.locators.map(({ evidenceId: _, ...locator }) => locator),
  };
  return { request, project, plan, approval, semanticHash: hash(semanticPlan) };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function enqueue(p: Prepared) {
  return p.request<Job>('/jobs', {
    planId: p.plan.planId,
    revision: p.plan.revision,
    approvalId: p.approval.approvalId,
  });
}
async function terminal(p: Prepared, jobId: string) {
  return until(async () => {
    const job = await p.request<Job>(`/jobs/${jobId}`);
    return ['queued', 'running'].includes(job.status) ? undefined : job;
  });
}
async function artifact(job: Job) {
  assert.equal(job.status, 'succeeded', JSON.stringify(job.failure ?? job.sceneAttempts));
  assert.equal(job.sceneAttempts.length, 3);
  assert(job.sceneAttempts.every((attempt) => attempt.status === 'succeeded'));
  const record = (await db.get<InternalJob>('job', job.jobId))!;
  assert.equal(await db.get('auth', record.plan.auth.authRef!, record.owner), null);
  const result = (await db.get<Artifact>('artifact', job.outputArtifactId!, record.owner))!;
  const meta = await probe(result.path);
  const duration = Number(meta.format.duration);
  assert(duration >= 45 && duration <= 75);
  const video = meta.streams.find((s: any) => s.codec_type === 'video');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.r_frame_rate, '30/1');
  assert.equal(meta.streams.find((s: any) => s.codec_type === 'audio').codec_name, 'aac');
  return { result, duration, record };
}
async function preview(p: Prepared, base: Job, sceneIds: string[]) {
  return p.request<RecoveryPreview>(`/jobs/${base.jobId}/recovery-preview`, {
    sceneIds,
    mode: 'recapture',
    planId: p.plan.planId,
    revision: p.plan.revision,
  });
}
try {
  for (const port of [4000, 4001, 4002])
    assert(
      !(await listening(`http://127.0.0.1:${port}/health`)),
      `Port ${port} is occupied; stop the existing project service first`,
    );
  await db.init();
  await start('demo');
  await start('api');
  let worker = await start('worker');
  for (let trial = 1; trial <= 3; trial++) {
    console.log(`PoC ${trial}/3: expected identical plan, three scenes, playable 45–75 second MP4`);
    await fixture('reset');
    const p = await prepare();
    const startMs = Date.now();
    const finished = await terminal(p, (await enqueue(p)).jobId);
    const { result, duration } = await artifact(finished);
    const elapsedMs = Date.now() - startMs;
    if (trial > 1) assert.equal(p.semanticHash, report.repeats[0].semanticPlanHash);
    report.repeats.push({
      trial,
      jobId: finished.jobId,
      semanticPlanHash: p.semanticHash,
      durationSeconds: duration,
      elapsedMs,
      sha256: result.sha256,
      authDisposed: true,
      scenes: finished.sceneAttempts.map((a) => ({
        sceneId: a.sceneId,
        status: a.status,
        durationMs: a.durationMs,
        trimStartMs: a.trimStartMs,
      })),
    });
    if (trial === 1) await copyFile(result.path, join(dir, 'demo-reel.mp4'));
    console.log(
      `PoC ${trial}/3: passed, ${duration}s, ${Math.round(elapsedMs / 1000)}s processing`,
    );
    await save();
  }
  console.log('Partial recovery: expected one failed scene, two preserved clips, then success');
  await fixture('reset');
  const p = await prepare();
  await fixture('fault', { brokenOverview: true });
  const base = await terminal(p, (await enqueue(p)).jobId);
  assert.equal(base.status, 'needs_action');
  assert.equal(base.sceneAttempts.find((a) => a.sceneId === 'overview')?.status, 'failed');
  const preserved = base.sceneAttempts.filter((a) => a.sceneId !== 'overview');
  assert(preserved.every((a) => a.status === 'succeeded'));
  await fixture('fault', { brokenOverview: false });
  const initialPreview = await preview(p, base, ['overview']);
  assert(initialPreview.requiresAuth);
  assert(!initialPreview.requiresStateReset);
  await p.request(`/projects/${p.project.projectId}/auth`, { mode: 'form', ...DEMO_CREDENTIALS });
  const ready = await preview(p, base, ['overview']);
  assert.deepEqual(ready.captureSceneIds, ['overview']);
  assert.equal(ready.reuseArtifactIds.length, 2);
  // Exercise the delayed-recovery boundary without waiting ten minutes. The unrelated
  // completed task no longer has a completion button, so only overview may be revalidated.
  const storedBase = (await db.get<InternalJob>('job', base.jobId))!;
  const oldReport = (await db.get<ValidationReport>(
    'validation',
    p.approval.reportId,
    storedBase.owner,
  ))!;
  await db.put(
    'validation',
    oldReport.reportId,
    storedBase.owner,
    {
      ...oldReport,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
    p.project.projectId,
  );
  const recovery = await p.request<Job>(`/jobs/${base.jobId}/recoveries`, {
    previewId: ready.previewId,
    approvalId: p.approval.approvalId,
  });
  const recovered = await terminal(p, recovery.jobId);
  await artifact(recovered);
  for (const prior of preserved) {
    const current = recovered.sceneAttempts.find((a) => a.sceneId === prior.sceneId)!;
    assert.equal(current.renderedArtifactId, prior.renderedArtifactId);
    assert.equal(current.captureHash, prior.captureHash);
    assert.equal(current.reusedFromAttemptId, prior.attemptId);
  }
  report.partialRecovery = {
    baseJobId: base.jobId,
    recoveredJobId: recovered.jobId,
    failedCode: base.sceneAttempts[0].failure?.code,
    recaptured: ready.captureSceneIds,
    reused: preserved.map((a) => ({
      sceneId: a.sceneId,
      artifactId: a.renderedArtifactId,
      captureHash: a.captureHash,
    })),
    status: 'passed',
    expiredReportRevalidatedForCaptureOnly: true,
    authDisposed: true,
  };
  await save();
  console.log('Partial recovery: passed; both existing clip IDs and hashes preserved');

  console.log(
    'Process crash: expected exit 86 after create_save, exactly one saved task, retry blocked',
  );
  await fixture('reset');
  const crash = await prepare();
  await stop(worker);
  worker = await start('worker', { POC_CRASH_AFTER_ACTION: 'create_save' });
  const crashedJob = await enqueue(crash);
  const [exitCode] = await Promise.race([
    once(worker, 'exit'),
    pause(120000, undefined, { ref: false }).then(() => {
      throw new Error('Crash hook was not reached');
    }),
  ]);
  assert.equal(exitCode, 86);
  const interrupted = (await db.get<InternalJob>('job', crashedJob.jobId))!;
  assert.equal(interrupted.snapshot.status, 'running');
  assert.equal(
    interrupted.snapshot.sceneAttempts.find((a) => a.sceneId === 'create')?.effectOutcome,
    'unknown',
  );
  const countCreated = async () =>
    Number(
      (await db.pool.query("SELECT count(*) FROM dr_demo_tasks WHERE title='데모 영상 만들기'"))
        .rows[0].count,
    );
  await until(async () => ((await countCreated()) === 1 ? true : undefined), 5000);
  worker = await start('worker');
  const stopped = await terminal(crash, crashedJob.jobId);
  assert.equal(stopped.status, 'needs_action');
  assert.equal(stopped.failure?.code, 'WORKER_INTERRUPTED');
  assert.equal(await db.get('auth', crash.plan.auth.authRef!, interrupted.owner), null);
  const blocked = await preview(crash, stopped, ['create']);
  assert(blocked.requiresStateReset);
  assert(blocked.requiresAuth);
  await crash.request(
    `/jobs/${stopped.jobId}/recoveries`,
    {
      previewId: blocked.previewId,
      approvalId: crash.approval.approvalId,
    },
    409,
  );
  assert.equal(await countCreated(), 1);
  const queueRecord = (
    await db.pool.query('SELECT retry_limit, retry_count FROM pgboss.job WHERE id=$1', [
      interrupted.queueId,
    ])
  ).rows[0];
  assert.equal(queueRecord.retry_limit, 0);
  assert.equal(queueRecord.retry_count, 0);
  report.crash = {
    jobId: stopped.jobId,
    processExitCode: exitCode,
    status: 'passed',
    persistedOutcome: 'unknown',
    savedTaskCount: 1,
    restartStatus: stopped.status,
    retryLimit: queueRecord.retry_limit,
    retryCount: queueRecord.retry_count,
    recoveryBlocked: true,
    authDisposed: true,
  };
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await save();
  console.log(`All PoC assertions passed. Report: ${join(dir, 'report.json')}`);
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  await save();
  throw error;
} finally {
  await Promise.all([...children].map(stop));
  await db.close();
}
