import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
export const DEMO_CREDENTIALS={username:'demo@demo-reel.test',password:'demo-reel-poc'};
export async function resetDemo(db:Database) {
  await db.tx(async c=>{
    await c.query('DELETE FROM dr_demo_tasks');
    await c.query(`INSERT INTO dr_demo_tasks(id,title,description,done) VALUES
      ('seed-task','포트폴리오 소개 작성','프로젝트의 문제와 해결 과정을 짧고 명확하게 정리합니다.',false),
      ('seed-review','사용자 흐름 점검','로그인부터 결과 확인까지 자연스럽게 이어지는지 확인합니다.',false),
      ('seed-done','프로젝트 환경 준비','팀의 개발 환경과 공통 작업 기준을 준비했습니다.',true)`);
  });
}
export async function createDemoApp(db:Database,cfg:Config) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS dr_demo_tasks(id text PRIMARY KEY,title text UNIQUE NOT NULL,description text NOT NULL,done boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now())`);
  if(!(await db.pool.query('SELECT 1 FROM dr_demo_tasks LIMIT 1')).rowCount)await resetDemo(db);
  const app=Fastify({logger:false});
  await app.register(cookie,{secret:createHash('sha256').update(`${cfg.key}:demo`).digest('hex')});
  app.addHook('onRequest',async(req,reply)=>{
    if(!req.url.startsWith('/demo-api/')||req.url==='/demo-api/login')return;
    const token=req.cookies.demo_session?req.unsignCookie(req.cookies.demo_session):null;
    if(!token?.valid||!token.value||Number(token.value.split(':')[1])<Date.now())return reply.code(401).send({message:'로그인이 필요합니다.'});
  });
  app.post('/demo-api/login',async(req,reply)=>{
    const b=z.object({username:z.string(),password:z.string()}).safeParse(req.body);
    if(!b.success||b.data.username!==DEMO_CREDENTIALS.username||b.data.password!==DEMO_CREDENTIALS.password)return reply.code(401).send({message:'테스트 계정 정보를 확인해 주세요.'});
    reply.setCookie('demo_session',`demo:${Date.now()+3600000}`,{signed:true,httpOnly:true,sameSite:'strict',path:'/',maxAge:3600});return {name:'김데모'};
  });
  app.get('/demo-api/me',async()=>({name:'김데모',workspace:'포트폴리오 프로젝트'}));
  app.get('/demo-api/tasks',async()=>({tasks:(await db.pool.query('SELECT * FROM dr_demo_tasks ORDER BY created_at,id')).rows}));
  app.post('/demo-api/tasks',async(req,reply)=>{
    const b=z.object({title:z.string().min(1).max(100),description:z.string().max(1000)}).safeParse(req.body);
    if(!b.success)return reply.code(400).send({message:'업무 제목을 입력해 주세요.'});
    const id=randomUUID();
    try{await db.pool.query('INSERT INTO dr_demo_tasks(id,title,description) VALUES($1,$2,$3)',[id,b.data.title,b.data.description]);}
    catch(e:any){if(e.code==='23505')return reply.code(409).send({message:'같은 제목의 업무가 이미 있습니다. 중복 생성하지 않았습니다.'});throw e;}
    return reply.code(201).send({id,...b.data,done:false});
  });
  app.post('/demo-api/tasks/:id/complete',async(req,reply)=>{
    const r=await db.pool.query('UPDATE dr_demo_tasks SET done=true WHERE id=$1 RETURNING *',[(req.params as any).id]);
    if(!r.rowCount)return reply.code(404).send({message:'업무를 찾을 수 없습니다.'});return r.rows[0];
  });
  app.post('/__test/reset',async(req,reply)=>{
    if(!cfg.pocMode||req.headers['x-demo-fixture']!=='reset-v1')return reply.code(403).send();
    await resetDemo(db);return {reset:true};
  });
  app.get('/health',async()=>({status:'ok'}));
  app.get('/app.js',async(_req,reply)=>reply.type('application/javascript').send(await readFile(fileURLToPath(new URL('../public/app.js',import.meta.url)),'utf8')));
  app.get('/style.css',async(_req,reply)=>reply.type('text/css').send(await readFile(fileURLToPath(new URL('../public/style.css',import.meta.url)),'utf8')));
  for(const path of ['/','/login','/dashboard','/tasks','/tasks/new','/tasks/:id','/completed'])app.get(path,async(_req,reply)=>reply.type('text/html').send(await readFile(fileURLToPath(new URL('../public/index.html',import.meta.url)),'utf8')));
  return app;
}
