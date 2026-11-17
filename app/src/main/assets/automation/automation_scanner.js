
/*
 * Automation Scanner (v11 - Huawei Country + Country Code Fix)
 *
 * Fixes:
 * 1. Huawei Country/Region detected as a field, not a normal click.
 * 2. Jiaotuai Malaysia +60 matching.
 * 3. Chinese country names and international dialing codes.
 * 4. Custom dropdown option detection.
 * 5. FydeOS year selector support.
 * 6. Element-owned DOM prototypes for cross-frame safety.
 */

(function () {
  "use strict";

  const g = globalThis;

  if (g.__automationScannerInstalled) {
    try { g.__automationScan(); } catch (_) {}
    return;
  }

  g.__automationScannerInstalled = true;

  const CFG = {
    MAX_IFRAME_DEPTH: 2,
    MAX_SHADOW_DEPTH: 3,
    MIN_SIZE_PX: 2,
    MAX_BUTTONS_OUT: 25,
    MAX_LINKS_OUT: 20,
    FILL_DELAY_MS: 50,
    CLICK_SETTLE_POLL_MS: 100,
    DROPDOWN_WAIT_MS: 500
  };

  g.__automation_active = false;

  // --------------------------------------------------
  // Focus protection
  // --------------------------------------------------

  const originalFocus = HTMLElement.prototype.focus;

  HTMLElement.prototype.focus = function (...args) {
    if (g.__automation_active) return;
    return originalFocus.apply(this, args);
  };

  // --------------------------------------------------
  // Field recognition
  // --------------------------------------------------

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

    fullname: /\b(full\s*name|your\s*name|display\s*name|name)\b/i,

    username: /\b(user[\s_-]?name|user[\s_-]?id|login|handle|screen[\s_-]?name)\b/i,

    message: /\b(message|comment|feedback|description|bio|notes?|details?)\b/i,

    dob: /\b(dob|date\s*of\s*birth|birth[\s_-]?date|birthday|bday)\b/i,

    zip: /\b(zip|postal|post[\s_-]?code|pin\s*code|pincode)\b/i,

    city: /\b(city|town|ville)\b/i,

    state: /\b(state|province|region|county)\b/i,

    country: /\b(country|nation)\b/i,

    countrycode: /\b(country\s*(calling\s*)?code|calling\s*code|dial(?:ling)?\s*code|phone\s*code|countrycode|dialcode|international\s*code)\b/i,

    currency: /\b(currency|select currency|billing currency|payment currency|iso-4217)\b/i,

    address: /\b(address|street|line\s*1|line\s*2|apartment|apt)\b/i,

    company: /\b(company|organi[sz]ation|employer|business)\b/i,

    jobtitle: /\b(job\s*title|position|role|occupation|designation)\b/i,

    gender: /\b(gender|sex)\b/i,

    terms: /\b(terms|agree|consent|privacy|policy|accept|conditions)\b/i
  };

  const BTN_POS =
    /\b(next|continue|submit|sign\s*up|signup|register|create|join|proceed|verify|confirm|finish|done|save|send|login|log\s*in|sign\s*in|apply)\b/i;

  const BTN_NEG =
    /\b(back|previous|prev|cancel|close|dismiss|reset|clear|delete|remove|log\s*out|sign\s*out|logout|skip|forgot|resend|no\s*thanks|not\s*now|decline|reject|deny)\b/i;

  // --------------------------------------------------
  // References
  // --------------------------------------------------

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
      refToEl.set(r, {
        deref: () => el
      });
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

  // --------------------------------------------------
  // Utilities
  // --------------------------------------------------

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function dispatchElementEvent(el, type, init, preferInputEvent) {
    const view =
      el && el.ownerDocument && el.ownerDocument.defaultView || window;

    const Ctor =
      preferInputEvent && view.InputEvent
        ? view.InputEvent
        : view.Event;

    try {
      el.dispatchEvent(
        new Ctor(type, init || { bubbles: true })
      );
    } catch (_) {
      try {
        el.dispatchEvent(
          new view.Event(type, { bubbles: true })
        );
      } catch (_) {}
    }
  }

  const txt = el =>
    el
      ? ((el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim())
      : "";

  const attr = (el, name) =>
    el && el.getAttribute
      ? el.getAttribute(name) || ""
      : "";

  function normalizeText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  // --------------------------------------------------
  // Huawei selector detection
  // --------------------------------------------------

  function isHuaweiCountryControl(el) {
    if (!el) return false;

    const id = (el.id || "").toLowerCase();

    const cls = (
      typeof el.className === "string"
        ? el.className
        : ""
    ).toLowerCase();

    const combined = [
      id,
      cls,
      attr(el, "data-name"),
      attr(el, "aria-label"),
      attr(el, "title")
    ].join(" ");

    return (
      /hwid-selectedcountry/.test(combined) ||
      /selectedcountryname/.test(combined) ||
      /selectedcountry/.test(combined) ||
      /countrywidthfix/.test(combined)
    );
  }

  // --------------------------------------------------
  // Visibility
  // --------------------------------------------------

  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    try {
      let node = el;

      while (node && node.nodeType === 1) {
        if (
          node.hasAttribute("hidden") ||
          attr(node, "aria-hidden") === "true" ||
          node.hasAttribute("inert")
        ) {
          return false;
        }

        const view =
          node.ownerDocument &&
          node.ownerDocument.defaultView;

        const st = view && view.getComputedStyle(node);

        if (
          !st ||
          st.display === "none" ||
          st.visibility === "hidden" ||
          st.visibility === "collapse" ||
          st.contentVisibility === "hidden" ||
          parseFloat(st.opacity) === 0
        ) {
          return false;
        }

        node =
          node.parentElement ||
          (node.getRootNode && node.getRootNode().host) ||
          null;
      }

      const r = el.getBoundingClientRect();

      if (
        r.width < CFG.MIN_SIZE_PX &&
        r.height < CFG.MIN_SIZE_PX
      ) {
        return false;
      }

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
    ) {
      return false;
    }

    try {
      let node = el;

      while (node && node.nodeType === 1) {
        if (
          node.hasAttribute("hidden") ||
          node.hasAttribute("inert") ||
          attr(node, "aria-hidden") === "true"
        ) {
          return false;
        }

        const view =
          node.ownerDocument &&
          node.ownerDocument.defaultView;

        const st = view && view.getComputedStyle(node);

        if (
          !st ||
          st.display === "none" ||
          st.visibility === "hidden" ||
          st.visibility === "collapse" ||
          st.contentVisibility === "hidden"
        ) {
          return false;
        }

        node =
          node.parentElement ||
          (node.getRootNode && node.getRootNode().host) ||
          null;
      }

      const labels = [];

      if (el.labels) {
        for (const label of el.labels) {
          labels.push(label);
        }
      }

      const wrapping = el.closest && el.closest("label");

      if (wrapping && !labels.includes(wrapping)) {
        labels.push(wrapping);
      }

      if (el.id) {
        const linked = el.ownerDocument.querySelector(
          'label[for="' + CSS.escape(el.id) + '"]'
        );

        if (linked && !labels.includes(linked)) {
          labels.push(linked);
        }
      }

      return labels.some(label => isVisible(label));

    } catch (_) {
      return false;
    }
  }

  function isDisabled(el) {
    if (!el) return false;

    if (el.disabled === true || el.inert === true) {
      return true;
    }

    if (attr(el, "aria-disabled") === "true") {
      return true;
    }

    if (el.closest && el.closest("[inert]")) {
      return true;
    }

    return false;
  }

  // --------------------------------------------------
  // Labels
  // --------------------------------------------------

  function findLabel(el) {
    if (!el) return "";

    const out = [];

    try {
      if (el.labels && el.labels.length) {
        for (const l of el.labels) {
          const t = txt(l).slice(0, 120);

          if (t && !out.includes(t)) {
            out.push(t);
          }
        }
      }

      if (el.id) {
        try {
          const l = el.ownerDocument.querySelector(
            'label[for="' + CSS.escape(el.id) + '"]'
          );

          if (l) {
            const t = txt(l).slice(0, 120);

            if (t && !out.includes(t)) {
              out.push(t);
            }
          }
        } catch (_) {}
      }

      const wrap = el.closest && el.closest("label");

      if (wrap) {
        const t = txt(wrap).slice(0, 120);

        if (t && !out.includes(t)) {
          out.push(t);
        }
      }

      const lblBy = attr(el, "aria-labelledby");

      if (lblBy) {
        for (const id of lblBy.split(/\s+/)) {
          const n = el.ownerDocument.getElementById(id);

          if (n) {
            const t = txt(n).slice(0, 120);

            if (t && !out.includes(t)) {
              out.push(t);
            }
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
      findLabel(el)
    ];

    try {
      let node = el;

      for (
        let depth = 0;
        node && depth < 3;
        depth++, node = node.parentElement
      ) {
        let prev = node.previousElementSibling;

        for (
          let n = 0;
          prev && n < 2;
          n++, prev = prev.previousElementSibling
        ) {
          const t = txt(prev);

          if (t && t.length <= 120) {
            parts.push(t);
          }
        }
      }

      const wrap = el.closest(
        "[data-field],[class*='form-group' i],[class*='form-field' i],[class*='field-wrapper' i],[role='group']"
      );

      if (wrap) {
        parts.push(txt(wrap).slice(0, 180));
      }

    } catch (_) {}

    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  // --------------------------------------------------
  // Autocomplete classification
  // --------------------------------------------------

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

  // --------------------------------------------------
  // Custom dropdown detection
  // --------------------------------------------------

  function isCustomSelectTrigger(el) {
    if (!el) return false;

    if (isHuaweiCountryControl(el)) {
      return true;
    }

    const role = attr(el, "role").toLowerCase();

    if (
      role === "combobox" ||
      role === "listbox" ||
      attr(el, "aria-haspopup") === "listbox" ||
      attr(el, "aria-haspopup") === "true" ||
      attr(el, "data-type") === "fydeos_select" ||
      el.matches(".choose_value,#selectedCountry,.hwid-selectedCountryName,[id*='selectedCountry']")
    ) {
      return true;
    }

    const cls = (
      typeof el.className === "string"
        ? el.className
        : ""
    ).toLowerCase();

    if (
      /\b(mui-?select|ant-?select|chakra-?select|react-?select|rs-?select|v-?select|select2|choices|dd-?trigger|dd-?toggle)\b/.test(cls) ||
      /hwid-country|countrywidthfix|selectedcountry/.test(cls)
    ) {
      return true;
    }

    return false;
  }

  // --------------------------------------------------
  // Field classification
  // --------------------------------------------------

  function classify(el) {
    if (!el) return "text";

    // Huawei Country/Region must be recognized before
    // ordinary button or generic text classification.

    if (isHuaweiCountryControl(el)) {
      return "country";
    }

    const ac =
      attr(el, "autocomplete")
        .toLowerCase()
        .split(/\s+/)[0];

    if (ac && AUTOCOMPLETE_MAP[ac]) {
      return AUTOCOMPLETE_MAP[ac];
    }

    const tag = (el.tagName || "").toLowerCase();

    const type = (el.type || "").toLowerCase();

    const role = attr(el, "role").toLowerCase();

    if (type === "password") return "password";

    if (type === "email") return "email";

    if (type === "tel") return "phone";

    const c = combinedLabel(el);

    if (
      type === "checkbox" ||
      role === "checkbox" ||
      role === "switch"
    ) {
      return "termscheckbox";
    }

    if (type === "radio" || role === "radio") {
      if (RX.gender.test(c)) return "gender";
      return "termscheckbox";
    }

    const phoneSibling = !!(
      el.parentElement &&
      el.parentElement.querySelector(
        "input[type='tel'],input[autocomplete^='tel'],input[name*='phone' i]"
      )
    );

    if (
      RX.countrycode.test(c) ||
      (
        role === "combobox" &&
        /^\+\d{1,4}$/.test(txt(el)) &&
        (RX.phone.test(c) || phoneSibling)
      )
    ) {
      return "countrycode";
    }

    if (RX.currency.test(c)) return "currency";

    if (
      /\b(birth|date of birth|dob|birthday)\s*(year|month|day)\b|\b(year|month|day)\s*(of birth|dob)\b/i.test(c)
    ) {
      if (/\byear\b/i.test(c)) return "dobyear";
      if (/\bmonth\b/i.test(c)) return "dobmonth";
      if (/\bday\b/i.test(c)) return "dobday";
    }

    if (
      el.id === "selectedCountry" ||
      /hwid-selectedCountryName|selectedcountry/i.test(c)
    ) {
      return "country";
    }

    if (
      attr(el, "data-type") === "fydeos_select" ||
      /\bchoose_value\b/i.test(c)
    ) {
      return "dobyear";
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

    if (
      tag === "textarea" ||
      role === "textbox" ||
      RX.message.test(c)
    ) {
      return "message";
    }

    return "text";
  }

  // --------------------------------------------------
  // DOM selectors
  // --------------------------------------------------

  const FIELD_SELECTOR = [
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file])',
    "textarea",
    "select",
    "[role=combobox]",
    "[role=textbox]",
    '[contenteditable="true"]',
    '[contenteditable=""]',
    ".dd",
    ".ctl",
    ".select-trigger",
    "[data-dropdown]",
    "[data-select]",
    '[data-type="fydeos_select"]',
    ".choose_value",
    "#selectedCountry",
    ".hwid-selectedCountryName",
    ".hwid-countryWidthFix",
    "[class*='hwid-selectedCountry' i]",
    "[class*='countryWidthFix' i]",
    "[id*='selectedCountry' i]",
    "[aria-haspopup=listbox]",
    ".MuiSelect-select",
    ".ant-select-selector",
    ".react-select__control"
  ].join(",");

  const BUTTON_SELECTOR = [
    "button",
    "a[role=button]",
    "input[type=submit]",
    "input[type=button]",
    "input[type=image]",
    "[role=button]:not(a)",
    "[onclick]"
  ].join(",");

  // --------------------------------------------------
  // Collect elements
  // --------------------------------------------------

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
      ) {
        return;
      }

      addMatches(root);

      let nodeList;

      try {
        nodeList = root.querySelectorAll("*");
      } catch (_) {
        return;
      }

      for (const el of nodeList) {
        if (++visitedNodes >= 5000) break;

        if (
          el.shadowRoot &&
          shadowDepth < CFG.MAX_SHADOW_DEPTH
        ) {
          walk(
            el.shadowRoot,
            shadowDepth + 1,
            frameDepth
          );
        }

        if (
          el.tagName === "IFRAME" &&
          frameDepth < CFG.MAX_IFRAME_DEPTH
        ) {
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

  // --------------------------------------------------
  // Page scanning
  // --------------------------------------------------

  function scanPage() {
    if (document.readyState === "loading") {
      return emptyResult();
    }

    const fieldElements = collectAll(
      document,
      FIELD_SELECTOR
    );

    const fields = [];

    const seenFields = new Set();

    for (const el of fieldElements) {
      try {
        if (
          !el ||
          !el.isConnected ||
          (
            !isVisible(el) &&
            !isVisuallyHiddenControl(el)
          ) ||
          isDisabled(el)
        ) {
          continue;
        }

        if (
          el.type === "search" ||
          (el.closest && el.closest("[role=search]"))
        ) {
          continue;
        }

        if (seenFields.has(el)) continue;

        seenFields.add(el);

        const tag = (el.tagName || "").toLowerCase();

        const type = (el.type || "").toLowerCase();

        const ref = getRef(el);

        const looksLike = classify(el) || (
          tag === "select" ? "" : "text"
        );

        fields.push({
          index: fields.length,
          ref,
          tag,
          type,

          kind:
            tag === "select"
              ? "native"
              : (
                  type === "date" ||
                  looksLike === "dob"
                )
                ? "date"
                : isCustomSelectTrigger(el)
                  ? "custom-select"
                  : "native",

          name:
            attr(el, "name") ||
            findLabel(el) ||
            el.id ||
            "",

          looksLike: looksLike || "text",

          currentValue: el.value || "",

          required: !!(
            el.required ||
            attr(el, "aria-required") === "true"
          )
        });

      } catch (_) {}
    }

    // ------------------------------------------------
    // BUTTON SCAN
    //
    // IMPORTANT:
    // Custom selectors are never automatic action buttons.
    // This prevents Huawei Country/Region from being
    // recorded as a normal click.
    // ------------------------------------------------

    const btnElements = collectAll(
      document,
      BUTTON_SELECTOR
    );

    const seenButtons = new Set();

    const buttons = [];

    for (const el of btnElements) {
      try {
        if (
          !el ||
          !el.isConnected ||
          !isVisible(el) ||
          isDisabled(el) ||
          seenButtons.has(el)
        ) {
          continue;
        }

        seenButtons.add(el);

        // Exclude all custom dropdown triggers.
        if (isCustomSelectTrigger(el)) {
          continue;
        }

        const label = (
          txt(el) ||
          attr(el, "value") ||
          attr(el, "aria-label") ||
          ""
        ).trim();

        let score = 0;

        if ((el.type || "").toLowerCase() === "submit") {
          score += 50;
        }

        if (
          el.tagName.toLowerCase() === "button" &&
          !el.type
        ) {
          score += 10;
        }

        if (BTN_POS.test(label)) {
          score += 100;
        }

        if (BTN_NEG.test(label)) {
          score -= 150;
        }

        // Ignore irrelevant clickable elements.
        if (score > 0) {
          buttons.push({
            ref: getRef(el),
            label: label.slice(0, 60),
            score
          });
        }

      } catch (_) {}
    }

    buttons.sort((a, b) => b.score - a.score);

    const bestBtn = buttons[0] || null;

    sendToBridge(fields);

    return {
      url: location.href,
      title: document.title || "",

      fields,

      buttons: buttons.slice(0, CFG.MAX_BUTTONS_OUT),

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

  // --------------------------------------------------
  // Android bridge
  // --------------------------------------------------

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

      if (attempts < 5) {
        setTimeout(trySend, 200);
      }
    })();
  }

  // --------------------------------------------------
  // Country-code matching
  // --------------------------------------------------

  function getOptionMetadata(el) {
    if (!el) return "";

    return [
      txt(el),
      attr(el, "data-value"),
      attr(el, "data-country"),
      attr(el, "data-code"),
      attr(el, "data-dial-code"),
      attr(el, "data-phone-code"),
      attr(el, "aria-label"),
      attr(el, "title"),
      attr(el, "value")
    ]
      .filter(Boolean)
      .join(" ");
  }

  function extractDialCodes(value) {
    const result = new Set();

    const text = String(value || "");

    // Match +60, 60, (+60), Malaysia 60, etc.
    const regex = /(?:^|[^\d])\+?\s*(\d{1,4})(?=$|[^\d])/g;

    let match;

    while ((match = regex.exec(text)) !== null) {
      const code = match[1];

      if (code.length >= 1 && code.length <= 4) {
        result.add(code);
      }
    }

    return Array.from(result);
  }

  function getTargetDialCode(value) {
    const codes = extractDialCodes(value);

    if (!codes.length) return "";

    // Prefer the number following an explicit plus.
    const plusMatch = String(value || "").match(
      /\+\s*(\d{1,4})/
    );

    if (plusMatch) {
      return plusMatch[1];
    }

    return codes[0];
  }

  function matchCountryCode(candidate, target) {
    if (!candidate || !target) return false;

    const metadata = getOptionMetadata(candidate);

    const targetCode = getTargetDialCode(target);

    if (!targetCode) return false;

    const candidateCodes = extractDialCodes(metadata);

    // Exact numeric dialing-code match.
    //
    // +60 matches:
    // 60
    // Malaysia 60
    // 马来西亚 60
    // +60 Malaysia
    // data-code="60"

    if (candidateCodes.includes(targetCode)) {
      return true;
    }

    return false;
  }

  // --------------------------------------------------
  // Dropdown option collection
  // --------------------------------------------------

  function collectDropdownOptions(doc, field) {
    const selectors = [
      "[role=option]",
      "[role=menuitem]",
      "[role=listbox] *",
      ".MuiMenuItem-root",
      ".ant-select-item-option",
      ".chakra-menu__menuitem",
      "[data-radix-collection-item]",
      ".dd-i",
      ".dropdown-item",
      ".select-option",
      "[data-value]",
      "[data-country]",
      "[data-code]",
      "[data-dial-code]",
      ".hwid-country-item",
      ".hwid-country-list li",
      "[class*='hwid-country' i]",
      "li",
      "button",
      ".year-item"
    ];

    const candidates = [];

    const seen = new Set();

    for (const n of collectAll(
      doc,
      selectors.join(",")
    )) {
      if (
        !isVisible(n) ||
        isDisabled(n) ||
        seen.has(n)
      ) {
        continue;
      }

      seen.add(n);

      candidates.push(n);
    }

    // FydeOS plain year list.
    if (
      field.matches(".choose_value,[data-type='fydeos_select]") ||
      classify(field) === "dobyear"
    ) {
      for (const n of collectAll(
        doc,
        "li,button,[role=option],div,span"
      )) {
        if (
          /^\d{4}$/.test(txt(n)) &&
          isVisible(n) &&
          !seen.has(n)
        ) {
          seen.add(n);
          candidates.push(n);
        }
      }
    }

    return candidates;
  }

  // --------------------------------------------------
  // Find dropdown selection
  // --------------------------------------------------

  function findDropdownOption(candidates, field, value) {
    const target = normalizeText(value);

    const kind = classify(field);

    // 1. Country calling code matching.
    if (kind === "countrycode") {
      const matching = candidates.filter(
        candidate =>
          matchCountryCode(candidate, value)
      );

      if (matching.length) {
        // Prefer the smallest visible matching row.
        matching.sort((a, b) => {
          const aText = getOptionMetadata(a).length;
          const bText = getOptionMetadata(b).length;

          return aText - bText;
        });

        return matching[0];
      }
    }

    // 2. Exact text and attribute matching.
    let chosen = candidates.find(candidate => {
      const metadata = normalizeText(
        getOptionMetadata(candidate)
      );

      return (
        normalizeText(txt(candidate)) === target ||
        normalizeText(attr(candidate, "data-value")) === target ||
        normalizeText(attr(candidate, "data-country")) === target ||
        normalizeText(attr(candidate, "data-code")) === target ||
        metadata === target
      );
    });

    if (chosen) return chosen;

    // 3. Partial text matching.
    chosen = candidates.find(candidate => {
      const metadata = normalizeText(
        getOptionMetadata(candidate)
      );

      return (
        metadata.includes(target) ||
        normalizeText(txt(candidate)).includes(target)
      );
    });

    if (chosen) return chosen;

    // 4. Country name + calling code fallback.
    if (kind === "countrycode") {
      const code = getTargetDialCode(value);

      if (code) {
        chosen = candidates.find(candidate => {
          const metadata = getOptionMetadata(candidate);

          const codes = extractDialCodes(metadata);

          return codes.includes(code);
        });
      }
    }

    return chosen || null;
  }

  // --------------------------------------------------
  // Simulated click
  // --------------------------------------------------

  function simulateClick(el) {
    if (!el) return false;

    try {
      try {
        el.scrollIntoView({
          block: "center",
          behavior: "instant"
        });
      } catch (_) {
        try {
          el.scrollIntoView();
        } catch (_) {}
      }

      const view =
        el.ownerDocument &&
        el.ownerDocument.defaultView || window;

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
        if (view.PointerEvent) {
          el.dispatchEvent(
            new view.PointerEvent("pointerdown", opts)
          );
        }
      } catch (_) {}

      try {
        el.dispatchEvent(
          new view.MouseEvent("mousedown", opts)
        );
      } catch (_) {}

      try {
        if (view.PointerEvent) {
          el.dispatchEvent(
            new view.PointerEvent("pointerup", opts)
          );
        }
      } catch (_) {}

      try {
        el.dispatchEvent(
          new view.MouseEvent("mouseup", opts)
        );
      } catch (_) {}

      el.click();

      return true;

    } catch (_) {
      try {
        el.click();
        return true;
      } catch (_) {}

      return false;
    }
  }

  // --------------------------------------------------
  // Custom dropdown filling
  // --------------------------------------------------

  async function fillCustomSelect(el, value) {
    const doc = el.ownerDocument || document;

    let trigger = el;

    // Huawei Country/Region selector.
    if (isHuaweiCountryControl(el)) {
      trigger =
        el.closest(
          "button,[role=button],[onclick],.hwid-countryWidthFix"
        ) || el;
    }

    // Other custom selectors.
    else if (
      !el.matches(
        "button,[role=combobox],[aria-haspopup],[data-type='fydeos_select'],.choose_value,.MuiSelect-select,.ant-select-selector,.react-select__control"
      )
    ) {
      trigger =
        el.closest(
          "button,[role=combobox],[aria-haspopup],[data-type='fydeos_select'],.choose_value,.MuiSelect-select,.ant-select-selector,.react-select__control,[onclick],[tabindex]"
        ) ||
        el.querySelector(
          "button,[role=combobox],[aria-haspopup],.ctl,.select-trigger"
        ) ||
        el;
    }

    if (!trigger || !isVisible(trigger)) {
      return false;
    }

    if (!simulateClick(trigger)) {
      return false;
    }

    await sleep(CFG.DROPDOWN_WAIT_MS);

    const candidates = collectDropdownOptions(
      doc,
      el
    );

    const chosen = findDropdownOption(
      candidates,
      el,
      value
    );

    if (!chosen) {
      return false;
    }

    if (!simulateClick(chosen)) {
      return false;
    }

    await sleep(300);

    return true;
  }

  // --------------------------------------------------
  // Fill fields
  // --------------------------------------------------

  async function fillFields(fieldsJson, optsJson) {
    g.__automation_active = true;

    try {
      const items = JSON.parse(fieldsJson || "[]");

      const opts = JSON.parse(optsJson || "{}");

      const typingDelay = opts.typingDelayMs || 50;

      const fieldDelay = opts.fieldDelayMs || 100;

      const results = [];

      for (const item of items) {
        try {
          const el = getByRef(item.ref);

          if (!el) {
            results.push({
              ref: item.ref,
              ok: false,
              err: "not_found"
            });

            continue;
          }

          if (
            isDisabled(el) ||
            (
              !isVisible(el) &&
              !isVisuallyHiddenControl(el)
            )
          ) {
            results.push({
              ref: item.ref,
              ok: false,
              err: "not_interactable"
            });

            continue;
          }

          const ok = await fillOne(
            el,
            item.value,
            {
              typingDelay,
              humanize: !!opts.humanize
            }
          );

          results.push({
            ref: item.ref,
            ok
          });

        } catch (e) {
          results.push({
            ref: item.ref,
            ok: false,
            err: String(e)
          });
        }

        if (fieldDelay) {
          await sleep(fieldDelay);
        }
      }

      return {
        filled: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results
      };

    } finally {
      g.__automation_active = false;
    }
  }

  // --------------------------------------------------
  // Fill one field
  // --------------------------------------------------

  async function fillOne(el, value, opts) {
    const tag = (el.tagName || "").toLowerCase();

    const type = (el.type || "").toLowerCase();

    const kind = classify(el);

    const finalInput = String(
      value == null ? "" : value
    );

    // IMPORTANT:
    // Custom selectors must be processed BEFORE ordinary
    // input setters. Huawei and FydeOS can use custom
    // selector elements rather than normal HTML inputs.

    if (
      isCustomSelectTrigger(el) ||
      kind === "countrycode" ||
      kind === "country" ||
      kind === "currency" ||
      kind === "dobyear"
    ) {
      return await fillCustomSelect(
        el,
        finalInput
      );
    }

    // ------------------------------------------------
    // Date fields
    // ------------------------------------------------

    const isDate =
      type === "date" ||
      type === "datetime-local" ||
      (
        kind === "dob" &&
        (tag === "input" || tag === "textarea")
      );

    if (isDate) {
      const wasReadonly = el.hasAttribute("readonly");

      if (wasReadonly) {
        el.removeAttribute("readonly");
      }

      let finalValue = finalInput.trim();

      if (
        type === "date" &&
        /^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(finalValue)
      ) {
        const parts = finalValue.split(/[\/\-]/);

        finalValue =
          `${parts[2]}-${parts[1]}-${parts[0]}`;
      }

      try {
        const view = el.ownerDocument.defaultView;

        const focusDescriptor =
          Object.getOwnPropertyDescriptor(
            view.HTMLElement.prototype,
            "focus"
          );

        if (
          focusDescriptor &&
          focusDescriptor.value
        ) {
          focusDescriptor.value.call(el);
        }

        const setter =
          Object.getOwnPropertyDescriptor(
            view.HTMLInputElement.prototype,
            "value"
          )?.set;

        if (setter) {
          setter.call(el, finalValue);
        } else {
          el.value = finalValue;
        }

        dispatchElementEvent(el, "input");

        dispatchElementEvent(el, "change");

        dispatchElementEvent(el, "blur");

        if (el._valueTracker) {
          el._valueTracker.setValue(finalValue);
        }

      } catch (_) {}

      if (wasReadonly) {
        el.setAttribute("readonly", "true");
      }

      return true;
    }

    // ------------------------------------------------
    // Native select
    // ------------------------------------------------

    if (tag === "select") {
      const target = finalInput.trim();

      const lower = target.toLowerCase();

      const matched =
        Array.from(el.options).find(
          o => (o.value || "").trim() === target
        ) ||
        Array.from(el.options).find(
          o => (o.textContent || "").trim() === target
        ) ||
        Array.from(el.options).find(
          o => (
            o.textContent || ""
          ).toLowerCase().includes(lower)
        );

      if (!matched) return false;

      el.value = matched.value;

      dispatchElementEvent(el, "input");

      dispatchElementEvent(el, "change");

      return true;
    }

    // ------------------------------------------------
    // Checkbox and radio
    // ------------------------------------------------

    if (
      tag === "input" &&
      (type === "checkbox" || type === "radio")
    ) {
      const want =
        /^(1|true|yes|on|checked)$/i.test(
          finalInput.trim()
        );

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

    // ------------------------------------------------
    // Input and textarea
    // ------------------------------------------------

    if (tag === "input" || tag === "textarea") {
      const wasReadonly =
        el.hasAttribute("readonly");

      el.setAttribute("readonly", "true");

      const view = el.ownerDocument.defaultView;

      try {
        const focusDescriptor =
          Object.getOwnPropertyDescriptor(
            view.HTMLElement.prototype,
            "focus"
          );

        if (
          focusDescriptor &&
          focusDescriptor.value
        ) {
          focusDescriptor.value.call(el);
        }

      } catch (_) {}

      const proto =
        tag === "textarea"
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype;

      const valueDescriptor =
        Object.getOwnPropertyDescriptor(
          proto,
          "value"
        );

      const setter =
        valueDescriptor && valueDescriptor.set;

      if (!opts.humanize) {
        try {
          if (setter) {
            setter.call(el, finalInput);
          } else {
            el.value = finalInput;
          }
        } catch (_) {
          el.value = finalInput;
        }

        dispatchElementEvent(el, "input");

        dispatchElementEvent(el, "change");

      } else {
        let currentText = "";

        for (
          let i = 0;
          i < finalInput.length;
          i++
        ) {
          currentText += finalInput[i];

          try {
            if (setter) {
              setter.call(el, currentText);
            } else {
              el.value = currentText;
            }
          } catch (_) {
            el.value = currentText;
          }

          dispatchElementEvent(el, "input");

          if (el._valueTracker) {
            el._valueTracker.setValue(currentText);
          }

          await sleep(
            opts.typingDelay *
            (0.5 + Math.random())
          );
        }

        dispatchElementEvent(el, "change");
      }

      if (!wasReadonly) {
        el.removeAttribute("readonly");
      }

      try {
        el.blur();
      } catch (_) {}

      return true;
    }

    // ------------------------------------------------
    // Contenteditable
    // ------------------------------------------------

    if (el.isContentEditable) {
      try {
        el.innerText = finalInput;

        dispatchElementEvent(
          el,
          "input",
          {
            bubbles: true,
            data: finalInput,
            inputType: "insertText"
          },
          true
        );

      } catch (_) {
        el.textContent = finalInput;

        dispatchElementEvent(el, "input");
      }

      return true;
    }

    return false;
  }

  // --------------------------------------------------
  // Next / Continue button
  // --------------------------------------------------

  async function clickNextAndSettle(optsJson) {
    const opts = JSON.parse(optsJson || "{}");

    const settleTimeoutMs =
      opts.settleTimeoutMs || 2000;

    let el = opts.actionRef
      ? getByRef(opts.actionRef)
      : null;

    if (!el) {
      const cands = collectAll(
        document,
        BUTTON_SELECTOR
      )
        .map(b => {
          const label = (
            txt(b) ||
            attr(b, "value") ||
            attr(b, "aria-label") ||
            ""
          ).trim();

          let score = 0;

          if (
            (b.type || "").toLowerCase() === "submit"
          ) {
            score += 50;
          }

          if (
            b.tagName &&
            b.tagName.toLowerCase() === "button" &&
            !b.type
          ) {
            score += 10;
          }

          if (BTN_POS.test(label)) {
            score += 100;
          }

          if (BTN_NEG.test(label)) {
            score -= 150;
          }

          return {
            el: b,
            score
          };
        })
        .filter(x =>
          x.score >= 100 &&
          isVisible(x.el) &&
          !isDisabled(x.el) &&
          !isCustomSelectTrigger(x.el)
        );

      cands.sort(
        (a, b) => b.score - a.score
      );

      el = cands[0]
        ? cands[0].el
        : null;
    }

    if (
      !el ||
      !el.isConnected ||
      !isVisible(el) ||
      isDisabled(el) ||
      isCustomSelectTrigger(el)
    ) {
      return {
        verdict: "no_button_found"
      };
    }

    const actionView =
      el.ownerDocument &&
      el.ownerDocument.defaultView || window;

    const urlBefore = actionView.location.href;

    simulateClick(el);

    const start = Date.now();

    while (
      Date.now() - start < settleTimeoutMs
    ) {
      await sleep(
        CFG.CLICK_SETTLE_POLL_MS
      );

      try {
        if (
          actionView.location.href !== urlBefore
        ) {
          return {
            verdict: "navigated"
          };
        }
      } catch (_) {}
    }

    return {
      verdict: "clicked_no_change"
    };
  }

  // --------------------------------------------------
  // Cookie banner
  // --------------------------------------------------

  function dismissCookieBanner() {
    return {
      dismissed: false
    };
  }

  // --------------------------------------------------
  // Automatic scanning
  // --------------------------------------------------

  let scanTimeout = null;

  function scheduleScan() {
    if (g.__automation_active) return;

    if (scanTimeout) return;

    scanTimeout = setTimeout(() => {
      scanTimeout = null;

      try {
        scanPage();
      } catch (_) {}

    }, 500);
  }

  try {
    new MutationObserver(scheduleScan).observe(
      document.documentElement || document,
      {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "class",
          "style",
          "aria-expanded",
          "aria-hidden"
        ]
      }
    );
  } catch (_) {}

  // --------------------------------------------------
  // Expose functions
  // --------------------------------------------------

  g.__automationScan = scanPage;

  g.__automationFill = fillFields;

  g.__automationClickNextAndSettle =
    clickNextAndSettle;

  g.__automationDismissCookieBanner =
    dismissCookieBanner;

  // --------------------------------------------------
  // Initial scan
  // --------------------------------------------------

  try {
    scanPage();
  } catch (_) {}

})();
