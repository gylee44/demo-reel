import { config } from './config.ts';
import { Database, createQueue } from './db.ts';
import { createApp } from './app.ts';
const cfg=config();const db=new Database(cfg.databaseUrl);await db.init();const queue=await createQueue(cfg.databaseUrl);const app=await createApp(db,queue,cfg);
await app.listen({port:cfg.apiPort,host:cfg.host});console.log(`Demo Reel API: http://${cfg.host}:${cfg.apiPort}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await app.close();await queue.stop();await db.close();process.exit(0);});
