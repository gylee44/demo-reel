import type { Browser, Page, BrowserContextOptions } from 'playwright';
import type { Database } from '../../api/src/db.ts';
import type { Config } from '../../api/src/config.ts';
import type { AuthRecord } from '../../api/src/models.ts';
import type { Plan } from '../../../packages/contracts/src/index.ts';
import { AuthInputSchema, type LoginProfile } from '../../../packages/contracts/src/connection.ts';
import { AppError, decrypt } from '../../api/src/security.ts';
import { newContext } from './browser.ts';
import { authenticatePoc } from './poc-auth.ts';
export function loginLocator(page: Page, target: LoginProfile['username']) {
  if (target.strategy === 'label') return page.getByLabel(target.value, { exact: true });
  if (target.strategy === 'testId') return page.getByTestId(target.value);
  if (target.strategy === 'role')
    return page.getByRole(target.role!, { name: target.value, exact: true });
  return page.locator(target.value);
}
export async function authenticate(
  browser: Browser,
  db: Database,
  cfg: Config,
  plan: Pick<Plan, 'target' | 'auth'>,
  owner: string,
): Promise<BrowserContextOptions['storageState']> {
  if (plan.auth.mode === 'none') return undefined;
  if (cfg.pocMode) return authenticatePoc(browser, db, cfg, plan as Plan, owner);
  const auth = await db.get<AuthRecord>('auth', plan.auth.authRef!, owner);
  if (!auth || Date.parse(auth.expiresAt) <= Date.now())
    throw new AppError('AUTH_EXPIRED', '테스트 계정 또는 세션을 다시 입력해 주세요.');
  const secret = AuthInputSchema.parse(decrypt(auth.ciphertext, cfg.key));
  const within = (url: string) => {
    if (!plan.target.allowedOrigins.includes(new URL(url).origin))
      throw new AppError(
        'AUTH_UNSUPPORTED',
        '로그인 주소와 확인 주소는 승인한 앱 범위 안이어야 합니다.',
      );
    return url;
  };
  if (secret.mode === 'storage_state') {
    for (const cookie of secret.storageState.cookies) {
      const domain = cookie.domain.replace(/^\./, '');
      if (!plan.target.allowedOrigins.some((origin) => new URL(origin).hostname === domain))
        throw new AppError('AUTH_UNSUPPORTED', '세션에 다른 사이트의 쿠키가 있습니다.');
    }
    for (const item of secret.storageState.origins) within(item.origin);
  }
  const context = await newContext(
    browser,
    plan,
    secret.mode === 'storage_state' ? secret.storageState : undefined,
  );
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    if (secret.mode === 'form') {
      if (!secret.profile)
        throw new AppError(
          'AUTH_PROFILE_REQUIRED',
          '로그인 화면과 입력 대상, 성공 조건을 지정해 주세요.',
        );
      const p = secret.profile;
      await page.goto(within(p.loginUrl), { waitUntil: 'domcontentloaded', timeout: 20000 });
      for (const field of [p.username, p.password, p.submit])
        if ((await loginLocator(page, field).count()) !== 1)
          throw new AppError('TARGET_AMBIGUOUS', '로그인 입력 대상을 하나로 특정해 주세요.');
      await loginLocator(page, p.username).fill(secret.username);
      await loginLocator(page, p.password).fill(secret.password);
      await loginLocator(page, p.submit).click();
      await page.waitForURL((url) => url.href === within(p.successUrl), { timeout: 15000 });
      await loginLocator(page, p.successTarget).waitFor({ state: 'visible' });
    } else {
      if (!secret.verifyUrl || !secret.successTarget)
        throw new AppError(
          'AUTH_PROFILE_REQUIRED',
          '세션 확인 주소와 로그인 성공 대상을 지정해 주세요.',
        );
      await page.goto(within(secret.verifyUrl), { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (page.url() !== secret.verifyUrl)
        throw new AppError('AUTH_FAILED', '세션 확인 화면에 접근하지 못했습니다.');
      await loginLocator(page, secret.successTarget).waitFor({ state: 'visible' });
    }
    return await context.storageState();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      'AUTH_FAILED',
      '로그인한 화면에 접근하지 못했습니다. 계정·입력 대상·성공 조건을 확인해 주세요.',
    );
  } finally {
    await context.close();
  }
}
