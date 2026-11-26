(() => {
  'use strict';
  if (window.self !== window.top) return;
  if (window.__AGY_ENHANCEMENTS__) return;

  // ---------------------------------------------------------------------------
  // Shared Settings State
  // ---------------------------------------------------------------------------
  let cfg = {
    locale: 'zh-CN',
    fileOpenMode: 'sidebar', // 'sidebar' | 'finder' | 'external'
    codeBlockEnhance: true,
    streamFadeIn: true,
    smoothCaret: true,
  };

  const isZh = () => cfg.locale === 'zh-CN';

  function detectAccent() {
    const vars = ['--primary', '--color-primary', '--sdk-primary'];
    for (const el of [document.body, document.documentElement].filter(Boolean)) {
      try {
        const cs = getComputedStyle(el);
        for (const v of vars) {
          const val = cs.getPropertyValue(v).trim();
          if (val && val !== 'transparent' && val !== 'none') return val;
        }
      } catch (_e) {}
    }
    return '#3b82f6';
  }

  // ===========================================================================
  // 1. Code Block Enhancements: Sticky Header + Manual Fold for >= 48 lines
  // ===========================================================================
  const CODE_STYLE_ID = 'agy-code-enhance-style';
  const CODE_FOLD_MIN_LINES = 48;
  const codeBlockState = new WeakMap(); // pre -> { len, stableAt, collapsed }
  let codeScanTimer = null;

  function ensureCodeStyles() {
    let style = document.getElementById(CODE_STYLE_ID);
    if (!cfg.codeBlockEnhance) {
      if (style) style.remove();
      teardownCodeBlocks();
      return;
    }
    if (style) return;
    style = document.createElement('style');
    style.id = CODE_STYLE_ID;
    style.textContent = `
      .agy-code-sticky-host {
        overflow: visible !important;
      }
      .agy-code-sticky-head {
        position: sticky !important;
        top: 0 !important;
        z-index: 4 !important;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      .agy-code-fold-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 22px;
        padding: 0 8px;
        margin-right: 4px;
        border-radius: 6px;
        border: 1px solid rgba(128, 128, 138, 0.24);
        background: rgba(128, 128, 138, 0.10);
        color: var(--muted-foreground, inherit);
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
        transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
      }
      .agy-code-fold-btn:hover {
        background: rgba(128, 128, 138, 0.20);
        color: var(--foreground, inherit);
      }
      .agy-code-fold-btn.floating {
        position: absolute;
        top: 8px;
        right: 44px;
        z-index: 5;
      }
      pre.agy-code-collapsed {
        max-height: 248px !important;
        overflow: hidden !important;
        position: relative !important;
        mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
        -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
      }
      .agy-code-fold-bar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        padding: 6px 10px;
        margin-top: -2px;
        border: none;
        border-top: 1px solid rgba(128, 128, 138, 0.14);
        background: transparent;
        color: var(--muted-foreground, rgba(128, 128, 138, 0.9));
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        transition: color 0.14s ease, background-color 0.14s ease;
      }
      .agy-code-fold-bar:hover {
        color: var(--foreground, inherit);
        background: rgba(128, 128, 138, 0.08);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function teardownCodeBlocks() {
    document.querySelectorAll('.agy-code-fold-btn, .agy-code-fold-bar').forEach((n) => n.remove());
    document.querySelectorAll('pre.agy-code-collapsed').forEach((p) => p.classList.remove('agy-code-collapsed'));
    document.querySelectorAll('.agy-code-sticky-head').forEach((h) => h.classList.remove('agy-code-sticky-head'));
    document.querySelectorAll('.agy-code-sticky-host').forEach((w) => w.classList.remove('agy-code-sticky-host'));
  }

  function findCodeHeaderForPre(pre) {
    const parent = pre.parentElement;
    if (!parent) return null;
    // Common pattern: wrapper div -> [headerBar, pre] or [headerBar, scrollWrapper(pre)]
    let prev = pre.previousElementSibling;
    if (prev && prev.tagName !== 'PRE' && prev.clientHeight > 0 && prev.clientHeight <= 48) {
      return { wrapper: parent, header: prev };
    }
    const grand = parent.parentElement;
    if (grand && parent.children.length === 1) {
      prev = parent.previousElementSibling;
      if (prev && prev.tagName !== 'PRE' && prev.clientHeight > 0 && prev.clientHeight <= 48) {
        return { wrapper: grand, header: prev };
      }
    }
    return null;
  }

  function findScrollAncestor(el) {
    let cur = el?.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const oy = getComputedStyle(cur).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 4) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function toggleCodeFold(pre, lines, forceState) {
    const st = codeBlockState.get(pre) || { len: 0, stableAt: 0, collapsed: false };
    const nextCollapsed = typeof forceState === 'boolean' ? forceState : !st.collapsed;
    if (nextCollapsed === st.collapsed) return;

    const scroller = findScrollAncestor(pre);
    const rectBefore = pre.getBoundingClientRect();
    const heightBefore = pre.offsetHeight;

    st.collapsed = nextCollapsed;
    codeBlockState.set(pre, st);
    pre.classList.toggle('agy-code-collapsed', nextCollapsed);

    // If collapsing a tall block whose top is above viewport, adjust scroll so reading position doesn't jump
    if (nextCollapsed && scroller && rectBefore.top < 60) {
      const delta = heightBefore - pre.offsetHeight;
      if (delta > 0) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - delta);
      }
    }

    // Sync fold button & bottom expand bar
    const zh = isZh();
    const btn = pre.__agyFoldBtn;
    if (btn && btn.isConnected) {
      btn.textContent = nextCollapsed
        ? (zh ? `展开 (${lines} 行)` : `Expand (${lines} lines)`)
        : (zh ? `收起 (${lines} 行)` : `Fold (${lines} lines)`);
    }

    let bar = pre.nextElementSibling;
    if (bar && !bar.classList?.contains('agy-code-fold-bar')) bar = null;
    if (nextCollapsed) {
      if (!bar) {
        bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'agy-code-fold-bar';
        bar.setAttribute('data-agy-i18n-ignore', '1');
        bar.setAttribute('data-agy-telemetry-ignore', '1');
        bar.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCodeFold(pre, lines, false);
        });
        pre.insertAdjacentElement('afterend', bar);
      }
      bar.textContent = zh ? `展开全部 ${lines} 行代码` : `Show all ${lines} lines`;
    } else if (bar) {
      bar.remove();
    }
  }

  function scanCodeBlocks() {
    if (!cfg.codeBlockEnhance) return;
    ensureCodeStyles();

    const now = Date.now();
    const pres = document.querySelectorAll('[data-markdown-root] pre');
    for (const pre of pres) {
      if (!pre || !pre.isConnected) continue;
      if (pre.closest?.('[data-testid="user-message"], .xterm')) continue;

      const codeEl = pre.querySelector('code') || pre;
      const text = codeEl.textContent || '';
      const len = text.length;
      if (len < 80) continue;

      // Apply sticky header if present
      const hdrInfo = findCodeHeaderForPre(pre);
      if (hdrInfo && hdrInfo.header) {
        hdrInfo.header.classList.add('agy-code-sticky-head');
        if (hdrInfo.wrapper) {
          const ov = getComputedStyle(hdrInfo.wrapper).overflow;
          if (ov === 'hidden' || ov === 'clip') {
            hdrInfo.wrapper.classList.add('agy-code-sticky-host');
          }
        }
      }

      const lines = text.split('\n').length;
      if (lines < CODE_FOLD_MIN_LINES) continue;

      let st = codeBlockState.get(pre);
      if (!st) {
        st = { len, stableAt: now, collapsed: false };
        codeBlockState.set(pre, st);
        scheduleCodeScan(750);
        continue;
      }
      if (st.len !== len) {
        st.len = len;
        st.stableAt = now;
        scheduleCodeScan(750);
        continue;
      }
      if (now - st.stableAt < 650) {
        scheduleCodeScan(700);
        continue;
      }

      // Settled long code block: mount manual fold button
      let btn = pre.__agyFoldBtn;
      const zh = isZh();
      const label = st.collapsed
        ? (zh ? `展开 (${lines} 行)` : `Expand (${lines} lines)`)
        : (zh ? `收起 (${lines} 行)` : `Fold (${lines} lines)`);

      if (!btn || !btn.isConnected) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'agy-code-fold-btn';
        btn.setAttribute('data-agy-i18n-ignore', '1');
        btn.setAttribute('data-agy-telemetry-ignore', '1');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const curLines = ((pre.querySelector('code') || pre).textContent || '').split('\n').length;
          toggleCodeFold(pre, curLines);
        });

        if (hdrInfo && hdrInfo.header) {
          const rightAction = hdrInfo.header.querySelector('button');
          if (rightAction && rightAction.parentElement) {
            rightAction.parentElement.insertBefore(btn, rightAction);
          } else {
            hdrInfo.header.appendChild(btn);
          }
        } else {
          btn.classList.add('floating');
          if (getComputedStyle(pre).position === 'static') pre.style.position = 'relative';
          pre.appendChild(btn);
        }
        pre.__agyFoldBtn = btn;
      }
      if (btn.textContent !== label) btn.textContent = label;
    }
  }

  function scheduleCodeScan(delay = 220) {
    if (!cfg.codeBlockEnhance) return;
    if (codeScanTimer) return;
    codeScanTimer = setTimeout(() => {
      codeScanTimer = null;
      scanCodeBlocks();
    }, delay);
  }

  // ===========================================================================
  // 2. Local File Link Click Routing (Sidebar / Finder / System Default App)
  // ===========================================================================
  const ABS_LOCAL_PREFIX_RE = /^\/(?:Users|Applications|Volumes|Library|opt|tmp|var|etc|System|private)\//;

  function extractLocalFilePathFromTarget(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.closest?.('#agy-settings-host, #agy-telemetry-bar-host, #agy-telemetry-popover-host, #agy-home-dashboard-host, aside, [data-testid="conversation-list-sidebar"]')) {
      return null;
    }
    // Only intercept inside conversation/markdown/artifact areas
    const inChat = target.closest?.('[data-markdown-root], [data-testid*="message"], [data-testid*="artifact"], main');
    if (!inChat) return null;

    // 1. Standard <a href="file:///...">
    const anchor = target.closest?.('a[href]');
    if (anchor) {
      const href = (anchor.getAttribute('href') || '').trim();
      if (/^file:\/\//i.test(href)) return href;
      if (ABS_LOCAL_PREFIX_RE.test(href)) return href;
      return null;
    }

    // 2. File reference buttons/chips with explicit path attributes or absolute path title
    const clickable = target.closest?.('button, [role="button"], [data-file-path], [data-path], [data-uri]');
    if (clickable) {
      for (const attr of ['data-file-path', 'data-path', 'data-uri', 'href']) {
        const v = (clickable.getAttribute?.(attr) || '').trim();
        if (/^file:\/\//i.test(v) || ABS_LOCAL_PREFIX_RE.test(v)) return v;
      }
      const title = (clickable.getAttribute?.('title') || '').trim();
      if (/^file:\/\//i.test(title) || ABS_LOCAL_PREFIX_RE.test(title)) return title;
    }

    return null;
  }

  document.addEventListener('click', (ev) => {
    if (cfg.fileOpenMode === 'sidebar') return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
    const api = window.__AGY_TELEMETRY_API__;
    if (!api || typeof api.openLocalFile !== 'function') return;

    const targetPath = extractLocalFilePathFromTarget(ev.target);
    if (!targetPath) return;

    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();

    api.openLocalFile({ targetPath, mode: cfg.fileOpenMode }).catch(() => {});
  }, true);

  // ===========================================================================
  // 3. Streaming Text Ink Fade-in (CSS.highlights, Zero-DOM, 0fps Idle)
  // ===========================================================================
  const FADE_STYLE_ID = 'agy-stream-fade-style';
  const FADE_DURATION_MS = 230;
  const FADE_BUCKETS = 4;
  const SUPPORTS_HIGHLIGHTS = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  let fadeEntries = []; // { range, startMs }
  let fadeRaf = null;
  let fadeObserver = null;
  const textLenCache = new WeakMap();

  function ensureFadeStyles() {
    let style = document.getElementById(FADE_STYLE_ID);
    if (!cfg.streamFadeIn || !SUPPORTS_HIGHLIGHTS) {
      if (style) style.remove();
      clearAllFadeHighlights();
      return;
    }
    if (style) return;
    style = document.createElement('style');
    style.id = FADE_STYLE_ID;
    style.textContent = `
      ::highlight(agy-stream-f1) { color: color-mix(in srgb, var(--foreground, currentColor) 24%, transparent); }
      ::highlight(agy-stream-f2) { color: color-mix(in srgb, var(--foreground, currentColor) 50%, transparent); }
      ::highlight(agy-stream-f3) { color: color-mix(in srgb, var(--foreground, currentColor) 76%, transparent); }
      ::highlight(agy-stream-f4) { color: color-mix(in srgb, var(--foreground, currentColor) 92%, transparent); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function clearAllFadeHighlights() {
    fadeEntries = [];
    if (fadeRaf) {
      cancelAnimationFrame(fadeRaf);
      fadeRaf = null;
    }
    if (!SUPPORTS_HIGHLIGHTS) return;
    for (let i = 1; i <= FADE_BUCKETS; i++) {
      try { CSS.highlights.delete(`agy-stream-f${i}`); } catch (_e) {}
    }
  }

  function isStreamEligibleNode(node) {
    const el = node?.nodeType === 3 ? node.parentElement : node;
    if (!el || el.nodeType !== 1) return false;
    if (!el.closest?.('[data-markdown-root]')) return false;
    if (el.closest?.('[data-testid="user-message"], pre, code, .xterm, [contenteditable="true"], #agy-settings-host, #agy-telemetry-bar-host, #agy-telemetry-popover-host, #agy-home-dashboard-host, .agy-turn-footer, .agy-code-fold-btn, .agy-code-fold-bar')) {
      return false;
    }
    return true;
  }

  function enqueueFadeRange(textNode, startOffset, endOffset) {
    if (!cfg.streamFadeIn || !SUPPORTS_HIGHLIGHTS) return;
    const len = textNode?.nodeValue?.length || 0;
    const s = Math.max(0, Math.min(startOffset, len));
    const e = Math.max(s, Math.min(endOffset, len));
    if (e <= s) return;
    try {
      const range = document.createRange();
      range.setStart(textNode, s);
      range.setEnd(textNode, e);
      fadeEntries.push({ range, startMs: performance.now() });
      if (fadeEntries.length > 80) fadeEntries.splice(0, fadeEntries.length - 80);
      if (!fadeRaf) fadeRaf = requestAnimationFrame(tickFadeHighlights);
    } catch (_err) {}
  }

  function tickFadeHighlights(now) {
    fadeRaf = null;
    if (!cfg.streamFadeIn || !SUPPORTS_HIGHLIGHTS || fadeEntries.length === 0) {
      clearAllFadeHighlights();
      return;
    }

    const buckets = [[], [], [], []];
    const remaining = [];
    for (const entry of fadeEntries) {
      const elapsed = now - entry.startMs;
      if (elapsed >= FADE_DURATION_MS) continue;
      if (!entry.range?.startContainer?.isConnected) continue;
      const ratio = elapsed / FADE_DURATION_MS;
      const idx = Math.min(FADE_BUCKETS - 1, Math.floor(ratio * FADE_BUCKETS));
      buckets[idx].push(entry.range);
      remaining.push(entry);
    }
    fadeEntries = remaining;

    for (let i = 0; i < FADE_BUCKETS; i++) {
      const name = `agy-stream-f${i + 1}`;
      try {
        if (buckets[i].length > 0) {
          CSS.highlights.set(name, new Highlight(...buckets[i]));
        } else {
          CSS.highlights.delete(name);
        }
      } catch (_e) {}
    }

    if (fadeEntries.length > 0) {
      fadeRaf = requestAnimationFrame(tickFadeHighlights);
    }
  }

  function handleStreamMutations(mutations) {
    if (!cfg.streamFadeIn || !SUPPORTS_HIGHLIGHTS || document.hidden) return;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const tn = m.target;
        if (!tn || tn.nodeType !== 3 || !isStreamEligibleNode(tn)) continue;
        const newLen = tn.nodeValue?.length || 0;
        const prevLen = typeof m.oldValue === 'string'
          ? m.oldValue.length
          : (textLenCache.get(tn) || 0);
        textLenCache.set(tn, newLen);
        if (newLen > prevLen && (newLen - prevLen) <= 240) {
          enqueueFadeRange(tn, prevLen, newLen);
        }
      } else if (m.type === 'childList' && m.addedNodes?.length) {
        // Skip massive bulk insertions (like initial history load on route switch)
        if (m.addedNodes.length > 16) continue;
        for (const node of m.addedNodes) {
          if (!isStreamEligibleNode(node)) continue;
          if (node.nodeType === 3) {
            const len = node.nodeValue?.length || 0;
            textLenCache.set(node, len);
            if (len > 0 && len <= 240) enqueueFadeRange(node, 0, len);
          } else if (node.nodeType === 1) {
            const txtLen = (node.textContent || '').length;
            if (txtLen === 0 || txtLen > 240) continue;
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let cur;
            while ((cur = walker.nextNode())) {
              const l = cur.nodeValue?.length || 0;
              textLenCache.set(cur, l);
              if (l > 0) enqueueFadeRange(cur, 0, l);
            }
          }
        }
      }
    }
  }

  function syncFadeObserver() {
    ensureFadeStyles();
    if (!cfg.streamFadeIn || !SUPPORTS_HIGHLIGHTS) {
      if (fadeObserver) {
        fadeObserver.disconnect();
        fadeObserver = null;
      }
      return;
    }
    if (fadeObserver || !document.body) return;
    fadeObserver = new MutationObserver(handleStreamMutations);
    fadeObserver.observe(document.body, {
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    });
  }

  // ===========================================================================
  // 4. Composer Smooth Caret (IME & Selection Safe, Zero Idle Overhead)
  // ===========================================================================
  const CARET_STYLE_ID = 'agy-smooth-caret-style';
  let caretEl = null;
  let caretActiveEditor = null;
  let caretComposing = false;
  let caretUserBlurred = false;
  let caretIdleTimer = null;
  let caretRaf = null;

  function ensureCaretStyleAndEl() {
    let style = document.getElementById(CARET_STYLE_ID);
    if (!cfg.smoothCaret) {
      if (style) style.remove();
      teardownCaret();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = CARET_STYLE_ID;
      style.textContent = `
        .agy-smooth-caret-active {
          caret-color: transparent !important;
        }
        #agy-smooth-caret {
          position: fixed;
          top: 0;
          left: 0;
          width: 1.8px;
          height: 18px;
          border-radius: 1px;
          pointer-events: none;
          z-index: 2147483640;
          opacity: 0;
          will-change: transform, opacity;
          transition: transform 78ms cubic-bezier(0.22, 1, 0.36, 1), height 78ms ease, opacity 110ms ease;
        }
        #agy-smooth-caret.blinking {
          animation: agy-caret-blink 1.05s ease-in-out infinite;
        }
        @keyframes agy-caret-blink {
          0%, 45% { opacity: 1; }
          55%, 100% { opacity: 0.12; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    if (!caretEl || !caretEl.isConnected) {
      caretEl = document.createElement('div');
      caretEl.id = 'agy-smooth-caret';
      caretEl.setAttribute('data-agy-i18n-ignore', '1');
      caretEl.setAttribute('data-agy-telemetry-ignore', '1');
      document.documentElement.appendChild(caretEl);
    }
  }

  function hideCaret(restoreNative = true) {
    if (caretIdleTimer) {
      clearTimeout(caretIdleTimer);
      caretIdleTimer = null;
    }
    if (caretEl) {
      caretEl.classList.remove('blinking');
      caretEl.style.opacity = '0';
    }
    if (restoreNative && caretActiveEditor) {
      caretActiveEditor.classList.remove('agy-smooth-caret-active');
    }
  }

  function teardownCaret() {
    hideCaret(true);
    caretActiveEditor = null;
    if (caretEl && caretEl.isConnected) caretEl.remove();
    caretEl = null;
  }

  function isComposerEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest?.('.xterm, .monaco-editor, #agy-settings-host, [role="dialog"]')) return false;
    if (el.isContentEditable) return true;
    return false;
  }

  function measureContentEditableCaret(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    if (!editor.contains(sel.anchorNode)) return null;

    const edRect = editor.getBoundingClientRect();
    if (!edRect || edRect.width <= 0 || edRect.height <= 0) return null;

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rects = range.getClientRects();
    let rect = rects && rects.length > 0 ? rects[rects.length - 1] : null;

    if (!rect || (rect.height === 0 && rect.width === 0)) {
      const r2 = range.getBoundingClientRect();
      if (r2 && r2.height > 0) {
        rect = r2;
      }
    }

    // Handle Shift+Enter / <br> / element-offset positions where getClientRects() returns empty
    if (!rect || rect.height === 0) {
      const node = sel.anchorNode;
      const offset = sel.anchorOffset;
      const anchorEl = node.nodeType === 1 ? node : node.parentElement;
      const cs = getComputedStyle(anchorEl || editor);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.4;

      if (node.nodeType === 1) {
        const atChild = node.childNodes[offset] || null;
        const prevChild = offset > 0 ? node.childNodes[offset - 1] : null;

        // 1. Caret sits right before a <br> or inline element on the current (possibly new) line
        if (atChild && atChild.nodeType === 1) {
          const ar = atChild.getBoundingClientRect();
          if (ar && ar.height > 0) {
            rect = { left: ar.left, top: ar.top, height: ar.height };
          }
        }
        // 2. Caret sits right after a <br> (e.g. Shift+Enter at end of paragraph)
        if ((!rect || rect.height === 0) && prevChild && prevChild.nodeType === 1) {
          const pr = prevChild.getBoundingClientRect();
          if (pr && pr.height > 0) {
            if (prevChild.tagName === 'BR') {
              const blockBox = (anchorEl && editor.contains(anchorEl) ? anchorEl : editor).getBoundingClientRect();
              const lineLeft = blockBox.left + padL;
              // If the <br> sits at the end of a non-empty line (to the right of lineLeft),
              // the caret is on the NEXT line below it; if it's already on a blank line, use its top.
              const isInlineBreak = pr.left > lineLeft + 6;
              rect = {
                left: lineLeft,
                top: isInlineBreak ? pr.bottom : pr.top,
                height: pr.height || lh,
              };
            } else {
              rect = { left: pr.right, top: pr.top, height: pr.height };
            }
          }
        }
        // 3. Caret sits right after a text node
        if ((!rect || rect.height === 0) && prevChild && prevChild.nodeType === 3) {
          const len = prevChild.nodeValue?.length || 0;
          if (len > 0) {
            try {
              const tr = document.createRange();
              tr.setStart(prevChild, len - 1);
              tr.setEnd(prevChild, len);
              const tRects = tr.getClientRects();
              const lr = tRects && tRects.length > 0 ? tRects[tRects.length - 1] : null;
              if (lr && lr.height > 0) {
                rect = { left: lr.right, top: lr.top, height: lr.height };
              }
            } catch (_e) {}
          }
        }
        // 4. Truly empty block element (0 text inside this block, e.g. blank editor or new <p></p>)
        if ((!rect || rect.height === 0) && offset === 0 && (node.textContent || '').length === 0) {
          const box = node.getBoundingClientRect();
          if (box && box.height > 0) {
            const padT = parseFloat(cs.paddingTop) || 0;
            rect = { left: box.left + padL, top: box.top + padT, height: lh };
          }
        }
      }
    }

    // Never jump to an uncertain fallback coordinate: if unmeasurable, yield cleanly to native caret
    if (!rect || rect.height <= 0) return null;
    if (rect.top < edRect.top - 4 || rect.top > edRect.bottom + 4) return null;
    if (rect.left < edRect.left - 4 || rect.left > edRect.right + 4) return null;
    const h = Math.max(14, Math.min(28, rect.height || 18));
    return { x: rect.left, y: rect.top, h };
  }

  let caretResizeObs = null;
  function watchActiveEditorGeometry(editor) {
    if (typeof ResizeObserver !== 'function') return;
    if (caretResizeObs) {
      caretResizeObs.disconnect();
      caretResizeObs = null;
    }
    if (!editor) return;
    caretResizeObs = new ResizeObserver(() => scheduleCaretUpdate());
    try {
      caretResizeObs.observe(editor);
      if (editor.parentElement) caretResizeObs.observe(editor.parentElement);
    } catch (_e) {}
  }

  function updateCaretNow() {
    caretRaf = null;
    if (!cfg.smoothCaret || caretComposing || caretUserBlurred || !document.hasFocus()) {
      hideCaret(true);
      return;
    }
    const active = document.activeElement;
    if (!isComposerEditable(active)) {
      hideCaret(true);
      caretActiveEditor = null;
      return;
    }
    ensureCaretStyleAndEl();
    const pos = measureContentEditableCaret(active);
    if (!pos || !caretEl) {
      hideCaret(true);
      return;
    }

    if (caretActiveEditor !== active) {
      if (caretActiveEditor) caretActiveEditor.classList.remove('agy-smooth-caret-active');
      caretActiveEditor = active;
      watchActiveEditorGeometry(active);
    }
    active.classList.add('agy-smooth-caret-active');

    caretEl.style.backgroundColor = detectAccent();
    caretEl.style.height = `${Math.round(pos.h)}px`;
    caretEl.style.transform = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0)`;
    caretEl.style.opacity = '1';
    caretEl.classList.remove('blinking');

    if (caretIdleTimer) clearTimeout(caretIdleTimer);
    caretIdleTimer = setTimeout(() => {
      if (caretEl && caretEl.style.opacity === '1' && !caretUserBlurred && document.hasFocus()) {
        caretEl.classList.add('blinking');
      }
    }, 480);
  }

  function scheduleCaretUpdate() {
    if (!cfg.smoothCaret) return;
    if (caretRaf) return;
    caretRaf = requestAnimationFrame(updateCaretNow);
  }

  document.addEventListener('selectionchange', scheduleCaretUpdate, true);
  document.addEventListener('input', () => {
    caretUserBlurred = false;
    scheduleCaretUpdate();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (isComposerEditable(document.activeElement)) {
      caretUserBlurred = false;
      scheduleCaretUpdate();
    }
  }, true);
  document.addEventListener('keyup', scheduleCaretUpdate, true);
  document.addEventListener('mouseup', scheduleCaretUpdate, true);
  document.addEventListener('focusin', (ev) => {
    if (isComposerEditable(ev.target)) {
      caretUserBlurred = false;
      scheduleCaretUpdate();
    } else {
      caretUserBlurred = true;
      hideCaret(true);
    }
  }, true);
  document.addEventListener('focusout', () => {
    caretUserBlurred = true;
    hideCaret(true);
  }, true);
  document.addEventListener('pointerdown', (ev) => {
    const pathArr = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const hitEditor = pathArr.some((el) => isComposerEditable(el));
    if (hitEditor) {
      caretUserBlurred = false;
      scheduleCaretUpdate();
    } else {
      caretUserBlurred = true;
      hideCaret(true);
    }
  }, true);
  window.addEventListener('blur', () => {
    caretUserBlurred = true;
    hideCaret(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      caretUserBlurred = true;
      hideCaret(true);
    }
  });
  window.addEventListener('resize', scheduleCaretUpdate);
  window.addEventListener('agy-layout-shift', scheduleCaretUpdate);
  document.addEventListener('scroll', () => {
    if (caretActiveEditor && !caretUserBlurred) scheduleCaretUpdate();
  }, true);
  document.addEventListener('compositionstart', () => {
    caretComposing = true;
    hideCaret(true);
  }, true);
  document.addEventListener('compositionend', () => {
    caretComposing = false;
    scheduleCaretUpdate();
  }, true);

  // ===========================================================================
  // Lifecycle & Settings Bridge
  // ===========================================================================
  let domWatchObs = null;

  function startDomWatch() {
    if (domWatchObs || !document.body) return;
    domWatchObs = new MutationObserver((mutations) => {
      if (!cfg.codeBlockEnhance) return;
      for (const m of mutations) {
        const t = m.target;
        if (t && t.nodeType === 1 && t.closest?.('#agy-settings-host, #agy-telemetry-bar-host, #agy-telemetry-popover-host, #agy-home-dashboard-host, #agy-smooth-caret')) {
          continue;
        }
        scheduleCodeScan(260);
        break;
      }
    });
    domWatchObs.observe(document.body, { childList: true, subtree: true });
  }

  function applySettings(next) {
    if (!next || typeof next !== 'object') return;
    const prevLocale = cfg.locale;
    if (next.i18n?.locale) cfg.locale = next.i18n.locale === 'en' ? 'en' : 'zh-CN';
    const tel = next.telemetry || next;
    if (['sidebar', 'finder', 'external'].includes(tel.fileOpenMode)) cfg.fileOpenMode = tel.fileOpenMode;
    if (typeof tel.codeBlockEnhance === 'boolean') cfg.codeBlockEnhance = tel.codeBlockEnhance;
    if (typeof tel.streamFadeIn === 'boolean') cfg.streamFadeIn = tel.streamFadeIn;
    if (typeof tel.smoothCaret === 'boolean') cfg.smoothCaret = tel.smoothCaret;

    ensureCodeStyles();
    if (cfg.codeBlockEnhance) {
      if (prevLocale !== cfg.locale) {
        // Refresh fold button labels in new language
        document.querySelectorAll('[data-markdown-root] pre').forEach((pre) => {
          const st = codeBlockState.get(pre);
          if (st && pre.__agyFoldBtn) {
            const lines = ((pre.querySelector('code') || pre).textContent || '').split('\n').length;
            pre.__agyFoldBtn.textContent = st.collapsed
              ? (isZh() ? `展开 (${lines} 行)` : `Expand (${lines} lines)`)
              : (isZh() ? `收起 (${lines} 行)` : `Fold (${lines} lines)`);
            const bar = pre.nextElementSibling;
            if (bar && bar.classList?.contains('agy-code-fold-bar')) {
              bar.textContent = isZh() ? `展开全部 ${lines} 行代码` : `Show all ${lines} lines`;
            }
          }
        });
      }
      scheduleCodeScan(120);
    }

    syncFadeObserver();
    ensureCaretStyleAndEl();
  }

  function boot() {
    startDomWatch();
    ensureCodeStyles();
    syncFadeObserver();
    ensureCaretStyleAndEl();
    scheduleCodeScan(300);
  }

  if (document.body) boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });

  window.addEventListener('agy-i18n:state', (ev) => {
    if (ev?.detail?.locale) applySettings({ i18n: { locale: ev.detail.locale } });
  });

  window.__AGY_ENHANCEMENTS__ = {
    version: '1.0.0',
    applySettings,
    rescanCodeBlocks: () => scanCodeBlocks(),
  };
})();
