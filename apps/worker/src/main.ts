import { heartbeat, cleanupExpired } from './maintenance.ts';
import { config } from '../../api/src/config.ts';
import { Database, createQueue, PLAN_QUEUE, RECORD_QUEUE } from '../../api/src/db.ts';
import { processOperation, runJob, recoverInterrupted } from './runner.ts';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
const cfg = config(),
  db = new Database(cfg.databaseUrl),
  workerId = process.env.WORKER_ID || `${hostname()}:${process.pid}:${randomUUID()}`;
await db.init();
await recoverInterrupted(db, cfg.workerLeaseMs);
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
let recovering = false;
const recovery = setInterval(() => {
  if (recovering) return;
  recovering = true;
  recoverInterrupted(db, cfg.workerLeaseMs)
    .catch(() => process.stderr.write('Lease recovery failed\n'))
    .finally(() => {
      recovering = false;
    });
}, 30000);
const queue = await createQueue(cfg.databaseUrl);
type Task = { type: 'operation' | 'job'; id: string; owner: string };
const lane = (name: string, localConcurrency: number, run: (task: Task) => Promise<void>) =>
  queue.work<Task>(name, { localConcurrency, batchSize: 1, pollingIntervalSeconds: 1 }, (jobs) =>
    Promise.all(jobs.map(({ data }) => run(data))).then(() => {}),
  );
// The record lane still answers on the plan lane's behalf for anything enqueued before the split,
// so nothing already waiting is stranded by a deploy.
await lane(RECORD_QUEUE, cfg.recordConcurrency, async (task) =>
  task.type === 'operation'
    ? processOperation(db, cfg, task.id, task.owner, workerId)
    : runJob(db, cfg, task.id, task.owner, {
        crashAfterAction: process.env.POC_CRASH_AFTER_ACTION,
        workerId,
      }),
);
await lane(PLAN_QUEUE, cfg.planConcurrency, (task) =>
  processOperation(db, cfg, task.id, task.owner, workerId),
);
console.log(
  `Demo Reel worker ready: id=${workerId} record=${cfg.recordConcurrency}, plan=${cfg.planConcurrency}, browser auto-retry=0`,
);
const health = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', workerId }));
});
health.listen(Number(process.env.WORKER_HEALTH_PORT ?? 4002), cfg.host);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    clearInterval(pulse);
    clearInterval(maintenance);
    clearInterval(recovery);
    health.close();
    await queue.stop({ graceful: true, timeout: 15000 });
    await db.close();
    process.exit(0);
  });
