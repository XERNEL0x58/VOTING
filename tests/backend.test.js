'use strict';
/**
 * Backend acceptance tests. Run:  node --test tests/*.test.js
 * Numbers in the test names refer to the acceptance list in the project brief.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./mock-gas');

const EMAIL = 'admin@example.com';
const PASSWORD = 'Test-Only-Passw0rd';
const voter = n => 'voter-' + String(n).padStart(12, '0');

function login(env) {
  const r = env.post({ action: 'admin_login', email: EMAIL, password: PASSWORD });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.token;
}
function start(env, token, title = 'من هو الأفضل؟', options = ['مصور', 'نجار', 'مبرمج']) {
  const r = env.post({ action: 'admin_start', token, title, options });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}
function vote(env, contestId, optionId, voterId) {
  return env.post({ action: 'vote', contestId, optionId, voterId });
}
function live(env, token) {
  return env.post({ action: 'admin_results', token });
}
function end(env, token, contestId) {
  return env.post({ action: 'admin_end', token, contestId });
}
const cell = (env, sheet, row, col) => (env.sheets[sheet].data[row - 1] || [])[col - 1];

/* ------------------------------------------------------------------ 1 */
test('1. empty spreadsheet: public poll is IDLE without writing; first admin login creates the sheets', () => {
  const env = createEnv();
  assert.deepEqual(env.get({ action: 'public_poll' }), { ok: true, status: 'IDLE' });
  assert.equal(env.opLog.length, 0, 'public read must not write');

  login(env);
  assert.deepEqual(env.sheets.Poll.data.slice(0, 7).map(r => r.slice(0, 2)), [
    ['key', 'value'], ['status', 'IDLE'], ['contest_id', ''], ['title', ''],
    ['started_at', ''], ['ended_at', ''], ['total_votes', 0]
  ]);
  assert.deepEqual(env.sheets.Options.data[0], ['option_id', 'label', 'votes', 'sort_order', 'active']);
  assert.deepEqual(env.sheets.Voters.data[0], ['voter_id', 'contest_id', 'option_id', 'created_at']);
});

/* ---------------------------------------------------------------- 2,3 */
test('2. admin can start a contest with 2 options', () => {
  const env = createEnv();
  const token = login(env);
  const r = start(env, token, 'قهوة أم شاي؟', ['قهوة', 'شاي']);
  assert.equal(r.status, 'ACTIVE');
  assert.equal(r.options.length, 2);
  assert.match(r.contestId, /^\d{14}-[a-f0-9]{6}$/);
  assert.equal(r.totalVotes, 0);
});

test('3. admin can start a contest with 3+ options (and up to 20)', () => {
  const env = createEnv();
  const token = login(env);
  assert.equal(start(env, token).options.length, 3);
  const c = live(env, token).contestId;
  end(env, token, c);
  const many = Array.from({ length: 20 }, (_, i) => 'خيار ' + (i + 1));
  assert.equal(start(env, token, 'عشرون', many).options.length, 20);
});

/* ---------------------------------------------------------------- 4,5 */
test('4/5. public endpoint exposes question + options only, never any statistics', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  vote(env, contestId, '1', voter(1));
  vote(env, contestId, '1', voter(2));
  env.advance(11);                                   // bypass the 10s public cache

  const pub = env.get({ action: 'public_poll' });
  assert.deepEqual(Object.keys(pub).sort(), ['contestId', 'options', 'ok', 'status', 'title'].sort());
  assert.equal(pub.title, 'من هو الأفضل؟');
  assert.deepEqual(pub.options, [
    { id: '1', label: 'مصور' }, { id: '2', label: 'نجار' }, { id: '3', label: 'مبرمج' }
  ]);
  const raw = JSON.stringify(pub);
  for (const banned of ['votes', 'total', 'percent', 'rank', 'winner', 'leader']) {
    assert.ok(!raw.toLowerCase().includes(banned), `public response leaks "${banned}"`);
  }
  // Same guarantee via POST and via the vote response
  assert.deepEqual(env.post({ action: 'public_poll' }), pub);
  const v = vote(env, contestId, '2', voter(3));
  assert.deepEqual(v, { ok: true, message: 'تم تسجيل تصويتك بنجاح' });
});

/* ------------------------------------------------------------------ 6 */
test('6. a valid vote is stored exactly once', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  assert.equal(vote(env, contestId, '2', voter(1)).ok, true);

  const view = live(env, token);
  assert.deepEqual(view.options.map(o => o.votes), [0, 1, 0]);
  assert.equal(view.totalVotes, 1);
  assert.equal(cell(env, 'Poll', 7, 2), 1);
  assert.equal(env.sheets.Voters.getLastRow(), 2);
  assert.deepEqual(Array.from(env.sheets.Voters.data[1]).slice(0, 3), [voter(1), contestId, '2']);
});

/* ------------------------------------------------------------------ 7 */
test('7. the same voter id cannot vote twice in one contest (even for another option)', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  vote(env, contestId, '1', voter(1));
  const again = vote(env, contestId, '1', voter(1));
  assert.deepEqual(again, { ok: false, code: 'ALREADY_VOTED', message: 'تم استخدام هذا التصويت بالفعل' });
  assert.equal(vote(env, contestId, '3', voter(1)).code, 'ALREADY_VOTED');
  assert.deepEqual(live(env, token).options.map(o => o.votes), [1, 0, 0]);
  assert.equal(live(env, token).totalVotes, 1);
});

/* ------------------------------------------------------------------ 8 */
test('8a. concurrency: a second request cannot enter while a vote holds the lock', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);

  let inner;
  env.onWrite = () => { inner = vote(env, contestId, '1', voter(2)); };   // fires mid-write of vote #1
  const first = vote(env, contestId, '1', voter(1));

  assert.equal(first.ok, true);
  assert.equal(inner.ok, false);
  assert.equal(inner.code, 'SERVER_BUSY');                                // production: it would wait, then run
  assert.equal(vote(env, contestId, '1', voter(2)).ok, true);             // retry after the lock is free
  assert.deepEqual(live(env, token).options.map(o => o.votes), [2, 0, 0]); // no lost increment
});

test('8b. 300 votes from distinct voters: option counters, Poll total and Voters rows agree', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  const expected = [0, 0, 0];
  for (let i = 1; i <= 300; i++) {
    const opt = (i * 7) % 3;
    expected[opt]++;
    assert.equal(vote(env, contestId, String(opt + 1), voter(i)).ok, true);
  }
  const view = live(env, token);
  assert.deepEqual(view.options.map(o => o.votes), expected);
  assert.equal(view.totalVotes, 300);
  assert.equal(cell(env, 'Poll', 7, 2), 300);
  assert.equal(env.sheets.Voters.getLastRow() - 1, 300);
});

test('8c. every sheet mutation in every flow happens under the lock', () => {
  // The mock throws "WRITE WITHOUT LOCK" otherwise; run the whole lifecycle to prove none do.
  const env = createEnv();
  const token = login(env);
  env.post({ action: 'admin_save_options', token, title: 'مسودة', options: ['أ', 'ب'] });
  const { contestId } = start(env, token);
  vote(env, contestId, '1', voter(1));
  end(env, token, contestId);
  assert.equal(env.post({ action: 'admin_reset', token }).ok, true);
  assert.ok(env.opLog.length > 0);
});

/* ------------------------------------------------------------------ 9 */
test('9. votes after the contest ended are rejected', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  end(env, token, contestId);
  const r = vote(env, contestId, '1', voter(9));
  assert.equal(r.ok, false);
  assert.ok(['NO_ACTIVE_CONTEST', 'CONTEST_NOT_ACTIVE'].includes(r.code));
});

test('9b. a vote carrying an old contest id is rejected after a new contest starts', () => {
  const env = createEnv();
  const token = login(env);
  const old = start(env, token).contestId;
  end(env, token, old);
  start(env, token);
  assert.equal(vote(env, old, '1', voter(1)).code, 'CONTEST_NOT_ACTIVE');
});

/* ------------------------------------------------------------------ 10 */
test('10. admin sees live private totals and percentages', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  [1, 1, 1, 2].forEach((o, i) => vote(env, contestId, String(o), voter(i + 1)));
  const view = live(env, token);
  assert.equal(view.totalVotes, 4);
  assert.deepEqual(view.options.map(o => [o.votes, o.percent]), [[3, 75], [1, 25], [0, 0]]);
});

/* ------------------------------------------------------------ 11,12,13 */
test('11-13. end: final totals are captured BEFORE the sheet is cleared, then IDLE and clean', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  [1, 1, 2, 3, 3, 3].forEach((o, i) => vote(env, contestId, String(o), voter(i + 1)));
  env.opLog.length = 0;

  const r = end(env, token, contestId);
  assert.equal(r.ok, true);
  assert.equal(r.resetOk, true);
  assert.equal(r.final.totalVotes, 6);
  assert.equal(r.final.consistent, true);
  assert.deepEqual(r.final.options.map(o => [o.label, o.votes, o.rank]), [['مبرمج', 3, 1], ['مصور', 2, 2], ['نجار', 1, 3]]);
  assert.deepEqual(r.final.winnerIds, ['3']);
  assert.ok(r.final.endedAt && r.final.startedAt);

  // ordering: ENDED written first, and only afterwards any clear
  const endedIdx = env.opLog.findIndex(o => o.sheet === 'Poll' && o.op === 'setValues' && o.detail.vals[0][0] === 'ENDED');
  const clearIdx = env.opLog.findIndex(o => o.op === 'clear');
  assert.ok(endedIdx >= 0 && clearIdx > endedIdx, `ENDED@${endedIdx} must precede first clear@${clearIdx}`);

  // sheet is clean and IDLE
  assert.equal(cell(env, 'Poll', 2, 2), 'IDLE');
  assert.equal(cell(env, 'Poll', 3, 2), '');
  assert.equal(cell(env, 'Poll', 7, 2), 0);
  assert.equal(env.sheets.Options.getLastRow(), 1);
  assert.equal(env.sheets.Voters.getLastRow(), 1);
  assert.deepEqual(env.get({ action: 'public_poll' }), { ok: true, status: 'IDLE' });

  // the safety copy is available to the admin only
  assert.equal(env.post({ action: 'admin_last_result', token }).final.totalVotes, 6);
  assert.equal(env.post({ action: 'admin_last_result' }).code, 'UNAUTHORIZED');
});

test('11b. a tie yields several winners; zero votes yields none', () => {
  const env = createEnv();
  const token = login(env);
  let c = start(env, token, 'تعادل', ['أ', 'ب']).contestId;
  vote(env, c, '1', voter(1)); vote(env, c, '2', voter(2));
  assert.deepEqual(end(env, token, c).final.winnerIds.sort(), ['1', '2']);
  c = start(env, token, 'فارغة', ['أ', 'ب']).contestId;
  const r = end(env, token, c);
  assert.equal(r.final.totalVotes, 0);
  assert.deepEqual(r.final.winnerIds, []);
});

test('11c. if the reset step fails, the result is still returned, ENDED blocks votes, admin_reset recovers', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  vote(env, contestId, '2', voter(1));
  env.failNextClear = true;
  const r = end(env, token, contestId);
  assert.equal(r.ok, true);
  assert.equal(r.resetOk, false);
  assert.equal(r.final.totalVotes, 1);
  assert.equal(live(env, token).status, 'ENDED');
  assert.equal(vote(env, contestId, '1', voter(2)).code, 'CONTEST_NOT_ACTIVE');
  assert.equal(env.post({ action: 'admin_reset', token }).status, 'IDLE');
  assert.equal(env.sheets.Voters.getLastRow(), 1);
});

test('11d. end refuses a stale/wrong contest id and an idle sheet', () => {
  const env = createEnv();
  const token = login(env);
  assert.equal(end(env, token, 'x').code, 'NO_ACTIVE_CONTEST');
  const { contestId } = start(env, token);
  assert.equal(end(env, token, 'wrong-id').code, 'INVALID_REQUEST');
  assert.equal(live(env, token).status, 'ACTIVE');
  assert.equal(end(env, token, contestId).ok, true);
});

/* ------------------------------------------------------------------ 14 */
test('14. a new contest starts from zero; the same voter may vote in the new contest', () => {
  const env = createEnv();
  const token = login(env);
  const first = start(env, token).contestId;
  vote(env, first, '1', voter(1));
  end(env, token, first);

  const second = start(env, token, 'سؤال جديد', ['نعم', 'لا']);
  assert.notEqual(second.contestId, first);
  assert.equal(second.totalVotes, 0);
  assert.deepEqual(second.options.map(o => o.votes), [0, 0]);
  assert.equal(env.sheets.Voters.getLastRow(), 1);
  assert.equal(vote(env, second.contestId, '2', voter(1)).ok, true);
  assert.equal(live(env, token).totalVotes, 1);
});

test('14b. public cache never serves a stale state across start / end', () => {
  const env = createEnv();
  const token = login(env);
  assert.equal(env.get({}).status, 'IDLE');                 // caches IDLE
  const { contestId } = start(env, token);
  assert.equal(env.get({}).status, 'ACTIVE');               // invalidated by start
  end(env, token, contestId);
  assert.equal(env.get({}).status, 'IDLE');                 // invalidated by end
});

/* ------------------------------------------------------------------ 15 */
test('15. admin actions fail without a valid session', () => {
  const env = createEnv();
  const token = login(env);
  const actions = ['admin_results', 'admin_last_result', 'admin_save_options', 'admin_start', 'admin_end', 'admin_reset'];
  const payload = { title: 'س', options: ['أ', 'ب'], contestId: 'x' };

  for (const action of actions) {
    assert.equal(env.post({ action, ...payload }).code, 'UNAUTHORIZED', action + ' (no token)');
    assert.equal(env.post({ action, ...payload, token: 'a'.repeat(64) }).code, 'UNAUTHORIZED', action + ' (fake token)');
    assert.equal(env.post({ action, ...payload, token: "' OR 1=1" }).code, 'UNAUTHORIZED', action + ' (malformed)');
  }
  // admin data is not reachable through GET at all
  assert.equal(env.get({ action: 'admin_results', token }).code, 'INVALID_REQUEST');
  assert.equal(env.get({ action: 'nope' }).code, 'INVALID_REQUEST');

  // nothing was created by the rejected calls
  assert.equal(live(env, token).status, 'IDLE');
});

test('15b. sessions expire (sliding 2h) and can be revoked by logout', () => {
  const env = createEnv();
  let token = login(env);
  env.advance(3600); assert.equal(live(env, token).ok, true);      // refreshes expiry
  env.advance(3600); assert.equal(live(env, token).ok, true);      // still alive: sliding
  env.advance(7201); assert.equal(live(env, token).code, 'UNAUTHORIZED');

  token = login(env);
  assert.equal(env.post({ action: 'admin_logout', token }).ok, true);
  assert.equal(live(env, token).code, 'UNAUTHORIZED');
});

test('15c. login: wrong credentials rejected, 5 failures lock login for 15 minutes', () => {
  const env = createEnv();
  assert.equal(env.post({ action: 'admin_login', email: EMAIL, password: 'nope' }).code, 'UNAUTHORIZED');
  assert.equal(env.post({ action: 'admin_login', email: 'x@y.z', password: PASSWORD }).code, 'UNAUTHORIZED');
  for (let i = 0; i < 3; i++) env.post({ action: 'admin_login', email: EMAIL, password: 'bad' + i });
  assert.equal(env.post({ action: 'admin_login', email: EMAIL, password: PASSWORD }).code, 'RATE_LIMITED', 'locked, even with the right password');
  env.advance(901);
  assert.equal(env.post({ action: 'admin_login', email: EMAIL, password: PASSWORD }).ok, true);
  assert.ok(env.sleepCalls > 0);
});

test('15d. password migration: plain value is replaced by a salted hash and login keeps working', () => {
  const env = createEnv();
  env.context.migratePasswordToHash();
  assert.equal(env.props.getProperty('ADMIN_PASSWORD'), null);
  assert.match(env.props.getProperty('ADMIN_PASSWORD_HASH'), /^[a-f0-9]{64}$/);
  assert.match(env.props.getProperty('ADMIN_SALT'), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify([...env.props.getProperty('ADMIN_PASSWORD_HASH')]).includes(PASSWORD));
  assert.equal(env.post({ action: 'admin_login', email: EMAIL, password: 'wrong' }).code, 'UNAUTHORIZED');
  assert.equal(env.post({ action: 'admin_login', email: EMAIL.toUpperCase(), password: PASSWORD }).ok, true);
});

test('15e. login without configured credentials fails safely', () => {
  const env = createEnv();
  env.props.deleteProperty('ADMIN_PASSWORD');
  const r = env.post({ action: 'admin_login', email: EMAIL, password: 'anything' });
  assert.equal(r.ok, false);
  assert.ok(!('token' in r));
});

/* ---------------------------------------------------------- validation */
test('validation: inputs are checked server-side', () => {
  const env = createEnv();
  const token = login(env);
  const bad = (title, options) => env.post({ action: 'admin_start', token, title, options });

  assert.equal(bad('', ['أ', 'ب']).code, 'INVALID_REQUEST');                   // no question
  assert.equal(bad('س', ['أ']).code, 'INVALID_REQUEST');                        // <2 options
  assert.equal(bad('س', Array.from({ length: 21 }, (_, i) => 'o' + i)).code, 'INVALID_REQUEST');
  assert.equal(bad('س'.repeat(201), ['أ', 'ب']).code, 'INVALID_REQUEST');       // long title
  assert.equal(bad('س', ['أ', 'ب'.repeat(101)]).code, 'INVALID_REQUEST');      // long label
  assert.equal(bad('س', ['أ', '   ']).code, 'INVALID_REQUEST');                 // empty label
  assert.equal(bad('س', ['أ', ' أ ']).code, 'INVALID_REQUEST');                 // duplicate after trim
  assert.equal(bad('س', ['A', 'a']).code, 'INVALID_REQUEST');                   // duplicate ignoring case
  assert.equal(bad('س', 'not-an-array').code, 'INVALID_REQUEST');
  assert.equal(bad({ x: 1 }, ['أ', 'ب']).code, 'INVALID_REQUEST');
  assert.equal(bad('س', [1, 2]).code, 'INVALID_REQUEST');
  assert.equal(live(env, token).status, 'IDLE');                                // nothing was started

  const ok = bad('  سؤال \u202E  مع   مسافات  ', ['  أ  ', 'ب']);
  assert.equal(ok.title, 'سؤال مع مسافات');                                     // control chars stripped, spaces collapsed
  assert.equal(ok.options[0].label, 'أ');
});

test('12. invalid ids and payloads fail safely', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  assert.equal(vote(env, contestId, '99', voter(1)).code, 'OPTION_NOT_FOUND');
  assert.equal(vote(env, contestId, '1; DROP', voter(1)).code, 'INVALID_REQUEST');
  assert.equal(vote(env, contestId, '1', 'short').code, 'INVALID_REQUEST');
  assert.equal(vote(env, contestId, '1', 'has spaces in voter id!!').code, 'INVALID_REQUEST');
  assert.equal(vote(env, 'bad id', '1', voter(1)).code, 'INVALID_REQUEST');
  assert.equal(vote(env, 123, '1', voter(1)).code, 'INVALID_REQUEST');
  assert.equal(vote(env, 'nonexistent-contest', '1', voter(1)).code, 'CONTEST_NOT_ACTIVE');
  assert.equal(env.post('not json').code, 'INVALID_REQUEST');
  assert.equal(env.post('[]').code, 'INVALID_REQUEST');
  assert.equal(env.post({ action: 'vote' }).code, 'INVALID_REQUEST');
  assert.equal(env.post({ action: 'drop_tables' }).code, 'INVALID_REQUEST');
  assert.equal(env.post({ noaction: true }).code, 'INVALID_REQUEST');
  assert.equal(env.post('{"action":"vote","x":"' + 'a'.repeat(21000) + '"}').code, 'INVALID_REQUEST');
  assert.equal(live(env, token).totalVotes, 0);                                 // none of it counted
});

test('lifecycle guards: cannot start or edit while ACTIVE; draft save/reset work while IDLE', () => {
  const env = createEnv();
  const token = login(env);
  const saved = env.post({ action: 'admin_save_options', token, title: 'مسودة', options: ['أ'] });
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 'IDLE');
  assert.equal(saved.options.length, 1);
  assert.deepEqual(env.get({ action: 'public_poll' }), { ok: true, status: 'IDLE' }, 'drafts are invisible to the public');

  start(env, token);
  assert.equal(env.post({ action: 'admin_start', token, title: 'x', options: ['أ', 'ب'] }).code, 'CONTEST_ACTIVE');
  assert.equal(env.post({ action: 'admin_save_options', token, title: 'x', options: ['أ', 'ب'] }).code, 'CONTEST_ACTIVE');
  assert.equal(env.post({ action: 'admin_reset', token }).code, 'CONTEST_ACTIVE');
  assert.equal(live(env, token).title, 'من هو الأفضل؟');                        // untouched
});

test('vote rate limit: too many attempts by one voter id are throttled', () => {
  const env = createEnv();
  const token = login(env);
  const { contestId } = start(env, token);
  vote(env, contestId, '1', voter(1));
  let last;
  for (let i = 0; i < 10; i++) last = vote(env, contestId, '2', voter(1));
  assert.equal(last.code, 'RATE_LIMITED');
  env.advance(61);
  assert.equal(vote(env, contestId, '2', voter(1)).code, 'ALREADY_VOTED');       // window reset, dedupe still holds
});

test('errors never leak internals (stack traces, sheet ids, secrets)', () => {
  const env = createEnv();
  const token = login(env);
  start(env, token);
  env.sheets.Options.getRange = () => { throw new Error('boom: secret-internal-detail at Sheet.gs:42'); };
  env.advance(11);
  const r = env.get({ action: 'public_poll' });
  assert.deepEqual(r, { ok: false, code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع، حاول مرة أخرى' });
  assert.ok(env.captured.some(l => l.includes('secret-internal-detail')), 'logged server-side only');
});
