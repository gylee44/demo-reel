import type { Approval, Job, Plan, RecoveryPreview } from '../../../packages/contracts/src/index.ts';
export type Project = { projectId: string; owner: string; targetUrl: string; intent: string; repoUrl?: string; authRef?: string; authIdentity?: string };
export type AuthRecord = { authRef: string; owner: string; projectId: string; mode: 'form' | 'storage_state'; ciphertext: string; expiresAt: string };
export type PlanRecord = { owner: string; projectId: string; planId: string; revision: number; state: string };
export type Operation = { operationId: string; owner: string; projectId: string; type: 'plan' | 'validation'; status: 'queued' | 'running' | 'succeeded' | 'failed'; planId?: string; revision?: number; authRef?: string; reportId?: string; error?: { code: string; message: string } };
export type InternalJob = { owner: string; projectId: string; snapshot: Job; plan: Plan; approval: Approval; cancelRequested: boolean; baseJobId?: string; recovery?: RecoveryPreview; queueId?: string; heartbeatAt?: string; reservation: boolean };
export type StoredPreview = { owner: string; baseJobId: string; targetPlanId: string; preview: RecoveryPreview };
export type Artifact = { artifactId: string; owner: string; jobId: string; kind: 'raw' | 'clip' | 'audio' | 'final' | 'screenshot'; path: string; mimeType: string; sha256: string; expiresAt: string; durationMs?: number };
