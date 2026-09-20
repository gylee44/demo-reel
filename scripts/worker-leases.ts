/**
 * 어떤 워커가 무엇을 잡고 있는지 본다. 예전에는 워커 한 대가 전역 advisory lock 하나를 쥐는
 * 구조라 `lane-lock.ts`로 그 락만 보면 됐지만, 지금은 **작업마다** `workerId`로 소유권을 잡고
 * `heartbeatAt`을 갱신한다. 그래서 "왜 내 작업이 안 집히지"의 답도 락이 아니라 여기에 있다.
 *
 *   set -a && . ./.env.neon && set +a && npx tsx scripts/worker-leases.ts
 *
 * 리스가 만료된(기본 WORKER_LEASE_MS=90초) 실행 중 작업은 다른 워커가 회수해 간다. 그런 줄이
 * 계속 보이면 잡고 있던 워커가 죽었는데 아무도 안 가져가는 것이므로 워커 상태를 의심할 것.
 */
import pg from 'pg';
const connectionString = process.env.DATABASE_URL;
if (!connectionString || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString))
  throw new Error(
    `DATABASE_URL ${connectionString ? 'points at localhost' : 'is unset'}; the records live in Neon. ` +
      'Check that .env.neon quotes its value, then re-run.',
  );
const leaseMs = Number(process.env.WORKER_LEASE_MS || 90000);
const client = new pg.Client({ connectionString });
await client.connect();
const rows = await client.query(
  `SELECT kind, id,
          document->>'workerId'   AS worker,
          document->>'heartbeatAt' AS beat,
          coalesce(document->'snapshot'->>'status', document->>'status') AS status
   FROM dr_records
   WHERE kind IN ('job','operation') AND document->>'workerId' IS NOT NULL
     AND coalesce(document->'snapshot'->>'status', document->>'status') IN ('queued','running')
   ORDER BY beat DESC NULLS LAST`,
);
if (!rows.rowCount) console.log('진행 중인 작업 없음');
for (const r of rows.rows) {
  const age = r.beat ? Date.now() - Date.parse(r.beat) : null;
  const stale = age === null || age > leaseMs;
  console.log(
    `${r.kind.padEnd(9)} ${String(r.id).slice(0, 28).padEnd(28)} ${String(r.status).padEnd(8)}`,
    `worker=${String(r.worker).slice(0, 26).padEnd(26)}`,
    age === null ? 'heartbeat 없음' : `heartbeat ${Math.round(age / 1000)}초 전`,
    stale ? '<- 리스 만료, 회수 대상' : '',
  );
}
await client.end();
