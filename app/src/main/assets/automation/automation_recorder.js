/*
 * Automation Recorder v22
 *
 * v22: toasts render inside open <dialog>/top-layer modals (Zomato login), arrival counter + "ready" badge for diagnosis
 *
 * v21 on top of v20:
 *  - FIX: "Country/Region" (and any country selector) is classified as "country", not "state"
 *    (the word "region" used to win and the step became a ClickNext)
 *  - FIX: "state" custom dropdowns are treated as fields too
 *  - FIX: every silent drop now shows a grey toast with the reason, so "nothing detected" is diagnosable
 *
 * v18/v19/v20 features kept:
 *  - toasts appear ON the tapped element, with sequence numbers acknowledged by Kotlin
 *  - __automationRecorderDrain(): Kotlin pulls queued events with evaluateJavascript
 *  - canary + watchdog re-binds listeners if a page erases them
 *  - taps swallowed with stopPropagation() are still recorded
 *  - keyboard suppressed with inputmode=none before focus
 *  - top frame only
 */
(function () {
  "use strict";
  const g = globalThis;
  const VERSION = "v22";
  const DEBUG = true;

  function log() {
    if (!DEBUG) return;
    try { console.log("WebConsole: " + Array.prototype.slice.call(arguments).join(" ")); } catch (_) {}
  }
  function warn() {
    try { console.warn("WebConsole: " + Array.prototype.slice.call(arguments).join(" ")); } catch (_) {}
  }

  try { if (window.top !== window) return; } catch (_) { return; }

  const CFG = { TOASTS: true, OUTBOX_MAX: 200, PUMP_MS: 300, TAP_MAX_MS: 800, MOVE_PX: 30, POINTER_SCAN_DEPTH: 6 };

  // ---- re-injection: only skip when we are really bound to THIS document ----
  const prev = g.__ddgRecorderState;
  if (prev && prev.active && prev.doc === document && prev.listeners.length > 0) {
    log("already active on this document, skipping re-install (" + prev.version + ")");
    return;
  }
  const carriedPause = !!(prev && prev.isPaused);
  if (prev && typeof prev.stop === "function") { try { prev.stop(); } catch (_) {} }

  const S = {
    version: VERSION, doc: document, active: false, isPaused: carriedPause,
    listeners: [], outbox: [], pumpTimer: null, watchdog: null, styleEl: null, onReady: null, stop: null,
    captured: 0, ignored: 0, rebinds: 0, patched: false, seq: 0, pending: new Map(),
  };

  let lastTarget = null;
  let lastTime = 0;
  let lastFieldContext = "";
  let lastFieldContextAt = 0;
  let highlightedElement = null;
  let highlightedPreviousOutline = "";
  let highlightGeneration = 0;

  const INTERACTIVE =
    'input, textarea, select, button, a, summary, [contenteditable=""], [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], ' +
    '[role="combobox"], [role="textbox"], [role="tab"], [role="menuitem"], [role="option"], ' +
    '[tabindex]:not([tabindex="-1"]), [onclick], ' +
    '[role="spinbutton"], [role="listbox"], [role="option"], [role="treeitem"], [role="menuitemradio"], [aria-haspopup], [aria-expanded], [aria-controls], [data-value], ' +
    '[class*="callingCode"], [class*="calling-code"], [class*="countryDropDown"], [class*="country-code"], ' +
    '[class*="countryCode"], [class*="dial-code"], [class*="dialCode"], [class*="birthday"], [class*="bday"], ' +
    '[class*="date-root"], [class*="date-picker"], [class*="datepicker"], ' +
    '.iti__selected-flag, .iti__selected-country, .iti__flag-container, .PhoneInputCountry, .selected-flag, .flag-dropdown, ' +
    '[data-dial-code], [data-country-code], [data-datepicker], [data-type="fydeos_select"], .choose_value, ' +
    '#selectedCountry, .hwid-selectedCountryName, [id*="selectedCountry"], ' +
    '.MuiSelect-select, .ant-select-selector, .react-select__control';
  const CLICK_INPUT_TYPES = ["submit", "button", "image", "reset"];
  const FIELD_ROLES = ["checkbox", "radio", "switch", "combobox", "textbox"];

  // ---- make disabled controls tappable (lazy: document.head does not exist at document-start) ----
  function ensureStyle() {
    try {
      if (S.styleEl && S.styleEl.isConnected) return true;
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      const el = document.createElement("style");
      el.id = "__automation_recorder_style";
      el.textContent =
        'button:disabled, input:disabled, [aria-disabled="true"] { pointer-events: auto !important; cursor: crosshair !important; opacity: 0.7 !important; }';
      parent.appendChild(el);
      S.styleEl = el;
      return true;
    } catch (_) { return false; }
  }

  // ---- keyboard blocking: wrapper is chain-safe (scanner may wrap on top of us) ----
  const proto = HTMLElement.prototype;
  const currentFocus = proto.focus;
  const originalFocus = (currentFocus && currentFocus.__ddgOrig) ? currentFocus.__ddgOrig : currentFocus;
  function wrappedFocus() {
    if (S.active && !S.isPaused) return;
    return originalFocus.apply(this, arguments);
  }
  wrappedFocus.__ddgOrig = originalFocus;

  // ---- helpers ----
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const st = window.getComputedStyle(el);
      if (!st || st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || el.offsetParent !== null || el.getClientRects().length > 0;
    } catch (_) { return false; }
  }

  function isBoxy(el) {
    return !!el && el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
  }

  function stableId(id) {
    return !!id && !/\d{4,}/.test(id) && !/^:/.test(id) && !/^\d/.test(id);
  }

  function countMatches(sel) {
    try { return document.querySelectorAll(sel).length; } catch (_) { return 0; }
  }

  // ---- selectors ----
  function getCssSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.nodeName.toLowerCase();

    if (stableId(el.id)) {
      const s = "#" + CSS.escape(el.id);
      if (countMatches(s) === 1) return s;
    }

    const attrs = ["data-testid", "data-test", "data-cy", "name", "aria-label", "title", "placeholder"];
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && v.length > 1 && v.length < 60 && !/\d{4,}/.test(v)) {
        const s = tag + "[" + a + '="' + CSS.escape(v) + '"]';
        if (countMatches(s) === 1) return s;
      }
    }

    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let name = cur.nodeName.toLowerCase();
      if (stableId(cur.id) && countMatches("#" + CSS.escape(cur.id)) === 1) {
        path.unshift("#" + CSS.escape(cur.id));
        break;
      }
      const parent = cur.parentElement;
      if (!parent) break;
      const sibs = Array.from(parent.children).filter(function (c) { return c.nodeName === cur.nodeName; });
      if (sibs.length > 1) name += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      path.unshift(name);
      cur = parent;
    }
    return path.join(" > ");
  }

  function getXPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (stableId(el.id) && el.id.indexOf('"') === -1) return '//*[@id="' + el.id + '"]';

    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a") {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 0 && text.length < 40 && text.indexOf('"') === -1) {
        return "//" + tag + '[contains(normalize-space(.), "' + text + '")]';
      }
    }

    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let i = 1;
      let sib = cur.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.nodeName === cur.nodeName) i++;
        sib = sib.previousSibling;
      }
      path.unshift(cur.nodeName.toLowerCase() + "[" + i + "]");
      cur = cur.parentElement;
    }
    return "/" + path.join("/");
  }

  function getLabel(el) {
    if (!el) return "";
    let label = "";
    const type = (el.type || "").toLowerCase();
    if (el.labels && el.labels.length) {
      label = el.labels[0].innerText || el.labels[0].textContent;
    } else if (el.closest && el.closest("label") && !(el.tagName === "A" || el.tagName === "BUTTON")) {
      const l = el.closest("label");
      label = l.innerText || l.textContent;
    } else {
      label = el.innerText || el.textContent ||
        (el.tagName === "INPUT" && CLICK_INPUT_TYPES.indexOf(type) !== -1 ? el.value : "") ||
        el.getAttribute("aria-label") || el.getAttribute("title") ||
        el.getAttribute("placeholder") || el.getAttribute("name") || el.id;
      if (!label && el.querySelector) {
        const img = el.querySelector("img[alt]");
        if (img) label = img.getAttribute("alt");
      }
    }
    return (label || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function localContext(el) {
    if (!el || !el.closest) return "";
    const selectors = [
      "label", "fieldset", "[role='group']", "[role='radiogroup']",
      "[data-field]", "[data-testid*='field' i]", "[class*='form-group' i]",
      "[class*='form-field' i]", "[class*='field-wrapper' i]",
      "[class*='input-group' i]", "[class*='MuiFormControl' i]"
    ];
    for (const selector of selectors) {
      try {
        const group = el.closest(selector);
        if (group) {
          const text = (group.innerText || group.textContent || "").replace(/\s+/g, " ").trim();
          if (text && text.length <= 500) return text;
        }
      } catch (_) {}
    }
    try {
      let node = el;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        let prev = node.previousElementSibling;
        for (let n = 0; prev && n < 2; n++, prev = prev.previousElementSibling) {
          const text = (prev.innerText || prev.textContent || "").replace(/\s+/g, " ").trim();
          if (text && text.length <= 120) return text;
        }
      }
    } catch (_) {}
    try {
      const popup = el.closest("[role='dialog'],[role='listbox'],[role='menu'],[aria-modal='true'],[data-radix-popper-content-wrapper],.MuiPopover-root,.MuiMenu-paper,.ant-select-dropdown,.react-select__menu");
      if (popup) return (popup.innerText || popup.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    } catch (_) {}
    return "";
  }

  function classify(el) {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    const own = [
      getLabel(el), el.name, el.id, el.getAttribute("aria-label"),
      el.getAttribute("placeholder"), el.getAttribute("data-testid"),
      el.getAttribute("data-field"), el.getAttribute("data-value"),
      el.getAttribute("data-type"), el.getAttribute("title"), el.getAttribute("class")
    ].filter(Boolean).join(" ").toLowerCase();
    const context = localContext(el).toLowerCase();
    const popup = el.closest && el.closest("[role='listbox'],[role='menu'],[role='dialog'],[data-radix-popper-content-wrapper],.MuiPopover-root,.MuiMenu-paper,.ant-select-dropdown,.react-select__menu");
    const optionLike = role === "option" || role === "menuitem" || tag === "li" || !!(popup && el !== popup);
    const freshContext = optionLike && Date.now() - lastFieldContextAt < 15000 ? lastFieldContext : "";
    const c = (own + " " + context + " " + freshContext).replace(/\s+/g, " ").trim();

    const ownText = (el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
    if (el.id === "selectedCountry" || /hwid-selectedCountryName/i.test(own) || /selectedcountry/i.test(own)) return "country";
    if (el.getAttribute("data-type") === "fydeos_select" || /\bchoose_value\b/.test(own)) {
      if (/\b(year|birth year|date of birth|dob|birthday)\b/.test(context + " " + own)) return "dobYear";
      if (/\b(month)\b/.test(context + " " + own)) return "dobMonth";
      if (/\b(day)\b/.test(context + " " + own)) return "dobDay";
      return "dob";
    }
    const hasPhoneSibling = !!(el.parentElement && el.parentElement.querySelector("input[type='tel'],input[autocomplete^='tel'],input[name*='phone' i]"));
    if (role === "combobox" && /^\+\d{1,4}$/.test(ownText) && (/\b(phone|mobile|tel)\b/.test(context + " " + own) || hasPhoneSibling)) return "countryCode";

    if (freshContext === "countryCode" ||
        /\b(country\s*(calling\s*)?code|calling\s*code|dial(?:ling)?\s*code|phone\s*code|international\s*prefix)\b/.test(c) ||
        /\b(iti__selected-flag|countrycode|country-code|dialcode|dial-code)\b/.test(own)) return "countryCode";
    if (/\b(currency|select currency|preferred currency|billing currency|payment currency)\b/.test(c) ||
        /\b(currency|curr|iso-4217)\b/.test(own)) return "currency";

    // v21: a control whose OWN text says country/nation is a country selector.
    // This MUST run before the generic "state|province|region" rule: the label
    // "Country/Region" contains the word "region" and used to be classified as "state".
    if (/\b(country|nation)\b/.test(own) && !/\b(code|prefix)\b/.test(own) &&
        !/\b(date\s*of\s*birth|birth\s*date|birthday|dob)\b/.test(own)) return "country";

    const optionText = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const inheritedDob = /\b(dob|date of birth|birth date|birthday)\b/.test(freshContext);
    if (inheritedDob && /^\d{4}$/.test(optionText)) return "dobYear";
    if (inheritedDob && /\b(year|search year)\b/.test(own)) return "dobYear";
    if (/\b(date\s*of\s*birth|birth\s*date|birthday|date\s*picker|calendar|bday|dob)\b/.test(c) ||
        (/\b(year|month|day)\b/.test(c) && /\b(birth|dob|birthday)\b/.test(c))) {
      if (/\b(year|birth year)\b/.test(own) || /^\d{4}$/.test(optionText)) return "dobYear";
      if (/\b(month|birth month)\b/.test(own)) return "dobMonth";
      if (/\b(day|birth day)\b/.test(own)) return "dobDay";
      return "dob";
    }
    if (type === "checkbox" || type === "radio" || role === "checkbox" || role === "radio" || role === "switch") {
      if (/\b(gender|sex|male|female)\b/.test(c)) return "gender";
      return "termscheckbox";
    }
    if (ac) {
      if (ac.includes("email")) return "email";
      if (ac.includes("tel")) return "phone";
      if (ac.includes("name")) {
        if (ac.includes("given")) return "firstName";
        if (ac.includes("family")) return "lastName";
        return "fullName";
      }
      if (ac.includes("street")) return "address";
      if (ac.includes("postal")) return "zip";
      if (ac.includes("country")) return "country";
      if (ac.includes("bday")) return "dob";
    }
    if (type === "email") return "email";
    if (type === "tel") return "phone";
    if (type === "password") return "password";
    if (type === "date") return "dob";
    if (/\b(first|given)\s*name\b|\bfname\b/.test(c)) return "firstName";
    if (/\b(last|family|sur)\s*name\b|\blname\b/.test(c)) return "lastName";
    if (/\b(full\s*name|your\s*name|name)\b/.test(own)) return "fullName";
    if (/\b(e-?mail)\b/.test(c)) return "email";
    if (/\b(phone|mobile|tel)\b/.test(c)) return "phone";
    if (/\b(password|pass)\b/.test(c)) return "password";
    if (/\b(city)\b/.test(c)) return "city";
    if (/\b(state|province|region)\b/.test(c)) return "state";
    if (/\b(zip|postal)\b/.test(c)) return "zip";
    if (/\b(country|nation)\b/.test(c)) return "country";
    if (tag === "textarea" || /\b(message|comment|description)\b/.test(own)) return "message";
    return "text";
  }

  function isTextField(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") return CLICK_INPUT_TYPES.indexOf((el.type || "").toLowerCase()) === -1 && !isBoxy(el);
    return false;
  }

  // ---- on-screen feedback: the badge sits on the tapped element ----
  let toastEl = null, toastTimer = null;
  function toast(msg, color, target) {
    if (!CFG.TOASTS) return;
    try {
      let host = document.body || document.documentElement;
      try { const dlg = document.querySelector("dialog[open], [popover]:popover-open"); if (dlg) host = dlg; } catch (_) {}
      if (!host) return;
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      clearTimeout(toastTimer);
      const el = document.createElement("div");
      el.setAttribute("data-automation-hud", "1");
      el.textContent = msg;
      el.style.cssText =
        "position:fixed;z-index:2147483647;top:0;left:0;visibility:hidden;max-width:80vw;" +
        "background:" + color + ";color:#fff;font:700 12px -apple-system,BlinkMacSystemFont,sans-serif;" +
        "padding:5px 10px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.35);pointer-events:none;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      host.appendChild(el);
      const w = el.offsetWidth, hgt = el.offsetHeight;
      let r = null;
      try { r = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null; } catch (_) {}
      let top, left;
      if (r && (r.width || r.height)) {
        top = r.top - hgt + 4;
        if (top < 6) top = r.top + 4;
        left = Math.max(6, Math.min(r.left + 6, window.innerWidth - w - 6));
      } else {
        top = window.innerHeight - 110;
        left = Math.max(6, (window.innerWidth - w) / 2);
      }
      el.style.top = top + "px";
      el.style.left = left + "px";
      el.style.visibility = "visible";
      toastEl = el;
      toastTimer = setTimeout(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {} }, 1600);
    } catch (_) {}
  }

  // ---- keyboard: inputmode=none BEFORE focus so no keyboard flashes up while recording ----
  const kbSaved = new Map();
  function suppressKeyboard(e, doBlur) {
    try {
      if (!S.active || S.isPaused) return;
      const path = pathOf(e);
      const n = Math.min(path.length, 4);
      for (let i = 0; i < n; i++) {
        const el = path[i];
        if (isTextField(el) || el.isContentEditable) {
          if (!kbSaved.has(el)) kbSaved.set(el, el.getAttribute("inputmode"));
          el.setAttribute("inputmode", "none");
          if (doBlur) { try { el.blur(); } catch (_) {} }
          return;
        }
      }
    } catch (_) {}
  }
  function restoreKeyboard() {
    kbSaved.forEach(function (orig, el) {
      try { if (orig === null) el.removeAttribute("inputmode"); else el.setAttribute("inputmode", orig); } catch (_) {}
    });
    kbSaved.clear();
  }

  // ---- delivery: immediate first, outbox only as fallback ----
  function deliver(item) {
    const b = window.AutomationBridge;
    if (!b || !b.onElementRecorded) return false;
    try { b.onElementRecorded(JSON.stringify(item)); return true; }
    catch (e) { S.lastBridgeError = String(e && e.message); warn("bridge call failed:", S.lastBridgeError); toast("\u26A0 bridge call failed", "#DC2626"); return false; }
  }

  function pump() {
    while (S.outbox.length && deliver(S.outbox[0])) S.outbox.shift();
    if (!S.outbox.length && S.pumpTimer) { clearInterval(S.pumpTimer); S.pumpTimer = null; }
  }

  function sendToBridge(item, targetEl) {
    if (S.outbox.length >= CFG.OUTBOX_MAX) {
      warn("outbox full, dropping oldest event");
      S.outbox.shift();
    }
    S.outbox.push(item);
    log("queued for native recorder (outbox=" + S.outbox.length + ")");
    toast("Captured \u2014 saving\u2026", "#D97706", targetEl);
  }

  // ---- target resolution (walks the composed path, so open shadow DOM works) ----
  function describe(el) {
    try {
      let s = el.tagName.toLowerCase();
      if (el.id) s += "#" + el.id;
      return s.slice(0, 60);
    } catch (_) { return "?"; }
  }

  function pathOf(e) {
    const out = [];
    try {
      const p = e.composedPath && e.composedPath();
      if (p && p.length) for (const n of p) if (n && n.nodeType === 1) out.push(n);
    } catch (_) {}
    if (!out.length) {
      let t = e.target;
      if (t && t.nodeType !== 1) t = t.parentElement;
      while (t && t.nodeType === 1) { out.push(t); t = t.parentElement; }
    }
    return out;
  }

  function isPopupShell(el) {
    if (!el || el.nodeType !== 1) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    return role === "listbox" || role === "menu" || role === "dialog" ||
      el.hasAttribute("aria-modal") || el.hasAttribute("data-radix-popper-content-wrapper") ||
      el.matches(".MuiPopover-root,.MuiMenu-paper,.ant-select-dropdown,.react-select__menu");
  }

  function isCustomSelectLike(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.matches("[role='combobox'],[aria-haspopup='listbox'],[data-type='fydeos_select'],.choose_value,#selectedCountry,.hwid-selectedCountryName,[id*='selectedCountry'],.MuiSelect-select,.ant-select-selector,.react-select__control");
  }

  function hasWidgetSemantics(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const role = (el.getAttribute("role") || "").toLowerCase();
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      return /^(option|menuitem|menuitemradio|menuitemcheckbox|tab|treeitem|radio|checkbox|switch|combobox|listbox|button|link)$/.test(role) ||
        el.hasAttribute("onclick") || el.hasAttribute("tabindex") ||
        el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded") ||
        el.hasAttribute("aria-controls") || el.hasAttribute("data-value") || el.hasAttribute("data-type") ||
        isCustomSelectLike(el) ||
        /\b(country|region|dropdown|select|option|menu|picker|date|year|month|day|calendar|calling.?code|dial.?code)\b/.test(cls);
    } catch (_) { return false; }
  }

  function resolveTarget(path) {
    let actual = null;
    for (let i = 0; i < path.length; i++) {
      const el = path[i];
      if (el === document.documentElement || el === document.body) break;
      try {
        if (isPopupShell(el)) continue;
        if (el.tagName === "LABEL" && el.control) { actual = el.control; break; }
        if (el.matches(INTERACTIVE) || hasWidgetSemantics(el)) {
          actual = el;
          if (el.id === "selectedCountry" || /hwid-selectedCountryName/i.test(String(el.className || ""))) {
            let owner = el.parentElement;
            for (let d = 0; owner && d < 3; d++, owner = owner.parentElement) {
              const st = getComputedStyle(owner);
              if (st.cursor === "pointer" || owner.hasAttribute("onclick") || owner.getAttribute("role") === "button") { actual = owner; break; }
            }
          }
          break;
        }
      } catch (_) {}
    }

    if (!actual) {
      const n = Math.min(path.length, CFG.POINTER_SCAN_DEPTH + 3);
      for (let i = 0; i < n; i++) {
        const el = path[i];
        if (!el || el === document.documentElement || el === document.body) break;
        try {
          if (isPopupShell(el)) continue;
          const st = getComputedStyle(el);
          if (st.cursor === "pointer" || hasWidgetSemantics(el)) { actual = el; break; }
        } catch (_) {}
      }
    }

    if (!actual) {
      for (let i = 0; i < Math.min(path.length, 5); i++) {
        const el = path[i];
        if (!el || el === document.documentElement || el === document.body) break;
        const tag = (el.tagName || "").toLowerCase();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if ((tag === "li" || tag === "span" || tag === "div") && text.length > 0 && text.length <= 100) {
          const parent = el.parentElement;
          const parentRole = parent && (parent.getAttribute("role") || "").toLowerCase();
          const parentClass = parent && (typeof parent.className === "string" ? parent.className : "").toLowerCase();
          if (tag === "li" || /listbox|menu|country|region|select|option|dropdown|picker/.test(parentRole + " " + parentClass)) {
            actual = tag === "span" && el.parentElement ? el.parentElement : el;
            break;
          }
        }
      }
    }
    if (!actual) return null;

    if (actual.tagName !== "A" && actual.tagName !== "BUTTON") {
      const lab = actual.tagName === "LABEL" ? actual : (actual.closest ? actual.closest("label") : null);
      if (lab) {
        const ctl = lab.control || lab.querySelector("input, select, textarea, [role='radio'], [role='checkbox']");
        if (ctl) actual = ctl;
      }
    }
    return actual;
  }

  // v21: every drop is now visible on screen (grey toast with the reason)
  function ignore(msg, target) {
    S.ignored++;
    log(msg);
    toast(msg.replace(/^IGNORED \(/, "Skipped ("), "#6B7280", target);
  }

  function processEvent(e, src) {
    try {
      if (!S.active) return;
      if (S.isPaused) { ignore("IGNORED (" + src + "): recorder paused"); return; }

      const path = pathOf(e);
      if (!path.length) { ignore("IGNORED (" + src + "): no target"); return; }
      for (let i = 0; i < path.length; i++) {
        if (path[i].hasAttribute && path[i].hasAttribute("data-automation-hud")) { S.ignored++; log("IGNORED (" + src + "): HUD tap"); return; }
      }

      const actual = resolveTarget(path);
      if (!actual) { ignore("IGNORED (" + src + "): no interactive target, tapped " + describe(path[0]), path[0]); return; }
      if (!isVisible(actual) && !isBoxy(actual)) { ignore("IGNORED (" + src + "): not visible " + describe(actual), actual); return; }

      const now = Date.now();
      if (actual === lastTarget && now - lastTime < (isTextField(actual) ? 1200 : 500)) { return; }
      lastTarget = actual;
      lastTime = now;

      const tag = actual.tagName.toLowerCase();
      const type = (actual.type || "").toLowerCase();
      const role = (actual.getAttribute("role") || "").toLowerCase();
      const semanticField = FIELD_ROLES.indexOf(role) !== -1 ||
        actual.matches("[aria-haspopup='listbox'],[aria-autocomplete],[data-datepicker],[data-date-picker],[data-type='fydeos_select'],.choose_value,#selectedCountry,.hwid-selectedCountryName,[id*='selectedCountry'],[class*='date-picker'],[class*='datepicker'],[class*='MuiSelect'],[class*='ant-select'],[class*='react-select']") || isCustomSelectLike(actual);
      const inferredType = classify(actual);
      if (["dob", "dobYear", "dobMonth", "dobDay", "country", "countryCode", "currency"].indexOf(inferredType) !== -1) {
        lastFieldContext = inferredType.indexOf("dob") === 0 ? "date of birth dob" : inferredType;
        lastFieldContextAt = Date.now();
      }
      const isDatePart = ["dob", "dobYear", "dobMonth", "dobDay"].indexOf(inferredType) !== -1;
      // v21: "state" added so custom state/province dropdowns are Fields, not ClickNext
      const isSemanticPicker = ["country", "countryCode", "currency", "state"].indexOf(inferredType) !== -1;
      const isFieldLike =
        tag === "textarea" || tag === "select" ||
        (tag === "input" && CLICK_INPUT_TYPES.indexOf(type) === -1) ||
        actual.isContentEditable || semanticField || isDatePart || isSemanticPicker;
      const kind = isFieldLike ? "Field" : "ClickNext";

      try {
        if (highlightedElement && highlightedElement !== actual) {
          highlightedElement.style.outline = highlightedPreviousOutline;
        }
        if (highlightedElement === actual) actual.style.outline = highlightedPreviousOutline;
        highlightedElement = actual;
        highlightedPreviousOutline = actual.style.outline || "";
        const thisHighlight = ++highlightGeneration;
        actual.style.outline = "3px solid #06b6d4";
        setTimeout(function () {
          try {
            if (highlightedElement === actual && highlightGeneration === thisHighlight) {
              actual.style.outline = highlightedPreviousOutline;
              highlightedElement = null;
              highlightedPreviousOutline = "";
            }
          } catch (_) {}
        }, 650);
      } catch (_) {}

      const label = getLabel(actual);
      const payload = {
        kind: kind, tag: tag, domType: type,
        name: actual.getAttribute("name") || "",
        domId: actual.id || "",
        placeholder: actual.getAttribute("placeholder") || "",
        ariaLabel: actual.getAttribute("aria-label") || "",
        role: role,
        autocomplete: actual.getAttribute("autocomplete") || "",
        contextLabel: (function () {
          let p = actual, out = [];
          for (let i = 0; p && i < 4; i++, p = p.parentElement) {
            const t = (p.innerText || p.textContent || "").replace(/\s+/g, " ").trim();
            if (t) out.push(t.slice(0, 120));
            if (p.tagName === "FORM") break;
          }
          return out.join(" | ").slice(0, 300);
        })(),
        cssSelector: getCssSelector(actual),
        xpath: getXPath(actual),
        looksLike: isFieldLike ? inferredType : "",
        displayLabel: label || "Element",
        buttonLabel: kind === "ClickNext" ? (label || "Button") : "",
        verified: true,
      };
      S.captured++;
      log("CAPTURED (" + src + "):", tag, payload.displayLabel);
      payload.seq = ++S.seq;
      S.pending.set(payload.seq, { el: actual, label: payload.displayLabel || tag });
      if (S.pending.size > 30) S.pending.delete(S.pending.keys().next().value);
      sendToBridge(payload, actual);

      if (isTextField(actual)) { try { actual.blur(); } catch (_) {} }
    } catch (err) {
      warn("processEvent failed:", err && err.message);
    }
  }

  // ---- listeners (window + capture) ----
  const processed = new WeakSet();
  const HANDLERS = {};

  function on(type, fn, opts) {
    window.addEventListener(type, fn, opts);
    S.listeners.push([type, fn, opts]);
  }

  function track(type, fn) {
    const h = function (e) {
      if (type === "click" || type === "pointerup" || type === "touchend") S.seen = (S.seen || 0) + 1;
      if (processed.has(e)) return;
      processed.add(e);
      fn(e);
    };
    HANDLERS[type] = h;
    return h;
  }

  let tX = 0, tY = 0, tT = 0, tMoved = false;
  let canaryHit = false;

  function bindListeners() {
    const passiveCap = { capture: true, passive: true };
    const cap = { capture: true };

    on("touchstart", track("touchstart", function (e) {
      if (e.touches && e.touches.length === 1) {
        tX = e.touches[0].clientX; tY = e.touches[0].clientY; tT = Date.now(); tMoved = false;
      }
      suppressKeyboard(e, false);
    }), passiveCap);

    on("pointerdown", track("pointerdown", function (e) {
      if (e.pointerType === "touch") { tX = e.clientX; tY = e.clientY; tT = Date.now(); tMoved = false; }
      suppressKeyboard(e, false);
    }), cap);

    on("touchmove", track("touchmove", function (e) {
      if (e.touches && e.touches.length === 1) {
        if (Math.abs(e.touches[0].clientX - tX) > CFG.MOVE_PX || Math.abs(e.touches[0].clientY - tY) > CFG.MOVE_PX) tMoved = true;
      }
    }), passiveCap);

    on("pointercancel", function (e) { if (e.pointerType === "touch") tMoved = true; }, cap);
    on("touchcancel", function () { tT = 0; tMoved = false; }, passiveCap);

    on("touchend", track("touchend", function (e) {
      const moved = tMoved, elapsed = tT ? Date.now() - tT : 0;
      tT = 0;
      if (e.changedTouches && e.changedTouches.length === 1 && !moved && elapsed < CFG.TAP_MAX_MS) processEvent(e, "touchend");
      else if (moved) log("IGNORED (touchend): scroll/swipe");
    }), passiveCap);

    on("pointerup", track("pointerup", function (e) {
      if (e.pointerType !== "touch") return;
      if (tMoved) return;
      processEvent(e, "pointerup");
    }), cap);

    on("click", track("click", function (e) { processEvent(e, "click"); }), cap);

    on("focusin", track("focusin", function (e) {
      suppressKeyboard(e, true);
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) processEvent(e, "focusin");
    }), cap);

    on("pagehide", function () { pump(); }, cap);
    on("pageshow", function (e) { if (e.persisted) verifyListeners("pageshow/bfcache"); }, cap);

    on("__ddg_canary", function () { canaryHit = true; }, cap);
  }

  function unbindListeners() {
    S.listeners.forEach(function (l) { try { window.removeEventListener(l[0], l[1], l[2]); } catch (_) {} });
    S.listeners.length = 0;
  }

  function verifyListeners(reason) {
    if (!S.active) return;
    canaryHit = false;
    try { window.dispatchEvent(new Event("__ddg_canary")); } catch (_) {}
    if (!canaryHit) {
      warn("listeners were erased (" + reason + "), re-binding");
      unbindListeners();
      bindListeners();
      S.rebinds++;
    }
    ensureStyle();
  }

  // ---- pages that call stopPropagation() on a tap must not hide it from us ----
  const evProto = Event.prototype;
  const origStop = evProto.stopPropagation;
  const origStopImm = evProto.stopImmediatePropagation;
  function hook(orig) {
    function wrapped() {
      try {
        if (S.active && this.isTrusted) {
          const h = HANDLERS[this.type];
          if (h) h(this);
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    }
    wrapped.__ddgOrig = orig;
    return wrapped;
  }
  const wrappedStop = hook(origStop);
  const wrappedStopImm = hook(origStopImm);

  // ---- lifecycle ----
  function stop() {
    S.active = false;
    restoreKeyboard();
    unbindListeners();
    if (S.pumpTimer) { clearInterval(S.pumpTimer); S.pumpTimer = null; }
    if (S.watchdog) { clearInterval(S.watchdog); S.watchdog = null; }
    if (S.onReady) { try { document.removeEventListener("DOMContentLoaded", S.onReady); } catch (_) {} S.onReady = null; }
    try { if (S.styleEl && S.styleEl.parentNode) S.styleEl.parentNode.removeChild(S.styleEl); } catch (_) {}
    S.styleEl = null;
    try { if (HTMLElement.prototype.focus === wrappedFocus) HTMLElement.prototype.focus = originalFocus; } catch (_) {}
    try {
      if (evProto.stopPropagation === wrappedStop) evProto.stopPropagation = origStop;
      if (evProto.stopImmediatePropagation === wrappedStopImm) evProto.stopImmediatePropagation = origStopImm;
    } catch (_) {}
    g.__automationRecorderInstalled = false;
    log("Recorder stopped");
  }
  S.stop = stop;

  try {
    if (!ensureStyle()) {
      S.onReady = function () { ensureStyle(); };
      document.addEventListener("DOMContentLoaded", S.onReady, { once: true });
    }
    HTMLElement.prototype.focus = wrappedFocus;
    bindListeners();
    evProto.stopPropagation = wrappedStop;
    evProto.stopImmediatePropagation = wrappedStopImm;
    S.active = true;
    g.__ddgRecorderState = S;
    S.watchdog = setInterval(function () { verifyListeners("watchdog"); }, 2000);

    g.__automationRecorderPause = function () { S.isPaused = true; restoreKeyboard(); log("Recorder paused"); };
    g.__automationRecorderResume = function () { S.isPaused = false; log("Recorder resumed"); };
    g.__automationRecorderStop = stop;
    g.__automationRecorderDrain = function () {
      if (!S.outbox.length) return "";
      return JSON.stringify(S.outbox.splice(0, S.outbox.length));
    };
    g.__automationRecorderAck = function (seq, ok, msg) {
      const p = S.pending.get(seq);
      S.pending.delete(seq);
      const label = p ? p.label : "";
      if (ok) toast("\u2713 Recorded " + (msg || "") + (label ? ": " + label : ""), "#10B981", p && p.el);
      else toast("\u2717 Not recorded: " + msg, "#DC2626", p && p.el);
    };
    g.__automationRecorderHealth = function () {
      return JSON.stringify({
        version: S.version, installed: !!g.__automationRecorderInstalled, active: S.active, paused: S.isPaused,
        listeners: S.listeners.length, outbox: S.outbox.length,
        bridge: !!(window.AutomationBridge && window.AutomationBridge.onElementRecorded),
        boundToThisDoc: S.doc === document, readyState: document.readyState, url: location.href,
        seen: S.seen || 0, captured: S.captured, ignored: S.ignored, rebinds: S.rebinds, lastBridgeError: S.lastBridgeError || "", pendingAcks: S.pending.size,
      });
    };

    g.__automationRecorderInstalled = true;
    setTimeout(function () { toast("Recorder " + VERSION + " ready", "#2563EB", null); }, 400);
    log("Recorder " + VERSION + " installed readyState=" + document.readyState + " url=" + location.href);
  } catch (err) {
    warn("INSTALL FAILED, will retry on next injection:", err && err.message);
    try { stop(); } catch (_) {}
  }
})();