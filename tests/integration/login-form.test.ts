import { beforeAll, afterAll, it, expect } from 'vitest';
import { launchBrowser } from '../../apps/worker/src/browser.ts';
import { detectLoginForm } from '../../apps/worker/src/login-form.ts';
import type { Browser, Page } from 'playwright';
let browser: Browser, page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await (await browser.newContext()).newPage();
});
afterAll(async () => await browser?.close());
const read = async (html: string) => {
  await page.setContent(html);
  return detectLoginForm(page);
};
it('reads a form whose boxes are labelled', async () => {
  expect(
    await read(`<form>
      <label for="u">이메일</label><input id="u" type="email">
      <label for="p">비밀번호</label><input id="p" type="password">
      <button type="submit">로그인</button></form>`),
  ).toEqual({
    username: { strategy: 'label', value: '이메일' },
    password: { strategy: 'label', value: '비밀번호' },
    submit: { strategy: 'role', value: '로그인', role: 'button' },
  });
});
it('falls back to a placeholder when nothing else names the box', async () => {
  const found = await read(`<form>
      <input type="text" placeholder="아이디">
      <input type="password" placeholder="비밀번호">
      <button>들어가기</button></form>`);
  expect(found?.username).toEqual({ strategy: 'css', value: '[placeholder="아이디"]' });
  expect(found?.submit).toEqual({ strategy: 'role', value: '들어가기', role: 'button' });
});
it('prefers a test id over anything the page renders', async () => {
  const found = await read(`<form>
      <input data-testid="login-id" type="text" placeholder="아이디">
      <input data-testid="login-pw" type="password" placeholder="비밀번호">
      <button data-testid="login-go">로그인</button></form>`);
  expect(found?.username).toEqual({ strategy: 'testId', value: 'login-id' });
  expect(found?.submit).toEqual({ strategy: 'testId', value: 'login-go' });
});
it('works without a form element, and ignores boxes after the password', async () => {
  const found = await read(`<div>
      <input type="text" placeholder="아이디">
      <input type="password" placeholder="비밀번호">
      <input type="text" placeholder="검색">
      <button>로그인</button></div>`);
  expect(found?.username).toEqual({ strategy: 'css', value: '[placeholder="아이디"]' });
});
/** A login box next to a search box is the usual shape of a marketing page. */
it('stays inside the form the password box belongs to', async () => {
  const found = await read(`<div>
      <form><input type="search" placeholder="검색"><button>찾기</button></form>
      <form><input type="email" placeholder="이메일"><input type="password" placeholder="비밀번호">
        <button type="submit">로그인</button></form></div>`);
  expect(found?.username).toEqual({ strategy: 'css', value: '[placeholder="이메일"]' });
  expect(found?.submit).toEqual({ strategy: 'role', value: '로그인', role: 'button' });
});
it('gives nothing back when the page has no password box', async () => {
  expect(
    await read('<form><input type="text" placeholder="검색"><button>찾기</button></form>'),
  ).toBeNull();
});
it('refuses a name that would match two things at once', async () => {
  // Both buttons say 로그인; naming it that way would be ambiguous, so it has to find another way.
  const found = await read(`<form>
      <input id="uu" type="text" placeholder="아이디">
      <input id="pp" type="password" placeholder="비밀번호">
      <button id="go" type="submit">로그인</button></form>
      <button>로그인</button>`);
  expect(found?.submit).toEqual({ strategy: 'css', value: '#go' });
});
/**
 * Real apps often keep the form in a dialog rather than at an address — app.rallytrack.win serves
 * its landing page at /login and opens the form on a button. Asking for a URL that shows the form
 * would be asking for one the app does not have.
 */
it('presses the thing that says log in when no box is on the page yet', async () => {
  const found = await read(`<div>
      <button onclick="document.getElementById('m').hidden=false">로그인</button>
      <div id="m" hidden>
        <label for="e">이메일</label><input id="e" type="email">
        <label for="w">비밀번호</label><input id="w" type="password">
        <button type="submit">로그인하기</button>
      </div></div>`);
  expect(found).toEqual({
    username: { strategy: 'label', value: '이메일' },
    password: { strategy: 'label', value: '비밀번호' },
    submit: { strategy: 'role', value: '로그인하기', role: 'button' },
  });
});
it('presses nothing when a box is already there', async () => {
  const found = await read(`<div>
      <button onclick="document.body.innerHTML=''">로그인</button>
      <form><label for="a">아이디</label><input id="a" type="text">
        <label for="b">비밀번호</label><input id="b" type="password">
        <button type="submit">보내기</button></form></div>`);
  expect(found?.username).toEqual({ strategy: 'label', value: '아이디' });
});
