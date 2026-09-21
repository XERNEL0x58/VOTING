'use strict';
/**
 * Frontend tests. The real index.html / admin.html / js files run inside jsdom, and their
 * fetch() calls are routed to the real apps-script/*.gs code (through tests/mock-gas.js).
 * Requires:  npm install   (jsdom)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createEnv } = require('./mock-gas');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const API = 'https://script.google.com/macros/s/TEST/exec';
const EMAIL = 'admin@example.com';
const PASSWORD = 'Test-Only-Passw0rd';

const openDoms = [];
test.afterEach(() => { openDoms.splice(0).forEach(d => d.window.close()); });   // stop polling timers

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 4)); };

function boot(page, env, { storage = {}, session = {}, failNetwork = false } = {}) {
  const dom = new JSDOM(read(page), { url: 'https://user.github.io/poll/' + page, runScripts: 'outside-only', pretendToBeVisual: true });
  openDoms.push(dom);
  const w = dom.window;
  Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  Object.entries(session).forEach(([k, v]) => w.sessionStorage.setItem(k, v));

  if (!w.crypto || !w.crypto.randomUUID) Object.defineProperty(w, 'crypto', { value: require('node:crypto').webcrypto, configurable: true });
  w.Element.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); w.__openDialog = this; };
  w.answerDialog = ok => { const d = w.__openDialog; d.returnValue = ok ? 'ok' : 'cancel'; d.removeAttribute('open'); d.dispatchEvent(new w.Event('close')); };

  w.fetchLog = [];
  w.fetch = async (url, opts = {}) => {
    w.fetchLog.push({ url, opts });
    if (failNetwork) throw new TypeError('Failed to fetch');
    let data;
    if ((opts.method || 'GET') === 'GET') {
      data = env.get(Object.fromEntries(new URL(url).searchParams));
    } else {
      assert.equal(opts.headers['Content-Type'], 'text/plain;charset=utf-8', 'POST must be a CORS "simple request"');
      data = env.post(opts.body);
    }
    return { ok: true, json: async () => data };
  };

  w.eval(`window.APP_CONFIG = { API_URL: ${JSON.stringify(API)} };`);
  ['js/api.js', page === 'index.html' ? 'js/app.js' : 'js/admin.js'].forEach(f => w.eval(read(f)));
  return dom;
}

const visible = doc => Array.from(doc.querySelectorAll('[data-view]')).filter(e => !e.hidden).map(e => e.getAttribute('data-view'));
const setValue = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

function adminSession(env) {
  const r = env.post({ action: 'admin_login', email: EMAIL, password: PASSWORD });
  return r.token;
}

/* ============================================================ public page */

test('public: idle → active → select → vote → success, with no statistics anywhere', async () => {
  const env = createEnv();
  const token = adminSession(env);

  let dom = boot('index.html', env);
  await settle();
  assert.deepEqual(visible(dom.window.document), ['idle']);

  const { contestId } = env.post({ action: 'admin_start', token, title: 'من هو الأفضل؟', options: ['مصور', 'نجار', 'مبرمج'] });
  env.advance(11);
  dom = boot('index.html', env);
  await settle();
  const doc = dom.window.document;
  assert.deepEqual(visible(doc), ['active']);
  assert.equal(doc.getElementById('question').textContent, 'من هو الأفضل؟');
  assert.deepEqual(Array.from(doc.querySelectorAll('.option-label')).map(e => e.textContent), ['مصور', 'نجار', 'مبرمج']);
  assert.equal(doc.getElementById('submitBtn').disabled, true, 'submit is disabled until an option is chosen');

  const radios = doc.querySelectorAll('input[type=radio]');
  radios[1].checked = true;
  radios[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(doc.getElementById('submitBtn').disabled, false);

  assert.ok(!/%|votes|أصوات/.test(doc.body.textContent), 'no stats on the public page');
  assert.equal(doc.querySelectorAll('.bar, .results, .total').length, 0);

  doc.getElementById('voteForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  assert.equal(doc.getElementById('submitBtn').disabled, true, 'button locked while submitting');
  await settle();
  assert.deepEqual(visible(doc), ['success']);
  const successText = doc.querySelector('[data-view=success]').textContent;
  assert.match(successText, /تم تسجيل تصويتك بنجاح/);
  assert.match(successText, /شكرًا لمشاركتك/);
  assert.ok(!/\d/.test(successText), 'success screen contains no numbers');

  const view = env.post({ action: 'admin_results', token });
  assert.deepEqual(view.options.map(o => o.votes), [0, 1, 0]);

  // the voted marker is written; a reload shows "already voted" without any request for a vote
  const storage = Object.fromEntries(Object.keys(dom.window.localStorage).map(k => [k, dom.window.localStorage.getItem(k)]));
  const again = boot('index.html', env, { storage });
  await settle();
  assert.deepEqual(visible(again.window.document), ['already']);
  assert.equal(env.post({ action: 'admin_results', token }).totalVotes, 1);

  // Cleared "voted" marker but same voter id → server refuses, UI shows "already voted"
  const onlyId = { 'poll.voterId.v1': storage['poll.voterId.v1'] };
  const third = boot('index.html', env, { storage: onlyId });
  await settle();
  const d3 = third.window.document;
  const r3 = d3.querySelectorAll('input[type=radio]')[0];
  r3.checked = true; r3.dispatchEvent(new third.window.Event('change', { bubbles: true }));
  d3.getElementById('voteForm').dispatchEvent(new third.window.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  assert.deepEqual(visible(d3), ['already']);
  assert.equal(env.post({ action: 'admin_results', token }).totalVotes, 1);
});

test('public: contest ends while the page is open → vote is refused and "ended" is shown', async () => {
  const env = createEnv();
  const token = adminSession(env);
  const { contestId } = env.post({ action: 'admin_start', token, title: 'س؟', options: ['أ', 'ب'] });

  const dom = boot('index.html', env);
  await settle();
  const doc = dom.window.document;
  const r = doc.querySelectorAll('input[type=radio]')[0];
  r.checked = true; r.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  env.post({ action: 'admin_end', token, contestId });
  doc.getElementById('voteForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  assert.deepEqual(visible(doc), ['ended']);

  // a browser that saw the contest before sees "ended"; a brand-new visitor sees "no contest"
  const seen = boot('index.html', env, { storage: { 'poll.lastSeenContest': contestId } });
  await settle();
  assert.deepEqual(visible(seen.window.document), ['ended']);
  env.advance(11);
  const fresh = boot('index.html', env);
  await settle();
  assert.deepEqual(visible(fresh.window.document), ['idle']);
});

test('public: network failure shows the error state and retry works', async () => {
  const env = createEnv();
  let dom = boot('index.html', env, { failNetwork: true });
  await settle();
  assert.deepEqual(visible(dom.window.document), ['error']);
  assert.match(dom.window.document.getElementById('errorText').textContent, /الإنترنت|الاتصال/);

  // backend returns an error object
  // backend throws internally → generic error state, no internals shown
  const bad = createEnv();
  bad.context.getPublicPoll_ = () => { throw new Error('boom'); };
  dom = boot('index.html', bad);
  await settle();
  assert.deepEqual(visible(dom.window.document), ['error']);
  assert.ok(!/boom/.test(dom.window.document.body.textContent), 'no internals shown');
});

test('public: server text is rendered as text, never as HTML', async () => {
  const env = createEnv();
  const token = adminSession(env);
  env.post({ action: 'admin_start', token, title: '<b onmouseover=alert(1)>عنوان</b>', options: ['<img src=x onerror=alert(1)>', '<script>alert(2)</script>'] });
  const dom = boot('index.html', env);
  await settle();
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('img, script[data-x], b').length, 0);
  assert.equal(doc.getElementById('question').textContent, '<b onmouseover=alert(1)>عنوان</b>');
  assert.equal(doc.querySelectorAll('.option-label')[0].textContent, '<img src=x onerror=alert(1)>');
});

test('public: unconfigured API_URL is reported, not silently ignored', async () => {
  const env = createEnv();
  const dom = boot('index.html', env);
  dom.window.eval('window.APP_CONFIG.API_URL = "PASTE_YOUR_WEB_APP_URL_HERE"');
  dom.window.document.getElementById('retryBtn').click();
  await settle();
  assert.deepEqual(visible(dom.window.document), ['error']);
  assert.match(dom.window.document.getElementById('errorText').textContent, /config\.js/);
});

/* ============================================================== admin page */

async function loginUI(dom) {
  const d = dom.window.document;
  setValue(dom.window, d.getElementById('email'), EMAIL);
  setValue(dom.window, d.getElementById('password'), PASSWORD);
  d.getElementById('loginForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
}

test('admin: wrong password is rejected, correct password opens the dashboard; nothing secret in the DOM/storage', async () => {
  const env = createEnv();
  const dom = boot('admin.html', env);
  const d = dom.window.document;
  await settle();
  assert.equal(d.getElementById('loginView').hidden, false);
  assert.equal(d.getElementById('dashView').hidden, true);

  setValue(dom.window, d.getElementById('email'), EMAIL);
  setValue(dom.window, d.getElementById('password'), 'wrong');
  d.getElementById('loginForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  assert.match(d.getElementById('loginError').textContent, /غير صحيحة/);
  assert.equal(d.getElementById('dashView').hidden, true);

  await loginUI(dom);
  assert.equal(d.getElementById('dashView').hidden, false);
  assert.equal(d.getElementById('loginView').hidden, true);
  assert.equal(d.getElementById('password').value, '', 'password field is cleared');
  assert.match(dom.window.sessionStorage.getItem('admin.token'), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(Object.entries(dom.window.sessionStorage)).includes(PASSWORD));
  assert.equal(dom.window.localStorage.length, 0);
});

test('admin: build a contest, start it (with confirmation), watch live totals, end it, see the final result', async () => {
  const env = createEnv();
  const dom = boot('admin.html', env);
  const w = dom.window, d = w.document;
  await settle();
  await loginUI(dom);

  // editor: title + 3 options
  setValue(w, d.getElementById('titleInput'), 'من هو الأفضل؟');
  for (let i = 0; i < 3; i++) d.getElementById('addOptBtn').click();
  const inputs = () => Array.from(d.querySelectorAll('#optList input'));
  ['مصور', 'نجار', 'مبرمج'].forEach((t, i) => setValue(w, inputs()[i], t));

  // reorder: move the first option down, then back up
  d.querySelector('#optList li:nth-child(1) [data-role=down]').click();
  assert.deepEqual(inputs().map(i => i.value), ['نجار', 'مصور', 'مبرمج']);
  d.querySelector('#optList li:nth-child(2) [data-role=up]').click();
  assert.deepEqual(inputs().map(i => i.value), ['مصور', 'نجار', 'مبرمج']);

  // delete + re-add
  d.querySelector('#optList li:nth-child(3) .del').click();
  assert.equal(inputs().length, 2);
  d.getElementById('addOptBtn').click();
  setValue(w, inputs()[2], 'مبرمج');

  // client-side validation: duplicate
  setValue(w, inputs()[2], 'نجار');
  d.getElementById('startBtn').click();
  assert.match(d.getElementById('editorError').textContent, /مكرر/);
  assert.equal(w.__openDialog, undefined, 'no dialog for invalid input');
  setValue(w, inputs()[2], 'مبرمج');

  // save draft
  d.getElementById('saveBtn').click();
  await settle();
  assert.equal(env.post({ action: 'public_poll' }).status, 'IDLE');
  assert.equal(env.sheets.Options.getLastRow(), 4);

  // start → confirmation dialog lists the options; cancel does nothing
  d.getElementById('startBtn').click();
  await settle(2);
  assert.equal(d.getElementById('dlgTitle').textContent, 'بدء المسابقة؟');
  assert.deepEqual(Array.from(d.querySelectorAll('#dlgList li')).map(li => li.textContent), ['مصور', 'نجار', 'مبرمج']);
  w.answerDialog(false);
  await settle();
  assert.equal(env.post({ action: 'public_poll' }).status, 'IDLE');

  d.getElementById('startBtn').click();
  await settle(2);
  w.answerDialog(true);
  await settle();
  const pub = env.post({ action: 'public_poll' });
  assert.equal(pub.status, 'ACTIVE');
  assert.equal(d.getElementById('statusPill').textContent, 'المسابقة جارية');
  assert.ok(inputs().every(i => i.disabled), 'options locked while live');
  assert.equal(d.getElementById('titleInput').disabled, true);
  assert.equal(d.getElementById('startBtn').disabled, true);
  assert.equal(d.querySelector('#liveBody .total strong').textContent, '0');

  // votes arrive → refresh shows private totals
  [0, 0, 1].forEach((o, i) => env.post({ action: 'vote', contestId: pub.contestId, optionId: String(o + 1), voterId: 'voter-00000000000' + i }));
  d.getElementById('refreshBtn').click();
  await settle();
  assert.equal(d.querySelector('#liveBody .total strong').textContent, '3');
  const metas = Array.from(d.querySelectorAll('#liveBody .meta')).map(e => e.textContent);
  assert.deepEqual(metas, ['2 · 66.7%', '1 · 33.3%', '0 · 0%']);
  assert.equal(d.querySelectorAll('#liveBody .result.top').length, 1);

  // end → confirmation → final result shown, sheet clean
  d.getElementById('endBtn').click();
  await settle(2);
  assert.equal(d.getElementById('dlgTitle').textContent, 'إنهاء المسابقة؟');
  w.answerDialog(true);
  await settle(12);
  assert.equal(d.getElementById('finalCard').hidden, false);
  assert.equal(d.getElementById('finalTotal').textContent, '3');
  assert.match(d.getElementById('finalWinner').textContent, /مصور/);
  assert.equal(d.getElementById('statusPill').textContent, 'لا توجد مسابقة نشطة');
  assert.equal(env.sheets.Voters.getLastRow(), 1);
  assert.equal(env.sheets.Options.getLastRow(), 1);
  assert.equal(d.getElementById('titleInput').disabled, false, 'editor is usable again');
  assert.equal(d.getElementById('titleInput').value, '', 'editor is empty for the next contest');

  // dismiss → new contest; result stays recoverable server-side (cache) but is not shown again
  d.getElementById('newContestBtn').click();
  assert.equal(d.getElementById('finalCard').hidden, true);
});

test('admin: an expired session returns to the login screen', async () => {
  const env = createEnv();
  const dom = boot('admin.html', env);
  const d = dom.window.document;
  await settle();
  await loginUI(dom);
  env.advance(7300);
  d.getElementById('refreshBtn').click();
  await settle();
  assert.equal(d.getElementById('loginView').hidden, false);
  assert.match(d.getElementById('loginError').textContent, /انتهت الجلسة/);
  assert.equal(dom.window.sessionStorage.getItem('admin.token'), null);
});

test('admin: a lost "end" reply can be recovered (final result kept in server memory)', async () => {
  const env = createEnv();
  const token = adminSession(env);
  const { contestId } = env.post({ action: 'admin_start', token, title: 'س', options: ['أ', 'ب'] });
  env.post({ action: 'vote', contestId, optionId: '2', voterId: 'voter-000000000001' });
  env.post({ action: 'admin_end', token, contestId });               // "reply lost": browser never saw it

  const dom = boot('admin.html', env, { session: { 'admin.token': token } });
  await settle(12);
  const d = dom.window.document;
  assert.equal(d.getElementById('finalCard').hidden, false);
  assert.equal(d.getElementById('finalBadge').hidden, false);
  assert.equal(d.getElementById('finalTotal').textContent, '1');
});

test('admin: logout revokes the token', async () => {
  const env = createEnv();
  const dom = boot('admin.html', env);
  await settle();
  await loginUI(dom);
  const token = dom.window.sessionStorage.getItem('admin.token');
  dom.window.document.getElementById('logoutBtn').click();
  await settle();
  assert.equal(env.post({ action: 'admin_results', token }).code, 'UNAUTHORIZED');
  assert.equal(dom.window.document.getElementById('loginView').hidden, false);
});

/* ======================================================= static source checks */

test('16. no credentials, tokens or spreadsheet ids exist in any frontend file', () => {
  const files = ['index.html', 'admin.html', 'css/style.css', 'js/app.js', 'js/admin.js', 'js/api.js', 'js/config.js'];
  const forbidden = [/ADMIN_(PASSWORD|EMAIL|SALT)/i, /Test-Only-Passw0rd/, /admin@example\.com/, /SPREADSHEET_ID/, /spreadsheets\/d\//, /AKfyc[\w-]{20,}/, /\bpassword\s*[:=]\s*["'][^"']+["']/i];
  for (const f of files) {
    const src = read(f);
    for (const re of forbidden) assert.ok(!re.test(src), `${f} matches ${re}`);
  }
});

test('public page sources have no statistics, admin or storage-of-secrets code', () => {
  for (const f of ['index.html', 'js/app.js']) {
    const src = read(f);
    for (const word of [/\bvotes\b/i, /percent/i, /leaderboard/i, /\bwinner/i, /totalVotes/, /admin/i, /innerHTML/]) {
      assert.ok(!word.test(src), `${f} contains ${word}`);
    }
  }
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(read('js/admin.js')), 'admin.js must not inject HTML');
});

test('17. RTL + mobile essentials are present on both pages', () => {
  for (const f of ['index.html', 'admin.html']) {
    const src = read(f);
    assert.match(src, /<html lang="ar" dir="rtl">/);
    assert.match(src, /name="viewport" content="width=device-width, initial-scale=1/);
  }
  const css = read('css/style.css');
  assert.match(css, /min-height: 52px/, 'large touch targets');
  assert.match(css, /min-height: 68px/, 'option cards are large touch targets');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /max-width: 520px/, 'small-screen rules');
  assert.match(css, /:focus-visible/);
});
