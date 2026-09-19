import { AuthInputSchema } from '../../../packages/contracts/src/connection.ts';
import { publicUrl } from '../../../packages/runtime/src/network.ts';
import { artifactUrl, storageReady } from '../../../packages/runtime/src/storage.ts';
import { assertExecutionPolicy } from '../../../packages/contracts/src/policy.ts';
import { registerAccounts, consumeLimit } from './accounts.ts';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomUUID, createHmac } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import {
  PlanSchema,
  type Approval,
  type Plan,
  type ValidationReport,
  type RecoveryPreview,
} from '../../../packages/contracts/src/index.ts';
import { affectedScenes } from '../../../packages/contracts/src/rules.ts';
import { Database, PLAN_QUEUE, RECORD_QUEUE } from './db.ts';
import type { Config } from './config.ts';
import { AppError, encrypt, equal, hash, validatePocTarget } from './security.ts';
import type {
  Project,
  AuthRecord,
  PlanRecord,
  Operation,
  InternalJob,
  StoredPreview,
  Artifact,
} from './models.ts';

const uid = (prefix: string) => `${prefix}_${randomUUID()}`;
const params = (r: FastifyRequest) => r.params as Record<string, string>;
const effectsHash = (p: Plan) => hash(p.scenes.map((s) => ({ id: s.id, effects: s.effects })));
const isoAfter = (ms: number) => new Date(Date.now() + ms).toISOString();
export async function createApp(db: Database, queue: PgBoss, cfg: Config) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie, { secret: cfg.key });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (
        req.headers['x-demo-reel'] !== '1' ||
        (origin && ![cfg.webOrigin, `http://127.0.0.1:${cfg.apiPort}`].includes(origin))
      )
        throw new AppError('CSRF_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
    }
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: 'INVALID_PLAN',
          message: '입력값 또는 계획 형식을 확인해 주세요.',
          details: err.issues.map((i) => ({ path: i.path, message: i.message })),
          requestId: _req.id,
        },
      });
    if (err instanceof AppError)
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, details: null, requestId: _req.id },
      });
    if (
      'statusCode' in err &&
      typeof err.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    )
      return reply.code(err.statusCode).send({
        error: {
          code: 'INVALID_REQUEST',
          message: '요청 형식을 확인해 주세요.',
          details: null,
          requestId: _req.id,
        },
      });
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '처리 중 오류가 발생했습니다.',
        details: null,
        requestId: _req.id,
      },
    });
  });
  await registerAccounts(app, db, cfg);
  function owner(req: FastifyRequest): string {
    if (!cfg.pocMode) {
      const id = (req as any).accountOwner;
      if (!id) throw new AppError('UNAUTHORIZED', '로그인 후 계속해 주세요.', 401);
      return id;
    }
    const signed = req.cookies.dr_session;
    const token = signed ? req.unsignCookie(signed) : null;
    if (!token?.valid || !token.value)
      throw new AppError('UNAUTHORIZED', '작업 세션을 다시 시작해 주세요.', 401);
    return token.value;
  }
  async function get<T>(kind: string, id: string, o: string, c?: PoolClient): Promise<T> {
    const result = await db.get<T>(kind, id, o, c);
    if (!result) throw new AppError('NOT_FOUND', '요청한 항목을 찾을 수 없습니다.', 404);
    return result;
  }
  async function locked<T>(o: string, fn: (c: PoolClient) => Promise<T>) {
    return db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [o]);
      return fn(c);
    });
  }
  async function once<T>(
    req: FastifyRequest,
    fn: (o: string, c: PoolClient) => Promise<T>,
  ): Promise<T> {
    const o = owner(req),
      route = req.url,
      key = z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    return locked(o, async (c) => {
      const prior = await c.query(
        'SELECT hash,response FROM dr_idempotency WHERE owner=$1 AND route=$2 AND key=$3',
        [o, route, key],
      );
      const bodyHash = hash(req.body ?? {});
      if (prior.rows[0]) {
        if (prior.rows[0].hash !== bodyHash)
          throw new AppError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 내용이 있습니다.', 409);
        return prior.rows[0].response;
      }
      const result = await fn(o, c);
      await c.query(
        'INSERT INTO dr_idempotency(owner,route,key,hash,response) VALUES($1,$2,$3,$4,$5)',
        [o, route, key, bodyHash, JSON.stringify(result)],
      );
      return result;
    });
  }
  // Planning goes to its own lane so it is not stuck behind a recording, and a recording is not
  // delayed by somebody else's planning.
  const sendQueue = (
    payload: { type: 'operation' | 'job'; id: string; owner: string },
    c: PoolClient,
  ) =>
    queue.send(payload.type === 'operation' ? PLAN_QUEUE : RECORD_QUEUE, payload, {
      retryLimit: 0,
      expireInSeconds: 600,
      db: { executeSql: (text, values) => c.query(text, values) },
    });
  const validateTarget = (value: string) =>
    cfg.pocMode ? validatePocTarget(value, cfg.demoOrigin) : publicUrl(value);
  const validatePlanTarget = (p: Plan) => {
    validateTarget(p.target.baseUrl);
    p.target.allowedOrigins.forEach(validateTarget);
    if (!cfg.pocMode) assertExecutionPolicy(p);
  };
  async function ready(c?: PoolClient) {
    const worker = await db.get<any>('runtime', 'worker', undefined, c);
    return (
      cfg.pocMode ||
      !!(
        worker?.mode === 'service' &&
        worker.plannerReady &&
        worker.storageReady &&
        Date.now() - Date.parse(worker.updatedAt) < 60000
      )
    );
  }
  async function requireReady(c?: PoolClient) {
    if (!(await ready(c)))
      throw new AppError(
        'SERVICE_NOT_READY',
        '영상 생성 서비스의 연결 설정이 필요합니다. 잠시 후 다시 확인해 주세요.',
        503,
      );
  }
  app.get('/health', async () => ({
    status: 'ok',
    mode: cfg.pocMode ? 'fixed-plan-poc' : 'service',
    ...(cfg.pocMode ? { demoOrigin: cfg.demoOrigin } : {}),
  }));
  app.get('/api/v1/capabilities', async () => ({
    mode: cfg.pocMode ? 'poc' : 'service',
    ready: await ready(),
    auth: 'email-password',
    ...(cfg.pocMode ? { demoOrigin: cfg.demoOrigin } : {}),
  }));
  app.get('/api/v1/projects', async (req) => {
    const o = owner(req);
    const projects = await db.list<Project>('project', o);
    const jobs = await db.list<InternalJob>('job', o);
    return {
      projects: projects
        .slice(-30)
        .reverse()
        .map((p) => ({
          projectId: p.projectId,
          targetUrl: p.targetUrl,
          intent: p.intent,
          jobs: jobs
            .filter((j) => j.projectId === p.projectId)
            .map((j) => ({
              jobId: j.snapshot.jobId,
              status: j.snapshot.status,
              planId: j.plan.planId,
              revision: j.plan.revision,
              approvalId: j.approval.approvalId,
            }))
            .reverse(),
        })),
    };
  });
  app.post('/api/v1/projects', async (req, reply) => {
    const b = z
      .strictObject({
        targetUrl: z.string(),
        intent: z.string().min(1).max(2000),
        repoUrl: z.url().optional(),
        allowedOrigins: z.array(z.url()).max(5).optional(),
        discoveryUrls: z.array(z.url()).max(5).optional(),
      })
      .parse(req.body);
    validateTarget(b.targetUrl);
    const origins = [
      ...new Set([
        new URL(b.targetUrl).origin,
        ...(b.allowedOrigins ?? []).map((o) => validateTarget(o).origin),
      ]),
    ];
    if (origins.length > 5) throw new AppError('INVALID_REQUEST', '연결 도메인은 최대 5개입니다.');
    for (const url of b.discoveryUrls ?? [])
      if (!origins.includes(validateTarget(url).origin))
        throw new AppError('URL_BLOCKED', '탐색 주소는 연결 도메인 안이어야 합니다.');
    let o: string;
    try {
      o = owner(req);
    } catch {
      if (!cfg.pocMode) throw new AppError('UNAUTHORIZED', '로그인 후 계속해 주세요.', 401);
      o = uid('owner');
    }
    const p: Project = { projectId: uid('project'), owner: o, ...b, allowedOrigins: origins };
    if (!cfg.pocMode) await consumeLimit(db, `project:${o}`, 30);
    await db.put('project', p.projectId, o, p, p.projectId);
    if (cfg.pocMode)
      reply.setCookie('dr_session', o, {
        signed: true,
        httpOnly: true,
        sameSite: 'strict',
        secure: cfg.webOrigin.startsWith('https:'),
        path: '/',
        maxAge: 86400,
      });
    return reply
      .code(201)
      .send({ projectId: p.projectId, targetUrl: p.targetUrl, intent: p.intent });
  });
  app.post('/api/v1/projects/:id/auth', async (req, reply) => {
    const o = owner(req),
      project = await get<Project>('project', params(req).id, o);
    const b = AuthInputSchema.parse(req.body);
    if (!cfg.pocMode) {
      if (b.mode === 'form' && !b.profile)
        throw new AppError('AUTH_PROFILE_REQUIRED', '로그인 화면 연결 설정을 입력해 주세요.');
      if (b.mode === 'storage_state' && (!b.verifyUrl || !b.successTarget))
        throw new AppError('AUTH_PROFILE_REQUIRED', '세션 확인 주소와 성공 대상을 입력해 주세요.');
      const urls =
        b.mode === 'form'
          ? [b.profile!.loginUrl, b.profile!.successUrl]
          : [b.verifyUrl!, ...b.storageState.origins.map((o) => o.origin)];
      for (const url of urls)
        if (!project.allowedOrigins?.includes(validateTarget(url).origin))
          throw new AppError('URL_BLOCKED', '인증 주소는 연결한 도메인 안이어야 합니다.');
    }
    const identity = hash(
      b.mode === 'form' ? { mode: b.mode, username: b.username } : { mode: b.mode },
    );
    if (project.authIdentity && project.authIdentity !== identity)
      throw new AppError(
        'AUTH_PROFILE_CHANGED',
        '다른 계정으로 변경하려면 새 프로젝트에서 계획을 확인해 주세요.',
        409,
      );
    const record: AuthRecord = {
      authRef: project.authRef ?? uid('auth'),
      owner: o,
      projectId: project.projectId,
      mode: b.mode,
      ciphertext: encrypt(b, cfg.key),
      expiresAt: isoAfter(7200000),
    };
    await locked(o, async (c) => {
      const active = await c.query(
        "SELECT 1 FROM dr_records WHERE kind='job' AND project_id=$1 AND document->'snapshot'->>'status' IN ('queued','running')",
        [project.projectId],
      );
      if (active.rowCount)
        throw new AppError('JOB_ACTIVE', '현재 실행이 끝난 뒤 재인증해 주세요.', 409);
      await db.put('auth', record.authRef, o, record, project.projectId, c);
      await db.put(
        'project',
        project.projectId,
        o,
        { ...project, authRef: record.authRef, authIdentity: identity },
        project.projectId,
        c,
      );
    });
    return reply
      .code(201)
      .send({ authRef: record.authRef, mode: b.mode, expiresAt: record.expiresAt });
  });
  app.delete('/api/v1/projects/:id/auth/:authRef', async (req, reply) => {
    const o = owner(req);
    await get<Project>('project', params(req).id, o);
    const auth = await db.get<AuthRecord>('auth', params(req).authRef, o);
    if (auth && auth.projectId !== params(req).id)
      throw new AppError('NOT_FOUND', '인증 정보를 찾을 수 없습니다.', 404);
    await db.remove('auth', params(req).authRef, o);
    return reply.code(204).send();
  });
  app.post('/api/v1/projects/:id/plans', async (req, reply) =>
    reply.code(202).send(
      await once(req, async (o, c) => {
        const p = await get<Project>('project', params(req).id, o, c);
        const b = z.strictObject({ authRef: z.string().optional() }).parse(req.body);
        if (!cfg.pocMode) {
          await requireReady(c);
          await consumeLimit(db, `plan:${o}`, cfg.planQuota, 86400, c);
        }
        const auth = b.authRef ? await get<AuthRecord>('auth', b.authRef, o, c) : null;
        if (auth && auth.projectId !== p.projectId)
          throw new AppError('AUTH_FAILED', '대상 앱의 인증 정보가 아닙니다.');
        const op: Operation = {
          operationId: uid('op'),
          owner: o,
          projectId: p.projectId,
          type: 'plan',
          status: 'queued',
          authRef: b.authRef,
        };
        await db.put('operation', op.operationId, o, op, p.projectId, c);
        await sendQueue({ type: 'operation', id: op.operationId, owner: o }, c);
        return { operationId: op.operationId };
      }),
    ),
  );
  app.get('/api/v1/operations/:id', async (req) => {
    const {
      owner: _owner,
      authRef: _auth,
      ...op
    } = await get<Operation>('operation', params(req).id, owner(req));
    return op;
  });
  app.get('/api/v1/plans/:id', async (req) => {
    const o = owner(req),
      meta = await get<PlanRecord>('plan', params(req).id, o);
    const revision = Number((req.query as any).revision ?? meta.revision);
    const p = await get<Plan>('plan_version', `${meta.planId}_${revision}`, o);
    return { plan: p, state: meta.state, effectsHash: effectsHash(p) };
  });
  app.put('/api/v1/plans/:id', async (req) => {
    const o = owner(req),
      b = z.strictObject({ expectedRevision: z.number().int(), plan: PlanSchema }).parse(req.body);
    return locked(o, async (c) => {
      const meta = await get<PlanRecord>('plan', params(req).id, o, c);
      if (meta.revision !== b.expectedRevision)
        throw new AppError('STALE_REVISION', '다른 변경 사항을 먼저 불러와 주세요.', 409);
      const old = await get<Plan>('plan_version', `${meta.planId}_${meta.revision}`, o, c);
      if (
        b.plan.planId !== old.planId ||
        b.plan.projectId !== old.projectId ||
        hash(b.plan.auth) !== hash(old.auth)
      )
        throw new AppError('INVALID_PLAN', '계획의 소유권·인증 연결은 편집할 수 없습니다.');
      validatePlanTarget(b.plan);
      if (hash(b.plan.target) !== hash(old.target))
        throw new AppError('URL_BLOCKED', '계획의 연결 도메인은 변경할 수 없습니다.');
      const next = PlanSchema.parse({
        ...b.plan,
        revision: meta.revision + 1,
        createdAt: new Date().toISOString(),
      });
      await db.put('plan_version', `${next.planId}_${next.revision}`, o, next, meta.projectId, c);
      await db.put(
        'plan',
        meta.planId,
        o,
        { ...meta, revision: next.revision, state: 'draft' },
        meta.projectId,
        c,
      );
      return { plan: next, state: 'draft', effectsHash: effectsHash(next) };
    });
  });
  app.post('/api/v1/plans/:id/validations', async (req, reply) =>
    reply.code(202).send(
      await once(req, async (o, c) => {
        if (!cfg.pocMode) {
          await requireReady(c);
          await consumeLimit(db, `validation:${o}`, 30, 86400, c);
        }
        const b = z.strictObject({ revision: z.number().int().positive() }).parse(req.body);
        const meta = await get<PlanRecord>('plan', params(req).id, o, c);
        if (meta.revision !== b.revision)
          throw new AppError('STALE_REVISION', '현재 계획을 다시 불러와 주세요.', 409);
        const op: Operation = {
          operationId: uid('op'),
          owner: o,
          projectId: meta.projectId,
          type: 'validation',
          status: 'queued',
          planId: meta.planId,
          revision: b.revision,
        };
        await db.put('operation', op.operationId, o, op, meta.projectId, c);
        await db.put('plan', meta.planId, o, { ...meta, state: 'validating' }, meta.projectId, c);
        await sendQueue({ type: 'operation', id: op.operationId, owner: o }, c);
        return { operationId: op.operationId };
      }),
    ),
  );
  app.get('/api/v1/validations/:reportId', async (req) =>
    get<ValidationReport>('validation', params(req).reportId, owner(req)),
  );
  app.post('/api/v1/plans/:id/approvals', async (req, reply) => {
    const b = z
        .strictObject({
          revision: z.number().int(),
          reportId: z.string(),
          acceptedEffectsHash: z.string(),
        })
        .parse(req.body),
      o = owner(req);
    const approval = await locked(o, async (c) => {
      const meta = await get<PlanRecord>('plan', params(req).id, o, c),
        report = await get<ValidationReport>('validation', b.reportId, o, c);
      if (
        meta.revision !== b.revision ||
        report.revision !== b.revision ||
        report.planId !== meta.planId
      )
        throw new AppError('STALE_REVISION', '현재 계획을 다시 확인해 주세요.', 409);
      if (Date.parse(report.expiresAt) <= Date.now())
        throw new AppError(
          'VALIDATION_EXPIRED',
          '검증 결과가 만료되었습니다. 다시 검증해 주세요.',
          409,
        );
      if (
        report.issues.some((i) => i.severity === 'error') ||
        report.targets.some((t) => t.status === 'blocked')
      )
        throw new AppError('INVALID_PLAN', '실행할 수 없는 항목을 먼저 수정해 주세요.');
      const p = await get<Plan>('plan_version', `${meta.planId}_${b.revision}`, o, c);
      if (!equal(b.acceptedEffectsHash, effectsHash(p)))
        throw new AppError('STALE_REVISION', '데이터 변경 내용을 다시 확인해 주세요.', 409);
      const a: Approval = {
        approvalId: uid('approval'),
        planId: meta.planId,
        revision: b.revision,
        reportId: b.reportId,
        approvedAt: new Date().toISOString(),
        acceptedEffectsHash: b.acceptedEffectsHash,
      };
      await db.put('approval', a.approvalId, o, a, meta.projectId, c);
      await db.put('plan', meta.planId, o, { ...meta, state: 'approved' }, meta.projectId, c);
      return a;
    });
    return reply.code(201).send(approval);
  });
  async function enqueue(
    o: string,
    p: Plan,
    a: Approval,
    c: PoolClient,
    base?: InternalJob,
    recovery?: RecoveryPreview,
  ) {
    if (!cfg.pocMode) {
      await requireReady(c);
      await consumeLimit(db, 'global-jobs', cfg.globalQuota, 86400, c);
    }
    const busy = await c.query(
      "SELECT 1 FROM dr_records WHERE kind='job' AND owner=$1 AND document->'snapshot'->>'status' IN ('queued','running')",
      [o],
    );
    if (busy.rowCount)
      throw new AppError('JOB_ACTIVE', '진행 중인 작업을 먼저 마치거나 취소해 주세요.', 409);
    await c.query(
      'INSERT INTO dr_usage(owner,day,count) VALUES($1,CURRENT_DATE,0) ON CONFLICT DO NOTHING',
      [o],
    );
    const reserved = await c.query(
      'UPDATE dr_usage SET count=count+1 WHERE owner=$1 AND day=CURRENT_DATE AND count<$2 RETURNING count',
      [o, cfg.quota],
    );
    if (!reserved.rowCount)
      throw new AppError('QUOTA_EXCEEDED', '오늘 생성할 수 있는 횟수를 모두 사용했습니다.', 429);
    const jobId = uid('job');
    const record: InternalJob = {
      owner: o,
      projectId: p.projectId,
      plan: p,
      approval: a,
      cancelRequested: false,
      reservation: true,
      baseJobId: base?.snapshot.jobId,
      recovery,
      snapshot: {
        jobId,
        version: 1,
        status: 'queued',
        stage: 'preflight',
        planId: p.planId,
        revision: p.revision,
        sceneAttempts: [],
        completedSceneCount: 0,
        totalSceneCount: p.scenes.length,
        outputArtifactId: null,
        failure: null,
        expiresAt: isoAfter(86400000),
      },
    };
    await db.put('job', jobId, o, record, p.projectId, c);
    record.queueId = (await sendQueue({ type: 'job', id: jobId, owner: o }, c)) ?? undefined;
    await db.put('job', jobId, o, record, p.projectId, c);
    return record.snapshot;
  }
  async function approved(
    o: string,
    planId: string,
    revision: number,
    approvalId: string,
    c: PoolClient,
  ) {
    const p = await get<Plan>('plan_version', `${planId}_${revision}`, o, c),
      a = await get<Approval>('approval', approvalId, o, c);
    if (a.planId !== p.planId || a.revision !== p.revision)
      throw new AppError('STALE_REVISION', '승인한 계획 버전과 다릅니다.', 409);
    validatePlanTarget(p);
    return { p, a };
  }
  app.post('/api/v1/jobs', async (req, reply) =>
    reply.code(202).send(
      await once(req, async (o, c) => {
        const b = z
          .strictObject({ planId: z.string(), revision: z.number().int(), approvalId: z.string() })
          .parse(req.body);
        const { p, a } = await approved(o, b.planId, b.revision, b.approvalId, c);
        return enqueue(o, p, a, c);
      }),
    ),
  );
  app.get('/api/v1/jobs/:id', async (req, reply) => {
    const r = await get<InternalJob>('job', params(req).id, owner(req)),
      etag = `"${r.snapshot.jobId}-${r.snapshot.version}"`;
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return r.snapshot;
  });
  app.post('/api/v1/jobs/:id/cancel', async (req, reply) => {
    const o = owner(req);
    const r = await locked(o, async (c) => {
      const j = await get<InternalJob>('job', params(req).id, o, c);
      if (['succeeded', 'failed', 'cancelled', 'needs_action'].includes(j.snapshot.status))
        return j.snapshot;
      j.cancelRequested = true;
      j.snapshot.version++;
      if (j.snapshot.status === 'queued') {
        j.snapshot.status = 'cancelled';
        if (j.plan.auth.authRef) await db.remove('auth', j.plan.auth.authRef, o, c);
        if (j.reservation) {
          await c.query(
            'UPDATE dr_usage SET count=GREATEST(0,count-1) WHERE owner=$1 AND day=CURRENT_DATE',
            [o],
          );
          j.reservation = false;
        }
      }
      await db.put('job', j.snapshot.jobId, o, j, j.projectId, c);
      return j.snapshot;
    });
    return reply.code(202).send(r);
  });
  app.post('/api/v1/jobs/:id/recovery-preview', async (req) => {
    const o = owner(req),
      b = z
        .strictObject({
          sceneIds: z.array(z.string()),
          mode: z.enum(['recapture', 'rerender', 'compose']),
          planId: z.string(),
          revision: z.number().int(),
        })
        .parse(req.body);
    const base = await get<InternalJob>('job', params(req).id, o),
      p = await get<Plan>('plan_version', `${b.planId}_${b.revision}`, o);
    if (['queued', 'running'].includes(base.snapshot.status) || base.projectId !== p.projectId)
      throw new AppError('JOB_ACTIVE', '현재 작업 상태에서는 복구할 수 없습니다.', 409);
    if (b.mode !== 'compose' && !b.sceneIds.length)
      throw new AppError('INVALID_PLAN', '복구할 장면을 선택해 주세요.');
    const selected = affectedScenes(p, b.sceneIds),
      missing = p.scenes
        .filter(
          (s) =>
            !base.snapshot.sceneAttempts.some(
              (a) => a.sceneId === s.id && a.status === 'succeeded',
            ),
        )
        .map((s) => s.id);
    const changed = p.scenes
      .filter((s) => {
        const old = base.plan.scenes.find((t) => t.id === s.id);
        return (
          !old ||
          hash({ ...s, narration: null }) !== hash({ ...old, narration: null }) ||
          hash(p.locators) !== hash(base.plan.locators)
        );
      })
      .map((s) => s.id);
    const capture = affectedScenes(p, [
      ...new Set([...missing, ...changed, ...(b.mode === 'recapture' ? selected : [])]),
    ]);
    const render = p.scenes
      .filter(
        (s) =>
          capture.includes(s.id) ||
          selected.includes(s.id) ||
          s.narration.text !== base.plan.scenes.find((t) => t.id === s.id)?.narration.text,
      )
      .map((s) => s.id);
    const reset = capture.some((id) => {
      const s = p.scenes.find((s) => s.id === id)!,
        a = base.snapshot.sceneAttempts.find((a) => a.sceneId === id);
      return s.retryPolicy === 'manual_reset' && a && a.effectOutcome !== 'none';
    });
    const auth = p.auth.authRef ? await db.get<AuthRecord>('auth', p.auth.authRef, o) : null;
    const preview: RecoveryPreview = {
      previewId: uid('preview'),
      baseJobVersion: base.snapshot.version,
      targetPlanRevision: p.revision,
      mode: b.mode,
      captureSceneIds: capture,
      renderSceneIds: render,
      reuseArtifactIds: base.snapshot.sceneAttempts
        .filter((a) => a.status === 'succeeded' && !render.includes(a.sceneId))
        .flatMap((a) => (a.renderedArtifactId ? [a.renderedArtifactId] : [])),
      // A plan that authenticates needs live credentials to re-record; one that does not never
      // has an auth record, and treating that absence as expired would block its recovery forever.
      requiresAuth:
        capture.length > 0 &&
        p.auth.mode !== 'none' &&
        (!auth || Date.parse(auth.expiresAt) <= Date.now()),
      requiresStateReset: !!reset,
      reasons: reset
        ? [
            '데이터 변경이 있었거나 결과가 불확실한 장면입니다. 테스트 앱 상태를 확인·초기화해야 합니다.',
          ]
        : [],
      expiresAt: isoAfter(600000),
    };
    await db.put(
      'preview',
      preview.previewId,
      o,
      {
        owner: o,
        baseJobId: base.snapshot.jobId,
        targetPlanId: p.planId,
        preview,
      } satisfies StoredPreview,
      p.projectId,
    );
    return preview;
  });
  app.post('/api/v1/jobs/:id/recoveries', async (req, reply) =>
    reply.code(202).send(
      await once(req, async (o, c) => {
        const b = z.strictObject({ previewId: z.string(), approvalId: z.string() }).parse(req.body),
          stored = await get<StoredPreview>('preview', b.previewId, o, c),
          preview = stored.preview;
        const base = await get<InternalJob>('job', params(req).id, o, c);
        if (
          stored.baseJobId !== base.snapshot.jobId ||
          preview.baseJobVersion !== base.snapshot.version ||
          Date.parse(preview.expiresAt) <= Date.now()
        )
          throw new AppError('STALE_REVISION', '복구 범위를 다시 확인해 주세요.', 409);
        if (preview.requiresAuth || preview.requiresStateReset)
          throw new AppError(
            'PRECONDITION_FAILED',
            '재인증 또는 앱 상태 확인이 먼저 필요합니다.',
            409,
          );
        const { p, a } = await approved(
          o,
          stored.targetPlanId,
          preview.targetPlanRevision,
          b.approvalId,
          c,
        );
        return enqueue(o, p, a, c, base, preview);
      }),
    ),
  );
  /**
   * Subtitle and narration edits on a finished video. Narration never touches the target app,
   * so this path re-renders from the stored clips and skips re-authentication and DOM checks:
   * the next plan is built from the stored version with only narration text substituted, and
   * the server itself sets captureSceneIds to empty, so no request can turn it into a re-record.
   */
  app.post('/api/v1/jobs/:id/narration', async (req, reply) =>
    reply.code(202).send(
      await once(req, async (o, c) => {
        const b = z
          .strictObject({
            expectedRevision: z.number().int(),
            narrations: z
              .array(z.strictObject({ sceneId: z.string(), text: z.string().min(1).max(600) }))
              .min(1)
              .max(6),
          })
          .parse(req.body);
        const base = await get<InternalJob>('job', params(req).id, o, c);
        if (['queued', 'running'].includes(base.snapshot.status))
          throw new AppError('JOB_ACTIVE', '진행 중인 작업을 먼저 마치거나 취소해 주세요.', 409);
        const meta = await get<PlanRecord>('plan', base.snapshot.planId, o, c);
        if (meta.revision !== b.expectedRevision)
          throw new AppError('STALE_REVISION', '다른 변경 사항을 먼저 불러와 주세요.', 409);
        const old = await get<Plan>('plan_version', `${meta.planId}_${meta.revision}`, o, c);
        // Re-rendering needs every original clip, so only a fully successful video can be edited.
        const reusable = new Set(
          base.snapshot.sceneAttempts
            .filter((a) => a.status === 'succeeded' && a.rawClipArtifactId)
            .map((a) => a.sceneId),
        );
        if (old.scenes.some((s) => !reusable.has(s.id)))
          throw new AppError(
            'PRECONDITION_FAILED',
            '모든 장면이 완성된 영상에서만 자막을 수정할 수 있습니다.',
            409,
          );
        for (const n of b.narrations)
          if (!old.scenes.some((s) => s.id === n.sceneId))
            throw new AppError('INVALID_PLAN', '계획에 없는 장면입니다.');
        const changed = b.narrations.filter(
          (n) => old.scenes.find((s) => s.id === n.sceneId)!.narration.text !== n.text,
        );
        if (!changed.length) throw new AppError('INVALID_PLAN', '변경된 자막이 없습니다.');
        const next = PlanSchema.parse({
          ...old,
          revision: meta.revision + 1,
          createdAt: new Date().toISOString(),
          scenes: old.scenes.map((s) => {
            const n = changed.find((x) => x.sceneId === s.id);
            return n ? { ...s, narration: { ...s.narration, text: n.text } } : s;
          }),
        });
        await db.put('plan_version', `${next.planId}_${next.revision}`, o, next, meta.projectId, c);
        await db.put(
          'plan',
          meta.planId,
          o,
          { ...meta, revision: next.revision, state: 'approved' },
          meta.projectId,
          c,
        );
        // Targets are untouched, so the approved video's own report still describes this plan.
        const a: Approval = {
          approvalId: uid('approval'),
          planId: next.planId,
          revision: next.revision,
          reportId: base.approval.reportId,
          approvedAt: new Date().toISOString(),
          acceptedEffectsHash: effectsHash(next),
        };
        await db.put('approval', a.approvalId, o, a, meta.projectId, c);
        const recovery: RecoveryPreview = {
          previewId: uid('preview'),
          baseJobVersion: base.snapshot.version,
          targetPlanRevision: next.revision,
          mode: 'rerender',
          captureSceneIds: [],
          renderSceneIds: changed.map((n) => n.sceneId),
          reuseArtifactIds: base.snapshot.sceneAttempts
            .filter(
              (x) => x.status === 'succeeded' && !changed.some((n) => n.sceneId === x.sceneId),
            )
            .flatMap((x) => (x.renderedArtifactId ? [x.renderedArtifactId] : [])),
          requiresAuth: false,
          requiresStateReset: false,
          reasons: [],
          expiresAt: isoAfter(600000),
        };
        // The edit creates a new approval, so the caller needs it for any later recovery.
        return { job: await enqueue(o, next, a, c, base, recovery), approvalId: a.approvalId };
      }),
    ),
  );
  app.get('/api/v1/artifacts/:id/download', async (req) => {
    const artifact = await get<Artifact>('artifact', params(req).id, owner(req));
    if (Date.parse(artifact.expiresAt) < Date.now())
      throw new AppError('EXPIRED', '파일 보관 기간이 지났습니다.', 410);
    if (artifact.objectKey)
      return {
        url: await artifactUrl(cfg, artifact),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    const expires = Date.now() + 300000,
      signature = createHmac('sha256', cfg.key)
        .update(`${artifact.artifactId}:${expires}`)
        .digest('hex');
    return {
      url: `/api/v1/artifacts/${artifact.artifactId}/content?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires).toISOString(),
    };
  });
  app.get('/api/v1/artifacts/:id/content', async (req, reply) => {
    const q = z.object({ expires: z.coerce.number(), signature: z.string() }).parse(req.query),
      artifact = await db.get<Artifact>('artifact', params(req).id);
    const sig = createHmac('sha256', cfg.key)
      .update(`${params(req).id}:${q.expires}`)
      .digest('hex');
    if (
      !artifact ||
      q.expires < Date.now() ||
      q.expires > Date.now() + 300000 ||
      !equal(q.signature, sig) ||
      Date.parse(artifact.expiresAt) < Date.now()
    )
      throw new AppError('UNAUTHORIZED', '다운로드 링크가 만료되었거나 유효하지 않습니다.', 403);
    if (artifact.objectKey) return reply.redirect(await artifactUrl(cfg, artifact));
    const path = resolve(artifact.path);
    if (!path.startsWith(resolve(cfg.dataDir) + sep))
      throw new AppError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
    reply
      .type(artifact.mimeType)
      .header(
        'Content-Disposition',
        `inline; filename="${artifact.artifactId}.${artifact.mimeType === 'video/mp4' ? 'mp4' : 'bin'}"`,
      );
    return reply.send(createReadStream(path));
  });
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (!process.env.VERCEL && existsSync(webDist))
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  return app;
}
export { effectsHash };
