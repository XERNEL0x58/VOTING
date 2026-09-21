'use strict';
/**
 * Minimal in-memory emulation of the Apps Script services used by apps-script/*.gs,
 * plus a loader that evaluates the .gs files in a sandbox (vm).
 *
 * Strictness features used by the tests:
 *  - any sheet mutation while the script lock is NOT held throws ("WRITE WITHOUT LOCK");
 *  - the lock is not re-entrant and does not wait: a second request that tries to take it while
 *    another one holds it fails immediately (in production it waits up to LOCK_WAIT_MS);
 *  - an operation log lets tests assert ordering (e.g. "ENDED is written before rows are cleared");
 *  - Utilities.computeDigest returns SIGNED bytes like the real service.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const GS_FILES = ['Config.gs', 'Infra.gs', 'Code.gs', 'Auth.gs', 'Store.gs', 'PublicState.gs', 'Validation.gs', 'Results.gs', 'Admin.gs', 'Votes.gs', 'Diagnostics.gs'];

function createEnv() {
  const env = {
    clock: Date.now(),
    lockHeld: false,
    opLog: [],
    onWrite: null,          // hook fired before the first sheet write of an execution
    failNextClear: false,
    sleepCalls: 0,
    logs: [],
    calls: { total: 0, inLock: 0 },      // Spreadsheet service calls (each one is a network round trip in production)
    resetCalls() { env.calls.total = 0; env.calls.inLock = 0; }
  };
  const tick = () => { env.calls.total++; if (env.lockHeld) env.calls.inLock++; };

  class MockRange {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    getValues() {
      tick();
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j];
          row.push(v === undefined || v === null ? '' : v);
        }
        out.push(row);
      }
      return out;
    }
    setValues(vals) {
      tick();
      this.sheet._write('setValues', { r: this.r, c: this.c, vals });
      for (let i = 0; i < vals.length; i++) {
        const idx = this.r - 1 + i;
        this.sheet.data[idx] = this.sheet.data[idx] || [];
        for (let j = 0; j < vals[i].length; j++) this.sheet.data[idx][this.c - 1 + j] = vals[i][j];
      }
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    clearContent() {
      tick();
      this.sheet._write('clear', { r: this.r, nr: this.nr });
      if (env.failNextClear) { env.failNextClear = false; throw new Error('simulated clear failure'); }
      for (let i = 0; i < this.nr; i++) {
        const row = this.sheet.data[this.r - 1 + i];
        if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = '';
      }
      return this;
    }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
  }

  class MockSheet {
    constructor(name) { this.name = name; this.data = []; }
    _write(op, detail) {
      if (!env.lockHeld) throw new Error(`WRITE WITHOUT LOCK: ${op} on ${this.name}`);
      if (env.onWrite) { const fn = env.onWrite; env.onWrite = null; fn(); }
      env.opLog.push({ op, sheet: this.name, detail });
    }
    getLastRow() {
      tick();
      for (let i = this.data.length - 1; i >= 0; i--) {
        if (this.data[i] && this.data[i].some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
      }
      return 0;
    }
    getRange(a, b, c, d) {
      tick();
      if (typeof a === 'string') return new MockRange(this, 1, 1, 1, 1);      // A1 notation: only used for formats
      return new MockRange(this, a, b, c || 1, d || 1);
    }
    appendRow(arr) {
      tick();
      this._write('appendRow', { arr });
      this.data[this.getLastRow()] = arr.slice();
    }
    setFrozenRows() {}
  }

  const sheets = {};
  const spreadsheet = {
    getSheetByName: n => { tick(); return sheets[n] || null; },
    insertSheet: n => {
      if (!env.lockHeld) throw new Error('WRITE WITHOUT LOCK: insertSheet ' + n);
      env.opLog.push({ op: 'insertSheet', sheet: n });
      return (sheets[n] = new MockSheet(n));
    }
  };

  const store = new Map();
  const cache = {
    get: k => { const e = store.get(k); if (!e) return null; if (e.exp <= env.clock) { store.delete(k); return null; } return e.v; },
    put: (k, v, ttl) => { store.set(k, { v: String(v), exp: env.clock + (ttl || 600) * 1000 }); },
    remove: k => { store.delete(k); }
  };

  const propStore = new Map();
  const props = {
    getProperty: k => (propStore.has(k) ? propStore.get(k) : null),
    setProperty: (k, v) => propStore.set(k, String(v)),
    setProperties: (o, del) => { if (del) propStore.clear(); Object.keys(o).forEach(k => propStore.set(k, String(o[k]))); },
    deleteProperty: k => propStore.delete(k)
  };

  const lock = {
    held: false,
    waitLock() { if (this.held) throw new Error('Lock timeout'); this.held = true; env.lockHeld = true; },
    releaseLock() { this.held = false; env.lockHeld = false; }
  };

  const captured = [];
  const sandbox = {
    console: { log() {}, error: (...a) => captured.push(a.join(' ')), warn() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => { tick(); return spreadsheet; }, openById: () => { tick(); return spreadsheet; }, flush() { tick(); } },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => props },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: s => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => crypto.randomUUID(),
      sleep: () => { env.sleepCalls++; },
      computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b))
    }
  };

  const context = vm.createContext(sandbox);
  const src = GS_FILES.map(f => fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8')).join('\n');
  vm.runInContext(src, context, { filename: 'apps-script/all.gs' });

  const parse = out => JSON.parse(out.getContent());
  Object.assign(env, {
    sheets, props, cache, lock, context, captured,
    get: params => parse(context.doGet({ parameter: params || {} })),
    post: body => parse(context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } })),
    advance: sec => { env.clock += sec * 1000; }
  });

  props.setProperty('ADMIN_EMAIL', 'admin@example.com');
  props.setProperty('ADMIN_PASSWORD', 'Test-Only-Passw0rd');
  return env;
}

module.exports = { createEnv };
