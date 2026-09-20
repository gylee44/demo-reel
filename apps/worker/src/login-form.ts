import type { Page } from 'playwright';
import type { LoginProfile } from '../../../packages/contracts/src/connection.ts';
import { loginLocator } from './authentication.ts';
type Target = LoginProfile['username'];
type Candidate = {
  testId: string | null;
  label: string;
  placeholder: string;
  role: string | null;
  text: string;
  id: string;
};
/**
 * What the connect screen asks for — which box is the id, which is the password, which button sends
 * them — is the one part of setting up a demo that the person cannot answer by looking at their own
 * app. They have to name it the way a selector does. The page already says all three, so read it.
 *
 * Only the login page is readable this way. Where logging in lands, and what proves it worked, are
 * about the app after the door opens, so those stay the person's to give.
 */
export async function detectLoginForm(
  page: Page,
  openFirst = true,
): Promise<Pick<LoginProfile, 'username' | 'password' | 'submit'> | null> {
  // Plenty of apps keep the form behind a button rather than at an address: app.rallytrack.win
  // serves its landing page at /login and opens the real form in a dialog. Asking the person for a
  // URL that shows the form would be asking for one their app does not have, so press the thing
  // that says "log in" once and look again. Bounded on purpose: only when there is no password box
  // to be found, only something that says so, and only one press.
  // `:visible` matters: a dialog that is already in the DOM but not on screen counts as present to
  // a plain selector, which would skip the press and then find nothing to read.
  if (openFirst && (await page.locator('input[type=password]:visible').count()) === 0) {
    const opener = page
      .getByRole('button', { name: /로그인|로그 ?인|sign ?in|log ?in/i })
      .or(page.getByRole('link', { name: /로그인|sign ?in|log ?in/i }))
      .first();
    if (await opener.count()) {
      await opener.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    return detectLoginForm(page, false);
  }
  // Everything here runs in the page, so it must not name a function: the worker is transpiled by
  // tsx, which wraps named functions in a `__name` helper that does not exist in the browser and
  // fails the whole evaluate. Inline callbacks only.
  const found = await page.evaluate(() => {
    const seen = [...document.querySelectorAll('input[type=password]')].filter(
      (e) => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0,
    ) as HTMLInputElement[];
    const password = seen[0];
    if (!password) return null;
    // A password box is only ever part of one form; without a <form> the whole page is the scope.
    const scope: ParentNode = password.closest('form') ?? document;
    const inputs = [...scope.querySelectorAll('input')].filter(
      (e) => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0,
    );
    // The id box is the text box in front of the password box; a form that puts it after would be
    // asking people to tab backwards, so position is a better signal here than any name guess.
    const username =
      inputs
        .slice(0, inputs.indexOf(password))
        .reverse()
        .find((i) => ['text', 'email', 'tel', ''].includes(i.type)) ??
      inputs.find((i) => i !== password && ['text', 'email'].includes(i.type));
    if (!username) return null;
    // Only buttons after the password box: a <button> defaults to type=submit, so without a <form>
    // to bound the search the button that opened the dialog looks exactly like the one that sends
    // it, and it comes first.
    const buttons = [...scope.querySelectorAll('button,input[type=submit]')].filter(
      (e) =>
        ((e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0) &&
        password.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const submit =
      buttons.find((b) => (b as HTMLButtonElement).type === 'submit') ?? buttons.at(-1);
    if (!submit) return null;
    const [u, p, s] = [username, password, submit].map((e) => ({
      testId: e.getAttribute('data-testid'),
      label:
        e.getAttribute('aria-label') ||
        ('labels' in e
          ? [...((e as HTMLInputElement).labels ?? [])]
              .map((l) => (l as HTMLElement).innerText ?? l.textContent ?? '')
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim()
          : ''),
      // Kept apart from the label because getByLabel does not see a placeholder; a box named only
      // by the text inside it has to be reached by selector instead.
      placeholder: (e as HTMLInputElement).placeholder || '',
      role: e.getAttribute('role'),
      text:
        ((e as HTMLElement).innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim() ||
        (e as HTMLInputElement).value ||
        '',
      id: e.id,
    }));
    return { username: u, password: p, submit: s };
  });
  if (!found) return null;
  const resolve = async (c: Candidate, role: string): Promise<Target | null> => {
    const tries: Target[] = [];
    if (c.testId) tries.push({ strategy: 'testId', value: c.testId });
    if (c.label) tries.push({ strategy: 'label', value: c.label });
    if (c.text) tries.push({ strategy: 'role', value: c.text, role: role as Target['role'] });
    if (/^[a-zA-Z][\w-]*$/.test(c.id)) tries.push({ strategy: 'css', value: `#${c.id}` });
    if (c.placeholder && !c.placeholder.includes('"'))
      tries.push({ strategy: 'css', value: `[placeholder="${c.placeholder}"]` });
    // A selector that matches two things would log in to neither, so keep the first that is alone
    // on the page rather than the first that merely exists.
    for (const t of tries) if ((await loginLocator(page, t).count()) === 1) return t;
    return null;
  };
  const username = await resolve(found.username, 'textbox'),
    password = await resolve(found.password, 'textbox'),
    submit = await resolve(found.submit, 'button');
  return username && password && submit ? { username, password, submit } : null;
}
