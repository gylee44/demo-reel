import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
export type Config = ReturnType<typeof config>;
export function config() {
  const dataDir = resolve(process.env.DATA_DIR ?? 'output');
  mkdirSync(dataDir, { recursive: true });
  const keyPath = resolve(dataDir, 'encryption.key');
  if (!process.env.ENCRYPTION_KEY && !existsSync(keyPath)) {
    try { writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  }
  const key = process.env.ENCRYPTION_KEY ?? readFileSync(keyPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as hex');
  return {
    dataDir, key, databaseUrl: process.env.DATABASE_URL ?? 'postgres://demo@127.0.0.1:5448/demo_reel',
    demoOrigin: new URL(process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:4001').origin,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173',
    apiPort: Number(process.env.API_PORT ?? 4000), demoPort: Number(process.env.DEMO_PORT ?? 4001),
    host: process.env.HOST ?? '127.0.0.1', quota: Number(process.env.DAILY_QUOTA ?? 3),
    // Public arbitrary-target execution requires the production network isolation gate.
    pocMode: process.env.POC_MODE !== 'false',
  };
}
