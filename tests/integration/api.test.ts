import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, createQueue } from '../../apps/api/src/db.ts';
import { config } from '../../apps/api/src/config.ts';
import { createApp, effectsHash } from '../../apps/api/src/app.ts';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
import { createDemoApp, resetDemo, DEMO_CREDENTIALS } from '../../apps/demo/src/app.ts';
import type { InternalJob, Project } from '../../apps/api/src/models.ts';
import type { Plan, ValidationReport } from '../../packages/contracts/src/index.ts';
const cfg=config();const db=new Database(cfg.databaseUrl);let queue:Awaited<ReturnType<typeof createQueue>>,app:Awaited<ReturnType<typeof createApp>>,demo:Awaited<ReturnType<typeof createDemoApp>>;
const owners:string[]=[];const json=(res:any)=>JSON.parse(res.body);
const headers=(cookie='')=>({'x-demo-reel':'1',cookie,'idempotency-key':randomUUID()});
beforeAll(async()=>{await db.init();queue=await createQueue(cfg.databaseUrl);app=await createApp(db,queue,cfg);demo=await createDemoApp(db,cfg);await resetDemo(db);});
afterAll(async()=>{
  for(const o of owners){const jobs=await db.list<InternalJob>('job',o);for(const j of jobs)if(j.queueId)await queue.deleteJob('demo-reel',j.queueId);
    await db.pool.query('DELETE FROM dr_records WHERE owner=$1',[o]);await db.pool.query('DELETE FROM dr_usage WHERE owner=$1',[o]);await db.pool.query('DELETE FROM dr_idempotency WHERE owner=$1',[o]);}
  await demo.close();await app.close();await queue.stop();await db.close();
});
async function project(){const r=await app.inject({method:'POST',url:'/api/v1/projects',headers:headers(),payload:{targetUrl:cfg.demoOrigin,intent:'업무 추가와 완료'}});expect(r.statusCode).toBe(201);
  const cookie=r.cookies.find(c=>c.name==='dr_session')!;const value=`dr_session=${cookie.value}`,p=json(r);const stored=await db.get<Project>('project',p.projectId);owners.push(stored!.owner);return{...p,cookie:value,owner:stored!.owner};}
async function seed(){
  const p=await project(),auth=await app.inject({method:'POST',url:`/api/v1/projects/${p.projectId}/auth`,headers:headers(p.cookie),payload:{mode:'form',...DEMO_CREDENTIALS}});
  const authRef=json(auth).authRef,plan=samplePlan(cfg.demoOrigin,p.projectId,`plan_${randomUUID()}`,authRef);
  await db.put('plan',plan.planId,p.owner,{owner:p.owner,projectId:p.projectId,planId:plan.planId,revision:1,state:'ready_for_review'},p.projectId);
  await db.put('plan_version',`${plan.planId}_1`,p.owner,plan,p.projectId);
  const report:ValidationReport={reportId:`report_${randomUUID()}`,planId:plan.planId,revision:1,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),issues:[],targets:plan.locators.map(l=>({locatorId:l.id,status:'verified',count:1,evidenceId:l.evidenceId}))};
  await db.put('validation',report.reportId,p.owner,report,p.projectId);
  const approval=await app.inject({method:'POST',url:`/api/v1/plans/${plan.planId}/approvals`,headers:headers(p.cookie),payload:{revision:1,reportId:report.reportId,acceptedEffectsHash:effectsHash(plan)}});expect(approval.statusCode).toBe(201);
  return{...p,plan,report,authRef,approval:json(approval)};
}
it('requires CSRF custom header and rejects cross-site origins',async()=>{
  const a=await app.inject({method:'POST',url:'/api/v1/projects',payload:{targetUrl:cfg.demoOrigin,intent:'x'}});expect(a.statusCode).toBe(403);
  const b=await app.inject({method:'POST',url:'/api/v1/projects',headers:{...headers(),origin:'https://other.example'},payload:{targetUrl:cfg.demoOrigin,intent:'x'}});expect(b.statusCode).toBe(403);
});
it('returns a client error for malformed JSON without leaking request content',async()=>{
  const r=await app.inject({method:'POST',url:'/api/v1/projects',headers:{...headers(),'content-type':'application/json'},payload:'{"password":"do-not-echo"'});
  expect(r.statusCode).toBe(400);expect(r.body).not.toContain('do-not-echo');
});
it('blocks unconfigured network destinations before creating a project',async()=>{const r=await app.inject({method:'POST',url:'/api/v1/projects',headers:headers(),payload:{targetUrl:'http://169.254.169.254/latest/meta-data',intent:'x'}});expect(r.statusCode).toBe(400);expect(json(r).error.code).toBe('URL_BLOCKED');});
it('stores encrypted authentication and reuses the opaque handle after disposal',async()=>{
  const p=await project(),url=`/api/v1/projects/${p.projectId}/auth`,payload={mode:'form',...DEMO_CREDENTIALS};
  const first=await app.inject({method:'POST',url,headers:headers(p.cookie),payload});expect(first.body).not.toContain(DEMO_CREDENTIALS.password);
  const ref=json(first).authRef,stored=await db.get<any>('auth',ref,p.owner);expect(JSON.stringify(stored)).not.toContain(DEMO_CREDENTIALS.password);
  expect((await app.inject({method:'DELETE',url:`${url}/${ref}`,headers:headers(p.cookie)})).statusCode).toBe(204);
  expect(await db.get('auth',ref,p.owner)).toBeNull();
  const next=await app.inject({method:'POST',url,headers:headers(p.cookie),payload});expect(json(next).authRef).toBe(ref);
});
it('prevents another owner reading a plan or authentication handle',async()=>{
  const a=await seed(),b=await project();expect((await app.inject({url:`/api/v1/plans/${a.plan.planId}`,headers:headers(b.cookie)})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:`/api/v1/projects/${b.projectId}/plans`,headers:headers(b.cookie),payload:{authRef:a.authRef}})).statusCode).toBe(404);
});
it('persists versions and rejects a stale edit without changing the prior version',async()=>{
  const s=await seed(),next:Plan=structuredClone(s.plan);next.title='수정된 제목';
  const r=await app.inject({method:'PUT',url:`/api/v1/plans/${s.plan.planId}`,headers:headers(s.cookie),payload:{expectedRevision:1,plan:next}});expect(r.statusCode).toBe(200);expect(json(r).plan.revision).toBe(2);
  const stale=await app.inject({method:'PUT',url:`/api/v1/plans/${s.plan.planId}`,headers:headers(s.cookie),payload:{expectedRevision:1,plan:next}});expect(stale.statusCode).toBe(409);
  expect((await db.get<Plan>('plan_version',`${s.plan.planId}_1`,s.owner))!.title).toBe(s.plan.title);
});
it('blocks approval with an expired or blocked validation result',async()=>{
  const s=await seed();s.report.expiresAt=new Date(Date.now()-1000).toISOString();await db.put('validation',s.report.reportId,s.owner,s.report,s.projectId);
  const payload={revision:1,reportId:s.report.reportId,acceptedEffectsHash:effectsHash(s.plan)};
  const expired=await app.inject({method:'POST',url:`/api/v1/plans/${s.plan.planId}/approvals`,headers:headers(s.cookie),payload});expect(json(expired).error.code).toBe('VALIDATION_EXPIRED');
  s.report.expiresAt=new Date(Date.now()+600000).toISOString();s.report.targets[0].status='blocked';await db.put('validation',s.report.reportId,s.owner,s.report,s.projectId);
  expect((await app.inject({method:'POST',url:`/api/v1/plans/${s.plan.planId}/approvals`,headers:headers(s.cookie),payload})).statusCode).toBe(400);
});
it('does not enqueue unapproved work',async()=>{const s=await seed();const r=await app.inject({method:'POST',url:'/api/v1/jobs',headers:headers(s.cookie),payload:{planId:s.plan.planId,revision:1,approvalId:'missing'}});expect(r.statusCode).toBe(404);expect(await db.list('job',s.owner)).toHaveLength(0);});
it('atomically deduplicates concurrent job requests and reserves usage once',async()=>{
  const s=await seed(),h=headers(s.cookie),payload={planId:s.plan.planId,revision:1,approvalId:s.approval.approvalId};
  const rs=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:'/api/v1/jobs',headers:h,payload})));
  expect(rs.map(r=>r.statusCode)).toEqual([202,202]);expect(json(rs[0]).jobId).toBe(json(rs[1]).jobId);
  const rows=await db.list<InternalJob>('job',s.owner);expect(rows).toHaveLength(1);expect(rows[0].queueId).toBeTruthy();
  expect((await queue.getJobById('demo-reel',rows[0].queueId!))?.data).toMatchObject({id:rows[0].snapshot.jobId});
  expect((await db.pool.query('SELECT count FROM dr_usage WHERE owner=$1',[s.owner])).rows[0].count).toBe(1);
  const conflict=await app.inject({method:'POST',url:'/api/v1/jobs',headers:h,payload:{...payload,revision:2}});expect(conflict.statusCode).toBe(409);
});
it('pins a queued run to the approved revision and supports conditional polling',async()=>{
  const s=await seed(),j=await app.inject({method:'POST',url:'/api/v1/jobs',headers:headers(s.cookie),payload:{planId:s.plan.planId,revision:1,approvalId:s.approval.approvalId}});const jobId=json(j).jobId;
  const next=structuredClone(s.plan);next.title='다음 버전';await app.inject({method:'PUT',url:`/api/v1/plans/${s.plan.planId}`,headers:headers(s.cookie),payload:{expectedRevision:1,plan:next}});
  const r=await app.inject({url:`/api/v1/jobs/${jobId}`,headers:headers(s.cookie)});expect(json(r).revision).toBe(1);
  expect((await app.inject({url:`/api/v1/jobs/${jobId}`,headers:{...headers(s.cookie),'if-none-match':String(r.headers.etag)}})).statusCode).toBe(304);
});
it('cancels queued work idempotently and returns its unused reservation',async()=>{
  const s=await seed(),r=await app.inject({method:'POST',url:'/api/v1/jobs',headers:headers(s.cookie),payload:{planId:s.plan.planId,revision:1,approvalId:s.approval.approvalId}});
  for(let i=0;i<2;i++){const cancel=await app.inject({method:'POST',url:`/api/v1/jobs/${json(r).jobId}/cancel`,headers:headers(s.cookie),payload:{}});expect(json(cancel).status).toBe('cancelled');}
  expect((await db.pool.query('SELECT count FROM dr_usage WHERE owner=$1',[s.owner])).rows[0].count).toBe(0);
});
it('enforces the daily quota before queue insertion',async()=>{
  const s=await seed();await db.pool.query('INSERT INTO dr_usage(owner,count) VALUES($1,$2)',[s.owner,cfg.quota]);
  const r=await app.inject({method:'POST',url:'/api/v1/jobs',headers:headers(s.cookie),payload:{planId:s.plan.planId,revision:1,approvalId:s.approval.approvalId}});expect(r.statusCode).toBe(429);expect(await db.list('job',s.owner)).toHaveLength(0);
});
it('protects the demo app, creates real DB data, prevents duplicate creation, and completes a task',async()=>{
  expect((await demo.inject({url:'/demo-api/tasks'})).statusCode).toBe(401);
  expect((await demo.inject({method:'POST',url:'/demo-api/login',payload:{...DEMO_CREDENTIALS,password:'wrong'}})).statusCode).toBe(401);
  const login=await demo.inject({method:'POST',url:'/demo-api/login',payload:DEMO_CREDENTIALS}),c=login.cookies[0],cookie=`${c.name}=${c.value}`;
  const payload={title:'integration '+randomUUID(),description:'실제 DB 변경 검증'};
  const created=await demo.inject({method:'POST',url:'/demo-api/tasks',headers:{cookie},payload});expect(created.statusCode).toBe(201);
  expect((await demo.inject({method:'POST',url:'/demo-api/tasks',headers:{cookie},payload})).statusCode).toBe(409);
  const done=await demo.inject({method:'POST',url:`/demo-api/tasks/${json(created).id}/complete`,headers:{cookie},payload:{}});expect(json(done).done).toBe(true);
  expect((await db.pool.query('SELECT count(*)::int AS count FROM dr_demo_tasks WHERE title=$1',[payload.title])).rows[0].count).toBe(1);
});
