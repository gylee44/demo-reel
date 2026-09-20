import pg from 'pg';
import type { PoolClient } from 'pg';
import { PgBoss } from 'pg-boss';
export type Queryable = Pick<pg.Pool | PoolClient, 'query'>;
export class Database {
  pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: process.env.VERCEL ? 2 : 8,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS dr_records (
      kind text NOT NULL, id text NOT NULL, owner text NOT NULL, project_id text,
      document jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS dr_records_owner ON dr_records(owner,kind);
      CREATE TABLE IF NOT EXISTS dr_usage (owner text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE, count integer NOT NULL DEFAULT 0, PRIMARY KEY(owner,day));
      CREATE TABLE IF NOT EXISTS dr_idempotency (owner text NOT NULL, route text NOT NULL, key text NOT NULL, hash text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(owner,route,key));
      CREATE TABLE IF NOT EXISTS dr_users(id text PRIMARY KEY,email text NOT NULL UNIQUE,password_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS dr_sessions(token_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES dr_users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS dr_sessions_expiry ON dr_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS dr_limits(key text NOT NULL,window_id bigint NOT NULL,count integer NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(key,window_id));`);
  }
  async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async get<T>(
    kind: string,
    id: string,
    owner?: string,
    c: Queryable = this.pool,
  ): Promise<T | null> {
    const r = await c.query(
      'SELECT document FROM dr_records WHERE kind=$1 AND id=$2' + (owner ? ' AND owner=$3' : ''),
      owner ? [kind, id, owner] : [kind, id],
    );
    return r.rows[0]?.document ?? null;
  }
  async put(
    kind: string,
    id: string,
    owner: string,
    value: unknown,
    projectId: string | null = null,
    c: Queryable = this.pool,
  ) {
    await c.query(
      `INSERT INTO dr_records(kind,id,owner,project_id,document) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(kind,id) DO UPDATE SET document=EXCLUDED.document, version=dr_records.version+1, updated_at=now()
      WHERE dr_records.owner=EXCLUDED.owner`,
      [kind, id, owner, projectId, JSON.stringify(value)],
    );
  }
  async remove(kind: string, id: string, owner: string, c: Queryable = this.pool) {
    await c.query('DELETE FROM dr_records WHERE kind=$1 AND id=$2 AND owner=$3', [kind, id, owner]);
  }
  async touchLease(kind: string, id: string, owner: string, workerId: string) {
    const r = await this.pool.query(
      `UPDATE dr_records
       SET document=jsonb_set(document,'{heartbeatAt}',to_jsonb($5::text),true),
           version=version+1,updated_at=now()
       WHERE kind=$1 AND id=$2 AND owner=$3 AND document->>'workerId'=$4
       RETURNING 1`,
      [kind, id, owner, workerId, new Date().toISOString()],
    );
    return r.rowCount === 1;
  }
  async list<T>(kind: string, owner?: string): Promise<T[]> {
    const r = await this.pool.query(
      'SELECT document FROM dr_records WHERE kind=$1' +
        (owner ? ' AND owner=$2' : '') +
        ' ORDER BY created_at',
      owner ? [kind, owner] : [kind],
    );
    return r.rows.map((row) => row.document);
  }
  async close() {
    await this.pool.end();
  }
}
/**
 * Two lanes, because the two kinds of work do not cost the same. Planning waits on the provider;
 * recording holds a browser and an encoder. Sharing one lane meant a plan request queued behind
 * somebody else's video — which is also why the studio could not record itself: the click that
 * asks for a plan waited on the very worker that was filming the click.
 */
export const RECORD_QUEUE = 'demo-reel';
export const PLAN_QUEUE = 'demo-reel-plan';
export async function createQueue(connectionString: string, producerOnly = false) {
  const boss = new PgBoss({
    connectionString,
    max: producerOnly ? 1 : 4,
    ...(producerOnly ? { schedule: false, supervise: false, migrate: false } : {}),
  });
  boss.on('error', (error) => process.stderr.write(`Queue error: ${error.message}\n`));
  await boss.start();
  if (!producerOnly)
    for (const name of [RECORD_QUEUE, PLAN_QUEUE])
      await boss.createQueue(name, { retryLimit: 0, expireInSeconds: 600 });
  return boss;
}
