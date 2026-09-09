import pg from 'pg';
import type { PoolClient } from 'pg';
import { PgBoss } from 'pg-boss';
export type Queryable = Pick<pg.Pool | PoolClient, 'query'>;
export class Database {
  pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString, max: 8 }); }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS dr_records (
      kind text NOT NULL, id text NOT NULL, owner text NOT NULL, project_id text,
      document jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS dr_records_owner ON dr_records(owner,kind);
      CREATE TABLE IF NOT EXISTS dr_usage (owner text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE, count integer NOT NULL DEFAULT 0, PRIMARY KEY(owner,day));
      CREATE TABLE IF NOT EXISTS dr_idempotency (owner text NOT NULL, route text NOT NULL, key text NOT NULL, hash text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(owner,route,key));`);
  }
  async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async get<T>(kind: string, id: string, owner?: string, c: Queryable = this.pool): Promise<T | null> {
    const r = await c.query('SELECT document FROM dr_records WHERE kind=$1 AND id=$2' + (owner ? ' AND owner=$3' : ''), owner ? [kind, id, owner] : [kind, id]);
    return r.rows[0]?.document ?? null;
  }
  async put(kind: string, id: string, owner: string, value: unknown, projectId: string | null = null, c: Queryable = this.pool) {
    await c.query(`INSERT INTO dr_records(kind,id,owner,project_id,document) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(kind,id) DO UPDATE SET document=EXCLUDED.document, version=dr_records.version+1, updated_at=now()
      WHERE dr_records.owner=EXCLUDED.owner`, [kind,id,owner,projectId,JSON.stringify(value)]);
  }
  async remove(kind: string, id: string, owner: string, c: Queryable = this.pool) { await c.query('DELETE FROM dr_records WHERE kind=$1 AND id=$2 AND owner=$3', [kind,id,owner]); }
  async list<T>(kind: string, owner?: string): Promise<T[]> {
    const r = await this.pool.query('SELECT document FROM dr_records WHERE kind=$1' + (owner ? ' AND owner=$2' : '') + ' ORDER BY created_at', owner ? [kind,owner] : [kind]);
    return r.rows.map(row => row.document);
  }
  async close() { await this.pool.end(); }
}
export async function createQueue(connectionString: string) {
  const boss = new PgBoss({ connectionString });
  boss.on('error', error => process.stderr.write(`Queue error: ${error.message}\n`));
  await boss.start();
  await boss.createQueue('demo-reel', { retryLimit: 0, expireInSeconds: 600 });
  return boss;
}
