/*
 * Automation Recorder v28
 *
 * v23: records inside iframes. The recorder now runs in every frame (document-start script), a child frame posts each
 *      captured tap to the top page with postMessage, the top page queues it for Kotlin and sends the result back so the
 *      toast appears inside the frame. Pause / resume / stop are relayed to all frames. Each step carries frameHost.
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
  const VERSION = "v28";
  const DEBUG = true;

  function log() {
    if (!DEBUG) return;
    try { console.log("WebConsole: " + Array.prototype.slice.call(arguments).join(" ")); } catch (_) {}
  }
  function warn() {
    try { console.warn("WebConsole: " + Array.prototype.slice.call(arguments).join(" ")); } catch (_) {}
  }

  // v23: the recorder also runs inside iframes. A child frame never talks to Kotlin itself: it posts to the top page.
  let IS_TOP = true;
  try { IS_TOP = window.top === window; } catch (_) { IS_TOP = false; }
  function frameKey() { try { return location.hostname || location.protocol; } catch (_) { return ""; } }
  function frameDepth() {
    let d = 0, w = window;
    try { while (w !== w.top && d < 10) { d++; w = w.parent; } } catch (_) {}
    return d;
  }
  function relayCtl(cmd) {
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage({ __ddgRec: "ctl", cmd: cmd }, "*"); } catch (_) {}
      }
    } catch (_) {}
  }

  // v27: remember which elements the PAGE gave a click handler (addEventListener). Icons wrapped in a plain div with a
  // JS handler have no tag, role or cursor that says "button"; this is the only reliable sign.
  try {
    if (!g.__ddgClicky) g.__ddgClicky = new WeakSet();
    const origAdd = EventTarget.prototype.addEventListener;
    if (!origAdd.__ddgPatched) {
      const patched = function (type, fn, opts) {
        try {
          if (this && this.nodeType === 1 && /^(click|pointerdown|pointerup|mousedown|mouseup|touchstart|touchend)$/.test(type)) g.__ddgClicky.add(this);
        } catch (_) {}
        return origAdd.call(this, type, fn, opts);
      };
      patched.__ddgPatched = true;
      EventTarget.prototype.addEventListener = patched;
    }
  } catch (_) {}

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
    captured: 0, ignored: 0, rebinds: 0, frameCaptured: 0, patched: false, seq: 0, pending: new Map(),
  };

  let lastTarget = null;
  let lastPickerEl = null, lastPickerAt = 0;
  let lastWheelCol = null, lastWheelAt = 0;
  const wheelSeen = new WeakMap();   // column -> time it was recorded
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
    if (el.tagName === "SELECT") {
      // v24: never use the option list as a label (it is every option's text).
      let l = el.labels && el.labels.length ? (el.labels[0].innerText || el.labels[0].textContent) : "";
      l = l || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("name") || el.id || "";
      return l.replace(/\s+/g, " ").trim().slice(0, 100);
    }
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

  function localContext(el, tight) {
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
    // v26: the label that sits NEXT TO this input inside its own wrapper (floating labels, <div>/<span> captions).
    // Climb only while the wrapper still holds exactly this one field; the text of another field never counts.
    try {
      let wrap = el.parentElement;
      for (let depth = 0; wrap && depth < 3; depth++, wrap = wrap.parentElement) {
        if (wrap.querySelectorAll("input:not([type=hidden]),select,textarea,[role=combobox]").length > 1) break;
        const lines = (wrap.innerText || wrap.textContent || "").split(/\n+/).map(function (x) { return x.replace(/\s+/g, " ").trim(); })
          .filter(function (x) { return x && !/^(enter|please|invalid|required|error|must|should|this field)\b|\b(is required|invalid)\b/i.test(x); });
        const joined = lines.join(" ");
        if (joined && joined.length <= 80) return joined;
      }
    } catch (_) {}
    try {
      let node = el;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        let prev = node.previousElementSibling;
        for (let n = 0; prev && n < 2; n++, prev = prev.previousElementSibling) {
          // v26: a previous sibling that contains a field is ANOTHER field's block: stop looking
          if (prev.querySelector && prev.querySelector("input:not([type=hidden]),select,textarea,[role=combobox]")) break;
          const text = (prev.innerText || prev.textContent || "").replace(/\s+/g, " ").trim();
          // v25: a neighbouring error/hint line ("Enter your first name.") describes ANOTHER field
          if (/^(enter|please|invalid|required|error|must|should|this field)\b|\b(is required|invalid)\b/i.test(text)) continue;
          if (text && text.length <= 120) return text;
        }
      }
    } catch (_) {}
    if (tight) return "";
    try {
      const popup = el.closest("[role='dialog'],[role='listbox'],[role='menu'],[aria-modal='true'],[data-radix-popper-content-wrapper],.MuiPopover-root,.MuiMenu-paper,.ant-select-dropdown,.react-select__menu");
      if (popup) return (popup.innerText || popup.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    } catch (_) {}
    return "";
  }

  // ---- v24: structural date-part detection (month / day / year) ----
  const MONTH_RX = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
  function optionTexts(sel) {
    const out = [];
    for (let i = 0; i < sel.options.length; i++) out.push((sel.options[i].text || "").replace(/\s+/g, " ").trim());
    return out;
  }
  function selectShape(sel) {
    if (!sel || sel.tagName !== "SELECT") return "";
    const o = optionTexts(sel).filter(Boolean);
    if (o.length < 10) return "";
    const names = o.filter(function (t) { return MONTH_RX.test(t); }).length;
    if (names >= 12) return "month";
    const nums = o.filter(function (t) { return /^\d{1,4}$/.test(t); }).map(Number);
    if (nums.length >= 10) {
      const max = Math.max.apply(null, nums);
      const min = Math.min.apply(null, nums);
      if (max >= 1000 && min >= 1000) return "year";
      if (max >= 28 && max <= 31 && min <= 1) return "day";
      if (max === 12 && min <= 1) return "month";
    }
    return "";
  }
  function yearInputLike(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const t = (el.type || "text").toLowerCase();
    if (["text", "number", "tel", ""].indexOf(t) === -1) return false;
    const h = [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
    return /\b(year|yyyy|yy)\b|year$|^year/.test(h) || el.maxLength === 4 && /\bd?o?b\b|birth|year/.test(h);
  }
  function datePartOf(el) {
    let shape = "";
    if (el.tagName === "SELECT") shape = selectShape(el);
    else if (yearInputLike(el)) shape = "year";
    if (!shape) return "";
    let cur = el.parentElement;
    for (let d = 0; cur && d < 5; d++, cur = cur.parentElement) {
      const sels = cur.querySelectorAll("select,input");
      if (sels.length > 12) break;
      const shapes = [];
      for (let i = 0; i < sels.length; i++) {
        const sh = sels[i].tagName === "SELECT" ? selectShape(sels[i]) : (yearInputLike(sels[i]) ? "year" : "");
        if (sh) shapes.push(sh);
      }
      const uniq = shapes.filter(function (v, i) { return shapes.indexOf(v) === i; });
      if (uniq.length >= 2 && uniq.indexOf("month") !== -1) return shape;
    }
    return "";
  }
  function nearPhoneInput(el) {
    let cur = el.parentElement;
    for (let d = 0; cur && d < 4; d++, cur = cur.parentElement) {
      if (cur.querySelector("input[type='tel'],input[autocomplete^='tel'],input[name*='phone' i],input[name*='mobile' i],input[placeholder*='phone' i],input[placeholder*='mobile' i]")) return true;
    }
    return false;
  }

  function classifyCore(el, own, context, freshContext) {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    const c = (own + " " + context + " " + freshContext).replace(/\s+/g, " ").trim();

    const ownText = (el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
    if (el.id === "selectedCountry" || /hwid-selectedCountryName/i.test(own) || /selectedcountry/i.test(own)) return "country";
    if (el.getAttribute("data-type") === "fydeos_select" || /\bchoose_value\b/.test(own)) {
      if (/\b(year|birth year|date of birth|dob|birthday)\b/.test(context + " " + own)) return "dobYear";
      if (/\b(month)\b/.test(context + " " + own)) return "dobMonth";
      if (/\b(day)\b/.test(context + " " + own)) return "dobDay";
      return "dob";
    }
    const dpart = datePartOf(el);
    if (dpart === "month") return "dobMonth";
    if (dpart === "day") return "dobDay";
    if (dpart === "year") return "dobYear";
    const hasPhoneSibling = !!(el.parentElement && el.parentElement.querySelector("input[type='tel'],input[autocomplete^='tel'],input[name*='phone' i]"));
    if (role === "combobox" && /^\+\d{1,4}$/.test(ownText) && (/\b(phone|mobile|tel)\b/.test(context + " " + own) || hasPhoneSibling)) return "countryCode";
    if (/^\+\d{1,4}$/.test(ownText) && nearPhoneInput(el)) return "countryCode";

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
    if (/\b(e-?mail)\b/.test(c)) return "email";
    if (/\b(phone|mobile|tel|contact\s*number)\b/.test(c)) return "phone";
    if (/\b(password|pass)\b/.test(c)) return "password";
    if (type === "url" || /\b(web\s*site|website|homepage|home\s*page|site\s*url|url|web\s*address)\b/.test(c)) return "website";
    if (/\b(company|organi[sz]ation|business|employer|firm)\b/.test(c)) return "company";
    if (/\b(first|given)\s*name\b|\bfname\b/.test(c)) return "firstName";
    if (/\b(last|family|sur)\s*name\b|\blname\b/.test(c)) return "lastName";
    if (/\b(full\s*name|your\s*name|name)\b/.test(own)) return "fullName";
    if (/\b(city)\b/.test(c)) return "city";
    if (/\b(state|province|region)\b/.test(c)) return "state";
    if (/\b(zip|postal)\b/.test(c)) return "zip";
    if (/\b(country|nation)\b/.test(c)) return "country";
    if (tag === "textarea" || /\b(message|comment|description)\b/.test(own)) return "message";
    return "text";
  }

  // ---- v27: pickers whose trigger shows only the current value ("India", "INR") ----
  const COUNTRY_NAMES = new Set("afghanistan,albania,algeria,andorra,angola,argentina,armenia,australia,austria,azerbaijan,bahamas,bahrain,bangladesh,barbados,belarus,belgium,belize,benin,bhutan,bolivia,bosnia and herzegovina,botswana,brazil,brunei,bulgaria,burkina faso,burundi,cambodia,cameroon,canada,cape verde,chad,chile,china,colombia,comoros,congo,costa rica,croatia,cuba,cyprus,czech republic,czechia,denmark,djibouti,dominican republic,ecuador,egypt,el salvador,estonia,eswatini,ethiopia,fiji,finland,france,gabon,gambia,georgia,germany,ghana,greece,guatemala,guinea,guyana,haiti,honduras,hong kong,hungary,iceland,india,indonesia,iran,iraq,ireland,israel,italy,ivory coast,jamaica,japan,jordan,kazakhstan,kenya,kosovo,kuwait,kyrgyzstan,laos,latvia,lebanon,lesotho,liberia,libya,liechtenstein,lithuania,luxembourg,macau,madagascar,malawi,malaysia,maldives,mali,malta,mauritania,mauritius,mexico,moldova,monaco,mongolia,montenegro,morocco,mozambique,myanmar,namibia,nepal,netherlands,new zealand,nicaragua,niger,nigeria,north macedonia,norway,oman,pakistan,palestine,panama,papua new guinea,paraguay,peru,philippines,poland,portugal,puerto rico,qatar,romania,russia,rwanda,saudi arabia,senegal,serbia,seychelles,sierra leone,singapore,slovakia,slovenia,somalia,south africa,south korea,korea,south sudan,spain,sri lanka,sudan,suriname,sweden,switzerland,syria,taiwan,tajikistan,tanzania,thailand,togo,trinidad and tobago,tunisia,turkey,turkiye,turkmenistan,uganda,ukraine,united arab emirates,uae,united kingdom,uk,united states,usa,us,uruguay,uzbekistan,venezuela,vietnam,viet nam,yemen,zambia,zimbabwe".split(","));
  const CURRENCY_CODES = new Set("AED,AFN,ALL,AMD,ARS,AUD,AZN,BAM,BDT,BGN,BHD,BRL,BWP,BYN,CAD,CHF,CLP,CNY,COP,CRC,CZK,DKK,DZD,EGP,ETB,EUR,GBP,GEL,GHS,HKD,HRK,HUF,IDR,ILS,INR,IQD,IRR,ISK,JMD,JOD,JPY,KES,KGS,KHR,KRW,KWD,KZT,LAK,LBP,LKR,MAD,MDL,MKD,MMK,MNT,MUR,MXN,MYR,NGN,NOK,NPR,NZD,OMR,PEN,PHP,PKR,PLN,PYG,QAR,RON,RSD,RUB,SAR,SEK,SGD,THB,TND,TRY,TWD,TZS,UAH,UGX,USD,UYU,UZS,VES,VND,XAF,XOF,ZAR,ZMW,BTC,ETH,USDT".split(","));
  function knownPickerType(el) {
    try {
      const raw = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 40) return "";
      const r = el.getBoundingClientRect();
      if (r.width > 520 || r.height > 140) return "";
      let letters = raw.replace(/\([^)]*\)/g, " ").replace(/\+\s*\d+/g, " ").replace(/[^\p{L}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
      // a stray one-letter token is a chevron / icon glyph ("India v", "INR ^")
      letters = letters.split(" ").filter(function (t, i, a) { return !(t.length === 1 && a.length > 1); }).join(" ");
      const low = letters.toLowerCase().replace(/\.$/, "");
      if (low && COUNTRY_NAMES.has(low)) return "country";
      const toks = letters.split(" ").filter(Boolean);
      if (toks.length === 1 && /^[A-Za-z]{3}$/.test(toks[0]) && CURRENCY_CODES.has(toks[0].toUpperCase()) && toks[0] === toks[0].toUpperCase()) return "currency";
    } catch (_) {}
    return "";
  }
  function isCloseLike(el) {
    try {
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, "").trim();
      if (/^(\u00d7|\u2715|\u2716|\u2573|x|X|close|cancel|done)$/i.test(txt)) return true;
      const attrs = [el.getAttribute("aria-label"), el.getAttribute("title"), el.id, typeof el.className === "string" ? el.className : "", el.getAttribute("data-testid")].filter(Boolean).join(" ");
      if (/(^|[\s_-])(close|dismiss|cancel|clear)([\s_-]|$)/i.test(attrs)) return true;
      // icon-only control in the top-right corner of its popup
      if (!txt && el.querySelector && el.querySelector("svg,img,i")) {
        const pop = el.closest("[role='dialog'],[aria-modal='true'],[class*='modal' i],[class*='popup' i],[class*='sheet' i],[class*='drawer' i],[class*='picker' i]");
        if (pop) {
          const a = el.getBoundingClientRect(), b = pop.getBoundingClientRect();
          return a.top - b.top < b.height * 0.25 && b.right - a.right < b.width * 0.25;
        }
      }
    } catch (_) {}
    return false;
  }
  function insidePopup(el) {
    try {
      if (el.closest("[role='dialog'],[role='listbox'],[role='menu'],[aria-modal='true'],[class*='modal' i],[class*='popup' i],[class*='dropdown' i],[class*='sheet' i],[class*='drawer' i],[class*='picker' i],[class*='overlay' i]")) return true;
      // a floating layer (fixed / absolute) a few levels up
      let n = el.parentElement;
      for (let d = 0; n && d < 6; d++, n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === "fixed" || pos === "absolute") return true;
      }
    } catch (_) {}
    return false;
  }
  // something clickable among the ancestors that has a JS click handler but no tag/role/cursor that says so
  function hasClickHandler(el) {
    try {
      if (window.__ddgClicky && window.__ddgClicky.has(el)) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height < (window.innerWidth * window.innerHeight) * 0.4) return true;
      }
      if (typeof el.onclick === "function") return true;
      const ks = Object.keys(el);
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i];
        if (/^__reactProps\$|^__reactEventHandlers\$/.test(k) && el[k] && typeof el[k].onClick === "function") return true;
      }
      if (el._vei && (el._vei.onClick || el._vei.onclick)) return true;
      if (window.jQuery && window.jQuery._data) { const ev = window.jQuery._data(el, "events"); if (ev && ev.click) return true; }
    } catch (_) {}
    return false;
  }

  function splitWords(v) {
    return String(v || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:\/]+/g, " ");
  }
  function classify(el) {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const strongParts = [
      getLabel(el), el.name, el.id, el.getAttribute("aria-label"),
      el.getAttribute("placeholder"), el.getAttribute("data-testid"),
      el.getAttribute("data-field"), el.getAttribute("data-value"),
      el.getAttribute("data-type"), el.getAttribute("title")
    ].filter(Boolean).join(" ");
    const classPart = el.getAttribute("class") || "";
    // raw text plus a camelCase/snake_case split ("countrySelect" -> "country select") so \b rules can see the words
    const strong = (strongParts + " " + splitWords(strongParts)).toLowerCase();
    const ownAll = (strongParts + " " + classPart + " " + splitWords(strongParts + " " + classPart)).toLowerCase();
    const buttonLike = tag === "button" || tag === "a" || role === "button" ||
      (tag === "input" && CLICK_INPUT_TYPES.indexOf(type) !== -1);
    const pickerish = role === "combobox" || role === "listbox" || el.hasAttribute("aria-haspopup") ||
      el.hasAttribute("aria-expanded") && /\b(country|code|select|dial)\b/.test(ownAll);
    // popups that really are option lists. A plain dialog/modal is NOT one: every control in a login modal used to
    // inherit the last picker's type from it.
    const listPopup = el.closest && el.closest("[role='listbox'],[role='menu'],[data-radix-popper-content-wrapper],.MuiPopover-root,.MuiMenu-paper,.ant-select-dropdown,.react-select__menu");
    const optionLike = role === "option" || role === "menuitem" || tag === "li" || !!(listPopup && el !== listPopup);
    const canInherit = optionLike && tag !== "input" && tag !== "textarea" && tag !== "select" && tag !== "button";
    const fresh = canInherit && Date.now() - lastFieldContextAt < 15000 ? lastFieldContext : "";

    // v27: a trigger that only shows its current value ("India", "INR") is the country / currency picker
    if (!optionLike && !listPopup && tag !== "input" && tag !== "textarea" && tag !== "select") {
      const kp = knownPickerType(el);
      if (kp) return kp;
    }
    // class names and the surrounding text only describe real FIELDS; a close icon or a button must not
    // inherit "country" from the title of the popup it sits in
    const fieldLike = tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable ||
      ["textbox", "combobox", "listbox", "searchbox", "spinbutton", "checkbox", "radio", "switch"].indexOf(role) !== -1 ||
      pickerish;
    // 1) the element's own label / name / placeholder, 2) plus its class names, 3) plus its tight surrounding label.
    let r = classifyCore(el, strong + " " + fresh, "", fresh);
    if (r !== "text" || buttonLike && !pickerish) {
      // a plain button never becomes a data field because the form around it talks about dates or phones
      if (buttonLike && !pickerish && ["countryCode", "country", "currency", "dob", "dobYear", "dobMonth", "dobDay", "state"].indexOf(r) !== -1 &&
          !(r === "countryCode" && /^\+\d{1,4}$/.test((el.innerText || el.textContent || "").replace(/\s+/g, "")))) return "text";
      return r;
    }
    if (!fieldLike) return "text";
    r = classifyCore(el, ownAll + " " + fresh, "", fresh);
    if (r !== "text") return r;
    const tight = localContext(el, true).toLowerCase();
    if (!tight) return "text";
    return classifyCore(el, ownAll + " " + tight + " " + fresh, tight, fresh);
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
    if (!IS_TOP) {
      // child frame: hand the tap to the top page, which owns the queue Kotlin drains
      try { window.top.postMessage({ __ddgRec: "cap", payload: item }, "*"); }
      catch (e) { toast("\u26A0 cannot reach top page", "#DC2626", targetEl); return; }
      log("sent to top page from frame " + frameKey());
      toast("Captured \u2014 saving\u2026", "#D97706", targetEl);
      return;
    }
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


  // ---- v28: a big wrapper (login modal, card) is never "the button" ----
  const NATIVE_CTRL = "input,textarea,select,button,a,summary,label,[role='button'],[role='link']";
  function containerish(el) {
    try {
      if (el.matches("input,textarea,select,button,a,summary,label,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='switch'],[role='combobox'],[role='textbox'],[role='option'],[role='tab'],[role='menuitem']")) return false;
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 160) return true;
      const n = el.querySelectorAll(NATIVE_CTRL).length;
      if (n >= 3) return true;
      const r = el.getBoundingClientRect();
      return r.width >= (window.innerWidth || 1) * 0.9 && r.height >= (window.innerHeight || 1) * 0.5;
    } catch (_) { return false; }
  }
  // text that is short enough to be a button caption: the tapped leaf's own text beats a wrapper's whole text
  function shortCaption(label, leaf) {
    label = (label || "").replace(/\s+/g, " ").trim();
    if (label.length <= 50) return label;
    try {
      const t = ((leaf && (leaf.innerText || leaf.textContent)) || "").replace(/\s+/g, " ").trim();
      if (t && t.length <= 50) return t;
    } catch (_) {}
    return label.slice(0, 47) + "…";
  }

  // ---- v28: wheel pickers (day / month / year columns, the centred value is the chosen one) ----
  function dateToken(t) {
    t = (t || "").replace(/\s+/g, " ").trim();
    return t.length > 0 && t.length <= 12 && (/^\d{1,4}$/.test(t) || (MONTH_RX.test(t) && /^[A-Za-z]+\.?$/.test(t)));
  }
  function dateLeaves(root) {
    const out = [];
    let all;
    try { all = root.querySelectorAll("*"); } catch (_) { return out; }
    if (all.length > 400) return out;
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      let kidText = false;
      for (let k = 0; k < n.children.length; k++) { if ((n.children[k].textContent || "").trim()) { kidText = true; break; } }
      if (kidText) continue;
      const t = (n.textContent || "").trim();
      if (!dateToken(t)) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ el: n, t: t, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    return out;
  }
  function stacked(leaves) {
    if (leaves.length < 3) return false;
    const xs = leaves.map(function (l) { return l.cx; }), ys = leaves.map(function (l) { return Math.round(l.cy); });
    return Math.max.apply(null, xs) - Math.min.apply(null, xs) < 60 && new Set(ys).size >= 3;
  }
  function columnShape(leaves) {
    const ts = leaves.map(function (l) { return l.t; });
    if (ts.some(function (t) { return MONTH_RX.test(t) && /^[A-Za-z]/.test(t); })) return "month";
    const nums = ts.map(Number);
    if (nums.some(function (n) { return n >= 1000; })) return "year";
    if (nums.every(function (n) { return n < 100; }) && nums.length >= 3 && nums.some(function (n) { return n >= 13; })) return nums.some(function (n) { return n >= 32; }) ? "year2" : "day";
    return "";   // 1..12: month or day, decided by the neighbouring columns
  }
  function wheelDetect(path) {
    let item = null;
    for (let i = 0; i < Math.min(3, path.length); i++) {
      const el = path[i];
      if (!el || el.nodeType !== 1) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (dateToken(t)) item = el;
      break;
    }
    let col = null, leaves = null;
    if (item) {
      let cur = item.parentElement;
      for (let d = 0; cur && d < 5 && cur !== document.body; d++, cur = cur.parentElement) {
        const lv = dateLeaves(cur);
        if (lv.length >= 3) { col = cur; leaves = lv; break; }
        if (lv.length === 0 && d > 0) break;
      }
    } else {
      // pointer capture / scroll handlers often retarget the tap to the column itself ("2005 2004 2003 2002 2001")
      for (let i = 0; i < Math.min(3, path.length); i++) {
        const el = path[i];
        if (!el || el.nodeType !== 1) continue;
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        const toks = t.split(" ");
        if (toks.length >= 3 && toks.length <= 12 && toks.every(dateToken)) {
          const lv = dateLeaves(el);
          if (lv.length >= 3) { col = el; leaves = lv; item = el; }
        }
        break;
      }
    }
    if (!col) return null;
    if (!col || leaves.length > 12 || !stacked(leaves)) return null;   // a calendar grid has 28+ numbers / rows are horizontal
    // the picker must be about a date of birth
    let ctx = "", n = col;
    for (let d = 0; n && d < 8 && n !== document.body; d++, n = n.parentElement) {
      const t = (n.innerText || "").replace(/\s+/g, " ");
      if (t.length > 1500) break;
      ctx = t;
    }
    const sibling = [];
    // columns next to this one: leaf groups of the nearest ancestor that holds 2+ columns
    let grp = col.parentElement, groupLeaves = null;
    for (let d = 0; grp && d < 4 && grp !== document.body; d++, grp = grp.parentElement) {
      const lv = dateLeaves(grp);
      if (lv.length > 40) break;
      const xs = []; lv.forEach(function (l) { if (!xs.some(function (x) { return Math.abs(x - l.cx) < 40; })) xs.push(l.cx); });
      if (xs.length >= 2) { groupLeaves = lv; break; }
    }
    const cols = [];   // [{cx, leaves, shape}]
    (groupLeaves || leaves).forEach(function (l) {
      let c = cols.filter(function (c) { return Math.abs(c.cx - l.cx) < 40; })[0];
      if (!c) { c = { cx: l.cx, leaves: [], shape: "" }; cols.push(c); }
      c.leaves.push(l);
    });
    cols.sort(function (a, b) { return a.cx - b.cx; });
    cols.forEach(function (c) { c.shape = columnShape(c.leaves); if (c.shape === "year2") c.shape = "year"; });
    const mine = cols.filter(function (c) { return c.leaves.some(function (l) { return l.el === item || l.el.contains(item) || item.contains(l.el) || col.contains(l.el); }); })[0] || cols[0];
    const hasBirth = /\b(birth|dob|born|date of birth|birthday)\b/i.test(ctx) || (lastFieldContextAt && Date.now() - lastFieldContextAt < 60000 && /dob|birth/.test(lastFieldContext));
    const hasYearCol = cols.some(function (c) { return c.shape === "year"; });
    if (!hasBirth && !(hasYearCol && cols.length >= 2)) return null;
    // ambiguous 1..12 columns: day when the others already say month, otherwise left-to-right day, month, year
    const taken = cols.map(function (c) { return c.shape; }).filter(Boolean);
    const order = ["day", "month", "year"];
    cols.forEach(function (c) {
      if (c.shape) return;
      const free = order.filter(function (o) { return taken.indexOf(o) === -1; });
      c.shape = free.length ? free[0] : "month";
      taken.push(c.shape);
    });
    const shape = mine.shape;
    return { col: col, type: shape === "year" ? "dobYear" : shape === "month" ? "dobMonth" : "dobDay" };
  }

  function resolveTarget(path) {
    let actual = null;
    for (let i = 0; i < path.length; i++) {
      const el = path[i];
      if (el === document.documentElement || el === document.body) break;
      try {
        if (isPopupShell(el)) continue;
        if (el.tagName === "LABEL" && el.control) { actual = el.control; break; }
        if ((el.matches(INTERACTIVE) || hasWidgetSemantics(el)) && !containerish(el)) {
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
          if ((st.cursor === "pointer" || hasWidgetSemantics(el)) && !containerish(el)) { actual = el; break; }
        } catch (_) {}
      }
    }

    // v27: icons (svg/span) inside a control whose handler is plain JS: walk up further, look for a click handler,
    // a pointer cursor, or a button-ish class; never pick something that fills the whole page
    if (!actual) {
      const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      for (let i = 0; i < Math.min(path.length, 12); i++) {
        const el = path[i];
        if (!el || el === document.documentElement || el === document.body) break;
        try {
          if (isPopupShell(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= vw * 0.95 && r.height >= vh * 0.6) break;
          const cls = (typeof el.className === "string" ? el.className : (el.getAttribute && el.getAttribute("class")) || "").toLowerCase();
          const st = getComputedStyle(el);
          if (hasClickHandler(el) || st.cursor === "pointer" ||
              /(^|[\s_-])(btn|button|icon-?btn|clickable|trigger|toggle)([\s_-]|$)/.test(cls) ||
              /(button|btn|icon)/i.test(el.getAttribute("data-testid") || "") || el.hasAttribute("aria-label") && st.cursor !== "default" && r.width < 120) {
            actual = el; break;
          }
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
    // v28: nothing looked clickable but the person tapped it on purpose: a small text or icon leaf is a step, not a skip
    if (!actual) {
      for (let i = 0; i < Math.min(path.length, 3); i++) {
        const el = path[i];
        if (!el || el === document.documentElement || el === document.body || isPopupShell(el)) break;
        try {
          const r = el.getBoundingClientRect();
          if (r.width > (window.innerWidth || 1) * 0.8 || r.height > 160 || r.width < 6 || r.height < 6) continue;
          const tg = (el.tagName || "").toLowerCase();
          const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          const iconish = /^(svg|path|img|i|use|g)$/.test(tg);
          if (iconish) {
            const host = el.closest("svg") ? (el.closest("svg").parentElement || el.closest("svg")) : el;
            const hr = host.getBoundingClientRect();
            actual = hr.width <= 120 && hr.height <= 120 ? host : el;
            break;
          }
          if (t && t.length <= 40 && !containerish(el)) { actual = el; break; }
        } catch (_) {}
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

      let wheel = null;
      try { wheel = wheelDetect(path); } catch (_) {}
      const actual = wheel ? wheel.col : resolveTarget(path);
      if (!actual) { ignore("IGNORED (" + src + "): no interactive target, tapped " + describe(path[0]), path[0]); return; }
      if (!isVisible(actual) && !isBoxy(actual)) { ignore("IGNORED (" + src + "): not visible " + describe(actual), actual); return; }

      const now = Date.now();
      // v27: the X / close icon of a "Choose country" style popup is not a step
      if (now - lastPickerAt < 60000 && isCloseLike(actual) && insidePopup(actual)) {
        ignore("IGNORED (" + src + "): closing a picker list", actual); return;
      }
      if (actual === lastTarget && now - lastTime < (isTextField(actual) ? 1200 : 500)) { return; }
      lastTarget = actual;
      lastTime = now;

      const tag = actual.tagName.toLowerCase();
      const type = (actual.type || "").toLowerCase();
      const role = (actual.getAttribute("role") || "").toLowerCase();
      const semanticField = FIELD_ROLES.indexOf(role) !== -1 ||
        actual.matches("[aria-haspopup='listbox'],[aria-autocomplete],[data-datepicker],[data-date-picker],[data-type='fydeos_select'],.choose_value,#selectedCountry,.hwid-selectedCountryName,[id*='selectedCountry'],[class*='date-picker'],[class*='datepicker'],[class*='MuiSelect'],[class*='ant-select'],[class*='react-select']") || isCustomSelectLike(actual);
      if (wheel) {
        if ((lastWheelCol === actual && now - lastWheelAt < 30000) || (wheelSeen.get(actual) && now - wheelSeen.get(actual) < 120000)) { ignore("IGNORED (" + src + "): same wheel tapped again", actual); return; }
        lastWheelCol = actual; lastWheelAt = now; wheelSeen.set(actual, now);
      }
      let inferredType = wheel ? wheel.type : classify(actual);
      // a drop-down with options that matches no data type ("monthly volume"): the step re-picks what was chosen now
      const isChoice = !wheel && tag === "select" && inferredType === "text";
      if (isChoice) inferredType = "choice";
      if (["dob", "dobYear", "dobMonth", "dobDay", "country", "countryCode", "currency"].indexOf(inferredType) !== -1) {
        lastFieldContext = inferredType.indexOf("dob") === 0 ? "date of birth dob" : inferredType;
        lastFieldContextAt = Date.now();
      }
      const isDatePart = ["dob", "dobYear", "dobMonth", "dobDay"].indexOf(inferredType) !== -1;
      if (["country", "countryCode", "currency", "state"].indexOf(inferredType) !== -1 && !isTextField(actual)) {
        // the same picker tapped again (to close it, or to re-open it) is still ONE step
        if (lastPickerEl === actual && now - lastPickerAt < 20000) { ignore("IGNORED (" + src + "): same picker tapped again", actual); return; }
        lastPickerEl = actual; lastPickerAt = now;
      }
      // v21: "state" added so custom state/province dropdowns are Fields, not ClickNext
      const isSemanticPicker = ["country", "countryCode", "currency", "state"].indexOf(inferredType) !== -1;
      const isFieldLike =
        tag === "textarea" || tag === "select" ||
        (tag === "input" && CLICK_INPUT_TYPES.indexOf(type) === -1) ||
        actual.isContentEditable || semanticField || isDatePart || isSemanticPicker || isChoice;
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

      const label = wheel ? "date wheel" : getLabel(actual);
      const chosenNow = function (sel) { try { const o = sel.options[sel.selectedIndex]; return o ? (o.text || o.label || o.value || "").replace(/\s+/g, " ").trim().slice(0, 90) : ""; } catch (_) { return ""; } };
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
        frameHost: IS_TOP ? "" : frameKey(),
        frameDepth: IS_TOP ? 0 : frameDepth(),
        frameUrl: IS_TOP ? "" : String(location.href).slice(0, 200),
        displayLabel: label || "Element",
        wheel: !!wheel,
        chosen: isChoice ? chosenNow(actual) : "",
        buttonLabel: kind === "ClickNext" ? (shortCaption(label, path[0]) || "Button") : "",
        verified: true,
      };
      S.captured++;
      log("CAPTURED (" + src + "):", tag, payload.displayLabel);
      payload.seq = ++S.seq;
      S.pending.set(payload.seq, { el: actual, label: payload.displayLabel || tag });
      if (S.pending.size > 30) S.pending.delete(S.pending.keys().next().value);
      sendToBridge(payload, actual);

      // the option is picked AFTER the tap: tell the step what was chosen
      if (isChoice) {
        const onPick = function () {
          const upd = { kind: "Update", op: "choice", cssSelector: payload.cssSelector, xpath: payload.xpath, frameHost: payload.frameHost, frameDepth: payload.frameDepth, chosen: chosenNow(actual), seq: ++S.seq };
          S.pending.set(upd.seq, { el: actual, label: "choice " + upd.chosen });
          sendToBridge(upd, actual);
        };
        try {
          actual.addEventListener("change", onPick);
          setTimeout(function () { try { actual.removeEventListener("change", onPick); } catch (_) {} }, 120000);
        } catch (_) {}
      }

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

  // ---- iframe plumbing ----
  function onFrameMessage(ev) {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.__ddgRec === undefined) return;
    try {
      if (d.__ddgRec === "cap" && IS_TOP) {
        // a child frame captured a tap
        const src = ev.source;
        const pl = d.payload;
        if (!pl || typeof pl !== "object" || src === window) return;
        const localId = pl.seq;
        const reply = function (ok, msg) {
          try { src.postMessage({ __ddgRec: "ack", localId: localId, ok: ok, msg: msg }, "*"); } catch (_) {}
        };
        if (!S.active) { reply(false, "recorder not active"); return; }
        if (S.isPaused) { reply(false, "recording is paused"); return; }
        pl.seq = ++S.seq;
        S.pending.set(pl.seq, { src: src, localId: localId, label: pl.displayLabel || pl.tag || "" });
        if (S.pending.size > 30) S.pending.delete(S.pending.keys().next().value);
        if (S.outbox.length >= CFG.OUTBOX_MAX) S.outbox.shift();
        S.outbox.push(pl);
        S.captured++; S.frameCaptured++;
        log("CAPTURED in frame " + (pl.frameHost || "?") + ": " + (pl.displayLabel || pl.tag));
        return;
      }
      if (d.__ddgRec === "hello" && IS_TOP) {
        const s2 = ev.source;
        if (s2 && s2 !== window) s2.postMessage({ __ddgRec: "ctl", cmd: S.active ? (S.isPaused ? "pause" : "resume") : "stop" }, "*");
        return;
      }
      if (!IS_TOP && (ev.source === window.parent || ev.source === window.top)) {
        if (d.__ddgRec === "ack") {
          const p = S.pending.get(d.localId);
          S.pending.delete(d.localId);
          const label = p ? p.label : "";
          if (d.ok) toast("\u2713 Recorded " + (d.msg || "") + (label ? ": " + label : ""), "#10B981", p && p.el);
          else toast("\u2717 Not recorded: " + d.msg, "#DC2626", p && p.el);
        } else if (d.__ddgRec === "ctl") {
          if (d.cmd === "pause") { S.isPaused = true; restoreKeyboard(); }
          else if (d.cmd === "resume") S.isPaused = false;
          else if (d.cmd === "stop") { relayCtl("stop"); stop(); return; }
          relayCtl(d.cmd);
        }
      }
    } catch (_) {}
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

    on("message", onFrameMessage, cap);
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
    if (IS_TOP && S.active) relayCtl("stop");
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

    g.__automationRecorderPause = function () { S.isPaused = true; restoreKeyboard(); relayCtl("pause"); log("Recorder paused"); };
    g.__automationRecorderResume = function () { S.isPaused = false; relayCtl("resume"); log("Recorder resumed"); };
    g.__automationRecorderStop = stop;
    g.__automationRecorderDrain = function () {
      if (!S.outbox.length) return "";
      return JSON.stringify(S.outbox.splice(0, S.outbox.length));
    };
    g.__automationRecorderAck = function (seq, ok, msg) {
      const p = S.pending.get(seq);
      S.pending.delete(seq);
      const label = p ? p.label : "";
      if (p && p.src) {   // the tap came from a child frame: the toast must appear inside that frame
        try { p.src.postMessage({ __ddgRec: "ack", localId: p.localId, ok: !!ok, msg: msg }, "*"); } catch (_) {}
        return;
      }
      if (ok) toast("\u2713 Recorded " + (msg || "") + (label ? ": " + label : ""), "#10B981", p && p.el);
      else toast("\u2717 Not recorded: " + msg, "#DC2626", p && p.el);
    };
    g.__automationRecorderHealth = function () {
      return JSON.stringify({
        version: S.version, installed: !!g.__automationRecorderInstalled, active: S.active, paused: S.isPaused,
        listeners: S.listeners.length, outbox: S.outbox.length,
        bridge: !!(window.AutomationBridge && window.AutomationBridge.onElementRecorded),
        boundToThisDoc: S.doc === document, readyState: document.readyState, url: location.href,
        seen: S.seen || 0, captured: S.captured, fromFrames: S.frameCaptured, frames: (function () { try { return window.frames.length; } catch (_) { return -1; } })(), ignored: S.ignored, rebinds: S.rebinds, lastBridgeError: S.lastBridgeError || "", pendingAcks: S.pending.size,
      });
    };

    g.__automationRecorderInstalled = true;
    setTimeout(function () { toast("Recorder " + VERSION + (IS_TOP ? "" : " (frame " + frameKey() + ")") + " ready", "#2563EB", null); }, 400);
    if (!IS_TOP) { try { window.top.postMessage({ __ddgRec: "hello" }, "*"); } catch (_) {} }
    log("Recorder " + VERSION + " installed readyState=" + document.readyState + " url=" + location.href);
  } catch (err) {
    warn("INSTALL FAILED, will retry on next injection:", err && err.message);
    try { stop(); } catch (_) {}
  }
})();