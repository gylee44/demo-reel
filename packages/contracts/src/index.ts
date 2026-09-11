import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const url = z.url().refine((value) => {
  const u = new URL(value);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
}, 'Only HTTP(S) URLs without credentials are allowed');
export const ValueSchema = z.union([
  z.string().max(4000),
  z.strictObject({ sceneId: id, output: id }),
]);
export type Value = z.infer<typeof ValueSchema>;
export const ConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('visible'), locatorId: id }),
  z.strictObject({ type: z.literal('hidden'), locatorId: id }),
  z.strictObject({ type: z.literal('textEquals'), locatorId: id, value: ValueSchema }),
  z.strictObject({
    type: z.literal('countEquals'),
    locatorId: id,
    value: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('urlMatches'), value: ValueSchema }),
]);
export type Condition = z.infer<typeof ConditionSchema>;
export const LocatorSchema = z
  .strictObject({
    id,
    strategy: z.enum(['role', 'label', 'testId', 'css']),
    value: ValueSchema,
    role: z.string().nullable(),
    exact: z.boolean(),
    scopeLocatorId: id.nullable(),
    evidenceId: id,
  })
  .superRefine((l, ctx) => {
    if (l.strategy === 'role' && !l.role)
      ctx.addIssue({ code: 'custom', message: 'role is required' });
    if (l.strategy !== 'role' && l.role !== null)
      ctx.addIssue({ code: 'custom', message: 'role is only valid for role locators' });
    if (l.strategy === 'css' && typeof l.value !== 'string')
      ctx.addIssue({ code: 'custom', message: 'Dynamic CSS is unsupported' });
  });
const common = {
  id,
  atMs: z.number().int().min(0).max(30000),
  timeoutMs: z.number().int().min(1).max(30000),
};
export const ActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('navigate'), url: ValueSchema }),
  z.strictObject({ ...common, type: z.literal('click'), locatorId: id }),
  z.strictObject({ ...common, type: z.literal('fill'), locatorId: id, value: ValueSchema }),
  z.strictObject({ ...common, type: z.literal('select'), locatorId: id, value: ValueSchema }),
  z.strictObject({
    ...common,
    type: z.literal('press'),
    locatorId: id,
    key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']),
  }),
  z.strictObject({
    ...common,
    type: z.literal('scroll'),
    deltaY: z.number().int().min(-2000).max(2000),
  }),
  z.strictObject({ ...common, type: z.literal('waitFor'), condition: ConditionSchema }),
  z.strictObject({ ...common, type: z.literal('assert'), condition: ConditionSchema }),
]);
export type Action = z.infer<typeof ActionSchema>;
export const SceneSchema = z.strictObject({
  id,
  title: z.string().min(1).max(120),
  purpose: z.string().max(1000),
  entry: z.strictObject({ url: ValueSchema, readyConditions: z.array(ConditionSchema).min(1) }),
  dependsOn: z.array(id),
  preconditions: z.array(ConditionSchema),
  actions: z.array(ActionSchema).min(1).max(20),
  postconditions: z.array(ConditionSchema).min(1),
  narration: z.strictObject({
    text: z.string().min(1).max(1500),
    estimatedDurationMs: z.number().int().positive(),
  }),
  timing: z.strictObject({
    maxDurationMs: z.number().int().min(1000).max(30000),
    tailHoldMs: z.number().int().min(0).max(3000),
    maxFreezeMs: z.number().int().min(0).max(3000),
  }),
  effects: z.strictObject({
    reads: z.array(z.string()),
    writes: z.array(z.string()),
    summary: z.string().max(1000),
  }),
  retryPolicy: z.enum(['read_only', 'verify_before_repeat', 'manual_reset']),
  recoveryConditions: z
    .strictObject({
      alreadyCompleted: z.array(ConditionSchema).min(1),
      safeToRepeat: z.array(ConditionSchema).min(1),
    })
    .nullable(),
  outputs: z.array(
    z.strictObject({
      name: id,
      source: z.enum(['text', 'href', 'currentUrl']),
      locatorId: id.nullable(),
    }),
  ),
});
export type Scene = z.infer<typeof SceneSchema>;
export const PlanSchema = z
  .strictObject({
    schemaVersion: z.literal('0.1'),
    planId: id,
    projectId: id,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(120),
    intent: z.string().min(1).max(2000),
    target: z.strictObject({ baseUrl: url, allowedOrigins: z.array(url).min(1).max(5) }),
    auth: z.strictObject({
      mode: z.enum(['form', 'storage_state', 'none']),
      authRef: id.nullable(),
      expiresAt: z.iso.datetime().nullable(),
    }),
    format: z.strictObject({
      width: z.literal(1280),
      height: z.literal(720),
      targetDurationMs: z.literal(60000),
      maxDurationMs: z.literal(75000),
      language: z.literal('ko-KR'),
    }),
    locators: z.array(LocatorSchema).min(1).max(100),
    scenes: z.array(SceneSchema).min(1).max(6),
    createdAt: z.iso.datetime(),
  })
  .superRefine((p, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: string[], name: string) => {
      if (new Set(values).size !== values.length) issue(`Duplicate ${name}`);
    };
    unique(
      p.locators.map((l) => l.id),
      'locator ID',
    );
    unique(
      p.scenes.map((s) => s.id),
      'scene ID',
    );
    unique(
      p.scenes.flatMap((s) => s.actions.map((a) => a.id)),
      'action ID',
    );
    const origins = p.target.allowedOrigins;
    for (const origin of origins)
      if (new URL(origin).origin !== origin) issue('allowedOrigins must contain origins only');
    const checkUrl = (value: Value) => {
      if (typeof value !== 'string') return;
      const parsed = url.safeParse(value);
      if (!parsed.success || !origins.includes(new URL(value).origin))
        issue('URL outside allowed origins');
    };
    checkUrl(p.target.baseUrl);
    if (
      p.auth.mode === 'none'
        ? p.auth.authRef !== null || p.auth.expiresAt !== null
        : !p.auth.authRef || !p.auth.expiresAt
    )
      issue('Invalid authentication reference');
    const locators = new Map(p.locators.map((l) => [l.id, l]));
    const checkLocator = (key: string) => {
      if (!locators.has(key)) issue(`Unknown locator: ${key}`);
    };
    for (const l of p.locators) {
      const seen = new Set([l.id]);
      let scope = l.scopeLocatorId;
      while (scope) {
        if (seen.has(scope)) {
          issue('Cyclic locator scope');
          break;
        }
        seen.add(scope);
        checkLocator(scope);
        scope = locators.get(scope)?.scopeLocatorId ?? null;
      }
    }
    const preceding = new Map<string, Scene>();
    for (const s of p.scenes) {
      unique(s.dependsOn, 'dependency');
      unique(
        s.outputs.map((o) => o.name),
        'output',
      );
      for (const d of s.dependsOn)
        if (!preceding.has(d)) issue('Dependencies must precede the scene');
      const checkValue = (v: Value) => {
        if (typeof v === 'string') return;
        if (
          !s.dependsOn.includes(v.sceneId) ||
          !preceding.get(v.sceneId)?.outputs.some((o) => o.name === v.output)
        )
          issue('Undeclared output dependency');
      };
      const checkCondition = (c: Condition) => {
        if ('locatorId' in c) checkLocator(c.locatorId);
        if ('value' in c && typeof c.value !== 'number') checkValue(c.value);
        if (c.type === 'urlMatches') checkUrl(c.value);
      };
      checkUrl(s.entry.url);
      checkValue(s.entry.url);
      [
        ...s.entry.readyConditions,
        ...s.preconditions,
        ...s.postconditions,
        ...(s.recoveryConditions?.alreadyCompleted ?? []),
        ...(s.recoveryConditions?.safeToRepeat ?? []),
      ].forEach(checkCondition);
      for (const a of s.actions) {
        if (a.atMs >= s.timing.maxDurationMs) issue('Action starts after scene budget');
        if ('locatorId' in a) {
          checkLocator(a.locatorId);
          let l = locators.get(a.locatorId);
          const seen = new Set<string>();
          while (l && !seen.has(l.id)) {
            seen.add(l.id);
            checkValue(l.value);
            l = l.scopeLocatorId ? locators.get(l.scopeLocatorId) : undefined;
          }
        }
        if ('value' in a) checkValue(a.value);
        if ('condition' in a) checkCondition(a.condition);
        if (a.type === 'navigate') {
          checkUrl(a.url);
          checkValue(a.url);
        }
      }
      for (const o of s.outputs) {
        if (o.source !== 'currentUrl' && !o.locatorId) issue('Output locator required');
        if (o.locatorId) checkLocator(o.locatorId);
      }
      if (s.retryPolicy === 'read_only' && s.effects.writes.length)
        issue('Writing scenes cannot be read_only');
      if ((s.retryPolicy === 'verify_before_repeat') !== (s.recoveryConditions !== null))
        issue('Recovery predicates required only for verify_before_repeat');
      if (s.narration.estimatedDurationMs + s.timing.tailHoldMs > s.timing.maxDurationMs)
        issue('Estimated narration exceeds scene budget');
      preceding.set(s.id, s);
    }
  });
export type Plan = z.infer<typeof PlanSchema>;
export type Outputs = Record<string, Record<string, string>>;
export function resolveValue(value: Value, outputs: Outputs): string {
  if (typeof value === 'string') return value;
  const result = outputs[value.sceneId]?.[value.output];
  if (result === undefined) throw new Error('PRECONDITION_FAILED');
  return result;
}
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'needs_action',
  'succeeded',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type Failure = {
  code: string;
  message: string;
  sceneId: string | null;
  actionId: string | null;
  locatorId: string | null;
  screenshotArtifactId: string | null;
  suggestedAction: string;
};
export type Attempt = {
  attemptId: string;
  jobId: string;
  sceneId: string;
  planRevision: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  stage: string;
  startedAt: string | null;
  finishedAt: string | null;
  rawClipArtifactId: string | null;
  renderedArtifactId: string | null;
  audioArtifactId: string | null;
  outputs: Record<string, string>;
  effectOutcome: 'none' | 'confirmed' | 'unknown';
  failure: Failure | null;
  reusedFromAttemptId?: string;
  captureHash?: string;
  durationMs?: number;
  trimStartMs?: number;
};
export type Job = {
  jobId: string;
  version: number;
  status: JobStatus;
  stage: string;
  planId: string;
  revision: number;
  sceneAttempts: Attempt[];
  completedSceneCount: number;
  totalSceneCount: number;
  outputArtifactId: string | null;
  failure: Failure | null;
  expiresAt: string;
};
export type ValidationReport = {
  reportId: string;
  planId: string;
  revision: number;
  checkedAt: string;
  expiresAt: string;
  issues: {
    code: string;
    message: string;
    sceneId: string | null;
    severity: 'error' | 'warning';
  }[];
  targets: {
    locatorId: string;
    status: 'verified' | 'runtime_required' | 'blocked';
    count: number;
    evidenceId: string;
  }[];
};
export type Approval = {
  approvalId: string;
  planId: string;
  revision: number;
  reportId: string;
  approvedAt: string;
  acceptedEffectsHash: string;
};
export type RecoveryPreview = {
  previewId: string;
  baseJobVersion: number;
  targetPlanRevision: number;
  mode: 'recapture' | 'rerender' | 'compose';
  captureSceneIds: string[];
  renderSceneIds: string[];
  reuseArtifactIds: string[];
  requiresAuth: boolean;
  requiresStateReset: boolean;
  reasons: string[];
  expiresAt: string;
};
