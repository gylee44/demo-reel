import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
export type Config = ReturnType<typeof config>;
export function config() {
  const production = process.env.NODE_ENV === 'production';
  const pocMode = process.env.POC_MODE === 'true';
  if (production && pocMode) throw new Error('POC_MODE is forbidden in production');
  if (production && (!process.env.ENCRYPTION_KEY || !process.env.DATABASE_URL))
    throw new Error('DATABASE_URL and ENCRYPTION_KEY are required in production');
  const webOrigin = process.env.WEB_ORIGIN || 'http://127.0.0.1:5173';
  if (
    production &&
    (new URL(webOrigin).protocol !== 'https:' || new URL(webOrigin).origin !== webOrigin)
  )
    throw new Error('WEB_ORIGIN must be the exact HTTPS service origin in production');
  if (
    production &&
    process.env.S3_ENDPOINT &&
    new URL(process.env.S3_ENDPOINT).protocol !== 'https:'
  )
    throw new Error('S3_ENDPOINT must use HTTPS in production');
  const dataDir = resolve(
    process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/demo-reel' : 'output'),
  );
  if (!production || !process.env.VERCEL) mkdirSync(dataDir, { recursive: true });
  const keyPath = resolve(dataDir, 'encryption.key');
  if (!production && !process.env.ENCRYPTION_KEY && !existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  const key = process.env.ENCRYPTION_KEY || readFileSync(keyPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as hex');
  return {
    production,
    dataDir,
    key,
    databaseUrl: process.env.DATABASE_URL || 'postgres://demo@127.0.0.1:5448/demo_reel',
    demoOrigin: new URL(process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:4001').origin,
    webOrigin,
    apiPort: Number(process.env.API_PORT ?? 4000),
    demoPort: Number(process.env.DEMO_PORT ?? 4001),
    host: process.env.HOST ?? '127.0.0.1',
    quota: positive('DAILY_QUOTA', 3),
    planQuota: positive('DAILY_PLAN_QUOTA', 10),
    globalQuota: positive('GLOBAL_DAILY_JOBS', 50),
    // Planning is mostly waiting on the provider, so several fit side by side. Recording holds a
    // Chromium capturing 720p and an x264 encode, and the scene schedule is wall-clock, so a host
    // that cannot render in real time does not just go slower — it records the wrong thing. One
    // lane is what a Raspberry Pi has; raise it with the box, not with optimism.
    planConcurrency: positive('PLAN_CONCURRENCY', 2),
    recordConcurrency: positive('RECORD_CONCURRENCY', 1),
    workerLeaseMs: milliseconds('WORKER_LEASE_MS', 90000),
    pocMode,
    openaiKey: process.env.OPENAI_API_KEY || '',
    plannerModel: process.env.OPENAI_PLANNER_MODEL || 'gpt-5-mini',
    ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.OPENAI_TTS_VOICE || 'coral',
    s3: {
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || 'auto',
      bucket: process.env.S3_BUCKET || '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
  };
}
function positive(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error(`Invalid ${name}`);
  return value;
}
function milliseconds(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 30000 || value > 600000)
    throw new Error(`Invalid ${name}`);
  return value;
}
