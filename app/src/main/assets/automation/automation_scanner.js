/*
 * Automation Scanner (v21 - Robust Field & Custom Dropdown Detection)
 * ------------------------------------------------------------
 * Fixes:
 *  - Huawei country selector incorrectly detected as Next/button
 *  - Country-code matching (+91, 91, India)
 *  - Custom dropdowns using div/li/span
 *  - FydeOS birth-year selector
 *  - Better field classification
 *  - Exact option matching before partial matching
 *  - Avoid dropdowns being included as action buttons
 *  - Shadow DOM and same-origin iframe scanning
 */
(function () {
  "use strict";

  const g = globalThis;

  if (g.__automationScannerInstalled) {
    try { g.__automationScan(); } catch (_) {}
    return;
  }

  g.__automationScannerInstalled = true;
  g.__automation_active = false;

  const CFG = {
    MAX_IFRAME_DEPTH: 2,
    MAX_SHADOW_DEPTH: 3,
    MIN_SIZE_PX: 2,
    FILL_DELAY_MS: 50,
    CLICK_SETTLE_POLL_MS: 100
  };

  const originalFocus = HTMLElement.prototype.focus;

  HTMLElement.prototype.focus = function (...args) {
    if (g.__automation_active) return;
    return originalFocus.apply(this, args);
  };

  const RX = {
    otp: /\b(otp|one[-\s]?time\s*(code|password)|2fa|verification\s*code|security\s*code|sms\s*code|auth\s*code)\b/i,
    confirm_password: /\b(confirm|repeat|re-?enter|verify)\b.*\b(password|pass)\b|\b(password|pass)\b.*\b(confirm|repeat)\b/i,
    confirm_email: /\b(confirm|repeat|re-?enter|verify)\b.*\b(e-?mail)\b|\b(e-?mail)\b.*\b(confirm|repeat)\b/i,
    password: /\b(password|passwd|passcode|pwd)\b/i,
    email: /\b(e-?mail|mail)\b/i,
    phone: /\b(phone|mobile|cell|tel|whatsapp|contact\s*number)\b/i,
    firstname: /\b(first|given)\s*name\b|\bfname\b|\bforename\b/i,
    lastname: /\b(last|family|sur)\s*name\b|\blname\b|\bsurname\b/i,
    middlename: /\b(middle|mid)\s*name\b/i,
    fullname: /\b(full\s*name|your\s*name|display\s*name)\b/i,
    username: /\b(user[\s_-]?name|user[\s_-]?id|login|handle|screen[\s_-]?name)\b/i,
    message: /\b(message|comment|feedback|description|bio|notes?|details?)\b/i,
    dob: /\b(dob|date\s*of\s*birth|birth[\s_-]?date|birthday|bday)\b/i,
    zip: /\b(zip|postal|post[\s_-]?code|pin\s*code|pincode)\b/i,
    city: /\b(city|town|ville)\b/i,
    state: /\b(state|province|region|county)\b/i,
    country: /\b(country|nation|country\s*\/\s*region|country\s*region)\b/i,
    countrycode: /\b(country\s*(calling\s*)?code|calling\s*code|dial(?:ling)?\s*code|phone\s*code|countrycode|dialcode|country\s*prefix)\b/i,
    currency: /\b(currency|select currency|billing currency|payment currency|iso-4217)\b/i,
    address: /\b(address|street|line\s*1|line\s*2|apartment|apt)\b/i,
    company: /\b(company|organi[sz]ation|employer|business)\b/i,
    jobtitle: /\b(job\s*title|position|role|occupation|designation)\b/i,
    gender: /\b(gender|sex)\b/i,
    terms: /\b(terms|agree|consent|privacy|policy|accept|conditions)\b/i,
    year: /\b(birth\s*year|year\s*of\s*birth|dob\s*year|yyyy)\b/i,
    month: /\b(birth\s*month|dob\s*month)\b/i,
    day: /\b(birth\s*day|dob\s*day)\b/i
  };

  const BTN_POS =
    /\b(next|continue|submit|sign\s*up|signup|register|create|join|proceed|verify|confirm|finish|done|save|send|login|log\s*in|sign\s*in|apply)\b/i;

  const BTN_NEG =
    /\b(back|previous|prev|cancel|close|dismiss|reset|clear|delete|remove|log\s*out|sign\s*out|logout|skip|forgot|resend|no\s*thanks|not\s*now|decline|reject|deny)\b/i;

  const COUNTRY_SELECTOR_SELECTOR =
    "#selectedCountry,.hwid-selectedCountryName,[id*='selectedCountry'],[ht*='selectedCountry']";

  const CUSTOM_SELECT_SELECTOR = [
    "[role=combobox]",
    "[role=listbox]",
    "[aria-haspopup=listbox]",
    "[data-type=fydeos_select]",
    ".choose_value",
    "#selectedCountry",
    ".hwid-selectedCountryName",
    "[id*='selectedCountry']",
    ".MuiSelect-select",
    ".ant-select-selector",
    ".react-select__control",
    "[data-dropdown]",
    "[data-select]",
    ".select-trigger",
    ".dd",
    ".ctl"
  ].join(",");

  const OPTION_SELECTOR = [
    "[role=option]",
    "[role=menuitem]",
    "[data-value]",
    "[data-country]",
    "[data-code]",
    "[data-dial-code]",
    "[data-phone-code]",
    ".MuiMenuItem-root",
    ".ant-select-item-option",
    ".chakra-menu__menuitem",
    ".dropdown-item",
    ".select-option",
    ".dd-i",
    ".hwid-country-item",
    ".hwid-country-list li",
    ".country-item",
    ".country-option",
    ".option",
    ".year-item",
    "li",
    "button",
    "div",
    "span"
  ].join(",");

  const FIELD_SELECTOR = [
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file])",
    "textarea",
    "select",
    "[role=combobox]",
    "[role=textbox]",
    "[contenteditable=true]",
    '[contenteditable=""]',
    ".dd",
    ".ctl",
    ".select-trigger",
    "[data-dropdown]",
    "[data-select]",
    "[data-type=fydeos_select]",
    ".choose_value",
    "#selectedCountry",
    ".hwid-selectedCountryName",
    "[id*='selectedCountry']",
    "[aria-haspopup=listbox]",
    ".MuiSelect-select",
    ".ant-select-selector",
    ".react-select__control"
  ].join(",");

  const BUTTON_SELECTOR =
    "button,a[role=button],input[type=submit],input[type=button],input[type=image],[role=button]:not(a),[onclick]";

  let refCounter = 0;
  const elToRef = new WeakMap();
  const refToEl = new Map();

  function getRef(el) {
    if (!el) return null;

    let r = elToRef.get(el);
    if (r) return r;

    r = "r" + (++refCounter);
    elToRef.set(el, r);

    try {
      refToEl.set(r, new WeakRef(el));
    } catch (_) {
      refToEl.set(r, { deref: () => el });
    }

    try {
      el.setAttribute("data-dd-ref", r);
    } catch (_) {}

    return r;
  }

  function getByRef(ref) {
    const w = refToEl.get(ref);
    if (!w) return null;
    const el = w.deref ? w.deref() : null;
    return el && el.isConnected ? el : null;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function dispatchElementEvent(el, type, init, preferInputEvent) {
    const view =
      el && el.ownerDocument && el.ownerDocument.defaultView || window;

    const Ctor =
      preferInputEvent && view.InputEvent ? view.InputEvent : view.Event;

    try {
      el.dispatchEvent(new Ctor(type, init || { bubbles: true }));
    } catch (_) {
      try {
        el.dispatchEvent(new view.Event(type, { bubbles: true }));
      } catch (_) {}
    }
  }

  const txt = el =>
    el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "";

  const attr = (el, name) =>
    el && el.getAttribute ? el.getAttribute(name) || "" : "";

  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    try {
      let node = el;

      while (node && node.nodeType === 1) {
        if (
          node.hasAttribute("hidden") ||
          attr(node, "aria-hidden") === "true" ||
          node.hasAttribute("inert")
        ) return false;

        const view = node.ownerDocument && node.ownerDocument.defaultView;
        const st = view && view.getComputedStyle(node);

        if (
          !st ||
          st.display === "none" ||
          st.visibility === "hidden" ||
          st.visibility === "collapse" ||
          st.contentVisibility === "hidden" ||
          parseFloat(st.opacity) === 0
        ) return false;

        node =
          node.parentElement ||
          (node.getRootNode && node.getRootNode().host) ||
          null;
      }

      const r = el.getBoundingClientRect();

      if (r.width < CFG.MIN_SIZE_PX && r.height < CFG.MIN_SIZE_PX)
        return false;

      return r.right >= -2000 && r.bottom >= -2000;
    } catch (_) {
      return false;
    }
  }

  function isVisuallyHiddenControl(el) {
    if (
      !el ||
      !el.isConnected ||
      el.tagName !== "INPUT" ||
      !/^(checkbox|radio)$/i.test(el.type || "")
    ) return false;

    try {
      let node = el;

      while (node && node.nodeType === 1) {
        if (
          node.hasAttribute("hidden") ||
          node.hasAttribute("inert") ||
          attr(node, "aria-hidden") === "true"
        ) return false;

        const view = node.ownerDocument && node.ownerDocument.defaultView;
        const st = view && view.getComputedStyle(node);

        if (
          !st ||
          st.display === "none" ||
          st.visibility === "hidden" ||
          st.visibility === "collapse"
        ) return false;

        node =
          node.parentElement ||
          (node.getRootNode && node.getRootNode().host) ||
          null;
      }

      const labels = [];

      if (el.labels) {
        for (const label of el.labels) labels.push(label);
      }

      const wrapping = el.closest && el.closest("label");
      if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);

      if (el.id) {
        const linked = el.ownerDocument.querySelector(
          'label[for="' + CSS.escape(el.id) + '"]'
        );
        if (linked && !labels.includes(linked)) labels.push(linked);
      }

      return labels.some(label => isVisible(label));
    } catch (_) {
      return false;
    }
  }

  function isDisabled(el) {
    if (!el) return true;

    if (
      el.disabled === true ||
      el.inert === true ||
      attr(el, "aria-disabled") === "true" ||
      (el.closest && el.closest("[inert]"))
    ) return true;

    return false;
  }

  function findLabel(el) {
    if (!el) return "";

    const out = [];

    try {
      if (el.labels && el.labels.length) {
        for (const l of el.labels) {
          const t = txt(l).slice(0, 120);
          if (t && !out.includes(t)) out.push(t);
        }
      }

      if (el.id) {
        try {
          const l = el.ownerDocument.querySelector(
            'label[for="' + CSS.escape(el.id) + '"]'
          );
          if (l) {
            const t = txt(l).slice(0, 120);
            if (t && !out.includes(t)) out.push(t);
          }
        } catch (_) {}
      }

      const wrap = el.closest && el.closest("label");
      if (wrap) {
        const t = txt(wrap).slice(0, 120);
        if (t && !out.includes(t)) out.push(t);
      }

      const lblBy = attr(el, "aria-labelledby");

      if (lblBy) {
        for (const id of lblBy.split(/\s+/)) {
          const n = el.ownerDocument.getElementById(id);
          if (n) {
            const t = txt(n);
            if (t && !out.includes(t)) out.push(t);
          }
        }
      }
    } catch (_) {}

    return out.join(" ").trim();
  }

  function combinedLabel(el) {
    const parts = [
      attr(el, "placeholder"),
      attr(el, "aria-label"),
      attr(el, "title"),
      attr(el, "name"),
      el.id,
      attr(el, "autocomplete"),
      attr(el, "inputmode"),
      attr(el, "data-testid"),
      attr(el, "data-name"),
      attr(el, "data-type"),
      attr(el, "ht"),
      findLabel(el)
    ];

    try {
      let node = el;

      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        let prev = node.previousElementSibling;

        for (let n = 0; prev && n < 2; n++, prev = prev.previousElementSibling) {
          const t = txt(prev);
          if (t && t.length <= 120) parts.push(t);
        }
      }

      const wrap = el.closest(
        "[data-field],[class*='form-group' i],[class*='form-field' i],[class*='field-wrapper' i],[role='group']"
      );

      if (wrap) parts.push(txt(wrap).slice(0, 180));
    } catch (_) {}

    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  const AUTOCOMPLETE_MAP = {
    "given-name": "firstname",
    "family-name": "lastname",
    "additional-name": "middlename",
    name: "fullname",
    email: "email",
    username: "username",
    "current-password": "password",
    "new-password": "password",
    "one-time-code": "otp",
    tel: "phone",
    "tel-national": "phone",
    "street-address": "address",
    "address-line1": "address",
    "address-line2": "address",
    "address-level1": "state",
    "address-level2": "city",
    "postal-code": "zip",
    country: "country",
    "country-name": "country",
    "bday-day": "dobday",
    "bday-month": "dobmonth",
    "bday-year": "dobyear",
    bday: "dob",
    organization: "company",
    "organization-title": "jobtitle",
    sex: "gender"
  };

  function isHuaweiCountry(el) {
    if (!el) return false;

    return (
      el.id === "selectedCountry" ||
      el.matches(".hwid-selectedCountryName") ||
      /selectedCountry/i.test(attr(el, "ht")) ||
      /hwid-selectedCountryName/i.test(el.className || "")
    );
  }

  function isFydeosYear(el) {
    if (!el) return false;

    return (
      attr(el, "data-type") === "fydeos_select" ||
      el.matches(".choose_value") ||
      /\b(year|birth)\b/i.test(combinedLabel(el))
    );
  }

  function isCountryCode(el) {
    if (!el) return false;

    const role = attr(el, "role").toLowerCase();
    const value = txt(el);

    if (RX.countrycode.test(combinedLabel(el))) return true;

    if (
      role === "combobox" &&
      /^\+\d{1,4}$/.test(value)
    ) return true;

    if (
      el.matches("[data-dial-code],[data-phone-code],[data-country-code]")
    ) return true;

    return false;
  }

  function classify(el) {
    if (!el) return "text";

    // Specific widget identification must take priority over generic button logic.
    if (isHuaweiCountry(el)) return "country";
    if (isCountryCode(el)) return "countrycode";
    if (isFydeosYear(el)) return "dobyear";

    const ac = attr(el, "autocomplete").toLowerCase().split(/\s+/)[0];

    if (ac && AUTOCOMPLETE_MAP[ac]) return AUTOCOMPLETE_MAP[ac];

    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = attr(el, "role").toLowerCase();

    if (type === "password") return "password";
    if (type === "email") return "email";
    if (type === "tel") return "phone";

    const c = combinedLabel(el);

    if (type === "checkbox" || role === "checkbox" || role === "switch")
      return "termscheckbox";

    if (type === "radio" || role === "radio") {
      if (RX.gender.test(c)) return "gender";
      return "termscheckbox";
    }

    if (RX.currency.test(c)) return "currency";

    if (
      /\b(birth|date of birth|dob|birthday)\s*(year|month|day)\b|\b(year|month|day)\s*(of birth|dob)\b/i.test(c)
    ) {
      if (/\byear\b/i.test(c)) return "dobyear";
      if (/\bmonth\b/i.test(c)) return "dobmonth";
      if (/\bday\b/i.test(c)) return "dobday";
    }

    if (RX.confirm_password.test(c)) return "confirmpassword";
    if (RX.confirm_email.test(c)) return "confirmemail";
    if (RX.otp.test(c)) return "otp";
    if (RX.password.test(c)) return "password";
    if (RX.email.test(c)) return "email";
    if (RX.phone.test(c)) return "phone";
    if (RX.firstname.test(c)) return "firstname";
    if (RX.middlename.test(c)) return "middlename";
    if (RX.lastname.test(c)) return "lastname";
    if (RX.dob.test(c)) return "dob";
    if (RX.fullname.test(c)) return "fullname";
    if (RX.username.test(c)) return "username";
    if (RX.zip.test(c)) return "zip";
    if (RX.city.test(c)) return "city";
    if (RX.state.test(c)) return "state";
    if (RX.country.test(c)) return "country";
    if (RX.address.test(c)) return "address";
    if (RX.company.test(c)) return "company";
    if (RX.jobtitle.test(c)) return "jobtitle";
    if (RX.gender.test(c)) return "gender";
    if (tag === "textarea" || role === "textbox" || RX.message.test(c))
      return "message";

    return "text";
  }

  function isCustomSelectTrigger(el) {
    if (!el) return false;

    const role = attr(el, "role").toLowerCase();

    if (
      role === "combobox" ||
      role === "listbox" ||
      attr(el, "aria-haspopup") === "listbox" ||
      attr(el, "data-type") === "fydeos_select" ||
      isHuaweiCountry(el) ||
      isCountryCode(el) ||
      el.matches(CUSTOM_SELECT_SELECTOR)
    ) return true;

    const cls = (el.className || "").toString().toLowerCase();

    if (/\b(mui-?select|ant-?select|chakra-?select|react-?select|rs-?select|v-?select|select2|choices|dd-?trigger|dd-?toggle)\b/.test(cls))
      return true;

    return false;
  }

  function collectAll(doc, selector) {
    const out = [];
    const seen = new Set();
    let visitedNodes = 0;
    let visitedFrames = 0;

    function addMatches(root) {
      try {
        for (const el of Array.from(root.querySelectorAll(selector))) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch (_) {}
    }

    function walk(root, shadowDepth, frameDepth) {
      if (
        !root ||
        shadowDepth > CFG.MAX_SHADOW_DEPTH ||
        visitedNodes >= 5000 ||
        visitedFrames >= 20
      ) return;

      addMatches(root);

      let nodeList;
      try {
        nodeList = root.querySelectorAll("*");
      } catch (_) {
        return;
      }

      for (const el of nodeList) {
        if (++visitedNodes >= 5000) break;

        if (el.shadowRoot && shadowDepth < CFG.MAX_SHADOW_DEPTH) {
          walk(el.shadowRoot, shadowDepth + 1, frameDepth);
        }

        if (el.tagName === "IFRAME" && frameDepth < CFG.MAX_IFRAME_DEPTH) {
          try {
            const frameDoc = el.contentDocument;
            if (frameDoc && frameDoc.documentElement) {
              visitedFrames++;
              walk(frameDoc, 0, frameDepth + 1);
            }
          } catch (_) {}
        }
      }
    }

    walk(doc, 0, 0);
    return out;
  }

  function isSelectorOnlyElement(el) {
    return (
      isHuaweiCountry(el) ||
      isCountryCode(el) ||
      isFydeosYear(el) ||
      isCustomSelectTrigger(el)
    );
  }

  function scanPage() {
    if (document.readyState === "loading") return emptyResult();

    const fieldElements = collectAll(document, FIELD_SELECTOR);
    const fields = [];
    const seenFields = new Set();

    for (const el of fieldElements) {
      try {
        if (
          !el ||
          !el.isConnected ||
          (!isVisible(el) && !isVisuallyHiddenControl(el)) ||
          isDisabled(el) ||
          seenFields.has(el)
        ) continue;

        if (el.type === "search" || (el.closest && el.closest("[role=search]")))
          continue;

        seenFields.add(el);

        const tag = (el.tagName || "").toLowerCase();
        const type = (el.type || "").toLowerCase();
        const ref = getRef(el);
        const looksLike = classify(el);

        let kind;

        if (tag === "select") kind = "native";
        else if (type === "date" || looksLike === "dob") kind = "date";
        else if (isCustomSelectTrigger(el)) kind = "custom-select";
        else kind = "native";

        fields.push({
          index: fields.length,
          ref,
          tag,
          type,
          kind,
          name: attr(el, "name") || findLabel(el) || el.id || "",
          looksLike: looksLike || "text",
          currentValue: el.value || txt(el) || "",
          required: !!(el.required || attr(el, "aria-required") === "true")
        });
      } catch (_) {}
    }

    const btnElements = collectAll(document, BUTTON_SELECTOR);
    const seenButtons = new Set();
    const buttons = [];

    for (const el of btnElements) {
      try {
        if (
          !el ||
          !el.isConnected ||
          !isVisible(el) ||
          isDisabled(el) ||
          seenButtons.has(el) ||
          isSelectorOnlyElement(el)
        ) continue;

        seenButtons.add(el);

        const label = (
          txt(el) ||
          attr(el, "value") ||
          attr(el, "aria-label") ||
          ""
        ).trim();

        let score = 0;

        if ((el.type || "").toLowerCase() === "submit") score += 50;
        if (el.tagName.toLowerCase() === "button") score += 10;
        if (BTN_POS.test(label)) score += 100;
        if (BTN_NEG.test(label)) score -= 150;

        buttons.push({
          ref: getRef(el),
          label: label.slice(0, 60),
          score
        });
      } catch (_) {}
    }

    buttons.sort((a, b) => b.score - a.score);

    const bestBtn = buttons[0] || null;

    sendToBridge(fields);

    return {
      url: location.href,
      title: document.title || "",
      fields,
      buttons,
      links: [],
      actionButtonRef: bestBtn ? bestBtn.ref : "",
      actionButtonName: bestBtn ? bestBtn.label : "",
      captchaDetected: false,
      captchaType: "",
      cookieBannerPresent: false,
      scanMeta: {
        sameOriginFramesIncluded: true,
        openShadowRootsIncluded: true
      },
      errorMessages: []
    };
  }

  function emptyResult() {
    return {
      url: location.href,
      fields: [],
      buttons: [],
      links: [],
      actionButtonRef: "",
      actionButtonName: "",
      captchaDetected: false,
      captchaType: "",
      cookieBannerPresent: false,
      hasIframes: false,
      iframeCount: 0,
      crossOriginIframeCount: 0,
      errorMessages: []
    };
  }

  function sendToBridge(fields) {
    const payload = JSON.stringify(fields);
    let attempts = 0;

    (function trySend() {
      attempts++;

      try {
        if (
          window.AutomationBridge &&
          typeof window.AutomationBridge.onFieldsDetected === "function"
        ) {
          window.AutomationBridge.onFieldsDetected(payload);
          return;
        }
      } catch (_) {}

      if (attempts < 5) setTimeout(trySend, 200);
    })();
  }

  function normalizeText(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function normalizeCode(s) {
    return String(s || "").replace(/[^\d+]/g, "");
  }

  function getOptionText(el) {
    return [
      txt(el),
      attr(el, "aria-label"),
      attr(el, "title"),
      attr(el, "data-value"),
      attr(el, "data-country"),
      attr(el, "data-code"),
      attr(el, "data-dial-code"),
      attr(el, "data-phone-code"),
      attr(el, "data-country-code")
    ].filter(Boolean).join(" ").trim();
  }

  function getOptionCandidates(doc) {
    const all = collectAll(doc, OPTION_SELECTOR);
    const candidates = [];

    for (const el of all) {
      if (
        !el ||
        !el.isConnected ||
        !isVisible(el) ||
        isDisabled(el) ||
        candidates.includes(el)
      ) continue;

      const text = getOptionText(el);
      if (!text) continue;

      candidates.push(el);
    }

    return candidates;
  }

  function findMatchingOption(candidates, target, type) {
    const wanted = normalizeText(target);
    const wantedCode = normalizeCode(target);

    // Exact visible text/data matches first.
    let chosen = candidates.find(el => {
      const text = normalizeText(txt(el));
      const data = normalizeText(attr(el, "data-value"));
      const country = normalizeText(attr(el, "data-country"));
      const code = normalizeText(
        attr(el, "data-code") ||
        attr(el, "data-dial-code") ||
        attr(el, "data-phone-code") ||
        attr(el, "data-country-code")
      );

      return (
        text === wanted ||
        data === wanted ||
        country === wanted ||
        code === wanted
      );
    });

    if (chosen) return chosen;

    // Country calling-code matching: +91, 91, India (+91).
    if (type === "countrycode") {
      chosen = candidates.find(el => {
        const combined = getOptionText(el);
        const optionCode = normalizeCode(combined);
        return wantedCode && optionCode.includes(wantedCode);
      });

      if (chosen) return chosen;
    }

    // Exact normalized text match.
    chosen = candidates.find(el =>
      normalizeText(getOptionText(el)) === wanted
    );

    if (chosen) return chosen;

    // Partial text matching last to reduce accidental wrong selections.
    chosen = candidates.find(el =>
      normalizeText(getOptionText(el)).includes(wanted)
    );

    return chosen || null;
  }

  async function fillFields(fieldsJson, optsJson) {
    g.__automation_active = true;

    const items = JSON.parse(fieldsJson || "[]");
    const opts = JSON.parse(optsJson || "{}");

    const typingDelay = opts.typingDelayMs || 50;
    const fieldDelay = opts.fieldDelayMs || 100;

    const results = [];

    for (const item of items) {
      try {
        const el = getByRef(item.ref);

        if (!el) {
          results.push({ ref: item.ref, ok: false, err: "not_found" });
          continue;
        }

        if (isDisabled(el) || (!isVisible(el) && !isVisuallyHiddenControl(el))) {
          results.push({ ref: item.ref, ok: false, err: "not_interactable" });
          continue;
        }

        const ok = await fillOne(el, item.value, {
          typingDelay,
          humanize: !!opts.humanize
        });

        results.push({ ref: item.ref, ok });
      } catch (e) {
        results.push({ ref: item.ref, ok: false, err: String(e) });
      }

      if (fieldDelay) await sleep(fieldDelay);
    }

    return {
      filled: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results
    };
  }

  async function fillOne(el, value, opts) {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const valueText = String(value == null ? "" : value);

    // Custom dropdowns, country selectors, country codes and year widgets.
    if (isCustomSelectTrigger(el)) {
      return await fillCustomSelect(el, valueText);
    }

    if (type === "date" || type === "datetime-local") {
      let finalValue = valueText.trim();

      if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(finalValue)) {
        const parts = finalValue.split(/[\/\-]/);
        finalValue = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }

      try {
        const view = el.ownerDocument.defaultView;
        const proto = view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        if (setter) setter.call(el, finalValue);
        else el.value = finalValue;

        dispatchElementEvent(el, "input");
        dispatchElementEvent(el, "change");
        dispatchElementEvent(el, "blur");
      } catch (_) {
        return false;
      }

      return true;
    }

    if (tag === "select") {
      const target = normalizeText(valueText);

      const matched =
        Array.from(el.options).find(o => normalizeText(o.value) === target) ||
        Array.from(el.options).find(o => normalizeText(o.textContent) === target) ||
        Array.from(el.options).find(o => normalizeText(o.textContent).includes(target));

      if (!matched) return false;

      el.value = matched.value;
      dispatchElementEvent(el, "input");
      dispatchElementEvent(el, "change");
      return true;
    }

    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      const want = /^(1|true|yes|on|checked)$/i.test(valueText.trim());

      if (el.checked !== want) {
        try {
          el.click();
        } catch (_) {
          el.checked = want;
          dispatchElementEvent(el, "change");
        }
      }

      return true;
    }

    if (tag === "input" || tag === "textarea") {
      const wasReadonly = el.hasAttribute("readonly");
      if (wasReadonly) el.removeAttribute("readonly");

      const view = el.ownerDocument.defaultView;
      const proto = tag === "textarea"
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

      try {
        if (setter) setter.call(el, valueText);
        else el.value = valueText;

        dispatchElementEvent(el, "input", {
          bubbles: true,
          data: valueText,
          inputType: "insertText"
        }, true);

        dispatchElementEvent(el, "change");

        if (el._valueTracker) el._valueTracker.setValue(valueText);
      } catch (_) {
        try {
          el.value = valueText;
          dispatchElementEvent(el, "input");
          dispatchElementEvent(el, "change");
        } catch (_) {
          if (wasReadonly) el.setAttribute("readonly", "");
          return false;
        }
      }

      if (wasReadonly) el.setAttribute("readonly", "");
      return true;
    }

    if (el.isContentEditable) {
      try {
        el.innerText = valueText;
        dispatchElementEvent(el, "input", {
          bubbles: true,
          data: valueText,
          inputType: "insertText"
        }, true);
      } catch (_) {
        el.textContent = valueText;
        dispatchElementEvent(el, "input");
      }

      return true;
    }

    return false;
  }

  async function fillCustomSelect(el, value) {
    const doc = el.ownerDocument || document;
    const kind = classify(el);

    let trigger = el;

    if (isHuaweiCountry(el)) {
      trigger =
        el.closest("button,[role=button],[onclick],.hwid-countryWidthFix") ||
        el;
    } else if (!el.matches(
      "button,[role=combobox],[aria-haspopup],[data-type=fydeos_select],.choose_value,.MuiSelect-select,.ant-select-selector,.react-select__control"
    )) {
      trigger =
        el.closest(
          "button,[role=combobox],[aria-haspopup],[data-type=fydeos_select],.choose_value,.MuiSelect-select,.ant-select-selector,.react-select__control,[onclick],[tabindex]"
        ) ||
        el.querySelector("button,[role=combobox],[aria-haspopup],.ctl,.select-trigger") ||
        el;
    }

    if (!trigger || !simulateClick(trigger)) return false;

    await sleep(350);

    const target = value.trim();

    // Search the open dropdown in the whole document including shadow roots.
    const candidates = getOptionCandidates(doc);

    // Year selectors often have plain numeric items without ARIA roles.
    if (kind === "dobyear" || isFydeosYear(el)) {
      for (const n of collectAll(doc, "li,button,[role=option],div,span")) {
        if (
          /^\d{4}$/.test(txt(n)) &&
          isVisible(n) &&
          !isDisabled(n) &&
          !candidates.includes(n)
        ) candidates.push(n);
      }
    }

    const chosen = findMatchingOption(candidates, target, kind);

    if (!chosen) return false;

    if (!simulateClick(chosen)) return false;

    await sleep(250);
    return true;
  }

  function simulateClick(el) {
    if (!el) return false;

    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {
      try { el.scrollIntoView(); } catch (_) {}
    }

    try {
      const view =
        el.ownerDocument && el.ownerDocument.defaultView || window;

      const r = el.getBoundingClientRect();

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        button: 0,
        view
      };

      try {
        if (view.PointerEvent)
          el.dispatchEvent(new view.PointerEvent("pointerdown", opts));
      } catch (_) {}

      try { el.dispatchEvent(new view.MouseEvent("mousedown", opts)); } catch (_) {}

      try {
        if (view.PointerEvent)
          el.dispatchEvent(new view.PointerEvent("pointerup", opts));
      } catch (_) {}

      try { el.dispatchEvent(new view.MouseEvent("mouseup", opts)); } catch (_) {}

      el.click();
      return true;
    } catch (_) {
      try {
        el.click();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async function clickNextAndSettle(optsJson) {
    const opts = JSON.parse(optsJson || "{}");
    const settleTimeoutMs = opts.settleTimeoutMs || 2000;

    let el = opts.actionRef ? getByRef(opts.actionRef) : null;

    if (!el) {
      const cands = collectAll(document, BUTTON_SELECTOR)
        .map(b => {
          // Explicitly exclude dropdown/country/year controls from Next.
          if (isSelectorOnlyElement(b)) return { el: b, score: -9999 };

          const label = (
            txt(b) ||
            attr(b, "value") ||
            attr(b, "aria-label") ||
            ""
          ).trim();

          let score = 0;

          if ((b.type || "").toLowerCase() === "submit") score += 50;
          if (b.tagName && b.tagName.toLowerCase() === "button") score += 10;
          if (BTN_POS.test(label)) score += 100;
          if (BTN_NEG.test(label)) score -= 150;

          return { el: b, score };
        })
        .filter(x =>
          x.score >= 100 &&
          isVisible(x.el) &&
          !isDisabled(x.el) &&
          !isSelectorOnlyElement(x.el)
        );

      cands.sort((a, b) => b.score - a.score);
      el = cands[0] ? cands[0].el : null;
    }

    if (
      !el ||
      !el.isConnected ||
      !isVisible(el) ||
      isDisabled(el) ||
      isSelectorOnlyElement(el)
    ) {
      return { verdict: "no_button_found" };
    }

    const actionView =
      el.ownerDocument && el.ownerDocument.defaultView || window;

    const urlBefore = actionView.location.href;

    simulateClick(el);

    const start = Date.now();

    while (Date.now() - start < settleTimeoutMs) {
      await sleep(CFG.CLICK_SETTLE_POLL_MS);

      try {
        if (actionView.location.href !== urlBefore)
          return { verdict: "navigated" };
      } catch (_) {}
    }

    return { verdict: "clicked_no_change" };
  }

  function dismissCookieBanner() {
    return { dismissed: false };
  }

  let scanTimeout = null;

  function scheduleScan() {
    if (g.__automation_active || scanTimeout) return;

    scanTimeout = setTimeout(() => {
      scanTimeout = null;
      try { scanPage(); } catch (_) {}
    }, 500);
  }

  try {
    new MutationObserver(scheduleScan).observe(
      document.documentElement || document,
      { subtree: true, childList: true }
    );
  } catch (_) {}

  g.__automationScan = scanPage;
  g.__automationFill = fillFields;
  g.__automationClickNextAndSettle = clickNextAndSettle;
  g.__automationDismissCookieBanner = dismissCookieBanner;

  try { scanPage(); } catch (_) {}
})();