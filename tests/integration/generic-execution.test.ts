import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runJob } from '../../apps/worker/src/runner.ts';
import { hash } from '../../apps/api/src/security.ts';
import type { InternalJob, Artifact } from '../../apps/api/src/models.ts';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import { config } from '../../apps/api/src/config.ts';
import { Database } from '../../apps/api/src/db.ts';
import { encrypt } from '../../apps/api/src/security.ts';
import { launchBrowser, newContext } from '../../apps/worker/src/browser.ts';
import { authenticate } from '../../apps/worker/src/authentication.ts';
import { discover } from '../../apps/worker/src/discovery.ts';
import { buildProjectPlan } from '../../apps/worker/src/planning.ts';
import { validatePlan } from '../../apps/worker/src/validation.ts';
import type { AuthRecord, Project } from '../../apps/api/src/models.ts';
const cfg = {
  ...config(),
  pocMode: false,
  openaiKey: 'unit-test-only',
  plannerModel: 'mock-model',
};
const db = new Database(cfg.databaseUrl),
  app = Fastify(),
  owner = `test_${randomUUID()}`,
  authRef = `auth_${randomUUID()}`;
let browser: Browser, origin: string, project: Project;
beforeAll(async () => {
  await db.init();
  app.get('/signin', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        '<label>사용자 ID<input id="u"></label><label>암호<input id="p" type="password"></label><button onclick="fetch(\'/session\',{method:\'POST\'}).then(()=>location.href=\'/notebook\')">접속하기</button>',
      ),
  );
  app.post('/session', async (_req, reply) =>
    reply.header('Set-Cookie', 'note_session=valid; HttpOnly; Path=/').send({ ok: true }),
  );
  app.get('/notebook', async (req, reply) =>
    req.headers.cookie?.includes('note_session=valid')
      ? reply
          .type('text/html; charset=utf-8')
          .send(
            '<title>연구 노트</title><main><h1>연구 노트</h1><label>노트 제목<input></label><button>노트 저장</button></main>',
          )
      : reply.redirect('/signin'),
  );
  const objects = new Map<string, Buffer>();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.put('/private-artifacts/*', async (req, reply) => {
    let bytes = req.body as Buffer;
    if (req.headers['content-encoding'] === 'aws-chunked') {
      const chunks: Buffer[] = [];
      let pos = 0;
      while (pos < bytes.length) {
        const end = bytes.indexOf('\r\n', pos);
        const size = parseInt(bytes.subarray(pos, end).toString(), 16);
        if (!size) break;
        chunks.push(bytes.subarray(end + 2, end + 2 + size));
        pos = end + size + 4;
      }
      bytes = Buffer.concat(chunks);
    }
    objects.set(req.url.split('?')[0], bytes);
    return reply.send();
  });
  app.get('/private-artifacts/*', async (req, reply) =>
    reply.type('application/octet-stream').send(objects.get(req.url.split('?')[0])),
  );
  origin = await app.listen({ port: 0, host: '127.0.0.1' });
  cfg.s3 = {
    endpoint: origin,
    region: 'us-east-1',
    bucket: 'private-artifacts',
    accessKeyId: 'TEST_ONLY',
    secretAccessKey: 'TEST_ONLY_SECRET',
  };
  project = {
    projectId: `project_${randomUUID()}`,
    owner,
    targetUrl: origin + '/notebook',
    intent: '연구 노트 화면과 노트 제목 입력을 소개',
    allowedOrigins: [origin],
  };
  const secret = {
    mode: 'form',
    username: 'unique-user-id',
    password: 'unique-test-password',
    profile: {
      loginUrl: origin + '/signin',
      username: { strategy: 'label', value: '사용자 ID' },
      password: { strategy: 'label', value: '암호' },
      submit: { strategy: 'role', role: 'button', value: '접속하기' },
      successUrl: origin + '/notebook',
      successTarget: { strategy: 'css', value: 'h1' },
    },
  };
  await db.put(
    'auth',
    authRef,
    owner,
    {
      authRef,
      owner,
      projectId: project.projectId,
      mode: 'form',
      ciphertext: encrypt(secret, cfg.key),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    } satisfies AuthRecord,
    project.projectId,
  );
  browser = await launchBrowser();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await browser?.close();
  await app.close();
  await db.pool.query('DELETE FROM dr_records WHERE owner=$1', [owner]);
  await db.close();
});
it('authenticates a different app using user-specified selectors and observes its real DOM', async () => {
  const state = await authenticate(
    browser,
    db,
    cfg,
    {
      target: { baseUrl: project.targetUrl, allowedOrigins: [origin] },
      auth: { mode: 'form', authRef, expiresAt: new Date(Date.now() + 60000).toISOString() },
    },
    owner,
  );
  expect((state as any).cookies[0].name).toBe('note_session');
  const observed = await discover(
    browser,
    { baseUrl: project.targetUrl, allowedOrigins: [origin] },
    state,
    [],
  );
  expect(observed[0].title).toBe('연구 노트');
  expect(observed[0].locators.some((l) => l.value === '노트 제목')).toBe(true);
  expect(JSON.stringify(observed)).not.toContain('unique-test-password');
});
it('builds and validates a provider plan against a second app, never importing demo routes', async () => {
  const request = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.input);
    const observation = input.observations[0];
    const target = observation.locators.find((l: any) => l.value === 'h1');
    const scenes = [
      {
        id: 'intro',
        title: '연구 노트',
        purpose: '현재 기능 소개',
        entry: {
          url: project.targetUrl,
          readyConditions: [{ type: 'visible', locatorId: target.id }],
        },
        dependsOn: [],
        preconditions: [],
        actions: [
          {
            id: 'observe',
            type: 'assert',
            condition: { type: 'visible', locatorId: target.id },
            atMs: 0,
            timeoutMs: 5000,
          },
        ],
        postconditions: [{ type: 'visible', locatorId: target.id }],
        narration: { text: '연구 노트에서 기록을 관리합니다.', estimatedDurationMs: 6000 },
        timing: { maxDurationMs: 20000, tailHoldMs: 1000, maxFreezeMs: 1000 },
        effects: { reads: ['노트'], writes: [], summary: '화면 열람' },
        retryPolicy: 'read_only',
        recoveryConditions: null,
        outputs: [],
      },
    ];
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: JSON.stringify({ title: '연구 노트 시연', scenes }) },
            ],
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', request);
  const plan = await buildProjectPlan(browser, db, cfg, project, authRef);
  expect(plan.intent).toBe(project.intent);
  expect(plan.scenes[0].entry.url).toBe(project.targetUrl);
  expect(JSON.stringify(plan)).not.toContain('/dashboard');
  const report = await validatePlan(browser, db, cfg, plan, owner);
  expect(report.issues).toEqual([]);
  expect(report.targets.every((t) => t.status === 'verified')).toBe(true);
  plan.locators.find((l) => l.id === report.targets[0].locatorId)!.value = 'made-up-target';
  const invalid = await validatePlan(browser, db, cfg, plan, owner);
  expect(invalid.issues.length).toBeGreaterThan(0);
  vi.unstubAllGlobals();
});

it('runs the service pipeline with actual browser capture, dynamic speech transport, and S3 uploads', async () => {
  const localDir = join(cfg.dataDir, 'service-test');
  await mkdir(localDir, { recursive: true });
  const speechPath = join(localDir, 'provider-response.mp3');
  await promisify(execFile)('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=16',
    '-c:a',
    'libmp3lame',
    speechPath,
  ]);
  const bytes = await readFile(speechPath);
  const state = await authenticate(
    browser,
    db,
    cfg,
    {
      target: { baseUrl: project.targetUrl, allowedOrigins: [origin] },
      auth: { mode: 'form', authRef, expiresAt: new Date(Date.now() + 60000).toISOString() },
    },
    owner,
  );
  const observations = await discover(
    browser,
    { baseUrl: project.targetUrl, allowedOrigins: [origin] },
    state,
    [],
  );
  const target = observations[0].locators.find((l) => l.value === 'h1')!;
  for (const observation of observations)
    await db.put('observation', observation.id, owner, observation, project.projectId);
  const { PlanSchema } = await import('../../packages/contracts/src/index.ts');
  const plan = PlanSchema.parse({
    schemaVersion: '0.1',
    planId: `plan_${randomUUID()}`,
    projectId: project.projectId,
    revision: 1,
    title: '연구 노트 실제 실행',
    intent: project.intent,
    target: { baseUrl: project.targetUrl, allowedOrigins: [origin] },
    auth: { mode: 'form', authRef, expiresAt: new Date(Date.now() + 600000).toISOString() },
    format: {
      width: 1280,
      height: 720,
      targetDurationMs: 60000,
      maxDurationMs: 75000,
      language: 'ko-KR',
    },
    locators: observations[0].locators,
    createdAt: new Date().toISOString(),
    scenes: [1, 2, 3].map((i) => ({
      id: `scene_${i}`,
      title: `연구 노트 ${i}`,
      purpose: '외부 앱 호환 검증',
      entry: {
        url: project.targetUrl,
        readyConditions: [{ type: 'visible', locatorId: target.id }],
      },
      dependsOn: [],
      preconditions: [],
      actions: [
        {
          id: `assert_${i}`,
          type: 'assert',
          atMs: 0,
          timeoutMs: 5000,
          condition: { type: 'visible', locatorId: target.id },
        },
      ],
      postconditions: [{ type: 'visible', locatorId: target.id }],
      narration: { text: `연구 노트의 ${i}번째 화면입니다.`, estimatedDurationMs: 16000 },
      timing: { maxDurationMs: 20000, tailHoldMs: 1000, maxFreezeMs: 1000 },
      effects: { reads: ['노트'], writes: [], summary: '화면 열람' },
      retryPolicy: 'read_only',
      recoveryConditions: null,
      outputs: [],
    })),
  });
  const report = await validatePlan(browser, db, cfg, plan, owner);
  expect(report.issues).toEqual([]);
  const jobId = `job_${randomUUID()}`;
  const record: InternalJob = {
    owner,
    projectId: project.projectId,
    plan,
    approval: {
      approvalId: `approval_${randomUUID()}`,
      planId: plan.planId,
      revision: 1,
      reportId: report.reportId,
      approvedAt: new Date().toISOString(),
      acceptedEffectsHash: hash(plan.scenes.map((s) => ({ id: s.id, effects: s.effects }))),
    },
    cancelRequested: false,
    reservation: false,
    snapshot: {
      jobId,
      version: 1,
      status: 'queued',
      stage: 'preflight',
      planId: plan.planId,
      revision: 1,
      sceneAttempts: [],
      completedSceneCount: 0,
      totalSceneCount: 3,
      outputArtifactId: null,
      failure: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  await db.put('job', jobId, owner, record, project.projectId);
  const requests = vi.fn(async (url: any, init: any) => {
    expect(String(url)).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(init.body).input).toContain('연구 노트');
    return new Response(bytes);
  });
  vi.stubGlobal('fetch', requests);
  // Dependency injection is test-only: production always launches with the public-network proxy.
  await runJob(db, cfg, jobId, owner, { browserFactory: () => launchBrowser() });
  vi.unstubAllGlobals();
  const finished = await db.get<InternalJob>('job', jobId, owner);
  expect(finished?.snapshot.failure).toBeNull();
  expect(finished?.snapshot.status).toBe('succeeded');
  expect(requests).toHaveBeenCalledTimes(3);
  const artifact = await db.get<Artifact>('artifact', finished!.snapshot.outputArtifactId!, owner);
  expect(artifact?.objectKey).toContain('artifacts/');
  expect(artifact?.durationMs).toBeGreaterThan(45000);
  expect(artifact?.durationMs).toBeLessThanOrEqual(75000);
  expect(await db.get('auth', authRef, owner)).toBeNull();
  await writeFile(
    join(localDir, 'verification.json'),
    JSON.stringify(
      {
        jobId,
        status: finished!.snapshot.status,
        durationMs: artifact?.durationMs,
        scenes: 3,
        speechRequests: requests.mock.calls.length,
        mode: 'service',
        provider: 'mock HTTP response',
        browser: 'real local second app',
        storage: 'local S3 protocol server',
      },
      null,
      2,
    ),
  );
}, 180000);
