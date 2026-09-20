/**
 * The worker's execution lane is a session-level advisory lock on 73480219. A worker killed with
 * SIGKILL — which `docker restart` causes, because its default 10s stop wait is shorter than our
 * 15s graceful queue drain — leaves its Postgres session behind still holding it, and every
 * replacement then loops on "Execution lane busy" until Postgres notices the dead client.
 *
 *   set -a && . ./.env.neon && set +a && npx tsx scripts/lane-lock.ts [--terminate]
 *
 * That sourcing only works while the value in .env.neon stays quoted: the connection string carries
 * an unquoted `&channel_binding=`, which the shell would otherwise read as "run the assignment in
 * the background", leaving DATABASE_URL empty and pg quietly dialling localhost instead of Neon.
 * The guard below turns that into an error rather than a lock report for the wrong database.
 *
 * Without --terminate it only reports. Deploy with `docker stop -t 30` then `docker start` to
 * avoid needing this at all.
 */
import pg from 'pg';
const connectionString = process.env.DATABASE_URL;
if (!connectionString || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString))
  throw new Error(
    `DATABASE_URL ${connectionString ? 'points at localhost' : 'is unset'}; the lane lock lives in Neon. ` +
      'Check that .env.neon quotes its value, then re-run.',
  );
const client = new pg.Client({ connectionString });
await client.connect();
const holders = await client.query(
  `SELECT l.pid, a.state, a.backend_start, a.state_change
   FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory' AND l.objid = 73480219`,
);
console.log('HOLDERS', JSON.stringify(holders.rows));
if (process.argv.includes('--terminate')) {
  // Only an idle backend: a lock held by a session that is actually working is not ours to break.
  const gone = await client.query(
    `SELECT l.pid, pg_terminate_backend(l.pid) AS terminated
     FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.objid = 73480219 AND a.state = 'idle'
       AND a.pid <> pg_backend_pid()`,
  );
  console.log('TERMINATED', JSON.stringify(gone.rows));
}
await client.end();
