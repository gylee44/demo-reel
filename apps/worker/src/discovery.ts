import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContextOptions } from 'playwright';
import type { Plan } from '../../../packages/contracts/src/index.ts';
import { newContext } from './browser.ts';
export type Observation = {
  id: string;
  url: string;
  title: string;
  locators: Plan['locators'];
  summary: string;
};
export async function discover(
  browser: Browser,
  target: Plan['target'],
  state: BrowserContextOptions['storageState'],
  urls: string[],
): Promise<Observation[]> {
  const context = await newContext(browser, { target }, state);
  const result: Observation[] = [];
  const queue = [...new Set([target.baseUrl, ...urls])].slice(0, 6);
  // The model has to copy these ids into the plan by hand, and it drops characters out of a UUID:
  // a run failed on "Unknown locator: loc_d9b2f8da-c6d0-4c90-b0e-534dd4b5530c", a segment short.
  // They only have to be unique within the plan, so keep them short enough to reproduce exactly.
  let locatorCount = 0;
  const nextLocatorId = () => `loc_${++locatorCount}`;
  try {
    for (const url of queue) {
      if (!target.allowedOrigins.includes(new URL(url).origin)) continue;
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.locator('body').waitFor({ state: 'visible' });
        const raw = await page.evaluate(() => {
          const elements = [
            ...document.querySelectorAll(
              'h1,h2,h3,button,a,input,textarea,select,[role],[data-testid]',
            ),
          ]
            .filter(
              (e) => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0,
            )
            .slice(0, 100);
          return elements.map((e) => ({
            tag: e.tagName.toLowerCase(),
            id: e.id,
            testId: e.getAttribute('data-testid'),
            role: e.getAttribute('role'),
            type: e.getAttribute('type'),
            label:
              e.getAttribute('aria-label') ||
              ('labels' in e
                ? [...((e as HTMLInputElement).labels ?? [])]
                    .map((l) => (l as HTMLElement).innerText ?? l.textContent)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                : ''),
            // The plan looks these up by accessible name, which treats a line break as a space.
            // textContent joins the two halves of a wrapped heading with nothing, producing a
            // string that can never match the element it came from, so read the rendered text.
            text: ((e as HTMLElement).innerText ?? e.textContent ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 150),
          }));
        });
        const evidenceId = `evidence_${randomUUID()}`;
        const locators: Plan['locators'] = [];
        for (const e of raw) {
          if (e.type === 'password' || e.type === 'hidden') continue;
          const base = { id: nextLocatorId(), exact: true, scopeLocatorId: null, evidenceId };
          if (e.testId) locators.push({ ...base, strategy: 'testId', value: e.testId, role: null });
          else if (e.label)
            locators.push({ ...base, strategy: 'label', value: e.label, role: null });
          else if (e.id && /^[a-zA-Z][\w-]*$/.test(e.id))
            locators.push({ ...base, strategy: 'css', value: `#${e.id}`, role: null });
          else {
            const role =
              e.role ||
              (
                {
                  h1: 'heading',
                  h2: 'heading',
                  h3: 'heading',
                  button: 'button',
                  a: 'link',
                } as Record<string, string>
              )[e.tag];
            if (role && e.text) locators.push({ ...base, strategy: 'role', role, value: e.text });
          }
        }
        for (const selector of ['h1', 'main', 'form'])
          if ((await page.locator(selector).count()) === 1)
            locators.push({
              id: nextLocatorId(),
              strategy: 'css',
              value: selector,
              role: null,
              exact: true,
              scopeLocatorId: null,
              evidenceId,
            });
        result.push({
          id: evidenceId,
          url: page.url(),
          title: (await page.title()).slice(0, 200),
          locators: locators.slice(0, 40),
          summary: raw
            .filter((e) => /^h[123]$/.test(e.tag))
            .map((e) => e.text)
            .join('\n')
            .slice(0, 1500),
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
  return result;
}
