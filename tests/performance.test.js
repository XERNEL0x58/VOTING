'use strict';
/**
 * Performance contract of the backend.
 *
 * Every Spreadsheet call is a network round trip in production, so "how many calls happen, and
 * how many of them while the script-wide lock is held" is the metric that decides how many
 * phones the site can serve at once. These tests pin that budget so it cannot regress silently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./mock-gas.js');

const EMAIL = 'admin@example.com';
const PASSWORD = 'Test-Only-Passw0rd';
const voter = n => 'voter-' + String(n).padStart(12, '0');

function startContest(env, labels = ['أ', 'ب', 'ج']) {
  const login = env.post({ action: 'admin_login', email: EMAIL, password: PASSWORD });
  const started = env.post({ action: 'admin_start', token: login.token, title: 'سؤال', options: labels });
  assert.equal(started.ok, true);
  return { token: login.token, contestId: started.contestId, options: started.options };
}

const castVote = (env, c, n, optionIndex = 0) =>
  env.post({ action: 'vote', contestId: c.contestId, optionId: c.options[optionIndex].id, voterId: voter(n) });

function measure(env, fn) {
  env.resetCalls();
  const result = fn();
  return { result, total: env.calls.total, inLock: env.calls.inLock };
}

test('public page load: a cache hit costs zero Spreadsheet calls', () => {
  const env = createEnv();
  env.get({});                                        // warm
  const m = measure(env, () => env.get({}));
  assert.equal(m.total, 0);
});

test('starting a contest pre-warms the cache: the first visitors never trigger a rebuild', () => {
  const env = createEnv();
  const c = startContest(env);
  const m = measure(env, () => env.get({}));
  assert.equal(m.result.status, 'ACTIVE');
  assert.equal(m.result.options.length, 3);
  assert.equal(m.total, 0, 'served straight from cache');
});

test('cache expiry rebuilds once, then everyone is served from cache again', () => {
  const env = createEnv();
  startContest(env);
  env.advance(env.context.CONFIG.PUBLIC_STATE_TTL_SEC + 1);
  const rebuild = measure(env, () => env.get({}));
  assert.equal(rebuild.result.status, 'ACTIVE');
  assert.ok(rebuild.total > 0 && rebuild.total <= 10, 'one bounded rebuild, got ' + rebuild.total);
  assert.equal(measure(env, () => env.get({})).total, 0);
});

test('a vote holds the lock for a small, fixed number of Spreadsheet calls', () => {
  const env = createEnv();
  const c = startContest(env);
  castVote(env, c, 1);
  for (let i = 2; i <= 40; i++) castVote(env, c, i, i % 3);
  const m = measure(env, () => castVote(env, c, 41));
  assert.equal(m.result.ok, true);
  assert.ok(m.inLock <= 12, 'in-lock calls: ' + m.inLock);          // was 19 before the rewrite
  assert.ok(m.total - m.inLock >= 3, 'sheet handles are opened BEFORE waiting for the lock');
});

test('requests the cache already knows are hopeless never reach the Sheet or the lock', () => {
  const env = createEnv();
  const c = startContest(env);
  castVote(env, c, 1);

  const cases = {
    ALREADY_VOTED: () => castVote(env, c, 1),
    CONTEST_NOT_ACTIVE: () => env.post({ action: 'vote', contestId: 'other-contest', optionId: '1', voterId: voter(2) }),
    OPTION_NOT_FOUND: () => env.post({ action: 'vote', contestId: c.contestId, optionId: '99', voterId: voter(3) })
  };
  for (const [code, run] of Object.entries(cases)) {
    const m = measure(env, run);
    assert.equal(m.result.code, code);
    assert.equal(m.total, 0, code + ' must cost zero Spreadsheet calls');
  }

  env.post({ action: 'admin_end', token: c.token, contestId: c.contestId });
  const m = measure(env, () => castVote(env, c, 4));
  assert.equal(m.result.code, 'NO_ACTIVE_CONTEST');
  assert.equal(m.total, 0);
});

test('while another request holds the lock: readers and duplicates are answered instantly, new votes are told to retry', () => {
  const env = createEnv();
  const c = startContest(env);
  castVote(env, c, 1);

  env.lock.held = true;                               // e.g. an admin action or another vote is mid-flight
  assert.equal(env.get({}).status, 'ACTIVE', 'page load does not wait');
  assert.equal(castVote(env, c, 1).code, 'ALREADY_VOTED', 'duplicates do not wait');
  const busy = castVote(env, c, 2);
  assert.equal(busy.code, 'SERVER_BUSY', 'a new vote gets a clean, retryable answer');
  env.lock.held = false;

  assert.equal(castVote(env, c, 2).ok, true, 'and succeeds on retry');
});

test('50 voters in a row: nothing lost, nothing double counted, every counter agrees', () => {
  const env = createEnv();
  const c = startContest(env, ['أ', 'ب', 'ج', 'د']);
  const expected = [0, 0, 0, 0];
  for (let i = 1; i <= 50; i++) {
    const pick = (i * 7) % 4;
    assert.equal(castVote(env, c, i, pick).ok, true);
    expected[pick]++;
  }
  for (let i = 1; i <= 50; i += 5) assert.equal(castVote(env, c, i).code, 'ALREADY_VOTED');

  const end = env.post({ action: 'admin_end', token: c.token, contestId: c.contestId });
  assert.equal(end.final.totalVotes, 50);
  assert.equal(end.final.votersRecorded, 50);
  assert.equal(end.final.consistent, true);
  assert.deepEqual(c.options.map(o => end.final.options.find(r => r.id === o.id).votes), expected);
});

test('counters are recomputed from the ledger, so drift heals itself on the next vote', () => {
  const env = createEnv();
  const c = startContest(env);
  castVote(env, c, 1, 0);
  castVote(env, c, 2, 1);
  env.sheets.Options.data[1][2] = 999;                // someone edits a counter by hand
  castVote(env, c, 3, 1);
  const optionRows = [1, 2, 3];                       // data[] is 0-based: rows 2..4 of the sheet
  assert.deepEqual(optionRows.map(i => env.sheets.Options.data[i][2]), [1, 2, 0]);
  assert.equal(env.sheets.Poll.data[6][1], 3, 'total_votes (row 7) agrees too');
});

test('cache eviction mid-contest is harmless: duplicates still refused, new voters still accepted', () => {
  const env = createEnv();
  const c = startContest(env);
  castVote(env, c, 1);
  env.cache.remove('public_state_v2');
  env.cache.remove('voted_' + c.contestId + '_' + voter(1));

  assert.equal(castVote(env, c, 1).code, 'ALREADY_VOTED', 'the ledger is the authority, not the cache');
  assert.equal(castVote(env, c, 2).ok, true);
  assert.equal(env.get({}).status, 'ACTIVE');
});

test('ping touches nothing: no Sheet, no lock, no data — only a timestamp', () => {
  const env = createEnv();
  const m = measure(env, () => env.get({ action: 'ping' }));
  assert.equal(m.total, 0);
  assert.deepEqual(Object.keys(m.result).sort(), ['ok', 'serverTime']);
});

test('diagnose() is read-only and works before and after the sheets exist', () => {
  const env = createEnv();
  assert.ok(env.context.diagnose().some(l => /run setup\(\) first/.test(l)));
  const c = startContest(env);
  castVote(env, c, 1);
  const before = JSON.stringify(env.sheets.Voters.data);
  const lines = env.context.diagnose();
  assert.ok(lines.length >= 6 && lines.every(l => !/ERROR/.test(l)), lines.join(' | '));
  assert.equal(JSON.stringify(env.sheets.Voters.data), before, 'no data changed');
});
