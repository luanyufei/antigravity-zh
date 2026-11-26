(() => {
  'use strict';
  if (window.__AGY_I18N_ENGINE__) {
    return;
  }

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'MATH', 'CANVAS',
    'PRE', 'CODE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT',
    'IFRAME', 'WEBVIEW', 'AUDIO', 'VIDEO', 'TEMPLATE',
  ]);

  const PROTECTED_SELECTOR = [
    '[data-agy-i18n-ignore]',
    '[data-testid="user-message"]',
    '[data-testid="user-message-bubble"]',
    '[data-testid="user-message-content"]',
    '[data-testid="voice-user-message"]',
    '[data-markdown-root]',
    '.xterm',
    '[data-testid="background-task-command"]',
    '[data-testid="code-gutter"]',
    '[data-testid="code-gutter-diff"]',
    '[data-testid="csv-file-viewer"]',
    '[data-testid="file-title-name"]',
    '[data-testid="artifact-pdf-view"]',
    '[data-testid="conversation-row-title"]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '#ag-context-meter',
    '#ag-context-meter-radial-host',
    '#ag-context-meter-modal-host',
    '.ag-cm-host-settings-page',
    '.ag-cm-settings-workspace',
    '.ag-cm-turn-footer',
    '.ag-cm-autoswitch-toast',
    '[data-ag-radial-top-layer]',
    '[data-ag-modal-top-layer]',
    '#agy-settings-host',
    '#agy-telemetry-bar-host',
    '#agy-telemetry-popover-host',
    '#agy-home-dashboard-host',
    '#agy-smooth-caret',
    '.agy-turn-footer',
    '.agy-code-fold-btn',
    '.agy-code-fold-bar',
    '[data-agy-telemetry-ignore]',
  ].join(',');

  const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  const LOOKS_LIKE_CODE_OR_PATH_RE = /^(?:https?:\/\/|file:\/\/|mailto:|\/|~\/|\.\.?\/|--[a-z]|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$|[0-9a-f]{7,64}$)/;

  const textRecords = new WeakMap(); // Text -> { orig, zh }
  const attrRecords = new WeakMap(); // Element -> Map<attr, { orig, zh }>

  let state = {
    locale: 'zh-CN',
    showFloatingToggle: true,
    dict: { exact: {}, patterns: [] },
  };
  let exactMap = new Map();
  let compiledPatterns = [];
  let originalDocTitle = null;
  let isApplying = false;
  let observer = null;
  const pendingRoots = new Set();
  let flushScheduled = false;

  // Shadow DOM widget refs
  let hostEl = null;
  let shadowRoot = null;
  let pillEl = null;
  let btnZh = null;
  let btnEn = null;

  function compileDict(dict) {
    exactMap = new Map();
    compiledPatterns = [];
    if (!dict) return;
    if (dict.exact && typeof dict.exact === 'object') {
      for (const [k, v] of Object.entries(dict.exact)) {
        if (typeof k === 'string' && typeof v === 'string' && k.length > 0 && v.length > 0) {
          exactMap.set(k, v);
        }
      }
    }
    if (Array.isArray(dict.patterns)) {
      for (const item of dict.patterns) {
        if (!item || item.onlyMenu || !item.regex || typeof item.replace !== 'string') continue;
        try {
          compiledPatterns.push([new RegExp(item.regex), item.replace]);
        } catch (_e) {
          // Skip invalid user regex safely
        }
      }
    }
  }

  function translateDurationFragment(frag) {
    return frag
      .replace(/\b(\d+)\s+days?\b/gi, '$1 天')
      .replace(/\b(\d+)\s+hours?\b/gi, '$1 小时')
      .replace(/\b(\d+)\s+minutes?\b/gi, '$1 分钟')
      .replace(/\b(\d+)\s+seconds?\b/gi, '$1 秒')
      .replace(/\b(\d+)\s+mins?\b/gi, '$1 分钟')
      .replace(/\b(\d+)\s+hrs?\b/gi, '$1 小时')
      .replace(/\b(\d+)d\b/g, '$1 天')
      .replace(/\b(\d+)h\b/g, '$1 小时')
      .replace(/\b(\d+)m\b/g, '$1 分钟')
      .replace(/\b(\d+)s\b/g, '$1 秒')
      .replace(/,\s*/g, ' ');
  }

  function translateText(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    if (raw.length > 520) return raw;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length < 2) return raw;
    if (CJK_RE.test(trimmed)) return raw;
    if (LOOKS_LIKE_CODE_OR_PATH_RE.test(trimmed)) return raw;

    let translated = exactMap.get(trimmed);
    if (translated === undefined) {
      for (let i = 0; i < compiledPatterns.length; i++) {
        const [re, rep] = compiledPatterns[i];
        if (re.test(trimmed)) {
          translated = trimmed.replace(re, rep);
          if (translated.includes('__DUR__')) {
            translated = translated.replace(/__DUR__(.+?)__ENDDUR__/g, (_m, g1) => translateDurationFragment(g1));
          }
          break;
        }
      }
    }
    if (translated === undefined || translated === trimmed) return raw;

    // Preserve exact leading/trailing whitespace so React layout spacing never shifts
    const leadLen = raw.indexOf(trimmed);
    const lead = leadLen > 0 ? raw.slice(0, leadLen) : '';
    const trail = raw.slice(leadLen + trimmed.length);
    return lead + translated + trail;
  }

  function isElementProtected(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.closest && el.closest(PROTECTED_SELECTOR)) return true;
    return false;
  }

  function isAttrElementProtected(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'SVG') return true;
    if (el.closest && el.closest('[data-agy-i18n-ignore],[data-testid="user-message"],[data-markdown-root],.xterm')) {
      return true;
    }
    return false;
  }

  function translateTextInContext(raw, el) {
    if (el && raw && raw.trim() === 'New') {
      const insideMenuOrOption = el.closest && el.closest('[role="menu"], [role="listbox"], [role="option"], [role="menuitem"]');
      const insideActionButton = el.closest && el.closest('button') && !insideMenuOrOption;
      if (insideMenuOrOption || !insideActionButton) {
        return raw.replace('New', '新');
      }
    }
    return translateText(raw);
  }

  function processTextNode(node) {
    const parent = node.parentElement;
    if (!parent || isElementProtected(parent)) return;

    const current = node.nodeValue;
    if (!current || !current.trim()) return;

    let rec = textRecords.get(node);
    if (state.locale === 'zh-CN') {
      if (rec) {
        if (current === rec.zh) return; // Already showing translated text
        // React updated the underlying text to a new string
        const zh = translateTextInContext(current, parent);
        rec.orig = current;
        rec.zh = zh;
        if (zh !== current) {
          node.nodeValue = zh;
        }
      } else {
        const zh = translateTextInContext(current, parent);
        if (zh !== current) {
          textRecords.set(node, { orig: current, zh });
          node.nodeValue = zh;
        }
      }
    } else {
      // Restore original English
      if (rec && current === rec.zh) {
        node.nodeValue = rec.orig;
      }
    }
  }

  function processElementAttrs(el) {
    if (!el || el.nodeType !== 1 || isAttrElementProtected(el)) return;
    let map = attrRecords.get(el);

    for (let i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
      const attr = TRANSLATABLE_ATTRS[i];
      if (!el.hasAttribute(attr)) continue;
      const cur = el.getAttribute(attr);
      if (!cur || !cur.trim()) continue;

      const rec = map ? map.get(attr) : undefined;
      if (state.locale === 'zh-CN') {
        if (rec) {
          if (cur === rec.zh) continue;
          const zh = translateText(cur);
          rec.orig = cur;
          rec.zh = zh;
          if (zh !== cur) el.setAttribute(attr, zh);
        } else {
          const zh = translateText(cur);
          if (zh !== cur) {
            if (!map) {
              map = new Map();
              attrRecords.set(el, map);
            }
            map.set(attr, { orig: cur, zh });
            el.setAttribute(attr, zh);
          }
        }
      } else {
        if (rec && cur === rec.zh) {
          el.setAttribute(attr, rec.orig);
        }
      }
    }
  }

  function processPureTextChildren(el) {
    if (!el || el.nodeType !== 1 || isElementProtected(el)) return false;
    const kids = el.childNodes;
    if (!kids || kids.length < 2) return false;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType !== 3) return false;
    }

    if (state.locale === 'zh-CN') {
      let alreadyTranslated = true;
      const origParts = [];
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        const rec = textRecords.get(k);
        if (!rec || k.nodeValue !== rec.zh) {
          alreadyTranslated = false;
          origParts.push(k.nodeValue || '');
        } else {
          origParts.push(rec.orig);
        }
      }
      if (alreadyTranslated) return true;

      const joined = origParts.join('');
      const zh = translateText(joined);
      if (zh === joined) return false;

      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        const target = i === 0 ? zh : '';
        textRecords.set(k, { orig: origParts[i], zh: target });
        if (k.nodeValue !== target) k.nodeValue = target;
      }
      return true;
    } else {
      let restoredAny = false;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        const rec = textRecords.get(k);
        if (rec && k.nodeValue === rec.zh) {
          k.nodeValue = rec.orig;
          restoredAny = true;
        }
      }
      return restoredAny;
    }
  }

  function walkSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (!processPureTextChildren(root.parentElement)) {
        processTextNode(root);
      }
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;

    if (root.nodeType === 1) {
      if (root.matches && root.matches('[data-agy-i18n-ignore]')) return;
      processElementAttrs(root);
      if (processPureTextChildren(root)) return;
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (n.hasAttribute && n.hasAttribute('data-agy-i18n-ignore')) {
              return NodeFilter.FILTER_REJECT;
            }
            if (SKIP_TAGS.has(n.tagName) && n.tagName !== 'INPUT' && n.tagName !== 'TEXTAREA') {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const handledParents = new Set();
    let curr;
    while ((curr = walker.nextNode())) {
      if (curr.nodeType === 3) {
        if (handledParents.has(curr.parentElement)) continue;
        processTextNode(curr);
      } else if (curr.nodeType === 1) {
        processElementAttrs(curr);
        if (processPureTextChildren(curr)) {
          handledParents.add(curr);
        }
      }
    }
  }

  function updateDocumentMeta() {
    if (document.documentElement) {
      document.documentElement.lang = state.locale === 'zh-CN' ? 'zh-CN' : 'en';
    }
    if (typeof document.title === 'string' && document.title) {
      if (originalDocTitle === null) originalDocTitle = document.title;
      if (state.locale === 'zh-CN') {
        const t = translateText(originalDocTitle);
        if (t !== document.title) document.title = t;
      } else if (originalDocTitle && document.title !== originalDocTitle) {
        document.title = originalDocTitle;
      }
    }
  }

  const observedIframes = new WeakSet();

  function attachSameOriginIframes(root) {
    if (!root || !root.querySelectorAll) return;
    const frames = root.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i];
      try {
        const fdoc = fr.contentDocument;
        if (!fdoc || !fdoc.body) continue;
        walkSubtree(fdoc.body);
        if (!observedIframes.has(fdoc)) {
          observedIframes.add(fdoc);
          const fobs = new MutationObserver((mutations) => {
            if (isApplying || state.locale !== 'zh-CN') return;
            for (let m = 0; m < mutations.length; m++) {
              const mut = mutations[m];
              if (mut.type === 'characterData' || mut.type === 'attributes') {
                scheduleNode(mut.target);
              } else if (mut.type === 'childList') {
                for (let j = 0; j < mut.addedNodes.length; j++) scheduleNode(mut.addedNodes[j]);
              }
            }
          });
          fobs.observe(fdoc.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: TRANSLATABLE_ATTRS,
          });
        }
      } catch (_crossOrigin) {
        // Cross-origin iframe: safely ignored
      }
    }
  }

  function applyFullPass() {
    if (!document.body) return;
    isApplying = true;
    try {
      walkSubtree(document.body);
      attachSameOriginIframes(document);
      updateDocumentMeta();
      updateWidgetUI();
    } finally {
      isApplying = false;
    }
  }

  function flushPending() {
    flushScheduled = false;
    if (pendingRoots.size === 0) return;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();

    isApplying = true;
    try {
      for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        if (!r || !r.isConnected) continue;
        walkSubtree(r);
      }
    } finally {
      isApplying = false;
    }
  }

  function scheduleNode(node) {
    if (!node || state.locale !== 'zh-CN') return;
    pendingRoots.add(node);
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flushPending);
    }
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (isApplying || state.locale !== 'zh-CN') return;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'characterData') {
          scheduleNode(m.target);
        } else if (m.type === 'attributes') {
          scheduleNode(m.target);
        } else if (m.type === 'childList') {
          for (let j = 0; j < m.addedNodes.length; j++) {
            scheduleNode(m.addedNodes[j]);
          }
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRS,
    });
  }

  function detectDarkTheme() {
    const html = document.documentElement;
    if (!html) return true;
    const cs = (html.style && html.style.colorScheme) || '';
    if (cs.includes('dark')) return true;
    if (cs.includes('light')) return false;
    if (html.classList.contains('dark')) return true;
    if (html.classList.contains('light')) return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function updateWidgetUI() {
    // Legacy bottom-right [中 | EN] pill has been replaced by the unified settings button.
    // Broadcast state changes so the unified settings UI stays in sync with ⌘⌥L & macOS menu bar.
    try {
      const legacy = document.getElementById('agy-i18n-host');
      if (legacy) legacy.remove();
    } catch (_e) {}
    try {
      window.dispatchEvent(new CustomEvent('agy-i18n:state', {
        detail: {
          locale: state.locale,
          showFloatingToggle: state.showFloatingToggle !== false,
        },
      }));
    } catch (_e) {}
  }

  function requestLocaleChange(nextLocale) {
    if (nextLocale === state.locale) return;
    // Optimistic instant local switch (<10ms)
    state.locale = nextLocale;
    applyFullPass();
    // Persist & sync to Main Process (updates macOS menu, tray, dock & all windows)
    try {
      const bridge = window.__AGY_I18N_BRIDGE__;
      if (bridge && typeof bridge.setLocale === 'function') {
        bridge.setLocale(nextLocale).catch(() => {});
      }
    } catch (_e) {}
  }

  function mountFloatingWidget() {
    // Replaced by unified floating settings icon in telemetry/settings overlay.
    updateWidgetUI();
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    const dictChanged = next.dict && next.dict !== state.dict;
    const prevLocale = state.locale;
    if (next.dict) {
      state.dict = next.dict;
      compileDict(state.dict);
    }
    if (next.locale === 'zh-CN' || next.locale === 'en') {
      state.locale = next.locale;
    }
    if (typeof next.showFloatingToggle === 'boolean') {
      state.showFloatingToggle = next.showFloatingToggle;
    }
    // If dictionary hot-reloaded while in zh-CN, restore then re-apply so updated entries take effect immediately
    if (dictChanged && prevLocale === 'zh-CN' && state.locale === 'zh-CN') {
      state.locale = 'en';
      applyFullPass();
      state.locale = 'zh-CN';
    }
    applyFullPass();
  }

  // Renderer keyboard shortcut fallback: Cmd+Option+L (macOS) / Ctrl+Alt+L
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && (e.code === 'KeyL' || e.key.toLowerCase() === 'l')) {
      e.preventDefault();
      e.stopPropagation();
      requestLocaleChange(state.locale === 'zh-CN' ? 'en' : 'zh-CN');
    }
  }, true);

  function init(initialState) {
    if (initialState) {
      if (initialState.dict) {
        state.dict = initialState.dict;
        compileDict(state.dict);
      }
      if (initialState.locale) state.locale = initialState.locale;
      if (typeof initialState.showFloatingToggle === 'boolean') {
        state.showFloatingToggle = initialState.showFloatingToggle;
      }
    }

    const bootDom = () => {
      mountFloatingWidget();
      startObserver();
      applyFullPass();
    };
    if (document.body) {
      bootDom();
    } else {
      window.addEventListener('DOMContentLoaded', bootDom, { once: true });
    }

    const bridge = window.__AGY_I18N_BRIDGE__;
    if (bridge && typeof bridge.onStateChanged === 'function') {
      bridge.onStateChanged((next) => applyState(next));
    }
    if (bridge && typeof bridge.getState === 'function') {
      Promise.resolve(bridge.getState())
        .then((fetched) => {
          if (fetched) applyState(fetched);
        })
        .catch(() => {});
    }
  }

  window.__AGY_I18N_ENGINE__ = {
    version: '1.0.0',
    init,
    applyState,
    setLocale: requestLocaleChange,
    toggle: () => requestLocaleChange(state.locale === 'zh-CN' ? 'en' : 'zh-CN'),
    getLocale: () => state.locale,
  };
})();
