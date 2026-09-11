import { config } from '../apps/api/src/config.ts';
import { Database, createQueue } from '../apps/api/src/db.ts';
const cfg = config();
const db = new Database(cfg.databaseUrl);
try {
  await db.init();
  const queue = await createQueue(cfg.databaseUrl);
  await queue.stop();
  console.log('Database and queue schema ready.');
} finally {
  await db.close();
}
