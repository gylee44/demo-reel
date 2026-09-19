import { materializeArtifact } from '../../../packages/runtime/src/storage.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import type { Browser, BrowserContextOptions } from 'playwright';
import {
  PlanSchema,
  type Plan,
  type Attempt,
  type Failure,
  type Outputs,
  type ValidationReport,
  type Scene,
} from '../../../packages/contracts/src/index.ts';
import { buildProjectPlan } from './planning.ts';
import { validatePlan } from './validation.ts';
export { validatePlan } from './validation.ts';
import { narrate } from './narration.ts';
import { affectedScenes } from '../../../packages/contracts/src/rules.ts';
import { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import { AppError, hash } from '../../api/src/security.ts';
import type {
  Operation,
  Project,
  PlanRecord,
  InternalJob,
  Artifact,
} from '../../api/src/models.ts';
import {
  launchBrowser,
  authenticate,
  newContext,
  locate,
  captureScene,
  type Elision,
} from './browser.ts';
import { renderScene, compose, storeArtifact, writeManifest, type Narration } from './media.ts';
const uid = (s: string) => `${s}_${randomUUID()}`;
function failure(error: unknown, sceneId: string | null = null): Failure {
  // An unexpected error is replaced by a generic message for the user, so the worker log is the
  // only place its cause survives. Without this there is nothing to debug a production failure with.
  if (!(error instanceof AppError))
    console.error('[worker] unexpected failure', sceneId ? `scene=${sceneId}` : '', error);
  const e =
    error instanceof AppError
      ? error
      : new AppError('RENDER_FAILED', '처리 중 오류가 발생했습니다.');
  return {
    code: e.code,
    message: e.message,
    sceneId,
    actionId: (e as any).actionId ?? null,
    locatorId: null,
    screenshotArtifactId: null,
    suggestedAction: ['AUTH_EXPIRED', 'AUTH_FAILED'].includes(e.code)
      ? '테스트 계정 또는 세션을 다시 입력해 주세요.'
      : e.code === 'EFFECT_UNKNOWN'
        ? '앱의 데이터 변경 결과를 확인한 뒤 다시 시도해 주세요.'
        : '계획과 테스트 앱 상태를 확인하고 필요한 장면만 다시 만들어 주세요.',
  };
}
export async function processOperation(db: Database, cfg: Config, id: string, owner: string) {
  const op = await db.get<Operation>('operation', id, owner);
  if (!op || op.status !== 'queued') return;
  op.status = 'running';
  await db.put('operation', id, owner, op, op.projectId);
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(cfg);
    let plan: Plan;
    if (op.type === 'plan') {
      const project = await db.get<Project>('project', op.projectId, owner);
      if (!project) throw new AppError('NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
      plan = await buildProjectPlan(browser, db, cfg, project, op.authRef);
      const report = await validatePlan(browser, db, cfg, plan, owner);
      await db.put('plan_version', `${plan.planId}_1`, owner, plan, op.projectId);
      await db.put(
        'plan',
        plan.planId,
        owner,
        {
          owner,
          projectId: op.projectId,
          planId: plan.planId,
          revision: 1,
          state: report.issues.length ? 'needs_changes' : 'ready_for_review',
        } satisfies PlanRecord,
        op.projectId,
      );
      op.planId = plan.planId;
      op.revision = 1;
      op.reportId = report.reportId;
    } else {
      const value = await db.get<Plan>('plan_version', `${op.planId}_${op.revision}`, owner);
      if (!value) throw new AppError('NOT_FOUND', '계획을 찾을 수 없습니다.');
      plan = PlanSchema.parse(value);
      const report = await validatePlan(browser, db, cfg, plan, owner);
      op.reportId = report.reportId;
      await db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
        const meta = await db.get<PlanRecord>('plan', plan.planId, owner, c);
        if (meta?.revision === plan.revision)
          await db.put(
            'plan',
            plan.planId,
            owner,
            { ...meta, state: report.issues.length ? 'needs_changes' : 'ready_for_review' },
            op.projectId,
            c,
          );
      });
    }
    op.status = 'succeeded';
  } catch (e) {
    op.status = 'failed';
    const f = failure(e);
    op.error = { code: f.code, message: f.message };
  } finally {
    await browser?.close();
    await db.put('operation', id, owner, op, op.projectId);
  }
}
async function persist(db: Database, record: InternalJob) {
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [record.owner]);
    const latest = await db.get<InternalJob>('job', record.snapshot.jobId, record.owner, c);
    if (latest?.cancelRequested) record.cancelRequested = true;
    record.snapshot.version = (latest?.snapshot.version ?? record.snapshot.version) + 1;
    record.snapshot.completedSceneCount = record.snapshot.sceneAttempts.filter(
      (a) => a.status === 'succeeded',
    ).length;
    record.heartbeatAt = new Date().toISOString();
    await db.put('job', record.snapshot.jobId, record.owner, record, record.projectId, c);
  });
}
export async function recoverInterrupted(db: Database) {
  for (const record of await db.list<InternalJob>('job'))
    if (record.snapshot.status === 'running') {
      record.snapshot.status = 'needs_action';
      record.snapshot.failure = failure(
        new AppError(
          'WORKER_INTERRUPTED',
          '실행 프로세스가 중단되었습니다. 실제 앱의 변경 상태를 확인해 주세요.',
        ),
      );
      for (const a of record.snapshot.sceneAttempts)
        if (a.status === 'running') {
          a.status = 'failed';
          a.failure = record.snapshot.failure;
        }
      if (record.plan.auth.authRef) await db.remove('auth', record.plan.auth.authRef, record.owner);
      await persist(db, record);
    }
  for (const op of await db.list<Operation>('operation'))
    if (op.status === 'running') {
      op.status = 'failed';
      op.error = {
        code: 'WORKER_INTERRUPTED',
        message: '계획 처리 중 실행 프로세스가 중단되었습니다. 다시 요청해 주세요.',
      };
      await db.put('operation', op.operationId, op.owner, op, op.projectId);
    }
}
export async function runJob(
  db: Database,
  cfg: Config,
  id: string,
  owner: string,
  options: { crashAfterAction?: string; browserFactory?: typeof launchBrowser } = {},
) {
  let record = await db.get<InternalJob>('job', id, owner);
  if (!record || record.snapshot.status !== 'queued') return;
  const claimed = await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    const fresh = await db.get<InternalJob>('job', id, owner, c);
    if (!fresh || fresh.snapshot.status !== 'queued') return null;
    fresh.snapshot.status = 'running';
    fresh.snapshot.version++;
    await db.put('job', id, owner, fresh, fresh.projectId, c);
    return fresh;
  });
  if (!claimed) return;
  record = claimed;
  const job = record.snapshot,
    plan = PlanSchema.parse(record.plan),
    dir = join(cfg.dataDir, 'jobs', id);
  await mkdir(dir, { recursive: true });
  let browser: Browser | undefined;
  const started = Date.now();
  const outputs: Outputs = {};
  try {
    if (
      hash(plan.scenes.map((s) => ({ id: s.id, effects: s.effects }))) !==
      record.approval.acceptedEffectsHash
    )
      throw new AppError('STALE_REVISION', '승인한 데이터 변경 범위와 다릅니다.');
    const base = record.baseJobId
      ? await db.get<InternalJob>('job', record.baseJobId, owner)
      : null;
    const captureIds = new Set(record.recovery?.captureSceneIds ?? plan.scenes.map((s) => s.id));
    const renderIds = new Set(record.recovery?.renderSceneIds ?? plan.scenes.map((s) => s.id));
    browser = await (options.browserFactory ?? launchBrowser)(cfg);
    job.stage = 'audio';
    await persist(db, record);
    const audio = new Map();
    const audioDeadline = Date.now() + 120000;
    // Scenes kept as-is reuse their finished clip, so re-voicing them would only cost provider calls.
    for (const scene of plan.scenes)
      if (renderIds.has(scene.id))
        audio.set(
          scene.id,
          await narrate(scene, cfg, join(dir, `audio-${scene.id}`), audioDeadline),
        );
    function narrationFor(sceneId: string): Narration {
      const voiced = audio.get(sceneId);
      if (!voiced) throw new AppError('RENDER_FAILED', '이 장면의 음성을 준비하지 못했습니다.');
      return voiced;
    }
    let state: BrowserContextOptions['storageState'];
    if (captureIds.size) {
      job.stage = 'preflight';
      await persist(db, record);
      state = await authenticate(browser, db, cfg, plan, owner);
      const report = await db.get<ValidationReport>('validation', record.approval.reportId, owner);
      if (!report) throw new AppError('VALIDATION_EXPIRED', '계획 검증 결과가 없습니다.');
      if (Date.parse(report.expiresAt) <= Date.now()) {
        const refreshed = await validatePlan(browser, db, cfg, plan, owner, [...captureIds]);
        if (refreshed.issues.some((i) => i.severity === 'error'))
          throw new AppError(
            'VALIDATION_EXPIRED',
            '화면이 달라졌습니다. 계획을 다시 검토해 주세요.',
          );
      }
    }
    async function check() {
      if (Date.now() - started > 600000)
        throw new AppError('ACTION_TIMEOUT', '전체 작업 실행 시간이 초과되었습니다.');
      const latest = await db.get<InternalJob>('job', id, owner);
      if (latest?.cancelRequested) throw new AppError('CANCELLED', '사용자가 작업을 취소했습니다.');
      if (captureIds.size && plan.auth.authRef) {
        const auth = await db.get<any>('auth', plan.auth.authRef, owner);
        if (!auth || Date.parse(auth.expiresAt) <= Date.now())
          throw new AppError('AUTH_EXPIRED', '인증 자료가 삭제되었거나 만료되었습니다.');
      }
    }
    /**
     * A scene that broke has still been recorded up to the moment it broke, and its narration is
     * already made. Render that much instead of dropping it: a reel one step short of the plan is
     * worth more to the person waiting than a job that hands back no video at all. The last frame
     * holds while the rest of the narration plays, which is what the freeze override is for.
     */
    async function salvage(
      scene: Scene,
      attempt: Attempt,
      narration: Narration | undefined,
      rawPath: string | undefined,
      elisions: Elision[] | undefined,
    ) {
      if (!narration || !rawPath || !browser) return;
      try {
        const durationMs = narration.durationMs + scene.timing.tailHoldMs;
        const rendered = await renderScene(
          browser,
          rawPath,
          scene,
          narration,
          durationMs,
          join(dir, `${scene.id}-salvage`),
          { elisions, maxFreezeMs: durationMs },
        );
        const artifact = await storeArtifact(
          db,
          cfg,
          owner,
          id,
          'clip',
          rendered.path,
          rendered.durationMs,
        );
        attempt.renderedArtifactId = artifact.artifactId;
        attempt.durationMs = rendered.durationMs;
        attempt.trimStartMs = rendered.trimStartMs;
        attempt.status = 'degraded';
      } catch (error) {
        console.error(`[worker] salvage render failed scene=${scene.id}`, error);
      }
    }
    const blocked = new Set<string>();
    for (const scene of plan.scenes) {
      await check();
      const prior = base?.snapshot.sceneAttempts.find(
        (a) => a.sceneId === scene.id && a.status === 'succeeded',
      );
      const attempt: Attempt = {
        attemptId: uid('attempt'),
        jobId: id,
        sceneId: scene.id,
        planRevision: plan.revision,
        status: 'running',
        stage: 'capture',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        rawClipArtifactId: null,
        renderedArtifactId: null,
        audioArtifactId: null,
        outputs: {},
        effectOutcome: 'none',
        failure: null,
      };
      job.sceneAttempts.push(attempt);
      if (blocked.has(scene.id)) {
        attempt.status = 'skipped';
        await persist(db, record);
        continue;
      }
      let n: Narration | undefined;
      try {
        let rawPath: string;
        let durationMs: number;
        if (!captureIds.has(scene.id) && prior) {
          Object.assign(attempt, {
            ...prior,
            attemptId: attempt.attemptId,
            jobId: id,
            planRevision: plan.revision,
            reusedFromAttemptId: prior.attemptId,
            startedAt: attempt.startedAt,
          });
          outputs[scene.id] = prior.outputs;
          if (!renderIds.has(scene.id)) {
            attempt.status = 'succeeded';
            await persist(db, record);
            continue;
          }
          n = narrationFor(scene.id);
          const raw = await db.get<Artifact>('artifact', prior.rawClipArtifactId!, owner);
          if (!raw || Date.parse(raw.expiresAt) < Date.now())
            throw new AppError('RENDER_FAILED', '재사용할 원본 영상이 만료되었습니다.');
          await stat(await materializeArtifact(cfg, raw));
          rawPath = await materializeArtifact(cfg, raw);
          durationMs = Math.max(prior.durationMs!, n.durationMs + scene.timing.tailHoldMs);
          attempt.status = 'running';
        } else {
          if (record.recovery?.requiresStateReset)
            throw new AppError(
              'EFFECT_UNKNOWN',
              '앱 상태 확인이 필요한 장면은 자동 재실행하지 않습니다.',
            );
          n = narrationFor(scene.id);
          job.stage = 'capture';
          await persist(db, record);
          const captured = await captureScene(
            browser,
            plan,
            scene,
            state,
            outputs,
            join(dir, scene.id),
            n.durationMs,
            {
              check,
              beforeMutation: async (action) => {
                attempt.effectOutcome = 'unknown';
                attempt.failure = {
                  ...failure(
                    new AppError('EFFECT_UNKNOWN', '데이터 변경 결과를 아직 확인하지 못했습니다.'),
                    scene.id,
                  ),
                  actionId: action.id,
                };
                await persist(db, record);
              },
              afterAction: async (action, page) => {
                if (
                  cfg.pocMode &&
                  options.crashAfterAction === 'create_save' &&
                  action.id === 'create_save'
                ) {
                  // Fixture-only crash window: the HTTP write has committed and the real result
                  // is visible, but the durable attempt outcome is deliberately still unknown.
                  await page
                    .getByRole('heading', { name: '데모 영상 만들기', exact: true })
                    .waitFor();
                  process.exit(86);
                }
              },
            },
          );
          state = captured.storageState;
          rawPath = captured.rawPath;
          durationMs = captured.durationMs;
          outputs[scene.id] = captured.outputs;
          attempt.outputs = captured.outputs;
          attempt.elisions = captured.elisions;
          attempt.effectOutcome = scene.effects.writes.length ? 'confirmed' : 'none';
          attempt.failure = null;
          const raw = await storeArtifact(db, cfg, owner, id, 'raw', rawPath);
          attempt.rawClipArtifactId = raw.artifactId;
          attempt.captureHash = raw.sha256;
        }
        attempt.stage = 'render';
        job.stage = 'render';
        await persist(db, record);
        const narrated = await storeArtifact(db, cfg, owner, id, 'audio', n.file, n.durationMs);
        attempt.audioArtifactId = narrated.artifactId;
        const rendered = await renderScene(
          browser,
          rawPath,
          scene,
          n,
          durationMs,
          join(dir, `${scene.id}-render`),
          {
            knownOffset: attempt.trimStartMs === undefined ? undefined : attempt.trimStartMs / 1000,
            elisions: attempt.elisions,
          },
        );
        const artifact = await storeArtifact(
          db,
          cfg,
          owner,
          id,
          'clip',
          rendered.path,
          rendered.durationMs,
        );
        attempt.renderedArtifactId = artifact.artifactId;
        attempt.durationMs = rendered.durationMs;
        attempt.trimStartMs = rendered.trimStartMs;
        attempt.status = 'succeeded';
        attempt.failure = null;
        attempt.finishedAt = new Date().toISOString();
      } catch (error) {
        if (error instanceof AppError && ['CANCELLED', 'AUTH_EXPIRED'].includes(error.code))
          throw error;
        attempt.status = 'failed';
        attempt.failure = failure(error, scene.id);
        attempt.finishedAt = new Date().toISOString();
        if ((error as any).screenshotPath) {
          try {
            const img = await storeArtifact(
              db,
              cfg,
              owner,
              id,
              'screenshot',
              (error as any).screenshotPath,
            );
            attempt.failure.screenshotArtifactId = img.artifactId;
          } catch {}
        }
        if (attempt.effectOutcome === 'unknown')
          attempt.failure.suggestedAction =
            '데이터가 이미 변경되었을 수 있습니다. 앱의 결과를 확인한 뒤 복구해 주세요.';
        await salvage(scene, attempt, n, (error as any).rawPath, (error as any).elisions);
        affectedScenes(plan, [scene.id])
          .filter((id) => id !== scene.id)
          .forEach((id) => blocked.add(id));
      }
      await persist(db, record);
    }
    // Compose whatever came out with a clip in it. A scene that failed outright, or one that was
    // skipped because it depended on that scene, simply is not in the reel; the job still reports
    // what went wrong so the person can re-record just that scene, but it hands them a video first.
    const usable = job.sceneAttempts.filter((a) => a.renderedArtifactId);
    const incomplete = job.sceneAttempts.some((a) => a.status !== 'succeeded');
    if (!usable.length) {
      job.status = 'needs_action';
      job.failure =
        job.sceneAttempts.find((a) => a.failure)?.failure ??
        failure(new AppError('PRECONDITION_FAILED', '일부 장면을 실행하지 못했습니다.'));
    } else {
      job.stage = 'compose';
      await persist(db, record);
      const clips = [];
      for (const a of usable) {
        const artifact = await db.get<Artifact>('artifact', a.renderedArtifactId!, owner);
        if (!artifact) throw new AppError('RENDER_FAILED', '클립이 없습니다.');
        clips.push({ path: await materializeArtifact(cfg, artifact), durationMs: a.durationMs! });
      }
      // The length floor is an acceptance check on a complete run, and planning now measures it
      // from the narration. Applying it again to a reel that is already short a scene would throw
      // away the one thing still worth delivering.
      const final = await compose(clips, join(dir, 'final.mp4'), !incomplete);
      job.stage = 'verify';
      await persist(db, record);
      const out = await storeArtifact(db, cfg, owner, id, 'final', final.path, final.durationMs);
      job.outputArtifactId = out.artifactId;
      // The video is there either way; needs_action says a scene in it is not what was planned.
      job.status = incomplete ? 'needs_action' : 'succeeded';
      if (incomplete)
        job.failure =
          job.sceneAttempts.find((a) => a.failure)?.failure ??
          failure(new AppError('PRECONDITION_FAILED', '일부 장면을 실행하지 못했습니다.'));
      await writeManifest(join(dir, 'manifest.json'), {
        planId: plan.planId,
        revision: plan.revision,
        planHash: hash(plan),
        jobId: id,
        sceneAttempts: job.sceneAttempts,
        output: out,
        renderProfile: '720p30-h264-aac-v1',
        elapsedMs: Date.now() - started,
      });
    }
  } catch (error) {
    job.status =
      error instanceof AppError && error.code === 'CANCELLED' ? 'cancelled' : 'needs_action';
    job.failure = failure(error);
  } finally {
    await browser?.close().catch(() => {});
    if (plan.auth.authRef) await db.remove('auth', plan.auth.authRef, owner);
    await persist(db, record);
  }
}
