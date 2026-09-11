import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../apps/api/src/config.ts';
import { Database, createQueue } from '../apps/api/src/db.ts';
import { createApp } from '../apps/api/src/app.ts';
// A Vercel instance only accepts requests and enqueues work. No browser, timers, or migrations.
let instance: Promise<Awaited<ReturnType<typeof createApp>>> | undefined;
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  instance ??= (async () => {
    const cfg = config();
    const db = new Database(cfg.databaseUrl);
    const queue = await createQueue(cfg.databaseUrl, true);
    const app = await createApp(db, queue, cfg);
    await app.ready();
    return app;
  })().catch((error) => {
    instance = undefined;
    throw error;
  });
  try {
    const app = await instance;
    app.server.emit('request', req, res);
  } catch {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'SERVICE_NOT_READY', message: '서비스 연결 설정을 확인하고 있습니다.' },
      }),
    );
  }
}
