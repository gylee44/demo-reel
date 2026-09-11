import { rm } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import type { Artifact, AuthRecord, InternalJob } from '../../api/src/models.ts';
import { deleteStoredArtifact, storageReady } from '../../../packages/runtime/src/storage.ts';
export async function heartbeat(db: Database, cfg: Config) {
  await db.put('runtime', 'worker', 'system', {
    mode: cfg.pocMode ? 'poc' : 'service',
    plannerReady: !!(cfg.openaiKey && cfg.plannerModel),
    storageReady: storageReady(cfg),
    updatedAt: new Date().toISOString(),
  });
}
export async function cleanupExpired(db: Database, cfg: Config) {
  for (const artifact of await db.list<Artifact>('artifact'))
    if (Date.parse(artifact.expiresAt) <= Date.now()) {
      await deleteStoredArtifact(cfg, artifact);
      for (const path of [resolve(artifact.path), join(cfg.dataDir, 'cache', artifact.artifactId)])
        if (path.startsWith(resolve(cfg.dataDir) + sep)) await rm(path, { force: true });
      await db.remove('artifact', artifact.artifactId, artifact.owner);
    }
  for (const auth of await db.list<AuthRecord>('auth'))
    if (Date.parse(auth.expiresAt) <= Date.now()) await db.remove('auth', auth.authRef, auth.owner);
  for (const job of await db.list<InternalJob>('job'))
    if (
      !['queued', 'running'].includes(job.snapshot.status) &&
      Date.parse(job.snapshot.expiresAt) <= Date.now()
    )
      await rm(join(cfg.dataDir, 'jobs', job.snapshot.jobId), { recursive: true, force: true });
  await db.pool.query('DELETE FROM dr_sessions WHERE expires_at<=now()');
  await db.pool.query('DELETE FROM dr_limits WHERE expires_at<=now()');
}
