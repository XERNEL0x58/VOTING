/*
 * api.js — tiny client for the Apps Script Web App (shared by index.html and admin.html).
 *
 * POST bodies are sent as text/plain: Apps Script web apps cannot answer CORS preflight
 * requests, and text/plain keeps the request "simple" so the browser skips the preflight.
 * The body is still JSON and is parsed on the server.
 */
(function () {
  "use strict";

  var TIMEOUT_MS = 25000;

  function apiUrl() {
    var url = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || "";
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      throw new ApiFailure("NOT_CONFIGURED", "لم يتم ضبط رابط الخادم في js/config.js");
    }
    return url;
  }

  function ApiFailure(code, message) {
    this.name = "ApiFailure";
    this.code = code;
    this.message = message;
  }
  ApiFailure.prototype = Object.create(Error.prototype);

  function withTimeout(run) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    // Promise.resolve().then(...) turns a synchronous throw (e.g. missing API_URL) into a rejection.
    return Promise.resolve().then(function () { return run(ctrl.signal); })
      .finally(function () { clearTimeout(timer); });
  }

  function parse(res) {
    if (!res.ok) throw new ApiFailure("NETWORK", "تعذّر الاتصال بالخادم");
    return res.json().catch(function () {
      throw new ApiFailure("BAD_RESPONSE", "استجابة غير صالحة من الخادم");
    });
  }

  function toFailure(err) {
    if (err instanceof ApiFailure) return err;
    return new ApiFailure("NETWORK", "تعذّر الاتصال بالخادم، تحقق من الإنترنت وأعد المحاولة");
  }

  /** GET ?action=public_poll  (public data only) */
  function get(action) {
    return withTimeout(function (signal) {
      return fetch(apiUrl() + "?action=" + encodeURIComponent(action), {
        method: "GET", redirect: "follow", cache: "no-store", signal: signal
      });
    }).then(parse).catch(function (e) { throw toFailure(e); });
  }

  /** POST JSON as text/plain */
  function post(payload) {
    return withTimeout(function (signal) {
      return fetch(apiUrl(), {
        method: "POST", redirect: "follow", cache: "no-store", signal: signal,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
    }).then(parse).catch(function (e) { throw toFailure(e); });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** POST, retrying a couple of times when the server says it is busy (lock contention). */
  function postWithRetry(payload, tries) {
    return post(payload).then(function (res) {
      if (res && res.code === "SERVER_BUSY" && tries > 0) {
        return sleep(1200).then(function () { return postWithRetry(payload, tries - 1); });
      }
      return res;
    });
  }

  window.Api = {
    ApiFailure: ApiFailure,
    publicPoll: function () { return get("public_poll"); },
    vote: function (p) {
      return postWithRetry({ action: "vote", contestId: p.contestId, optionId: p.optionId, voterId: p.voterId }, 2);
    },
    admin: function (action, fields) {
      return postWithRetry(Object.assign({ action: action }, fields || {}), 1);
    }
  };
})();
