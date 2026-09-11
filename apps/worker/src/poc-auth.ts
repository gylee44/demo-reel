import type { Browser, BrowserContextOptions } from 'playwright';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import type { Plan } from '../../../packages/contracts/src/index.ts';
import type { AuthRecord } from '../../api/src/models.ts';
import { AppError, decrypt } from '../../api/src/security.ts';
import { newContext } from './browser.ts';
export async function authenticatePoc(
  browser: Browser,
  db: Database,
  cfg: Config,
  plan: Plan,
  owner: string,
): Promise<BrowserContextOptions['storageState']> {
  if (plan.auth.mode === 'none') return undefined;
  const auth = await db.get<AuthRecord>('auth', plan.auth.authRef!, owner);
  if (!auth || Date.parse(auth.expiresAt) <= Date.now())
    throw new AppError('AUTH_EXPIRED', '테스트 계정 또는 세션을 다시 입력해 주세요.');
  const secret = decrypt<any>(auth.ciphertext, cfg.key);
  let state: BrowserContextOptions['storageState'];
  if (secret.mode === 'storage_state') {
    const host = new URL(cfg.demoOrigin).hostname;
    if (
      secret.storageState.cookies.some(
        (c: any) => typeof c.domain !== 'string' || c.domain.replace(/^\./, '') !== host,
      ) ||
      secret.storageState.origins.some((o: any) => o.origin !== cfg.demoOrigin || o.indexedDB)
    )
      throw new AppError('AUTH_UNSUPPORTED', '이 PoC에서 지원하지 않는 세션 형식입니다.');
    state = secret.storageState;
  }
  const context = await newContext(browser, plan, state);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    if (secret.mode === 'form') {
      await page.goto(`${cfg.demoOrigin}/login`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('이메일', { exact: true }).fill(secret.username);
      await page.getByLabel('비밀번호', { exact: true }).fill(secret.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      await page.waitForURL(`${cfg.demoOrigin}/dashboard`, { timeout: 7000 });
    } else await page.goto(`${cfg.demoOrigin}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: '프로젝트 현황', exact: true })
      .waitFor({ state: 'visible', timeout: 7000 });
    return await context.storageState();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      'AUTH_FAILED',
      '로그인한 화면에 접근하지 못했습니다. 테스트 계정을 확인해 주세요.',
    );
  } finally {
    await context.close();
  }
}
