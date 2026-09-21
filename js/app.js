/*
 * app.js — public voting page.
 * Only ever receives: status, contest id, question, option ids + labels.
 * All server text is written as plain text nodes (textContent), never parsed as HTML.
 */
(function () {
  "use strict";

  var el = Common.el;

  var POLL_INTERVAL_MS = 45000;
  var POLL_JITTER_MS = 8000;              // so viewers do not poll in lock-step
  var VOTER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
  var CHECK_ICON_PATH = "m5 12.5 4.5 4.5L19 7.5";

  var TEXT = {
    loading: "جارٍ تحميل المسابقة…",
    loadingSlow: "الاتصال بطيء قليلًا، نحاول مجددًا…",
    confirm: "تأكيد التصويت",
    sending: "جارٍ الإرسال…",
    busy: "الخادم مزدحم الآن، نعيد المحاولة تلقائيًا…",
    connection: "تحقق من اتصالك بالإنترنت ثم أعد المحاولة.",
    voteFailed: "تعذّر إرسال التصويت، أعد المحاولة."
  };

  var KEYS = {
    voter: "poll.voterId.v1",
    votedPrefix: "poll.voted.",           // + contestId
    lastSeen: "poll.lastSeenContest"
  };

  var store = Common.storage("local");
  var views = {};
  var refs = {};
  var current = { contestId: null, optionId: null, busy: false };
  var pollTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (node) {
      views[node.getAttribute("data-view")] = node;
    });
    ["voteForm", "question", "options", "submitBtn", "formNote", "errorText", "loadingText"].forEach(function (id) {
      refs[id] = document.getElementById(id);
    });

    refs.voteForm.addEventListener("submit", onSubmit);
    document.getElementById("retryBtn").addEventListener("click", function () { load(true); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && pollTimer) load(false);
    });

    load(true);
    Common.loadFonts();            // after the request is on its way, and never blocks rendering
  }

  /* ------------------------------------------------------ voter identity */

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  // Anti-abuse layer only: a random id kept in this browser. It does NOT prove one person = one vote.
  function voterId() {
    var id = store.getItem(KEYS.voter);
    if (!VOTER_ID_PATTERN.test(id || "")) {
      id = newId();
      store.setItem(KEYS.voter, id);
    }
    return id;
  }

  function hasVoted(contestId) { return store.getItem(KEYS.votedPrefix + contestId) === "1"; }
  function markVoted(contestId) { store.setItem(KEYS.votedPrefix + contestId, "1"); }

  /* --------------------------------------------------------------- views */

  function show(name) {
    Object.keys(views).forEach(function (key) { views[key].hidden = key !== name; });
  }

  function showError(message) {
    stopPolling();
    refs.errorText.textContent = message || TEXT.connection;
    show("error");
  }

  function setNote(message, isError) {
    refs.formNote.textContent = message || "";
    refs.formNote.className = "note" + (isError ? " error" : "");
  }

  function setSubmitLabel(text) { refs.submitBtn.textContent = text; }

  /* ------------------------------------------------------------- polling */

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (document.visibilityState === "visible") load(false);
      else schedulePoll();
    }, POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS));
  }

  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  function load(showSpinner) {
    if (current.busy) return;
    if (showSpinner) {
      refs.loadingText.textContent = TEXT.loading;
      show("loading");
    }
    Api.publicPoll({
      onRetry: function () { if (showSpinner) refs.loadingText.textContent = TEXT.loadingSlow; }
    }).then(apply, function (err) {
      if (showSpinner || !pollTimer) showError(err && err.message);
      else schedulePoll();   // background refresh failed: keep what is on screen and try again later
    });
  }

  function apply(data) {
    if (!data || data.ok !== true) return showError(data && data.message);
    if (data.status === "ACTIVE" && data.contestId && Array.isArray(data.options)) return applyActive(data);
    applyClosed(data);
  }

  function applyActive(data) {
    store.setItem(KEYS.lastSeen, data.contestId);
    if (hasVoted(data.contestId)) {
      stopPolling();
      return show("already");
    }
    // Keep the current selection if the same contest is simply being refreshed.
    if (current.contestId !== data.contestId || !views.active || views.active.hidden) renderContest(data);
    show("active");
    schedulePoll();
  }

  /** IDLE or ENDED: if this browser saw a contest before, tell the visitor it is over. */
  function applyClosed(data) {
    current.contestId = null;
    current.optionId = null;
    show(data.status === "ENDED" || store.getItem(KEYS.lastSeen) ? "ended" : "idle");
    schedulePoll();
  }

  /* ------------------------------------------------------------ rendering */

  function renderContest(data) {
    current.contestId = data.contestId;
    current.optionId = null;
    refs.question.textContent = data.title;
    refs.options.textContent = "";
    setNote("");
    refs.submitBtn.disabled = true;
    setSubmitLabel(TEXT.confirm);
    data.options.forEach(function (opt) { refs.options.appendChild(optionCard(opt)); });
  }

  function optionCard(opt) {
    var input = el("input", { type: "radio", name: "option", value: opt.id });
    input.addEventListener("change", function () {
      current.optionId = opt.id;
      refs.submitBtn.disabled = false;
      setNote("");
    });
    var dot = el("span", { class: "option-dot", "aria-hidden": "true" }, [Common.svgIcon(CHECK_ICON_PATH, 3.2)]);
    var label = el("span", { class: "option-label", text: opt.label });
    return el("label", { class: "option" }, [input, el("span", { class: "option-body" }, [dot, label])]);
  }

  /* -------------------------------------------------------------- voting */

  function onSubmit(ev) {
    ev.preventDefault();
    if (current.busy || !current.optionId || !current.contestId) return;

    current.busy = true;
    refs.submitBtn.disabled = true;
    setSubmitLabel(TEXT.sending);
    setNote("");

    var vote = { contestId: current.contestId, optionId: current.optionId, voterId: voterId() };
    Api.vote(vote, { onRetry: function () { setNote(TEXT.busy); } }).then(function (res) {
      current.busy = false;
      if (res && res.ok) return onVoteAccepted();
      onVoteRefused(res || {});
    }, function (err) {
      current.busy = false;
      resetSubmit();
      setNote((err && err.message) || TEXT.voteFailed, true);
    });
  }

  function onVoteAccepted() {
    markVoted(current.contestId);
    stopPolling();
    show("success");
  }

  function resetSubmit() {
    refs.submitBtn.disabled = !current.optionId;
    setSubmitLabel(TEXT.confirm);
  }

  function onVoteRefused(res) {
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
        setNote(res.message || TEXT.voteFailed, true);
    }
  }
})();
