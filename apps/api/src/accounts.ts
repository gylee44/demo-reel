import {
  randomBytes,
  randomUUID,
  scrypt as derive,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Database, Queryable } from './db.ts';
import { AppError, hash } from './security.ts';
const credentials = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(12).max(128),
});
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
async function deriveKey(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) =>
    derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await deriveKey(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, hex] = stored.split(':');
  if (!/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '')) return false;
  return timingSafeEqual(await deriveKey(password, salt), Buffer.from(hex, 'hex'));
}
export async function consumeLimit(
  db: Database,
  key: string,
  limit: number,
  windowSeconds = 86400,
  c: Queryable = db.pool,
) {
  const r = await c.query(
    `INSERT INTO dr_limits(key,window_id,count,expires_at) VALUES($1,floor(extract(epoch from now())/$3)::bigint,1,now()+($3::text || ' seconds')::interval)
    ON CONFLICT(key,window_id) DO UPDATE SET count=dr_limits.count+1 WHERE dr_limits.count<$2 RETURNING count`,
    [key, limit, windowSeconds],
  );
  if (!r.rowCount)
    throw new AppError(
      'RATE_LIMITED',
      '요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
      429,
    );
}
export async function registerAccounts(app: FastifyInstance, db: Database, cfg: Config) {
  async function session(req: FastifyRequest) {
    const token = req.cookies.dr_account;
    if (!token) return null;
    const r = await db.pool.query(
      'SELECT u.id,u.email FROM dr_sessions s JOIN dr_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [digest(token)],
    );
    return r.rows[0] ?? null;
  }
  app.addHook('preHandler', async (req) => {
    if (
      cfg.pocMode ||
      !req.url.startsWith('/api/v1/') ||
      req.url.startsWith('/api/v1/account/') ||
      req.url === '/api/v1/capabilities'
    )
      return;
    const user = await session(req);
    if (!user) throw new AppError('UNAUTHORIZED', '로그인 후 계속해 주세요.', 401);
    (req as any).accountOwner = user.id;
  });
  async function issue(
    req: FastifyRequest,
    reply: FastifyReply,
    user: { id: string; email: string },
  ) {
    if (req.cookies.dr_account)
      await db.pool.query('DELETE FROM dr_sessions WHERE token_hash=$1', [
        digest(req.cookies.dr_account),
      ]);
    const token = randomBytes(32).toString('base64url');
    await db.pool.query(
      "INSERT INTO dr_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [digest(token), user.id],
    );
    reply.setCookie('dr_account', token, {
      httpOnly: true,
      secure: cfg.webOrigin.startsWith('https:'),
      sameSite: 'strict',
      path: '/',
      maxAge: 604800,
    });
    return { user: { id: user.id, email: user.email } };
  }
  async function limit(req: FastifyRequest, email: string) {
    // Vercel sets x-vercel-forwarded-for; self-hosting uses the socket address, never arbitrary X-Forwarded-For.
    const ip = process.env.VERCEL
      ? String(req.headers['x-vercel-forwarded-for'] ?? req.ip)
          .split(',')[0]
          .trim()
      : req.ip;
    await consumeLimit(db, `auth-ip:${hash(ip)}`, 30, 900);
    await consumeLimit(db, `auth-email:${hash(email)}`, 10, 900);
  }
  app.get('/api/v1/account/me', async (req) => ({ user: await session(req) }));
  app.post('/api/v1/account/register', async (req, reply) => {
    const b = credentials.parse(req.body);
    await limit(req, b.email);
    const id = `user_${randomUUID()}`;
    const r = await db.pool.query(
      'INSERT INTO dr_users(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id,email',
      [id, b.email, await passwordHash(b.password)],
    );
    if (!r.rowCount)
      throw new AppError('ACCOUNT_EXISTS', '이 이메일로 가입할 수 없습니다. 로그인해 주세요.', 409);
    reply.code(201);
    return issue(req, reply, r.rows[0]);
  });
  app.post('/api/v1/account/login', async (req, reply) => {
    const b = credentials.parse(req.body);
    await limit(req, b.email);
    const r = await db.pool.query('SELECT id,email,password_hash FROM dr_users WHERE email=$1', [
      b.email,
    ]);
    const user = r.rows[0];
    const stored = user?.password_hash ?? `${'00'.repeat(16)}:${'00'.repeat(64)}`;
    if (!(await passwordMatches(b.password, stored)) || !user)
      throw new AppError('LOGIN_FAILED', '이메일 또는 비밀번호를 확인해 주세요.', 401);
    return issue(req, reply, user);
  });
  app.post('/api/v1/account/logout', async (req, reply) => {
    if (req.cookies.dr_account)
      await db.pool.query('DELETE FROM dr_sessions WHERE token_hash=$1', [
        digest(req.cookies.dr_account),
      ]);
    reply.clearCookie('dr_account', { path: '/' });
    return reply.code(204).send();
  });
  app.post('/api/v1/account/password', async (req, reply) => {
    const user = await session(req);
    if (!user) throw new AppError('UNAUTHORIZED', '로그인해 주세요.', 401);
    const b = z
      .strictObject({
        currentPassword: z.string().max(128),
        newPassword: z.string().min(12).max(128),
      })
      .parse(req.body);
    await limit(req, user.email);
    const row = await db.pool.query('SELECT password_hash FROM dr_users WHERE id=$1', [user.id]);
    if (!(await passwordMatches(b.currentPassword, row.rows[0].password_hash)))
      throw new AppError('LOGIN_FAILED', '현재 비밀번호를 확인해 주세요.', 401);
    await db.tx(async (c) => {
      await c.query('UPDATE dr_users SET password_hash=$1 WHERE id=$2', [
        await passwordHash(b.newPassword),
        user.id,
      ]);
      await c.query('DELETE FROM dr_sessions WHERE user_id=$1', [user.id]);
    });
    return issue(req, reply, user);
  });
}
