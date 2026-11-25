/*
 * Automation Executor e1
 * ------------------------------------------------------------
 * Replaces the fill / click JavaScript that used to be built inside AutomationEngine.kt.
 * Loaded from assets/automation/automation_executor.js, injected into the page by the engine,
 * and ALSO registered as a document-start script so it exists inside iframes.
 *
 *   window.__ddgExec.run(kind, params, frameHost)  ->  Promise<JSON string>
 *       kind = "fill" | "click" | "verify"
 *       frameHost = ""            run in this frame
 *       frameHost = "example.com" run inside the child frame whose hostname is example.com
 *
 * What is new compared with the code that lived in Kotlin:
 *   - native <select>: options are matched on label / text / value (an <option label="Malaysia"> with no text works),
 *     accents and zero-width characters are ignored, other <select>s are searched when the recorded one has no match,
 *     and the error lists the first options so a mismatch is visible
 *   - <input type=date | datetime-local | month>: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, "15 Aug 1999", "1999" are converted
 *     to what the browser accepts (the old code wrote the raw text and the value never stuck)
 *   - text inputs for a date of birth follow the placeholder format (dd/mm/yyyy, mm-dd-yyyy, ...)
 *   - masked inputs (phone numbers) count as filled when the digits match
 *   - custom dropdowns: rows are ranked (exact > same dial code > partial) and a container holding many rows can never win
 *   - after a synthetic click the selection is verified; if the page ignored it the result carries "native" coordinates so
 *     the engine can send a REAL touch (trusted event) and then call verify
 *   - open shadow roots are searched
 *   - fields inside cross-origin iframes are reached through postMessage (no eval, so page CSP does not matter)
 */
(function () {
  "use strict";
  var g = globalThis;
  if (g.__ddgExec) return;

  var IS_TOP = true;
  try { IS_TOP = window.top === window; } catch (_) { IS_TOP = false; }

  var ELEMENT_WAIT_MS = 15000;
  var FRAME_TIMEOUT_MS = 30000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function J(o) { try { return JSON.stringify(o); } catch (_) { return '{"ok":false,"err":"result not serializable"}'; } }
  function lower(s) { return String(s || "").toLowerCase(); }
  function frameKey() { try { return location.hostname || location.protocol; } catch (_) { return ""; } }

  // ------------------------------------------------------------------ text helpers
  function text(el) {
    return String(el && (el.innerText || el.textContent || el.value) || "").replace(/\s+/g, " ").trim();
  }
  // lower-case, accents removed, zero-width characters removed, whitespace collapsed
  function canon(s) {
    var t = String(s == null ? "" : s);
    try { t = t.normalize("NFKD"); } catch (_) {}
    return t.replace(/[̀-ͯ​-‏⁠﻿]/g, "").toLowerCase().replace(/[\s ]+/g, " ").trim();
  }
  // Digits of an option label that can be a dial code: "+853", "中国澳门 853", "India (+91)". More than 2 numbers means
  // the element is a container of many rows, never a single option.
  function numbersOf(s) { return String(s || "").match(/\d+/g) || []; }
  function codeOf(s) { var m = numbersOf(s); return m.length && m.length <= 2 ? m[m.length - 1] : ""; }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    try {
      var w = el.ownerDocument.defaultView, st = w.getComputedStyle(el), r = el.getBoundingClientRect();
      return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0 && r.width > 0 && r.height > 0;
    } catch (_) { return false; }
  }

  // querySelectorAll that also walks open shadow roots
  function deepAll(selector, root, out, depth) {
    root = root || document; out = out || []; depth = depth || 0;
    try { var list = root.querySelectorAll(selector); for (var i = 0; i < list.length; i++) out.push(list[i]); } catch (_) {}
    if (depth >= 3) return out;
    var all;
    try { all = root.querySelectorAll("*"); } catch (_) { return out; }
    var n = Math.min(all.length, 6000);
    for (var k = 0; k < n; k++) { if (all[k].shadowRoot) deepAll(selector, all[k].shadowRoot, out, depth + 1); }
    return out;
  }

  function dispatch(el, type) {
    var w = el.ownerDocument.defaultView;
    el.dispatchEvent(new w.Event(type, { bubbles: true, composed: true }));
  }

  // ------------------------------------------------------------------ synthetic click
  function synthClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) {}
    try {
      var w = el.ownerDocument.defaultView, r = el.getBoundingClientRect();
      var base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: w };
      function ev(Ctor, type, extra) { try { el.dispatchEvent(new w[Ctor](type, Object.assign({}, base, extra || {}))); } catch (_) {} }
      ev("PointerEvent", "pointerdown", { pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 });
      ev("MouseEvent", "mousedown", { buttons: 1 });
      ev("PointerEvent", "pointerup", { pointerId: 1, pointerType: "mouse", isPrimary: true });
      ev("MouseEvent", "mouseup");
    } catch (_) {}
    try { el.click(); return true; } catch (_) { return false; }
  }

  // ------------------------------------------------------------------ finding the recorded element
  var FIELD_SEL = "input:not([type=hidden]),textarea,select,button,[role=combobox],[aria-haspopup],.choose_value,#selectedCountry,.hwid-selectedCountryName,[id*=selectedCountry]";
  var CUSTOM_SEL = "button,[role=combobox],[aria-haspopup],.choose_value,[data-type=fydeos_select],#selectedCountry,.hwid-selectedCountryName,[id*=selectedCountry]";

  // The "+91 v" opener of a phone field: a small element whose whole text is a dial code, next to a phone input.
  function findDialTrigger() {
    var cands = deepAll("button,[role=button],[role=combobox],[aria-haspopup],div,span,a,p,label").filter(function (e) {
      if (!visible(e)) return false;
      var t = text(e).replace(/\s+/g, "");
      if (!/^\+\d{1,4}$/.test(t)) return false;
      var r = e.getBoundingClientRect();
      return r.width < 260 && r.height < 120;
    });
    if (!cands.length) return null;
    function nearPhone(e) {
      var n = e.parentElement;
      for (var d = 0; n && d < 5; d++, n = n.parentElement) {
        if (n.querySelector("input[type=tel],input[autocomplete^=tel],input[name*=phone i],input[name*=mobile i],input[placeholder*=phone i],input[placeholder*=mobile i]")) return true;
      }
      return false;
    }
    var near = cands.filter(nearPhone);
    var pool = near.length ? near : cands;
    // innermost element holding the dial code, then climb to something clickable
    var best = pool[pool.length - 1];
    for (var i = 0; i < pool.length; i++) { if (!pool.some(function (o) { return o !== pool[i] && pool[i].contains(o); })) { best = pool[i]; break; } }
    return best.closest("button,[role=button],[role=combobox],[aria-haspopup]") || best;
  }
  function checkLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = lower(el.type), r = lower(el.getAttribute("role"));
    return t === "checkbox" || t === "radio" || r === "checkbox" || r === "switch" || r === "radio";
  }
  // a custom-styled checkbox hides the real <input> (opacity 0 / 1px): its label or wrapper is what is on screen
  function visibleLoose(el) {
    if (visible(el)) return true;
    if (!checkLike(el) || !el.isConnected) return false;
    var labs = el.labels ? Array.prototype.slice.call(el.labels) : [];
    return labs.some(visible) || visible(el.parentElement) || (el.parentElement && visible(el.parentElement.parentElement));
  }
  function isChecked(el) {
    if (typeof el.checked === "boolean" && lower(el.tagName) === "input") return el.checked;
    var a = el.getAttribute("aria-checked");
    return a === "true";
  }
  async function setChecked(el, want, p) {
    if (isChecked(el) === want) return { ok: true, via: "already set" };
    var targets = [el];
    if (el.labels && el.labels[0]) targets.push(el.labels[0]);
    if (el.parentElement) targets.push(el.parentElement);
    for (var i = 0; i < targets.length; i++) {
      try { if (i === 0 && lower(el.tagName) === "input") el.click(); else synthClick(targets[i]); } catch (_) {}
      await sleep(300);
      if (isChecked(el) === want) return { ok: true };
    }
    // the page ignores dispatched clicks: ask the engine for a real tap on the visible box
    var vis = [el.labels && el.labels[0], el.parentElement, el].filter(function (x) { return x && visible(x); })[0] || el;
    g.__ddgPick = { check: el, want: want, label: "checkbox" };
    return { ok: false, err: "the checkbox did not change", native: nativeInfo(vis), stage: "option" };
  }
  function findElement(p) {
    var tries = [
      function () { return p.id ? document.getElementById(p.id) : null; },
      function () { return p.css ? document.querySelector(p.css) : null; },
      function () { return p.xpath ? document.evaluate(p.xpath, document, null, 9, null).singleNodeValue : null; },
      function () { return p.name ? document.getElementsByName(p.name)[0] : null; }
    ];
    for (var i = 0; i < tries.length; i++) {
      try { var el = tries[i](); if (visibleLoose(el)) return el; } catch (_) {}
    }
    var all = deepAll(FIELD_SEL).filter(visible);
    if (p.fieldType === "countrycode") {
      var cc = findDialTrigger();
      if (cc) return cc;
    }
    var hints = (p.hints || []).map(lower);
    for (var h = 0; h < hints.length; h++) {
      if (!hints[h]) continue;
      for (var k = 0; k < all.length; k++) {
        var e = all[k];
        var hay = lower((e.name || "") + " " + (e.id || "") + " " + (e.getAttribute("placeholder") || "") + " " + (e.getAttribute("aria-label") || "") + " " + text(e));
        if (hay.indexOf(hints[h]) >= 0) return e;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ dates
  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function pad(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
  function ymd(y, m, d) {
    y = +y; m = +m; d = +d;
    if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d };
  }
  // returns {y,m,d} or null. A bare year becomes 1 January of that year.
  // two-digit year: 09 -> 2009, 99 -> 1999 (anything not in the future is taken as 20xx)
  function fullYear(yy) { return yy <= (new Date().getFullYear() % 100) ? 2000 + yy : 1900 + yy; }
  function parseDate(s) {
    s = String(s || "").trim();
    var m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))) return ymd(m[1], m[2], m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/))) {
      var a = +m[1], b = +m[2];
      if (a > 12) return ymd(m[3], b, a);       // 25/12/1999
      if (b > 12) return ymd(m[3], a, b);       // 12/25/1999
      return ymd(m[3], b, a);                   // ambiguous: day first (same assumption the scanner made)
    }
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ymd(m[1], m[2], m[3]);
    // 12/07/09 (two-digit year) and 12/may/2001, 12-May-01, 12 May 01 (month as a word, any separator)
    if ((m = s.match(/^(\d{1,2})\s*[-\/. ]\s*(\d{1,2}|[A-Za-z]{3,9})\.?\s*[-\/. ,]\s*(\d{2}|\d{4})$/))) {
      var yy = m[3].length === 2 ? fullYear(+m[3]) : +m[3];
      if (/^[A-Za-z]/.test(m[2])) {
        var im = MONTHS.indexOf(lower(m[2]).slice(0, 3));
        return im >= 0 ? ymd(yy, im + 1, m[1]) : null;
      }
      var da = +m[1], mb = +m[2];
      if (da > 12) return ymd(yy, mb, da);
      if (mb > 12) return ymd(yy, da, mb);
      return ymd(yy, mb, da);                   // day first
    }
    if ((m = s.match(/^(\d{4})\s*[-\/. ]\s*([A-Za-z]{3,9})\.?\s*[-\/. ]\s*(\d{1,2})$/))) {
      var iy = MONTHS.indexOf(lower(m[2]).slice(0, 3)); return iy >= 0 ? ymd(m[1], iy + 1, m[3]) : null;
    }
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
      var i1 = MONTHS.indexOf(lower(m[2]).slice(0, 3)); return i1 >= 0 ? ymd(m[3], i1 + 1, m[1]) : null;
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
      var i2 = MONTHS.indexOf(lower(m[1]).slice(0, 3)); return i2 >= 0 ? ymd(m[3], i2 + 1, m[2]) : null;
    }
    if (/^\d{4}$/.test(s)) return ymd(s, 1, 1);
    return null;
  }
  // Format a parsed date for a text box that shows its expected pattern in the placeholder (dd/mm/yyyy ...).
  function formatForPlaceholder(d, placeholder) {
    var ph = lower(placeholder);
    var m = ph.match(/(d{1,2}|m{1,2}|y{2,4})\s*([\/\-.])\s*(d{1,2}|m{1,2}|y{2,4})\s*[\/\-.]\s*(d{1,2}|m{1,2}|y{2,4})/);
    if (!m) return null;
    var parts = [m[1], m[3], m[4]], sep = m[2], out = [];
    for (var i = 0; i < 3; i++) {
      var t = parts[i][0];
      if (t === "d") out.push(parts[i].length === 2 ? pad(d.d) : String(d.d));
      else if (t === "m") out.push(parts[i].length === 2 ? pad(d.m) : String(d.m));
      else out.push(parts[i].length === 4 ? String(d.y) : String(d.y).slice(-2));
    }
    return out.join(sep);
  }

  // ------------------------------------------------------------------ comparing what the page shows with what we wanted
  // For masked inputs: "(987) 654-3210" is the same number as "9876543210".
  function sameEntered(actual, wanted) {
    if (actual === wanted) return true;
    var a = canon(actual), w = canon(wanted);
    if (a === w) return true;
    var da = String(actual).replace(/\D/g, ""), dw = String(wanted).replace(/\D/g, "");
    return dw.length >= 4 && da === dw;
  }
  function valueMatches(cur, p, loose) {
    var c = canon(cur), w = canon(p.wanted);
    if (!c || !w) return false;
    if (p.fieldType === "countrycode") { var wd = w.replace(/\D/g, ""); return !!wd && (codeOf(c) === wd || numbersOf(c).indexOf(wd) >= 0 && numbersOf(c).length <= 2); }
    if (c === w) return true;
    return !!loose && (c.indexOf(w) >= 0 || (c.length >= 3 && w.indexOf(c) >= 0));
  }

  // ------------------------------------------------------------------ date parts (month / day / year lists)
  // p.fieldType dobmonth|dobday|dobyear -> {kind, n}; accepts a full date, a month name, or a number.
  function datePart(p) {
    var ft = p.fieldType, w = String(p.wanted == null ? "" : p.wanted).trim();
    if (ft !== "dobmonth" && ft !== "dobday" && ft !== "dobyear") return null;
    var kind = ft === "dobmonth" ? "m" : ft === "dobday" ? "d" : "y";
    var full = parseDate(w);
    if (full && !/^\d{4}$/.test(w)) return { kind: kind, n: kind === "m" ? full.m : kind === "d" ? full.d : full.y };
    var mi = MONTHS.indexOf(lower(w).slice(0, 3));
    if (kind === "m" && mi >= 0 && /^[a-z]/i.test(w)) return { kind: kind, n: mi + 1 };
    var num = parseInt(w.replace(/\D/g, ""), 10);
    if (!(num >= 0)) return null;
    if (kind === "y" && num < 100) num += num > 30 ? 1900 : 2000;
    return { kind: kind, n: num };
  }
  // does one option string (already canonical) stand for this date part?
  function datePartMatches(str, dp) {
    str = lower(str).trim();
    if (!str) return false;
    if (dp.kind === "m") {
      var mi = MONTHS.indexOf(str.slice(0, 3));
      if (mi >= 0 && /^[a-z]/.test(str)) return mi + 1 === dp.n;
      if (/^0?\d{1,2}$/.test(str)) return +str === dp.n;
      return false;
    }
    if (dp.kind === "d") return /^0?\d{1,2}(st|nd|rd|th)?$/.test(str) && parseInt(str, 10) === dp.n;
    return /^\d{2,4}$/.test(str) && (str.length === 4 ? +str === dp.n : (+str % 100) === (dp.n % 100));
  }

  // ------------------------------------------------------------------ native <select>
  function optStrings(o) {
    var a = [o.label, o.text, o.textContent, o.value, o.getAttribute("data-name"), o.getAttribute("aria-label")];
    var out = [];
    for (var i = 0; i < a.length; i++) { var c = canon(a[i]); if (c && out.indexOf(c) < 0) out.push(c); }
    return out;
  }
  // 0 exact, 1 starts with, 2 contains, -1 none
  function selectTier(o, p) {
    var strs = optStrings(o), target = canon(p.wanted), best = -1;
    var dp = datePart(p);
    if (dp) {
      for (var j = 0; j < strs.length; j++) if (datePartMatches(strs[j], dp)) return 0;
      return -1;
    }
    if (!target) return -1;
    var wd = target.replace(/\D/g, "");
    for (var i = 0; i < strs.length; i++) {
      var s = strs[i], t = -1;
      if (s === target) t = 0;
      else if (p.fieldType === "countrycode" && wd && codeOf(s) === wd) t = 1;
      else if (s.indexOf(target) === 0) t = 1;
      else if (s.indexOf(target) >= 0) t = 2;
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }
  function bestOption(sel, p) {
    var best = null, bt = 9, opts = sel.options;
    for (var i = 0; i < opts.length; i++) {
      var t = selectTier(opts[i], p);
      if (t >= 0 && t < bt) { best = opts[i]; bt = t; if (t === 0) break; }
    }
    return best ? { opt: best, tier: bt } : null;
  }
  function selectOptionSample(sel) {
    var out = [], n = Math.min(sel.options.length, 6);
    for (var i = 0; i < n; i++) out.push(String(sel.options[i].label || sel.options[i].text || sel.options[i].value).slice(0, 18));
    return "options(" + sel.options.length + "): " + out.join(" | ");
  }
  function setNativeSelect(sel, opt) {
    var w = sel.ownerDocument.defaultView;
    try { opt.selected = true; } catch (_) {}
    try {
      var d = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value");
      if (d && d.set) d.set.call(sel, opt.value); else sel.value = opt.value;
    } catch (_) { try { sel.value = opt.value; } catch (_) {} }
    dispatch(sel, "input"); dispatch(sel, "change");
    return sel.selectedIndex === opt.index;
  }
  function fillSelect(el, p) {
    var hit = bestOption(el, p), via = "recorded select";
    if (!hit && !datePart(p)) {
      // The recorded select may be a different one than the page uses now: look for a select that has the option.
      var others = deepAll("select").filter(function (s) { return s !== el && s.options.length > 1 && visible(s); });
      var hints = (p.hints || []).map(lower).filter(Boolean);
      var bestSel = null, bestScore = -1;
      for (var i = 0; i < others.length; i++) {
        var h = bestOption(others[i], p);
        if (!h) continue;
        var hay = lower((others[i].name || "") + " " + (others[i].id || "") + " " + (others[i].getAttribute("aria-label") || ""));
        var score = 10 - h.tier;
        for (var k = 0; k < hints.length; k++) if (hints[k].length > 2 && hay.indexOf(hints[k]) >= 0) score += 5;
        if (score > bestScore) { bestScore = score; bestSel = { sel: others[i], hit: h }; }
      }
      if (bestSel) { el = bestSel.sel; hit = bestSel.hit; via = "other select"; }
    }
    if (!hit) return { ok: false, err: "no option matches " + p.wanted + " (" + selectOptionSample(el) + ")" };
    var ok = setNativeSelect(el, hit.opt);
    return ok ? { ok: true, via: via } : { ok: false, err: "select would not change to " + (hit.opt.label || hit.opt.text) };
  }

  // ------------------------------------------------------------------ custom dropdowns (div / li / span lists)
  var OPT_SEL = "[role=option],[role=menuitem],li,button,[data-value],[data-country],.dropdown-item,.country-item,.year-item,.MuiMenuItem-root,.ant-select-item-option,.hwid-country-item,.hwid-country-list li,div,span,a,p";

  function findOptions() {
    return deepAll(OPT_SEL).filter(function (o) {
      if (!visible(o)) return false;
      var t = text(o);
      return t.length > 0 && t.length <= 80;
    });
  }
  // 0 exact, 1 exact dial code, 2 partial; -1 no match
  function optionTier(el, p) {
    var label = canon(text(el));
    var val = canon(el.getAttribute("data-value") || el.getAttribute("data-country") || el.getAttribute("value") || "");
    var target = canon(p.wanted);
    var dp = datePart(p);
    if (dp) return (datePartMatches(label, dp) || (val && datePartMatches(val, dp))) ? 0 : -1;
    if (!target) return -1;
    if (label === target || val === target) return 0;
    if (p.fieldType === "countrycode") {
      var want = target.replace(/\D/g, "");
      if (!want) return -1;
      var nums = numbersOf(label);
      if (label === "+" + want) return 0;
      if (nums.length <= 3 && new RegExp("\\+\\s*" + want + "(?!\\d)").test(label)) return 1;
      if (nums.length >= 1 && nums.length <= 2 && (nums[nums.length - 1] === want || nums[0] === want)) return 2;
      if (val && codeOf(val) === want) return 1;
      return -1;
    }
    if (label.indexOf(target) >= 0 || (val && val.indexOf(target) >= 0)) return 2;
    return -1;
  }
  // best tier first, then the SHORTEST text: a row always beats the container that holds it
  function pickOption(opts, p) {
    var best = null, bt = 9, bl = 1e9;
    for (var i = 0; i < opts.length; i++) {
      var t = optionTier(opts[i], p);
      if (t < 0) continue;
      var len = text(opts[i]).length;
      if (t < bt || (t === bt && len < bl)) { best = opts[i]; bt = t; bl = len; }
    }
    return best;
  }
  // the element that really owns the click handler: row / li / pointer cursor, never a block holding many rows
  function rowOf(el) {
    var best = el, n = el;
    for (var i = 0; i < 4 && n.parentElement; i++) {
      n = n.parentElement;
      var t = text(n);
      if (t.length > 80 || numbersOf(t).length > 2) break;
      if (n.matches("li,[role=option],[role=menuitem],[data-value],[onclick],a,button")) { best = n; break; }
      try { if (n.ownerDocument.defaultView.getComputedStyle(n).cursor === "pointer") best = n; } catch (_) {}
    }
    return best;
  }
  function scrollParent(n) {
    for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      try {
        if (n.scrollHeight > n.clientHeight + 8 && /(auto|scroll)/.test(n.ownerDocument.defaultView.getComputedStyle(n).overflowY)) return n;
      } catch (_) {}
    }
    return null;
  }
  // the selection really happened if the list went away or the control now shows the wanted value
  function settled(p, found) {
    if (!found.isConnected || !visible(found)) return true;
    var live = findElement(p);
    return !!live && valueMatches(text(live) || live.value || "", p, true);
  }

  function nativeInfo(found, trigger, kind, label, p) {
    try { found.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) {}
    var rect = found.getBoundingClientRect();
    var vv = window.visualViewport;
    return {
      x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      dpr: window.devicePixelRatio || 1,
      vx: vv ? vv.offsetLeft : 0, vy: vv ? vv.offsetTop : 0, vs: vv ? vv.scale : 1
    };
  }

  // Look for the wanted option in the list that is open NOW (trigger may be null: list rendered elsewhere).
  async function findInOpenList(p, trigger) {
    function notTrigger(o) { return !trigger || (o !== trigger && !trigger.contains(o)); }
    var isYear = p.fieldType === "dobyear";
    function scan() {
      var opts = findOptions().filter(notTrigger);
      if (isYear || (trigger && trigger.matches && trigger.matches(".choose_value,[data-type=fydeos_select]"))) {
        opts = opts.concat(deepAll("li,button,[role=option],div,span").filter(function (n) { return visible(n) && /^\d{4}$/.test(text(n)) && notTrigger(n); }));
      }
      return opts;
    }
    var found = null, opts = [];
    for (var i = 0; i < 15 && !found; i++) {
      opts = scan();
      found = pickOption(opts, p);
      if (found) break;
      var sc = opts.length ? scrollParent(opts[opts.length - 1]) : null;
      if (!sc) break;
      var prevTop = sc.scrollTop;
      sc.scrollTop += Math.max(200, sc.clientHeight * 0.8);
      await sleep(200);
      if (sc.scrollTop === prevTop) break;
    }
    if (found) return found;
    // a search box inside the list: type the wanted value to filter it
    var boxes = deepAll("input").filter(function (x) {
      var t = lower(x.type || "text");
      return visible(x) && (t === "search" || t === "text" || t === "") && notTrigger(x) && x !== trigger &&
        /search|country|find|filter|code/.test(lower((x.placeholder || "") + " " + (x.getAttribute("aria-label") || "") + " " + (x.name || "")));
    });
    if (boxes.length) {
      var box = boxes[0], q = p.fieldType === "countrycode" ? String(p.wanted).replace(/\D/g, "") : String(p.wanted);
      try {
        var w = box.ownerDocument.defaultView;
        var d = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value");
        d.set.call(box, q); dispatch(box, "input"); dispatch(box, "change");
      } catch (_) {}
      for (var k = 0; k < 6 && !found; k++) { await sleep(300); found = pickOption(scan(), p); }
    }
    return found;
  }

  async function clickOption(found, trigger, p) {
    var tries = [], cand = [rowOf(found), found];
    cand.forEach(function (x) { if (x && tries.indexOf(x) < 0) tries.push(x); });
    for (var t = 0; t < tries.length; t++) {
      synthClick(tries[t]);
      await sleep(500);
      if (settled(p, found)) return { ok: true, via: "click" };
    }
    // The page ignored synthetic events. Hand the exact screen position to the engine so it can send a real touch.
    var n = nativeInfo(found);
    g.__ddgPick = { p: p, found: found, label: text(found).slice(0, 40) };
    return {
      ok: false,
      err: 'clicked option <' + lower(found.tagName) + '> "' + text(found).slice(0, 40) + '" but the page ignored it' + (trigger ? ' (trigger still "' + text(trigger).slice(0, 20) + '")' : ""),
      native: n, stage: "option"
    };
  }

  // "pick": choose from a list that is already open in THIS document (the list can live outside the frame of its trigger)
  async function pick(p) {
    var wanted = String(p.wanted || "");
    if (!wanted) return J({ ok: false, err: "no data value available for this field: " + p.fieldType });
    var found = await findInOpenList(p, null);
    if (!found) return J({ ok: false, err: "no matching option found: " + wanted });
    return J(await clickOption(found, null, p));
  }

  async function chooseCustom(el, p) {
    var wanted = String(p.wanted || "");
    if (!wanted) return { ok: false, err: "no data value available for this field: " + p.fieldType };
    var trigger = el;
    if (el.id === "selectedCountry" || el.matches(".hwid-selectedCountryName,[id*=selectedCountry]")) {
      trigger = el.closest("[role=button],button,[onclick],.hwid-countryWidthFix,.hwid-selectedCountryName") || el;
    }
    var before = text(trigger);
    if (valueMatches(before, p, false)) return { ok: true, via: "already set" };
    if (!p.skipOpen) {
      if (!synthClick(trigger)) return { ok: false, err: "custom select trigger could not be clicked" };
      await sleep(450);
    }
    var found = await findInOpenList(p, trigger);
    if (!found) {
      if (!p.skipOpen) {
        // The page may ignore synthetic clicks on the trigger (list never opened): ask the engine for a real tap on it.
        try { trigger.scrollIntoView({ block: "center", inline: "nearest" }); await sleep(150); } catch (_) {}
        return { ok: false, stage: "open", native: nativeInfo(trigger), err: "opened custom selector but no matching option found: " + wanted };
      }
      return { ok: false, err: "opened custom selector but no matching option found: " + wanted };
    }
    return await clickOption(found, trigger, p);
  }

  async function verify() {
    var pk = g.__ddgPick;
    if (!pk) return J({ ok: false, err: "nothing to verify" });
    await sleep(300);
    if (pk.check) return isChecked(pk.check) === pk.want ? J({ ok: true, via: "real tap" }) : J({ ok: false, err: "a real tap did not change the checkbox" });
    if (settled(pk.p, pk.found)) return J({ ok: true, via: "real tap" });
    var live = findElement(pk.p);
    return J({ ok: false, err: 'a real tap on "' + pk.label + '" did not change the field (it shows "' + (live ? text(live).slice(0, 20) : "?") + '")' });
  }

  // ------------------------------------------------------------------ fill
  async function fill(p) {
    var started = Date.now(), el = null;
    while (Date.now() - started < ELEMENT_WAIT_MS && !el) { el = findElement(p); if (!el) await sleep(250); }
    if (!el) return J({ ok: false, err: "field not found" });
    try {
      var tag = lower(el.tagName), type = lower(el.type), wanted = String(p.wanted == null ? "" : p.wanted);
      if (checkLike(el)) {
        // ticking a box (terms, newsletter...) needs no stored data
        var wantTick = !/^(false|0|no|off|untick|uncheck)$/i.test(wanted.trim());
        return J(await setChecked(el, wantTick, p));
      }
      var isNative = tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
      var isCustom = !isNative || el.matches(CUSTOM_SEL);
      if (isCustom) return J(await chooseCustom(el, p));
      if (!wanted) return J({ ok: false, err: "no data value available for this field: " + p.fieldType });

      if (type === "checkbox" || type === "radio") {
        var want = !/^(false|0|no|off)$/i.test(wanted.trim());
        if (el.checked !== want) el.click();
        return J({ ok: el.checked === want, err: "checkbox did not change" });
      }
      if (tag === "select") return J(fillSelect(el, p));
      if (tag !== "input" && tag !== "textarea") {
        if (el.isContentEditable) { el.textContent = wanted; dispatch(el, "input"); return J({ ok: true }); }
        return J({ ok: false, err: "unsupported field element " + tag });
      }

      var win = el.ownerDocument.defaultView;
      var proto = tag === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value"), setter = desc && desc.set;
      if (!setter) return J({ ok: false, err: "native value setter unavailable" });
      function setValue(v) { setter.call(el, v); }

      var isDob = /^dob/.test(p.fieldType);
      var value = wanted;
      if (type === "date" || type === "datetime-local" || type === "month") {
        var d = parseDate(wanted);
        if (!d) return J({ ok: false, err: 'cannot read "' + wanted + '" as a date (use DD/MM/YYYY, YYYY-MM-DD or 15 Aug 1999)' });
        value = d.y + "-" + pad(d.m) + "-" + pad(d.d);
        if (type === "datetime-local") value += "T00:00";
        if (type === "month") value = d.y + "-" + pad(d.m);
      } else if (datePart(p)) {
        // a single month/day/year text box: write just that part
        var dpt = datePart(p);
        var padTo = el.maxLength === 2 || /^(mm|dd)$/i.test(el.getAttribute("placeholder") || "");
        value = dpt.kind === "y" ? String(dpt.n) : (padTo ? pad(dpt.n) : String(dpt.n));
        if (dpt.kind === "y" && el.maxLength === 2) value = String(dpt.n).slice(-2);
      } else if (isDob) {
        var pd = parseDate(wanted);
        var shaped = pd ? formatForPlaceholder(pd, el.getAttribute("placeholder") || "") : null;
        if (shaped) value = shaped;
      }

      setValue(""); dispatch(el, "input");
      if (p.humanize && type !== "date" && type !== "datetime-local" && type !== "month") {
        var cur = "";
        for (var i = 0; i < value.length; i++) { cur += value[i]; setValue(cur); dispatch(el, "input"); await sleep(50 + Math.random() * 80); }
      } else { setValue(value); dispatch(el, "input"); }
      dispatch(el, "change");
      var ok = el.value === value || sameEntered(el.value, value);
      return J(ok ? { ok: true } : { ok: false, err: 'value did not stick (page shows "' + String(el.value).slice(0, 24) + '", wanted "' + String(value).slice(0, 24) + '", input type ' + (type || "text") + ")" });
    } catch (e) { return J({ ok: false, err: "fill error: " + (e && e.message || String(e)) }); }
  }

  // ------------------------------------------------------------------ click
  async function click(p) {
    var labels = (p.labels || []).map(function (s) { return canon(s); }).filter(Boolean);
    var SEL = 'a,button,input[type=submit],input[type=button],input[type=image],[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=treeitem],[onclick],[aria-haspopup],[aria-expanded],[aria-controls],[tabindex]:not([tabindex="-1"]),summary,li';
    function attr(el, a) { return (el.getAttribute(a) || "").toLowerCase().trim(); }
    function textMatches(el, exact) {
      var t = canon(text(el)), a = canon(attr(el, "aria-label")), ti = canon(attr(el, "title"));
      return labels.some(function (l) { return exact ? (t === l || a === l || ti === l) : (t.indexOf(l) >= 0 || a.indexOf(l) >= 0 || ti.indexOf(l) >= 0); });
    }
    function clickable(el) {
      if (!el) return el;
      var direct = el.closest && el.closest(SEL);
      if (direct && direct !== document.body && direct !== document.documentElement) return direct;
      var n = el;
      for (var i = 0; n && i < 5; i++, n = n.parentElement) {
        if (!n || n === document.body || n === document.documentElement) break;
        var role = attr(n, "role"), cls = attr(n, "class"), st = null;
        try { st = getComputedStyle(n); } catch (_) {}
        if (/option|menuitem|treeitem|tab|button|link/.test(role) || n.hasAttribute("onclick") || n.hasAttribute("aria-haspopup") ||
            n.hasAttribute("aria-expanded") || n.hasAttribute("data-value") || (st && st.cursor === "pointer") ||
            /country|region|dropdown|select|option|picker|calendar|date|year/.test(cls)) return n;
      }
      return el;
    }
    function bySelectors() {
      var tries = [
        ["id", function () { return p.id ? document.getElementById(p.id) : null; }],
        ["css", function () { return p.css ? document.querySelector(p.css) : null; }],
        ["xpath", function () { return p.xpath ? document.evaluate(p.xpath, document, null, 9, null).singleNodeValue : null; }],
        ["name", function () { return p.name ? document.getElementsByName(p.name)[0] : null; }]
      ];
      for (var i = 0; i < tries.length; i++) { try { var e = tries[i][1](); if (e && visible(e)) return { el: e, via: tries[i][0] }; } catch (_) {} }
      return null;
    }
    function byText() {
      if (!labels.length) return null;
      var all = deepAll(SEL).filter(visible);
      var e = all.find(function (x) { return textMatches(x, true); }) || all.find(function (x) { return textMatches(x, false); });
      if (e) return clickable(e);
      var loose = deepAll("div,span,li,p,[role=option],[data-value]").filter(function (x) {
        if (!visible(x)) return false;
        var t = text(x); return t.length > 0 && t.length <= 120 && textMatches(x, true);
      });
      return loose.length ? clickable(loose[0]) : null;
    }
    function find() {
      var s = bySelectors(), t = byText();
      if (s) {
        if (!labels.length || !text(s.el) || textMatches(s.el, false)) return { el: clickable(s.el), via: s.via };
        if (t) return { el: t, via: "text" };
        return { el: clickable(s.el), via: s.via + "?" };
      }
      return t ? { el: t, via: "text" } : null;
    }
    var start = Date.now(), hit = null;
    while (Date.now() - start < ELEMENT_WAIT_MS) { hit = find(); if (hit) break; await sleep(300); }
    if (!hit) {
      var shown = deepAll("a,button").filter(visible).slice(0, 10).map(function (x) { return text(x).slice(0, 25); });
      return J({ ok: false, err: "click target not found. labels=" + JSON.stringify(p.labels || []) +
        " selectors(id/css/xpath/name)=" + [!!p.id, !!p.css, !!p.xpath, !!p.name].join("/") + " visible a/button=" + JSON.stringify(shown) });
    }
    try {
      var el = hit.el;
      el.scrollIntoView({ block: "center" });
      await sleep(250);
      if (el.tagName === "A" && el.target === "_blank") el.target = "_self";
      window.__ddgNavMark = true;
      try { el.focus(); } catch (_) {}
      synthClick(el);
      return J({ ok: true, via: hit.via });
    } catch (e) { return J({ ok: false, err: "click error: " + e.message }); }
  }

  // ------------------------------------------------------------------ frames
  async function local(kind, params) {
    if (kind === "fill") return await fill(params);
    if (kind === "click") return await click(params);
    if (kind === "verify") return await verify();
    if (kind === "pick") return await pick(params);
    return J({ ok: false, err: "unknown executor call " + kind });
  }

  // Run inside the child frame whose hostname is `host`.
  function relay(kind, params, host) {
    return new Promise(function (resolve) {
      var id = "x" + Math.random().toString(36).slice(2);
      var kids = [];
      try { for (var i = 0; i < window.frames.length; i++) kids.push(window.frames[i]); } catch (_) {}
      if (!kids.length) return resolve(J({ ok: false, err: "this page has no frames (step was recorded inside a frame)" }));
      var pending = kids.length, firstFail = null, done = false, timer = null;
      function finish(r) {
        if (done) return; done = true;
        window.removeEventListener("message", onMsg); clearTimeout(timer); resolve(r);
      }
      function addFrameOffset(n, src) {
        try {
          var f = Array.prototype.slice.call(document.querySelectorAll("iframe,frame")).filter(function (x) { return x.contentWindow === src; })[0];
          if (f) { var r = f.getBoundingClientRect(); n.x += r.left + f.clientLeft; n.y += r.top + f.clientTop; }
        } catch (_) {}
      }
      function onMsg(ev) {
        var d = ev.data;
        if (!d || typeof d !== "object" || d.__ddgRec !== "res" || d.id !== id) return;
        pending--;
        if (d.skipped) { if (pending <= 0) finish(firstFail || J({ ok: false, err: "no frame with host " + host + " answered (the executor must be loaded in the frame: reload the page after starting automation)" })); return; }
        var r; try { r = JSON.parse(d.result); } catch (_) { r = { ok: false, err: "bad frame answer" }; }
        if (r.native) addFrameOffset(r.native, ev.source);
        if (r.ok || r.native) return finish(J(r));
        if (!firstFail) firstFail = J(r);
        if (pending <= 0) finish(firstFail);
      }
      window.addEventListener("message", onMsg);
      timer = setTimeout(function () { finish(firstFail || J({ ok: false, err: "frame " + host + " did not answer in time" })); }, FRAME_TIMEOUT_MS);
      kids.forEach(function (w) {
        try { w.postMessage({ __ddgRec: "exec", id: id, kind: kind, params: params, host: host }, "*"); } catch (_) { pending--; }
      });
    });
  }

  async function run(kind, params, host) {
    params = params || {};
    if (host) return await relay(kind, params, host);
    return await local(kind, params);
  }

  // every frame (not the top page) executes requests that name its hostname
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object" || d.__ddgRec !== "exec" || IS_TOP) return;
    var src = ev.source;
    function send(o) { try { src.postMessage(Object.assign({ __ddgRec: "res", id: d.id }, o), "*"); } catch (_) {} }
    if (d.host && d.host !== frameKey()) { send({ skipped: true }); return; }
    local(d.kind, d.params || {}).then(
      function (r) { send({ result: r }); },
      function (e) { send({ result: J({ ok: false, err: "frame error: " + (e && e.message) }) }); }
    );
  }, false);

  g.__ddgExec = { run: run, fill: fill, click: click, verify: verify, version: "e1" };
})();