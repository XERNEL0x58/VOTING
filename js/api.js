/*
 * api.js — client for the Apps Script Web App (shared by index.html and admin.html).
 *
 * POST bodies are sent as text/plain: Apps Script web apps cannot answer CORS preflight
 * requests, and text/plain keeps the request "simple" so the browser skips the preflight.
 * The body is still JSON and is parsed on the server.
 *
 * Resilience: when many phones hit the Web App at once, Google may answer slowly, with an HTML
 * error page, or the script may say SERVER_BUSY. Each call therefore retries with exponential
 * backoff and random jitter (so the phones do not retry in lock-step), within a fixed budget.
 * Retrying a vote is safe: the server refuses a second vote from the same voter id.
 *
 * Observability: every request reports how long it took and how it ended through Api.onEvent(),
 * which is what the ?debug=1 panel (js/debug.js) displays.
 */
(function () {
  "use strict";

  var POLICY = {
    read:  { attempts: 3, baseMs: 800,  maxMs: 4000, timeoutMs: 20000, retryTransient: true  },
    vote:  { attempts: 8, baseMs: 900,  maxMs: 6000, timeoutMs: 20000, retryTransient: true  },
    admin: { attempts: 3, baseMs: 1200, maxMs: 4000, timeoutMs: 25000, retryTransient: false }
  };

  var SNIPPET_CHARS = 90;
  var listeners = [];

  function ApiFailure(code, message, detail) {
    this.name = "ApiFailure";
    this.code = code;
    this.message = message;
    this.detail = detail || "";
  }
  ApiFailure.prototype = Object.create(Error.prototype);

  /* ------------------------------------------------------------ events */

  function emit(event) {
    listeners.forEach(function (fn) { try { fn(event); } catch (e) { /* a broken listener must never break requests */ } });
  }

  /* --------------------------------------------------------- transport */

  function apiUrl() {
    var url = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || "";
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      throw new ApiFailure("NOT_CONFIGURED", "لم يتم ضبط رابط الخادم في js/config.js");
    }
    if (/\/dev(\?|$)/.test(url)) {
      throw new ApiFailure("NOT_CONFIGURED",
        "الرابط في js/config.js ينتهي بـ /dev وهو رابط تجريبي يعمل للمالك فقط. استخدم رابط النشر الذي ينتهي بـ /exec");
    }
    return url;
  }

  function withTimeout(run, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    // Promise.resolve().then(...) turns a synchronous throw (e.g. missing API_URL) into a rejection.
    return Promise.resolve().then(function () { return run(ctrl.signal); })
      .finally(function () { clearTimeout(timer); });
  }

  /** Read the body as text first, so an HTML error page can be told apart from a JSON answer. */
  function parse(res) {
    if (!res.ok) throw new ApiFailure("NETWORK", "تعذّر الاتصال بالخادم", "HTTP " + res.status);
    return res.text().then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new ApiFailure("BAD_RESPONSE", "استجابة غير صالحة من الخادم", text.slice(0, SNIPPET_CHARS));
      }
    });
  }

  function toFailure(err) {
    if (err instanceof ApiFailure) return err;
    var aborted = err && err.name === "AbortError";
    return new ApiFailure("NETWORK", "تعذّر الاتصال بالخادم، تحقق من الإنترنت وأعد المحاولة",
      aborted ? "timeout" : String((err && err.message) || err));
  }

  /** One HTTP round trip, reported through emit(). */
  function request(label, makeFetch, timeoutMs) {
    var started = Date.now();
    function report(outcome, code, detail) {
      emit({ label: label, ms: Date.now() - started, outcome: outcome, code: code || "", detail: detail || "" });
    }
    return withTimeout(makeFetch, timeoutMs).then(parse).then(function (data) {
      report("ok", data && data.code, data && data.status);
      return data;
    }, function (e) {
      var failure = toFailure(e);
      report("fail", failure.code, failure.detail);
      throw failure;
    });
  }

  function getRequest(action, timeoutMs) {
    return request(action, function (signal) {
      return fetch(apiUrl() + "?action=" + encodeURIComponent(action), {
        method: "GET", redirect: "follow", cache: "no-store", signal: signal
      });
    }, timeoutMs);
  }

  function postRequest(payload, timeoutMs) {
    return request(payload.action, function (signal) {
      return fetch(apiUrl(), {
        method: "POST", redirect: "follow", cache: "no-store", signal: signal,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
    }, timeoutMs);
  }

  /* ------------------------------------------------------------- retry */

  function delayScale() {
    var scale = window.APP_CONFIG && window.APP_CONFIG.RETRY_DELAY_SCALE;
    return typeof scale === "number" ? scale : 1;
  }

  /** "Equal jitter" backoff: half fixed, half random, doubling per attempt up to a cap. */
  function backoffMs(policy, attemptIndex) {
    var ceiling = Math.min(policy.maxMs, policy.baseMs * Math.pow(2, attemptIndex));
    return (ceiling / 2 + Math.random() * (ceiling / 2)) * delayScale();
  }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function isRetryable(err, policy) {
    return policy.retryTransient && (err.code === "NETWORK" || err.code === "BAD_RESPONSE");
  }

  /**
   * @param {function(): Promise} send     one attempt
   * @param {Object} policy                one of POLICY
   * @param {function(number)=} onRetry    called with the attempt number that is about to start
   */
  function withRetry(send, policy, onRetry) {
    function attempt(n) {
      var isLast = n + 1 >= policy.attempts;
      return send().then(function (res) {
        return res && res.code === "SERVER_BUSY" && !isLast ? retryAfterDelay(n) : res;
      }, function (err) {
        if (isLast || !isRetryable(err, policy)) throw err;
        return retryAfterDelay(n);
      });
    }
    function retryAfterDelay(n) {
      if (onRetry) onRetry(n + 1);
      return sleep(backoffMs(policy, n)).then(function () { return attempt(n + 1); });
    }
    return attempt(0);
  }

  /* ------------------------------------------------------------ public */

  window.Api = {
    ApiFailure: ApiFailure,

    /** Subscribe to {label, ms, outcome, code, detail} for every HTTP round trip. */
    onEvent: function (fn) { listeners.push(fn); },

    /** Bare Apps Script round trip, no retry: used by the ?debug=1 panel. */
    ping: function () { return getRequest("ping", POLICY.read.timeoutMs); },

    /** @param {{onRetry: function(number)}=} opts */
    publicPoll: function (opts) {
      return withRetry(function () { return getRequest("public_poll", POLICY.read.timeoutMs); },
        POLICY.read, opts && opts.onRetry);
    },

    /** @param {{contestId, optionId, voterId}} vote  @param {{onRetry: function(number)}=} opts */
    vote: function (vote, opts) {
      var payload = { action: "vote", contestId: vote.contestId, optionId: vote.optionId, voterId: vote.voterId };
      return withRetry(function () { return postRequest(payload, POLICY.vote.timeoutMs); },
        POLICY.vote, opts && opts.onRetry);
    },

    admin: function (action, fields) {
      var payload = Object.assign({ action: action }, fields || {});
      return withRetry(function () { return postRequest(payload, POLICY.admin.timeoutMs); }, POLICY.admin);
    }
  };
})();
