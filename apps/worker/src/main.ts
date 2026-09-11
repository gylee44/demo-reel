import { heartbeat, cleanupExpired } from './maintenance.ts';
import { config } from '../../api/src/config.ts';
import { Database, createQueue } from '../../api/src/db.ts';
import { processOperation, runJob, recoverInterrupted } from './runner.ts';
import { createServer } from 'node:http';
const cfg = config(),
  db = new Database(cfg.databaseUrl);
await db.init();
// One browser/encoding worker owns the entire execution lane, including after restarts.
const lease = await db.pool.connect();
const lock = await lease.query('SELECT pg_try_advisory_lock(73480219) AS acquired');
if (!lock.rows[0].acquired) {
  console.error('Another Demo Reel worker owns the execution lane.');
  lease.release();
  await db.close();
  process.exit(1);
}
await recoverInterrupted(db);
await cleanupExpired(db, cfg);
await heartbeat(db, cfg);
const pulse = setInterval(() => {
  heartbeat(db, cfg).catch(() => process.stderr.write('Worker heartbeat failed\n'));
}, 15000);
let cleaning = false;
const maintenance = setInterval(() => {
  if (cleaning) return;
  cleaning = true;
  cleanupExpired(db, cfg)
    .catch(() => process.stderr.write('Cleanup failed\n'))
    .finally(() => {
      cleaning = false;
    });
}, 300000);
const queue = await createQueue(cfg.databaseUrl);
await queue.work<{ type: 'operation' | 'job'; id: string; owner: string }>(
  'demo-reel',
  { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
  async (jobs) => {
    for (const { data } of jobs)
      if (data.type === 'operation') await processOperation(db, cfg, data.id, data.owner);
      else
        await runJob(db, cfg, data.id, data.owner, {
          crashAfterAction: process.env.POC_CRASH_AFTER_ACTION,
        });
  },
);
console.log('Demo Reel worker ready: concurrency=1, browser auto-retry=0');
const health = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
});
health.listen(Number(process.env.WORKER_HEALTH_PORT ?? 4002), cfg.host);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    clearInterval(pulse);
    clearInterval(maintenance);
    health.close();
    await queue.stop({ graceful: true, timeout: 15000 });
    await lease.query('SELECT pg_advisory_unlock(73480219)');
    lease.release();
    await db.close();
    process.exit(0);
  });
