import { config } from '../../api/src/config.ts';
import { Database } from '../../api/src/db.ts';
import { createDemoApp } from './app.ts';
const cfg = config(),
  db = new Database(cfg.databaseUrl);
await db.init();
const app = await createDemoApp(db, cfg);
await app.listen({ port: cfg.demoPort, host: cfg.host });
console.log(`Demo workspace: http://${cfg.host}:${cfg.demoPort}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
