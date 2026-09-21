/*
 * app.js — public voting page.
 * Only ever receives: status, contest id, question, option ids + labels.
 * All server text is written as plain text nodes (textContent), never parsed as HTML.
 */
(function () {
  "use strict";

  var POLL_INTERVAL_MS = 45000;
  var ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
  var KEYS = {
    voter: "poll.voterId.v1",
    votedPrefix: "poll.voted.",       // + contestId
    lastSeen: "poll.lastSeenContest"
  };

  var store = createStore();
  var views = {};
  var refs = {};
  var current = { contestId: null, optionId: null, busy: false };
  var pollTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (el) {
      views[el.getAttribute("data-view")] = el;
    });
    refs.form = document.getElementById("voteForm");
    refs.question = document.getElementById("question");
    refs.options = document.getElementById("options");
    refs.submit = document.getElementById("submitBtn");
    refs.note = document.getElementById("formNote");
    refs.errorText = document.getElementById("errorText");

    refs.form.addEventListener("submit", onSubmit);
    document.getElementById("retryBtn").addEventListener("click", function () { load(true); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && pollTimer) load(false);
    });

    load(true);
  }

  /* ------------------------------------------------------------ storage */

  // localStorage can throw (private mode, blocked cookies); fall back to memory.
  function createStore() {
    try {
      var s = window.localStorage;
      s.setItem("__probe", "1");
      s.removeItem("__probe");
      return s;
    } catch (e) {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  // Anti-abuse layer only: a random id kept in this browser. It does NOT prove one person = one vote.
  function voterId() {
    var id = store.getItem(KEYS.voter);
    if (!ID_RE.test(id || "")) {
      id = newId();
      store.setItem(KEYS.voter, id);
    }
    return id;
  }

  function hasVoted(contestId) { return store.getItem(KEYS.votedPrefix + contestId) === "1"; }
  function markVoted(contestId) { store.setItem(KEYS.votedPrefix + contestId, "1"); }

  /* -------------------------------------------------------------- views */

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (document.visibilityState === "visible") load(false);
      else schedulePoll();
    }, POLL_INTERVAL_MS + Math.floor(Math.random() * 8000));   // jitter so viewers don't sync up
  }

  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  function showError(message) {
    stopPolling();
    refs.errorText.textContent = message || "تحقق من اتصالك بالإنترنت ثم أعد المحاولة.";
    show("error");
  }

  /* ------------------------------------------------------------- loading */

  function load(showSpinner) {
    if (current.busy) return;
    if (showSpinner) show("loading");
    Api.publicPoll().then(apply, function (err) {
      if (showSpinner || !pollTimer) showError(err && err.message);
      else schedulePoll();   // background refresh failed: keep what is on screen and try again later
    });
  }

  function apply(data) {
    if (!data || data.ok !== true) return showError(data && data.message);

    if (data.status === "ACTIVE" && data.contestId && Array.isArray(data.options)) {
      store.setItem(KEYS.lastSeen, data.contestId);
      if (hasVoted(data.contestId)) {
        stopPolling();
        return show("already");
      }
      // Keep the current selection if the same contest is simply being refreshed.
      if (current.contestId !== data.contestId || !views.active || views.active.hidden) {
        renderContest(data);
      }
      show("active");
      return schedulePoll();
    }

    // IDLE or ENDED: if this browser saw a contest before, tell the visitor it is over.
    current.contestId = null;
    current.optionId = null;
    show(data.status === "ENDED" || store.getItem(KEYS.lastSeen) ? "ended" : "idle");
    schedulePoll();
  }

  function renderContest(data) {
    current.contestId = data.contestId;
    current.optionId = null;
    refs.question.textContent = data.title;
    refs.options.textContent = "";
    refs.note.textContent = "";
    refs.note.className = "note";
    refs.submit.disabled = true;
    refs.submit.textContent = "تأكيد التصويت";

    data.options.forEach(function (opt) {
      var label = document.createElement("label");
      label.className = "option";

      var input = document.createElement("input");
      input.type = "radio";
      input.name = "option";
      input.value = opt.id;
      input.addEventListener("change", function () {
        current.optionId = opt.id;
        refs.submit.disabled = false;
        setNote("");
      });

      var body = document.createElement("span");
      body.className = "option-body";

      var dot = document.createElement("span");
      dot.className = "option-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.appendChild(checkIcon());

      var text = document.createElement("span");
      text.className = "option-label";
      text.textContent = opt.label;

      body.appendChild(dot);
      body.appendChild(text);
      label.appendChild(input);
      label.appendChild(body);
      refs.options.appendChild(label);
    });
  }

  function checkIcon() {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "3.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", "m5 12.5 4.5 4.5L19 7.5");
    svg.appendChild(path);
    return svg;
  }

  function setNote(message, isError) {
    refs.note.textContent = message || "";
    refs.note.className = "note" + (isError ? " error" : "");
  }

  /* -------------------------------------------------------------- voting */

  function onSubmit(ev) {
    ev.preventDefault();
    if (current.busy || !current.optionId || !current.contestId) return;

    current.busy = true;
    refs.submit.disabled = true;
    refs.submit.textContent = "جارٍ الإرسال…";
    setNote("");

    Api.vote({ contestId: current.contestId, optionId: current.optionId, voterId: voterId() })
      .then(function (res) {
        current.busy = false;
        if (res && res.ok) {
          markVoted(current.contestId);
          stopPolling();
          return show("success");
        }
        handleVoteError(res || {});
      }, function (err) {
        current.busy = false;
        resetSubmit();
        setNote((err && err.message) || "تعذّر إرسال التصويت، أعد المحاولة.", true);
      });
  }

  function resetSubmit() {
    refs.submit.disabled = !current.optionId;
    refs.submit.textContent = "تأكيد التصويت";
  }

  function handleVoteError(res) {
    switch (res.code) {
      case "ALREADY_VOTED":
        markVoted(current.contestId);
        stopPolling();
        return show("already");
      case "CONTEST_NOT_ACTIVE":
      case "NO_ACTIVE_CONTEST":
        show("ended");
        return schedulePoll();   // keep watching: a new contest may start later
      default:
        resetSubmit();
        setNote(res.message || "تعذّر إرسال التصويت، أعد المحاولة.", true);
    }
  }
})();
