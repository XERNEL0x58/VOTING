/*
 * admin.js — admin panel.
 *
 * Holds NO credentials. The session token returned by the server after login is kept in
 * sessionStorage (cleared when the tab closes). Every string coming from the server is written
 * as plain text (textContent), never parsed as HTML.
 */
(function () {
  "use strict";

  var TOKEN_KEY = "admin.token";
  var REFRESH_MS = 8000;
  var LIM = { title: 200, label: 100, min: 2, max: 20 };
  var HANDLED = { handled: true };   // thrown after a 401 has already been dealt with

  var $ = function (id) { return document.getElementById(id); };
  var ui = {};
  var state = {
    token: null,
    view: null,            // last admin view from the server
    model: { title: "", options: [] },
    dirty: false,          // unsaved edits in the editor
    busy: false,
    timer: null,
    lastFinal: null,
    finalDismissed: false
  };

  document.addEventListener("DOMContentLoaded", init);

  /* ================================================================ setup */

  function init() {
    [
      "statusPill", "logoutBtn", "loginView", "loginForm", "email", "password", "loginError", "loginBtn",
      "dashView", "finalCard", "finalBadge", "finalQuestion", "finalWarn", "finalTotal", "finalWinner",
      "finalResults", "copyBtn", "newContestBtn", "editorCard", "lockedNote", "titleInput", "titleCount",
      "optList", "addOptBtn", "editorError", "saveBtn", "startBtn", "clearBtn", "liveSub", "liveBody",
      "refreshBtn", "endBtn", "dialog", "dlgTitle", "dlgBody", "dlgList", "dlgOk"
    ].forEach(function (id) { ui[id] = $(id); });

    ui.loginForm.addEventListener("submit", onLogin);
    ui.logoutBtn.addEventListener("click", function () { signOut("", true); });
    ui.titleInput.addEventListener("input", function () {
      state.model.title = ui.titleInput.value;
      state.dirty = true;
      updateCount();
    });
    ui.addOptBtn.addEventListener("click", addOption);
    ui.saveBtn.addEventListener("click", onSave);
    ui.startBtn.addEventListener("click", onStart);
    ui.clearBtn.addEventListener("click", onClear);
    ui.endBtn.addEventListener("click", onEnd);
    ui.refreshBtn.addEventListener("click", function () { refresh(true); });
    ui.copyBtn.addEventListener("click", copyFinal);
    ui.newContestBtn.addEventListener("click", function () {
      state.finalDismissed = true;
      ui.finalCard.hidden = true;
      ui.titleInput.focus();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.token) refresh(false);
    });

    var saved = null;
    try { saved = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
    if (saved && /^[a-f0-9]{64}$/.test(saved)) {
      state.token = saved;
      enterDashboard();
    } else {
      showLogin();
    }
  }

  /* ============================================================== helpers */

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) { node.appendChild(kid); });
    return node;
  }

  var ICONS = {
    up: "m6 15 6-6 6 6",
    down: "m6 9 6 6 6-6",
    trash: "M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"
  };
  function icon(name) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    ["viewBox:0 0 24 24", "fill:none", "stroke:currentColor", "stroke-width:2", "stroke-linecap:round", "stroke-linejoin:round"]
      .forEach(function (p) { var kv = p.split(":"); svg.setAttribute(kv[0], kv[1]); });
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function toast(message, isError) {
    var t = el("div", { class: "toast" + (isError ? " error" : ""), role: isError ? "alert" : "status", text: message });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }

  function confirmDialog(o) {
    return new Promise(function (resolve) {
      ui.dlgTitle.textContent = o.title;
      ui.dlgBody.textContent = o.body || "";
      ui.dlgList.textContent = "";
      (o.items || []).forEach(function (t) { ui.dlgList.appendChild(el("li", { text: t })); });
      ui.dlgOk.textContent = o.confirmLabel;
      ui.dlgOk.className = "btn " + (o.danger ? "danger" : "primary");
      ui.dialog.returnValue = "";
      ui.dialog.addEventListener("close", function onClose() {
        ui.dialog.removeEventListener("close", onClose);
        resolve(ui.dialog.returnValue === "ok");
      });
      ui.dialog.showModal();
    });
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    try { return d.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return d.toLocaleString(); }
  }

  function pct(n) { return (Math.round(n * 10) / 10) + "%"; }

  /** POST an admin action with the session token; a 401 signs the user out. */
  function call(action, fields) {
    return Api.admin(action, Object.assign({ token: state.token }, fields || {})).then(function (res) {
      if (res && res.ok === false && res.code === "UNAUTHORIZED") {
        signOut("انتهت الجلسة، سجّل الدخول مرة أخرى.");
        throw HANDLED;
      }
      return res;
    });
  }

  function fail(err) {
    if (err === HANDLED) return;
    toast((err && err.message) || "حدث خطأ غير متوقع", true);
  }

  /* ================================================================ login */

  function showLogin(message) {
    clearTimeout(state.timer);
    ui.loginView.hidden = false;
    ui.dashView.hidden = true;
    ui.logoutBtn.hidden = true;
    ui.statusPill.hidden = true;
    ui.loginError.textContent = message || "";
    ui.password.value = "";
    (ui.email.value ? ui.password : ui.email).focus();
  }

  function onLogin(ev) {
    ev.preventDefault();
    var email = ui.email.value.trim();
    var password = ui.password.value;
    if (!email || !password) {
      ui.loginError.textContent = "أدخل البريد الإلكتروني وكلمة المرور.";
      return;
    }
    ui.loginBtn.disabled = true;
    ui.loginError.textContent = "";
    Api.admin("admin_login", { email: email, password: password }).then(function (res) {
      ui.loginBtn.disabled = false;
      if (!res || res.ok !== true || !res.token) {
        ui.loginError.textContent = (res && res.message) || "تعذّر تسجيل الدخول.";
        ui.password.value = "";
        return;
      }
      state.token = res.token;
      try { sessionStorage.setItem(TOKEN_KEY, res.token); } catch (e) { /* ignore */ }
      ui.password.value = "";
      enterDashboard();
    }, function (err) {
      ui.loginBtn.disabled = false;
      ui.loginError.textContent = (err && err.message) || "تعذّر الاتصال بالخادم.";
    });
  }

  function signOut(message, callServer) {
    if (callServer && state.token) Api.admin("admin_logout", { token: state.token }).catch(function () {});
    state.token = null;
    state.view = null;
    state.dirty = false;
    state.lastFinal = null;
    state.finalDismissed = false;
    ui.finalCard.hidden = true;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    showLogin(message);
  }

  function enterDashboard() {
    ui.loginView.hidden = true;
    ui.dashView.hidden = false;
    ui.logoutBtn.hidden = false;
    refresh(true);
  }

  /* ============================================================ refreshing */

  function refresh(loud) {
    clearTimeout(state.timer);
    return call("admin_results").then(function (res) {
      if (!res || res.ok !== true) {
        if (loud) toast((res && res.message) || "تعذّر تحديث البيانات", true);
        return scheduleRefresh();
      }
      applyView(res);
      if (res.status !== "ACTIVE" && !state.lastFinal && !state.finalDismissed) recoverLastResult();
    }).catch(function (err) {
      if (err !== HANDLED) {
        if (loud) fail(err);
        scheduleRefresh();
      }
    });
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    if (!state.token || !state.view || state.view.status !== "ACTIVE") return;
    state.timer = setTimeout(function () {
      if (document.visibilityState === "visible") refresh(false);
      else scheduleRefresh();
    }, REFRESH_MS);
  }

  function recoverLastResult() {
    call("admin_last_result").then(function (res) {
      if (res && res.ok && res.final && !state.finalDismissed) {
        state.lastFinal = res.final;
        renderFinal(res.final, { recovered: true });
      }
    }).catch(function () {});
  }

  function applyView(view) {
    state.view = view;

    // Server truth wins while a contest is live; otherwise keep unsaved edits.
    if (view.status === "ACTIVE" || !state.dirty) {
      state.model = {
        title: view.title || "",
        options: view.options.map(function (o) { return o.label; })
      };
      if (view.status === "ACTIVE") state.dirty = false;
      renderEditor();
    }
    renderStatus();
    renderLive();
    updateControls();
    scheduleRefresh();
  }

  /* ================================================================ render */

  function renderStatus() {
    var s = state.view.status;
    var map = { IDLE: ["لا توجد مسابقة نشطة", ""], ACTIVE: ["المسابقة جارية", "active"], ENDED: ["انتهت المسابقة", "ended"] };
    ui.statusPill.hidden = false;
    ui.statusPill.textContent = map[s][0];
    ui.statusPill.className = "pill " + map[s][1];
  }

  function isLive() { return state.view && state.view.status === "ACTIVE"; }

  function renderEditor() {
    ui.titleInput.value = state.model.title;
    updateCount();
    renderOptions();

    var s = state.view && state.view.status;
    ui.lockedNote.hidden = s !== "ACTIVE" && s !== "ENDED";
    if (s === "ACTIVE") ui.lockedNote.textContent = "المسابقة جارية: السؤال والاختيارات مقفلة حتى تنتهي.";
    if (s === "ENDED") ui.lockedNote.textContent = "انتهت المسابقة لكن الجدول لم يُفرَّغ بعد. اضغط «مسح المسودة» لتهيئته.";
  }

  function updateCount() {
    ui.titleCount.textContent = ui.titleInput.value.length + " / " + LIM.title;
  }

  function renderOptions(focusIndex, role) {
    var locked = isLive();
    ui.optList.textContent = "";
    state.model.options.forEach(function (value, i) {
      var input = el("input", {
        class: "input", maxlength: String(LIM.label), autocomplete: "off",
        "aria-label": "نص الاختيار " + (i + 1), placeholder: "الاختيار " + (i + 1)
      });
      input.value = value;
      input.disabled = locked;
      input.addEventListener("input", function () {
        state.model.options[i] = input.value;
        state.dirty = true;
      });

      var up = toolButton("up", "تحريك للأعلى (إعادة ترتيب)", locked || i === 0, function () { moveOption(i, -1); });
      var down = toolButton("down", "تحريك للأسفل (إعادة ترتيب)", locked || i === state.model.options.length - 1, function () { moveOption(i, 1); });
      var del = toolButton("trash", "حذف", locked, function () { removeOption(i); });
      del.classList.add("del");
      up.setAttribute("data-role", "up");
      down.setAttribute("data-role", "down");

      ui.optList.appendChild(el("li", { class: "opt-row" }, [input, el("div", { class: "opt-tools" }, [up, down, del])]));
    });
    ui.addOptBtn.hidden = locked;

    if (typeof focusIndex === "number") {
      // Keep keyboard focus on the row that moved, on the same arrow if it is still enabled.
      var row = ui.optList.children[focusIndex];
      var target = row && (row.querySelector("[data-role='" + role + "']:not(:disabled)") ||
                           row.querySelector("[data-role]:not(:disabled)") || row.querySelector("input"));
      if (target) target.focus();
    }
  }

  function toolButton(name, label, disabled, onClick) {
    var b = el("button", { type: "button", class: "icon-btn", "aria-label": label, title: label }, [icon(name)]);
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderBars(container, rows, opts) {
    container.textContent = "";
    var max = 0;
    rows.forEach(function (r) { if (r.votes > max) max = r.votes; });
    rows.forEach(function (r) {
      var isTop = max > 0 && r.votes === max;
      var head = el("div", { class: "result-head" }, [
        el("span", { class: "name", text: r.label }),
        el("span", { class: "meta", text: r.votes + " · " + pct(r.percent) })
      ]);
      var fill = el("i");
      fill.style.width = Math.max(0, Math.min(100, r.percent)) + "%";
      var bar = el("div", { class: "bar", role: "img", "aria-label": r.label + ": " + r.votes + " (" + pct(r.percent) + ")" }, [fill]);
      container.appendChild(el("li", { class: "result" + (isTop && (opts && opts.markTop) ? " top" : "") }, [head, bar]));
    });
  }

  function renderLive() {
    var v = state.view;
    ui.liveBody.textContent = "";
    if (v.status === "IDLE" || v.options.length === 0 || !v.contestId) {
      ui.liveSub.textContent = "تظهر لك وحدك ولا تُعرض للزوار.";
      ui.liveBody.appendChild(el("p", { class: "empty", text: "لا توجد مسابقة نشطة. ابدأ مسابقة لتظهر نتائجها الخاصة هنا." }));
      return;
    }
    var started = formatDate(v.startedAt);
    ui.liveSub.textContent = started ? "بدأت المسابقة: " + started : "تظهر لك وحدك ولا تُعرض للزوار.";

    ui.liveBody.appendChild(el("div", { class: "total" }, [
      el("strong", { text: String(v.totalVotes) }),
      el("span", { text: "إجمالي الأصوات" })
    ]));
    var list = el("ul", { class: "results" });
    renderBars(list, v.options, { markTop: true });
    ui.liveBody.appendChild(list);
  }

  function updateControls() {
    var live = isLive();
    var idle = !live;
    ui.saveBtn.disabled = state.busy || live;
    ui.startBtn.disabled = state.busy || live;
    ui.clearBtn.disabled = state.busy || live;
    ui.addOptBtn.disabled = state.busy || live || state.model.options.length >= LIM.max;
    ui.endBtn.disabled = state.busy || idle && !(state.view && state.view.status === "ENDED");
    ui.endBtn.hidden = idle && !(state.view && state.view.status === "ENDED");
    ui.refreshBtn.disabled = state.busy;
    ui.titleInput.disabled = live;
  }

  function setBusy(v) { state.busy = v; if (state.view) updateControls(); }

  /* ================================================================ editing */

  function addOption() {
    if (state.model.options.length >= LIM.max) return;
    state.model.options.push("");
    state.dirty = true;
    renderOptions();
    var inputs = ui.optList.querySelectorAll("input");
    if (inputs.length) inputs[inputs.length - 1].focus();
    updateControls();
  }

  function removeOption(i) {
    state.model.options.splice(i, 1);
    state.dirty = true;
    renderOptions();
    var inputs = ui.optList.querySelectorAll("input");
    (inputs[Math.max(0, i - 1)] || ui.addOptBtn).focus();
    updateControls();
  }

  function moveOption(i, dir) {
    var o = state.model.options;
    var j = i + dir;
    if (j < 0 || j >= o.length) return;
    var t = o[i]; o[i] = o[j]; o[j] = t;
    state.dirty = true;
    renderOptions(j, dir < 0 ? "up" : "down");
  }

  /** Mirrors the server rules so mistakes are caught before a request is made. */
  function validate(strict) {
    var title = state.model.title.replace(/\s+/g, " ").trim();
    var labels = state.model.options.map(function (s) { return s.replace(/\s+/g, " ").trim(); });
    if (strict && !title) return "السؤال مطلوب.";
    if (title.length > LIM.title) return "السؤال أطول من " + LIM.title + " حرفًا.";
    if (strict && labels.length < LIM.min) return "أضف اختيارين على الأقل.";
    if (labels.length > LIM.max) return "الحد الأقصى " + LIM.max + " اختيارًا.";
    var seen = {};
    for (var i = 0; i < labels.length; i++) {
      if (!labels[i]) return "الاختيار " + (i + 1) + " فارغ.";
      if (labels[i].length > LIM.label) return "الاختيار " + (i + 1) + " أطول من " + LIM.label + " حرفًا.";
      var k = labels[i].toLowerCase();
      if (seen[k]) return "الاختيار «" + labels[i] + "» مكرر.";
      seen[k] = true;
    }
    return "";
  }

  function payload() {
    return {
      title: state.model.title,
      options: state.model.options
    };
  }

  /* ================================================================ actions */

  function onSave() {
    var err = validate(false);
    ui.editorError.textContent = err;
    if (err) return;
    setBusy(true);
    call("admin_save_options", payload()).then(function (res) {
      if (!res || res.ok !== true) { ui.editorError.textContent = (res && res.message) || "تعذّر الحفظ."; return; }
      state.dirty = false;
      applyView(res);
      toast("تم حفظ المسودة");
    }).catch(fail).then(function () { setBusy(false); });
  }

  function onStart() {
    var err = validate(true);
    ui.editorError.textContent = err;
    if (err) return;
    var items = state.model.options.map(function (s) { return s.replace(/\s+/g, " ").trim(); });
    confirmDialog({
      title: "بدء المسابقة؟",
      body: "«" + state.model.title.replace(/\s+/g, " ").trim() + "» — بعد البدء لا يمكن تعديل الاختيارات، وسيبدأ العدّ من الصفر.",
      items: items,
      confirmLabel: "بدء المسابقة"
    }).then(function (ok) {
      if (!ok) return;
      setBusy(true);
      return call("admin_start", payload()).then(function (res) {
        if (!res || res.ok !== true) { ui.editorError.textContent = (res && res.message) || "تعذّر بدء المسابقة."; return; }
        state.dirty = false;
        state.lastFinal = null;
        state.finalDismissed = true;
        ui.finalCard.hidden = true;
        applyView(res);
        toast("بدأت المسابقة");
      }).catch(fail).then(function () { setBusy(false); });
    });
  }

  function onEnd() {
    if (!state.view || state.view.status === "IDLE") return;
    var contestId = state.view.contestId;
    confirmDialog({
      title: "إنهاء المسابقة؟",
      body: "سيُغلق التصويت فورًا وتظهر لك النتيجة النهائية، ثم يُفرَّغ الجدول للمسابقة التالية. لا يمكن التراجع.",
      confirmLabel: "إنهاء المسابقة",
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      setBusy(true);
      return call("admin_end", { contestId: contestId }).then(function (res) {
        if (!res || res.ok !== true) {
          toast((res && res.message) || "تعذّر إنهاء المسابقة", true);
          return refresh(false);
        }
        state.lastFinal = res.final;
        state.finalDismissed = false;
        state.dirty = false;
        renderFinal(res.final, { resetOk: res.resetOk });
        return refresh(false);
      }).catch(function (err) {
        fail(err);
        if (err !== HANDLED) refresh(false);   // the end may have succeeded even though the reply was lost
      }).then(function () { setBusy(false); });
    });
  }

  function onClear() {
    confirmDialog({
      title: "مسح المسودة؟",
      body: "سيُحذف السؤال والاختيارات المحفوظة ويُترك الجدول فارغًا.",
      confirmLabel: "مسح",
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      setBusy(true);
      return call("admin_reset").then(function (res) {
        if (!res || res.ok !== true) { toast((res && res.message) || "تعذّر المسح", true); return; }
        state.dirty = false;
        applyView(res);
        toast("تم تفريغ الجدول");
      }).catch(fail).then(function () { setBusy(false); });
    });
  }

  /* ============================================================ final result */

  function renderFinal(f, opts) {
    opts = opts || {};
    ui.finalCard.hidden = false;
    ui.finalBadge.hidden = !opts.recovered;
    ui.finalQuestion.textContent = f.title;
    ui.finalTotal.textContent = String(f.totalVotes);

    var warnings = [];
    if (opts.resetOk === false) warnings.push("تعذّر تفريغ الجدول تلقائيًا. اضغط «مسح المسودة» لتهيئته.");
    if (f.consistent === false) warnings.push("تنبيه: عدّادات الاختيارات لا تطابق سجل المصوّتين تمامًا. راجع الجدول قبل تفريغه.");
    ui.finalWarn.hidden = warnings.length === 0;
    ui.finalWarn.textContent = warnings.join(" ");

    var winners = f.options.filter(function (o) { return (f.winnerIds || []).indexOf(o.id) !== -1; });
    ui.finalWinner.textContent = "";
    if (winners.length === 1) {
      ui.finalWinner.appendChild(document.createTextNode("الأعلى أصواتًا: "));
      ui.finalWinner.appendChild(el("b", { text: winners[0].label }));
    } else if (winners.length > 1) {
      ui.finalWinner.appendChild(document.createTextNode("تعادل بين: "));
      ui.finalWinner.appendChild(el("b", { text: winners.map(function (w) { return w.label; }).join(" و ") }));
    } else {
      ui.finalWinner.textContent = "لم يُسجَّل أي صوت.";
    }

    renderBars(ui.finalResults, f.options, { markTop: true });
    ui.finalCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function copyFinal() {
    var f = state.lastFinal;
    if (!f) return;
    var lines = ["النتيجة النهائية: " + f.title, "إجمالي الأصوات: " + f.totalVotes];
    f.options.forEach(function (o) { lines.push(o.rank + ". " + o.label + " — " + o.votes + " (" + pct(o.percent) + ")"); });
    var text = lines.join("\n");
    var done = function () { toast("تم نسخ النتيجة"); };
    var fallback = function () {
      var ta = el("textarea", { "aria-hidden": "true" });
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("تعذّر النسخ", true); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
})();
