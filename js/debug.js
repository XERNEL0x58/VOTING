/*
 * debug.js — diagnostic panel, shown ONLY when the page is opened with ?debug=1
 * (e.g. https://your-site/index.html?debug=1). Normal visitors never see it.
 *
 * It shows how long every request took and how it ended, and can fire several requests at once
 * from this one device to find out whether the server answers them in parallel or one by one.
 * Everything is written with textContent. Nothing here reveals votes or secrets.
 */
(function () {
  "use strict";

  if (!/[?&]debug=1(&|$)/.test(window.location.search) || !window.Api || !window.Common) return;

  var el = Common.el;
  var PARALLEL_REQUESTS = 5;
  var MAX_LOG_LINES = 60;
  var log;

  document.addEventListener("DOMContentLoaded", buildPanel);
  Api.onEvent(function (e) {
    var mark = e.outcome === "ok" ? (e.code ? "· " + e.code : "✓") : "✗ " + e.code;
    write(pad(e.label, 12) + pad(String(e.ms) + " ms", 10) + mark + (e.outcome === "fail" && e.detail ? "  [" + e.detail + "]" : ""));
  });

  function pad(text, width) { return (text + "                    ").slice(0, width); }

  function write(line) {
    if (!log) return;
    var stamp = new Date().toLocaleTimeString("en-GB");
    log.textContent = (stamp + "  " + line + "\n" + log.textContent).split("\n").slice(0, MAX_LOG_LINES).join("\n");
  }

  function environment() {
    var url = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || "(not set)";
    var connection = navigator.connection ? navigator.connection.effectiveType : "n/a";
    return [
      "online: " + navigator.onLine + "   network: " + connection,
      "api: …" + url.slice(-24) + (/\/exec$/.test(url) ? "" : "   ⚠ should end with /exec"),
      "agent: " + navigator.userAgent.slice(0, 70)
    ].join("\n");
  }

  function buildPanel() {
    log = el("pre", { class: "debug-log", dir: "ltr" });
    var info = el("pre", { class: "debug-info", dir: "ltr", text: environment() });
    var parallelBtn = el("button", { type: "button", class: "btn", text: "اختبار " + PARALLEL_REQUESTS + " طلبات معًا" });
    var pingBtn = el("button", { type: "button", class: "btn", text: "طلب واحد" });
    parallelBtn.addEventListener("click", runParallelTest);
    pingBtn.addEventListener("click", function () { Api.ping().catch(function () { /* already logged */ }); });

    document.body.appendChild(el("aside", { class: "debug", "aria-label": "diagnostics" }, [
      el("strong", { text: "وضع التشخيص" }),
      info,
      el("div", { class: "debug-actions" }, [pingBtn, parallelBtn]),
      log
    ]));
  }

  /** Fire N pings at the same instant and report when each one came back. */
  function runParallelTest() {
    var started = performance.now();
    var runs = [];
    for (var i = 0; i < PARALLEL_REQUESTS; i++) runs.push(timedPing(started));
    Promise.all(runs).then(function (times) {
      var ok = times.filter(function (t) { return t !== null; }).sort(function (a, b) { return a - b; });
      write("parallel x" + PARALLEL_REQUESTS + " → " + ok.join(" / ") + " ms  " + verdict(ok));
    });
  }

  function timedPing(started) {
    return Api.ping().then(
      function () { return Math.round(performance.now() - started); },
      function () { return null; });
  }

  /** Parallel answers arrive together; answers served one-by-one arrive spread out like 1s, 2s, 3s… */
  function verdict(sortedMs) {
    if (sortedMs.length < PARALLEL_REQUESTS) return "⚠ some requests failed";
    var first = sortedMs[0];
    var last = sortedMs[sortedMs.length - 1];
    return last > first * 2 + 800 ? "⚠ answered one by one (server is serialising)" : "✓ answered in parallel";
  }
})();
