/*
 * common.js — small helpers shared by the public page and the admin panel.
 * Everything here is UI-agnostic: safe storage, DOM building, SVG icons, non-blocking fonts.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var FONT_URL = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";

  /**
   * localStorage / sessionStorage can throw (private mode, blocked cookies). This returns an
   * object with the same three methods that never throws and falls back to memory.
   * @param {"local"|"session"} kind
   */
  function storage(kind) {
    try {
      var s = kind === "session" ? window.sessionStorage : window.localStorage;
      s.setItem("__probe", "1");
      s.removeItem("__probe");
      return s;
    } catch (e) {
      var memory = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
        setItem: function (k, v) { memory[k] = String(v); },
        removeItem: function (k) { delete memory[k]; }
      };
    }
  }

  /**
   * Build an element. Text always goes through textContent, never innerHTML.
   * @param {string} tag
   * @param {Object=} attrs  "class" → className, "text" → textContent, anything else → attribute
   * @param {Node[]=} kids
   */
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

  /** A 24×24 stroke icon made of one SVG path. */
  function svgIcon(pathData, strokeWidth) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(strokeWidth || 2));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  /**
   * Load the web font WITHOUT blocking the first paint. A <link rel="stylesheet"> in <head> stops
   * the whole page from rendering until Google Fonts answers, which is slow on weak mobile
   * networks. The page renders immediately with the system Arabic font and swaps when ready.
   */
  function loadFonts() {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONT_URL;
    document.head.appendChild(link);
  }

  window.Common = { storage: storage, el: el, svgIcon: svgIcon, loadFonts: loadFonts };
})();
