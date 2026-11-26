(() => {
  'use strict';
  if (window.self !== window.top) return;

  if (window.__AGY_TELEMETRY_UI__) {
    return;
  }

  // ---------------------------------------------------------------------------
  // State & Localization Helpers
  // ---------------------------------------------------------------------------
  let settings = {
    variant: 'insiders',
    appName: 'Antigravity',
    platform: 'darwin',
    i18n: { locale: 'zh-CN', showFloatingToggle: true },
    vibrancy: null,
    vibrancyMeta: null,
    telemetry: {
      showComposerBar: true,
      showTurnFooter: true,
      showHomeDashboard: true,
      mergeVariantUsage: false,
      fileOpenMode: 'sidebar',
      codeBlockEnhance: true,
      streamFadeIn: true,
      smoothCaret: true,
      quotaWindow: 'both',
    },
  };

  let snapshot = { quota: null, session: null };
  let usageSummary = null;
  let usageSummaryLoading = false;
  let homeRangeKey = 'all'; // 'all' | 'today' | '7d' | '30d'
  let settingsTab = 'general'; // 'general' | 'experience'
  let popoverOpen = false;
  let settingsOpen = false;
  let currentRouteId = null;
  let fetchSeq = 0;
  let pollTimer = null;
  let domObserver = null;
  let domSyncTimer = null;

  const isZh = () => (settings?.i18n?.locale || 'zh-CN') === 'zh-CN';

  function detectDarkTheme() {
    const html = document.documentElement;
    if (!html) return true;
    const cs = (html.style && html.style.colorScheme) || '';
    if (cs.includes('dark')) return true;
    if (cs.includes('light')) return false;
    if (html.classList.contains('dark')) return true;
    if (html.classList.contains('light')) return false;
    const bodyCls = document.body?.className || '';
    if (/\bdark\b/.test(bodyCls)) return true;
    if (/\blight\b/.test(bodyCls)) return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function detectAccentColor() {
    const isUsableColor = (val) => {
      if (!val || typeof val !== 'string') return false;
      const s = val.trim();
      if (!s || s === 'transparent' || s === 'none' || s === 'initial' || s === 'inherit') return false;
      if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/i.test(s)) return false;
      return true;
    };
    const vars = ['--primary', '--color-primary', '--sdk-primary', '--accent-color'];
    const roots = [document.body, document.documentElement].filter(Boolean);
    for (const el of roots) {
      try {
        const cs = getComputedStyle(el);
        for (const v of vars) {
          const raw = cs.getPropertyValue(v).trim();
          if (isUsableColor(raw)) return raw;
        }
      } catch (_e) {}
    }
    try {
      const sendBtn = document.querySelector('[data-testid="send-button"]');
      if (sendBtn) {
        const bg = getComputedStyle(sendBtn).backgroundColor;
        if (isUsableColor(bg)) return bg;
      }
    } catch (_e) {}
    return '#3b82f6';
  }

  const FALLBACK_FONT_SANS = '"Google Sans Flex", "Google Sans", "Google Sans Text", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const FALLBACK_FONT_MONO = '"Google Sans Code", ui-monospace, SFMono-Regular, Menlo, monospace';

  function detectHostFontFamily() {
    const roots = [
      document.querySelector('[data-testid="model-selector-trigger"]'),
      document.querySelector('[data-testid="permissions-selector-trigger"]'),
      document.body,
      document.documentElement,
    ].filter(Boolean);
    for (const el of roots) {
      try {
        const cs = getComputedStyle(el);
        const ff = (cs.fontFamily || '').trim();
        if (ff && !/^times\b/i.test(ff)) return ff;
        const v = cs.getPropertyValue('--font-sans').trim();
        if (v) return v;
      } catch (_e) {}
    }
    return FALLBACK_FONT_SANS;
  }

  function computeGlassSurface(dark) {
    const vib = settings?.vibrancy || window.__AGY_VIBRANCY_CFG__ || null;
    const vibOn = Boolean(vib && vib.enabled);
    const op = typeof vib?.opacity === 'number' && Number.isFinite(vib.opacity) ? vib.opacity : 0.55;

    // Match vibrancy-assets/style.js native popup glass (popRgb / popOp)
    const panelRgb = dark ? '24, 26, 35' : '252, 253, 255';
    const panelAlpha = vibOn
      ? (dark
        ? Math.min(0.86, Math.max(0.60, +(op + 0.28).toFixed(2)))
        : Math.min(0.90, Math.max(0.70, +(op + 0.30).toFixed(2))))
      : (dark ? 0.86 : 0.90);
    const fabAlpha = vibOn
      ? (dark
        ? Math.min(0.76, Math.max(0.48, +(op + 0.16).toFixed(2)))
        : Math.min(0.84, Math.max(0.62, +(op + 0.24).toFixed(2))))
      : (dark ? 0.80 : 0.86);

    const blur = vibOn ? 'blur(26px) saturate(160%)' : 'blur(22px) saturate(145%)';
    const fabBlur = vibOn ? 'blur(20px) saturate(155%)' : 'blur(16px) saturate(140%)';
    const hairline = dark ? 'rgba(255, 255, 255, 0.11)' : 'rgba(15, 20, 35, 0.10)';
    const specular = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.85)';
    const panelShadow = dark
      ? `inset 0 1px 0 ${specular}, 0 0 0 1px ${hairline}, 0 16px 40px -10px rgba(0, 0, 0, 0.46)`
      : `inset 0 1px 0 ${specular}, 0 0 0 1px ${hairline}, 0 14px 36px -10px rgba(15, 20, 35, 0.16)`;
    const fabShadow = dark
      ? `inset 0 1px 0 ${specular}, 0 0 0 1px ${hairline}, 0 4px 14px rgba(0, 0, 0, 0.36)`
      : `inset 0 1px 0 ${specular}, 0 0 0 1px ${hairline}, 0 3px 12px rgba(15, 20, 35, 0.10)`;

    return {
      panelBg: `rgba(${panelRgb}, ${panelAlpha})`,
      fabBg: `rgba(${panelRgb}, ${fabAlpha})`,
      blur,
      fabBlur,
      panelShadow,
      fabShadow,
    };
  }

  function formatCompactTokens(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Math.max(0, Number(n));
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(Math.round(v));
  }

  function formatCountdown(resetAtMs) {
    if (!resetAtMs || !Number.isFinite(resetAtMs)) return '';
    const diffMs = resetAtMs - Date.now();
    if (diffMs <= 0) return isZh() ? '即将重置' : 'Resetting';
    const totalMin = Math.max(1, Math.round(diffMs / 60000));
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (isZh()) {
      if (days > 0) return `${days}天${hours}小时`;
      if (hours > 0) return `${hours}小时${mins}分`;
      return `${mins}分钟`;
    }
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function extractRouteConversationId() {
    try {
      const pathStr = String(window.location?.pathname || '');
      const m = /\/c\/([0-9a-f-]{4,36})/i.exec(pathStr);
      if (m) return m[1];
      // If we are on the Home / New Chat screen (no /c/<id> in URL or home greeting visible),
      // do NOT fall back to sidebar or cached background [data-cascade-id] nodes.
      if (!pathStr || pathStr === '/' || /^\/(?:home|new)\b/i.test(pathStr)) return null;
      const greeting = document.querySelector('[data-testid="home-greeting"], .agy-home');
      if (greeting && greeting.offsetParent !== null) return null;
      const candidates = document.querySelectorAll('main [data-cascade-id]');
      for (const el of candidates) {
        if (!el || el.offsetParent === null) continue;
        if (el.closest?.('aside, [data-testid="conversation-list-sidebar"], [hidden], [aria-hidden="true"], [inert]')) continue;
        const attr = el.getAttribute?.('data-cascade-id');
        if (attr && /^[0-9a-f-]{4,36}$/i.test(attr.trim())) return attr.trim();
      }
    } catch (_e) {}
    return null;
  }

  function pickActiveQuotaGroup(quota, modelHint) {
    const groups = Array.isArray(quota?.groups) ? quota.groups : [];
    if (groups.length === 0) return null;
    const hint = String(modelHint || '').toLowerCase();
    if (/claude|anthropic|gpt|openai/.test(hint)) {
      const g3p = groups.find((g) => g.key === 'third_party');
      if (g3p) return g3p;
    }
    return groups.find((g) => g.key === 'gemini') || groups[0];
  }

  function getDisplayedModelLabelFromDom() {
    try {
      const trig = document.querySelector('[data-testid="model-selector-trigger"]');
      return (trig?.getAttribute?.('aria-label') || trig?.textContent || '').trim();
    } catch (_e) {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Piece 1: Per-Turn Footer Summary (Figure 1)
  // ---------------------------------------------------------------------------
  function ensureTurnFooterStyles() {
    if (document.getElementById('agy-turn-footer-style')) return;
    const style = document.createElement('style');
    style.id = 'agy-turn-footer-style';
    style.textContent = `
      .agy-turn-footer {
        display: inline-flex;
        align-items: center;
        margin-right: 8px;
        padding: 0 2px;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.45;
        letter-spacing: -0.01em;
        color: var(--muted-foreground, rgba(128, 128, 138, 0.88));
        background: transparent;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
        user-select: none;
        cursor: default;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function formatTurnFooterText(turn, toolbarWidth) {
    const zh = isZh();
    const modelText = turn.shortModelName || turn.modelDisplayName || '';
    const inText = `In ${formatCompactTokens(turn.totalInput)}`;
    const outText = `Out ${formatCompactTokens(turn.totalOutput)}`;
    const hitVal = turn.cacheHitPct !== null && turn.cacheHitPct !== undefined ? `${turn.cacheHitPct}%` : '—';
    const cacheText = zh ? `缓存 ${hitVal}` : `Cache ${hitVal}`;
    const tpsText = turn.tps && Number.isFinite(turn.tps) && turn.tps > 0 ? `${Math.round(turn.tps)} tok/s` : '';

    let parts;
    if (toolbarWidth <= 0 || toolbarWidth >= 420) {
      parts = [modelText, inText, outText, cacheText, tpsText];
    } else if (toolbarWidth >= 290) {
      parts = [inText, outText, cacheText, tpsText];
    } else if (toolbarWidth >= 195) {
      parts = [inText, cacheText, tpsText];
    } else {
      parts = tpsText ? [inText, tpsText] : [inText, hitVal];
    }
    return parts.filter(Boolean).join(' · ');
  }

  function formatTurnTooltip(turn) {
    const zh = isZh();
    const lines = [];
    if (turn.modelDisplayName) lines.push(`${zh ? '模型' : 'Model'}: ${turn.modelDisplayName}`);
    lines.push(`${zh ? '本轮请求次数' : 'Model calls'}: ${turn.callCount}`);
    lines.push(`${zh ? '总输入 (含缓存)' : 'Total input'}: ${formatCompactTokens(turn.totalInput)} (${zh ? '缓存读' : 'Cache read'} ${formatCompactTokens(turn.cacheRead)})`);
    lines.push(`${zh ? '总输出' : 'Total output'}: ${formatCompactTokens(turn.totalOutput)}`);
    if (turn.tps) lines.push(`${zh ? '输出速度' : 'Output speed'}: ${turn.tps} tok/s`);
    if (turn.lastCall?.ttftSec != null) lines.push(`TTFT: ${turn.lastCall.ttftSec}s`);
    return lines.join('\n');
  }

  function renderTurnFooters() {
    const show = settings?.telemetry?.showTurnFooter !== false;
    const turns = Array.isArray(snapshot?.session?.turns) ? snapshot.session.turns : [];
    const existingAll = document.querySelectorAll('.agy-turn-footer');

    if (!show || turns.length === 0) {
      existingAll.forEach((n) => n.remove());
      return;
    }

    ensureTurnFooterStyles();

    const rawToolbars = Array.from(document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]'));
    const mainToolbars = rawToolbars.filter((tb) => {
      if (!tb) return false;
      if (tb.closest?.('[data-testid="side-question-tab-conversation"], [data-side-question], .side-question-container')) {
        return false;
      }
      return true;
    });

    if (mainToolbars.length === 0) {
      existingAll.forEach((n) => n.remove());
      return;
    }

    // Batch-read widths first to avoid layout thrashing
    const widths = mainToolbars.map((tb) => {
      const row = tb.firstElementChild || tb;
      return Number(row.clientWidth || tb.clientWidth || 0);
    });

    const M = mainToolbars.length;
    const T = turns.length;
    const turnOffset = T > M ? (T - M) : 0;

    for (let i = 0; i < M; i++) {
      const tb = mainToolbars[i];
      const row = tb.firstElementChild || tb;
      const turn = turns[turnOffset + i] || null;
      let badge = row.querySelector(':scope > .agy-turn-footer') || tb.querySelector('.agy-turn-footer');

      if (!turn) {
        if (badge) badge.remove();
        continue;
      }

      const text = formatTurnFooterText(turn, widths[i]);
      const tip = formatTurnTooltip(turn);

      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'agy-turn-footer';
        badge.setAttribute('data-agy-i18n-ignore', '1');
        badge.setAttribute('data-agy-telemetry-ignore', '1');
        if (typeof row.prepend === 'function') row.prepend(badge);
        else row.insertBefore(badge, row.firstChild);
      }

      if (badge.textContent !== text) badge.textContent = text;
      if (badge.title !== tip) badge.title = tip;
    }
  }

  // ---------------------------------------------------------------------------
  // Piece 2: Composer Bottom Status Bar (Figure 2) + Detail Popover
  // ---------------------------------------------------------------------------
  let barHost = null;
  let barShadow = null;
  let barAnchor = null;
  let popoverHost = null;
  let popoverShadow = null;

  function isElementVisibleInComposer(el) {
    if (!el || el.hidden || el.style?.display === 'none') return false;
    if (el.closest?.('aside, [data-testid="conversation-list-sidebar"], [hidden], [aria-hidden="true"], [inert]')) return false;
    const rect = el.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function findComposerFooterTarget() {
    // 1. Anchor from the right-hand composer controls inside the input box (Turbo / mic / send)
    //    and walk up to the lowest horizontal row that does NOT contain the text editor itself.
    const rightSelectors = [
      '[data-testid="permissions-selector-trigger"]',
      '[data-testid="voice-live-pill"]',
      '[data-testid="send-button"]',
      '[data-testid="input-cancel-button"]',
    ];
    let rightCtrl = null;
    for (const sel of rightSelectors) {
      const list = Array.from(document.querySelectorAll(sel));
      const found = list.find(isElementVisibleInComposer);
      if (found) { rightCtrl = found; break; }
    }

    if (rightCtrl) {
      const rightRect = rightCtrl.getBoundingClientRect();
      let cur = rightCtrl.parentElement;
      for (let depth = 0; depth < 6 && cur && cur !== document.body; depth++) {
        // Never climb above the composer bottom row into the wrapper containing the text input
        if (cur.querySelector?.('[contenteditable="true"], textarea')) break;
        const kids = Array.from(cur.children || []).filter((k) => k !== barHost);
        if (kids.length >= 2) {
          const hasModelTrigger = Boolean(cur.querySelector?.('[data-testid="model-selector-trigger"]'));
          const buttons = Array.from(cur.querySelectorAll('button')).filter((b) => !barHost?.contains(b));
          const hasLeftButton = buttons.some((b) => {
            const br = b.getBoundingClientRect?.();
            return br && br.width > 0 && br.left < rightRect.left - 80;
          });
          if (hasModelTrigger || hasLeftButton) {
            const beforeNode = kids.find((k) => k === rightCtrl || k.contains(rightCtrl)) || kids[kids.length - 1];
            return { container: cur, beforeNode };
          }
        }
        cur = cur.parentElement;
      }
    }

    // 2. Fallback: explicit bottom toolbar classes that live inside the input box (never containing the editor)
    const candidates = Array.from(document.querySelectorAll('.agy-composer-footer, [data-testid="input-box-bottom-toolbar"]'));
    for (const el of candidates) {
      if (!isElementVisibleInComposer(el)) continue;
      if (el.querySelector?.('[contenteditable="true"], textarea')) continue;
      if (!el.querySelector?.('button')) continue;
      const kids = Array.from(el.children || []).filter((k) => k !== barHost);
      const beforeNode = kids.length >= 2 ? kids[kids.length - 1] : null;
      return { container: el, beforeNode };
    }

    return null;
  }

  function unmountComposerBar() {
    if (barHost && barHost.isConnected) barHost.remove();
    barHost = null;
    barShadow = null;
    barAnchor = null;
    closeTelemetryPopover();
  }

  let popoverStyleEl = null;
  let popoverCardEl = null;
  let popoverCloseTimer = null;

  function closeTelemetryPopover(immediate = false) {
    popoverOpen = false;
    if (barShadow) {
      barShadow.querySelectorAll('.bar').forEach((c) => c.classList.remove('active'));
    }
    if (!popoverHost) return;
    if (popoverCloseTimer) {
      clearTimeout(popoverCloseTimer);
      popoverCloseTimer = null;
    }
    if (immediate || popoverHost.style.display === 'none') {
      popoverHost.style.display = 'none';
      if (popoverCardEl) popoverCardEl.classList.remove('pop-in', 'pop-out');
      return;
    }
    popoverHost.style.pointerEvents = 'none';
    if (popoverCardEl) {
      popoverCardEl.classList.remove('pop-in');
      void popoverCardEl.offsetWidth;
      popoverCardEl.classList.add('pop-out');
    }
    popoverCloseTimer = setTimeout(() => {
      popoverCloseTimer = null;
      if (!popoverOpen && popoverHost) {
        popoverHost.style.display = 'none';
        if (popoverCardEl) popoverCardEl.classList.remove('pop-in', 'pop-out');
      }
    }, 115);
  }

  function ensurePopoverHost() {
    if (popoverHost && popoverHost.isConnected && popoverStyleEl && popoverCardEl) return;
    popoverHost = document.createElement('div');
    popoverHost.id = 'agy-telemetry-popover-host';
    popoverHost.setAttribute('data-agy-i18n-ignore', '1');
    popoverHost.setAttribute('data-agy-telemetry-ignore', '1');
    // Keep wrapper free of transform/opacity/will-change so it NEVER creates a Backdrop Root that kills child backdrop-filter
    popoverHost.style.cssText = 'position:fixed;z-index:2147483642;display:none;pointer-events:auto;';
    popoverShadow = popoverHost.attachShadow({ mode: 'open' });
    popoverStyleEl = document.createElement('style');
    popoverCardEl = document.createElement('div');
    popoverCardEl.className = 'card';
    popoverShadow.appendChild(popoverStyleEl);
    popoverShadow.appendChild(popoverCardEl);
    document.documentElement.appendChild(popoverHost);
  }

  function renderTelemetryPopover(animateOpen = false) {
    if (!popoverOpen || !barHost || !barHost.isConnected) {
      closeTelemetryPopover(true);
      return;
    }
    ensurePopoverHost();
    if (popoverCloseTimer) {
      clearTimeout(popoverCloseTimer);
      popoverCloseTimer = null;
    }

    const dark = detectDarkTheme();
    const zh = isZh();
    const ctx = snapshot?.session?.context || null;
    const sess = snapshot?.session?.session || null;
    const quota = snapshot?.quota || null;
    const modelHint = ctx?.modelDisplayName || getDisplayedModelLabelFromDom();
    const activeGroup = pickActiveQuotaGroup(quota, modelHint);

    const pctCtx = ctx?.usedFraction != null ? Math.round(ctx.usedFraction * 100) : null;
    const remPctCtx = ctx?.remainingFraction != null ? Math.round(ctx.remainingFraction * 100) : null;
    const ctxTone = pctCtx != null ? (pctCtx >= 90 ? 'danger' : pctCtx >= 75 ? 'warn' : 'ok') : 'muted';

    const quotaRowsHtml = activeGroup && activeGroup.buckets?.length
      ? activeGroup.buckets.map((b) => {
          const pct = b.percent != null ? b.percent : 0;
          const tone = b.percent == null ? 'muted' : (b.percent <= 15 ? 'danger' : b.percent <= 35 ? 'warn' : 'ok');
          const lbl = b.windowKey === 'weekly' ? (zh ? '每周限额' : 'Weekly') : (zh ? '5 小时限额' : '5h Window');
          const cd = formatCountdown(b.resetAtMs);
          return `
            <div class="qrow">
              <div class="qmeta">
                <span>${lbl}</span>
                <span class="mono">${b.percent != null ? `${b.percent}%` : '—'}${cd ? ` · ${cd}` : ''}</span>
              </div>
              <div class="track"><div class="fill ${tone}" style="width:${pct}%"></div></div>
            </div>
          `;
        }).join('')
      : `<div class="empty">${quota?.error ? (zh ? `额度获取失败：${quota.error}` : `Quota error: ${quota.error}`) : (zh ? '暂无额度数据' : 'No quota data yet')}</div>`;

    const ctxUsedStr = ctx?.usedTokens != null ? formatCompactTokens(ctx.usedTokens) : '—';
    const ctxMaxStr = ctx?.maxTokens != null ? formatCompactTokens(ctx.maxTokens) : (zh ? '未知' : 'Unknown');
    const glass = computeGlassSurface(dark);
    const accent = detectAccentColor();
    const hostFont = detectHostFontFamily();
    const wasHidden = popoverHost.style.display === 'none';
    const shouldAnimate = animateOpen || wasHidden;

    const cssText = `
        :host { all: initial; }
        @keyframes agy-pop-in {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to { opacity: 1; transform: none; }
        }
        @keyframes agy-pop-out {
          from { opacity: 1; transform: none; }
          to { opacity: 0; transform: translateY(5px) scale(0.97); }
        }
        .card {
          --agy-accent: ${accent};
          width: 316px;
          max-width: calc(100vw - 24px);
          border-radius: 14px;
          padding: 13px 14px;
          font-family: ${hostFont};
          font-size: 12px;
          line-height: 1.45;
          -webkit-font-smoothing: antialiased;
          color: ${dark ? 'rgba(244, 246, 252, 0.95)' : 'rgba(18, 20, 28, 0.94)'};
          background: ${glass.panelBg};
          backdrop-filter: ${glass.blur};
          -webkit-backdrop-filter: ${glass.blur};
          border: none;
          box-shadow: ${glass.panelShadow};
          box-sizing: border-box;
          transform-origin: bottom right;
        }
        .card.pop-in {
          animation: agy-pop-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .card.pop-out {
          animation: agy-pop-out 110ms ease-in forwards;
          pointer-events: none;
        }
        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 10px;
        }
        .title {
          font-weight: 600;
          font-size: 12.5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .badge {
          font-size: 10px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 999px;
          white-space: nowrap;
          background: color-mix(in srgb, var(--agy-accent, #3b82f6) 15%, transparent);
          color: var(--agy-accent, #3b82f6);
        }
        .icon-btn {
          appearance: none;
          border: 1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'};
          background: ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
          color: inherit;
          border-radius: 7px;
          padding: 3px 8px;
          font-size: 11px;
          cursor: pointer;
        }
        .icon-btn:hover { background: ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'}; }
        .sec {
          padding-top: 9px;
          margin-top: 9px;
          border-top: 1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'};
        }
        .sec:first-of-type { padding-top: 0; margin-top: 0; border-top: none; }
        .sec-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          margin-bottom: 6px;
        }
        .sec-lbl {
          font-size: 11px;
          font-weight: 600;
          color: ${dark ? '#a1a1aa' : '#52525b'};
        }
        .mono {
          font-variant-numeric: tabular-nums;
          font-family: ${FALLBACK_FONT_MONO};
          font-size: 11px;
        }
        .track {
          width: 100%;
          height: 6px;
          border-radius: 999px;
          background: ${dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'};
          overflow: hidden;
        }
        .fill {
          height: 100%;
          border-radius: 999px;
          transition: width 0.25s ease;
        }
        .fill.ok { background: var(--agy-accent, #3b82f6); }
        .fill.warn { background: ${dark ? '#f59e0b' : '#d97706'}; }
        .fill.danger { background: ${dark ? '#ef4444' : '#dc2626'}; }
        .fill.muted { background: #71717a; }
        .subrow {
          display: flex;
          justify-content: space-between;
          margin-top: 5px;
          font-size: 11px;
          color: ${dark ? '#a1a1aa' : '#52525b'};
        }
        .tabs { display: inline-flex; gap: 3px; }
        .tab {
          appearance: none;
          border: 1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'};
          background: transparent;
          color: ${dark ? '#a1a1aa' : '#52525b'};
          border-radius: 6px;
          padding: 1px 6px;
          font-size: 10.5px;
          cursor: pointer;
        }
        .tab.active {
          background: ${dark ? 'rgba(255,255,255,0.16)' : '#18181b'};
          color: #ffffff;
          border-color: transparent;
        }
        .qrow { margin-top: 7px; }
        .qrow:first-child { margin-top: 0; }
        .qmeta {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          margin-bottom: 3px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
        }
        .stat {
          padding: 6px 8px;
          border-radius: 8px;
          background: ${dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)'};
        }
        .stat-k { font-size: 10px; color: ${dark ? '#a1a1aa' : '#71717a'}; }
        .stat-v { font-size: 12px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
        .empty { font-size: 11px; color: ${dark ? '#a1a1aa' : '#71717a'}; padding: 4px 0; }
    `;
    if (popoverStyleEl.textContent !== cssText) {
      popoverStyleEl.textContent = cssText;
    }

    popoverCardEl.innerHTML = `
        <div class="head">
          <div class="title">
            <span>${zh ? '实时遥测' : 'Live Telemetry'}</span>
            ${quota?.planName ? `<span class="badge">${quota.planName}</span>` : ''}
          </div>
          <button type="button" class="icon-btn" id="btn-refresh">${zh ? '刷新' : 'Refresh'}</button>
        </div>

        <div class="sec">
          <div class="sec-head">
            <span class="sec-lbl">${zh ? '当前上下文' : 'Context Window'}</span>
            <span class="mono">${remPctCtx != null ? (zh ? `剩余 ${remPctCtx}% · 已用 ${pctCtx}%` : `${remPctCtx}% left · ${pctCtx}% used`) : ctxUsedStr}</span>
          </div>
          <div class="track"><div class="fill ${ctxTone}" style="width:${pctCtx != null ? Math.min(100, pctCtx) : 0}%"></div></div>
          <div class="subrow">
            <span>${ctx?.modelDisplayName || modelHint || (zh ? '未开始对话' : 'No active chat')}${ctx?.compacted ? (zh ? ' · 已压缩' : ' · Compacted') : ''}</span>
            <span class="mono">${ctxUsedStr} / ${ctxMaxStr}</span>
          </div>
        </div>

        <div class="sec">
          <div class="sec-head">
            <span class="sec-lbl">${zh ? '模型额度' : 'Model Quota'}</span>
          </div>
          ${quotaRowsHtml}
        </div>

        <div class="sec">
          <div class="sec-head">
            <span class="sec-lbl">${zh ? '本会话速度与缓存' : 'Session Speed & Cache'}</span>
            ${sess?.latestTtftSec != null ? `<span class="mono">TTFT ${sess.latestTtftSec}s</span>` : ''}
          </div>
          <div class="grid">
            <div class="stat">
              <div class="stat-k">${zh ? '输出速度' : 'Speed'}</div>
              <div class="stat-v">${sess?.latestTps ? `${Math.round(sess.latestTps)} t/s` : '—'}</div>
            </div>
            <div class="stat">
              <div class="stat-k">${zh ? '缓存命中' : 'Cache Hit'}</div>
              <div class="stat-v">${sess?.cacheHitPct != null ? `${sess.cacheHitPct}%` : '—'}</div>
            </div>
            <div class="stat">
              <div class="stat-k">${zh ? '本会话输出' : 'Output'}</div>
              <div class="stat-v">${sess?.totalOutput ? formatCompactTokens(sess.totalOutput) : '—'}</div>
            </div>
          </div>
        </div>
    `;

    popoverCardEl.querySelector('#btn-refresh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void pollSnapshot(true);
    });

    // Anchor cleanly right above the composer bar without overflowing viewport
    const rect = barHost.getBoundingClientRect();
    const cardW = 316;
    const left = Math.min(Math.max(12, rect.right - cardW), window.innerWidth - cardW - 12);
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    popoverHost.style.left = `${Math.round(left)}px`;
    popoverHost.style.bottom = `${Math.round(bottom)}px`;
    popoverHost.style.pointerEvents = 'auto';
    popoverHost.style.display = 'block';

    if (shouldAnimate) {
      popoverCardEl.classList.remove('pop-out', 'pop-in');
      void popoverCardEl.offsetWidth;
      popoverCardEl.classList.add('pop-in');
    }
  }

  function ensureComposerBarMounted() {
    if (settings?.telemetry?.showComposerBar === false) {
      unmountComposerBar();
      return false;
    }
    const target = findComposerFooterTarget();
    if (!target || !target.container) return false;
    const { container, beforeNode } = target;
    if (barHost && barHost.isConnected && barAnchor === container) return true;

    unmountComposerBar();
    barAnchor = container;
    barHost = document.createElement('div');
    barHost.id = 'agy-telemetry-bar-host';
    barHost.setAttribute('data-agy-i18n-ignore', '1');
    barHost.setAttribute('data-agy-telemetry-ignore', '1');
    barHost.style.cssText = 'display:inline-flex;align-items:center;margin-left:auto;margin-right:6px;flex-shrink:1;min-width:0;vertical-align:middle;';
    barShadow = barHost.attachShadow({ mode: 'open' });

    // Seat directly to the left of the right-hand controls (Turbo / mic / send) inside the input box
    if (beforeNode && beforeNode.parentElement === container) {
      container.insertBefore(barHost, beforeNode);
    } else {
      container.appendChild(barHost);
    }
    return true;
  }

  function renderComposerBar(skipPopoverSync = false) {
    if (!ensureComposerBarMounted() || !barShadow) return;

    const dark = detectDarkTheme();
    const zh = isZh();
    const activeConv = Boolean(currentRouteId);
    const ctx = activeConv ? (snapshot?.session?.context || null) : null;
    const sess = activeConv ? (snapshot?.session?.session || null) : null;
    const quota = snapshot?.quota || null;
    const modelHint = ctx?.modelDisplayName || getDisplayedModelLabelFromDom();
    const activeGroup = pickActiveQuotaGroup(quota, modelHint);

    // Context remaining ring & tone (only shown when inside an active conversation with usage data)
    const pctCtx = ctx?.usedFraction != null ? Math.round(ctx.usedFraction * 100) : null;
    const remFrac = ctx?.remainingFraction != null
      ? Math.max(0, Math.min(1, ctx.remainingFraction))
      : null;
    const remPct = remFrac != null ? Math.round(remFrac * 100) : null;
    const showContext = Boolean(activeConv && (remPct != null || ctx?.usedTokens != null));
    const ctxText = remPct != null
      ? `${remPct}%`
      : (ctx?.usedTokens != null ? formatCompactTokens(ctx.usedTokens) : '—');
    const ctxTone = remPct != null ? (remPct <= 10 ? 'danger' : remPct <= 25 ? 'warn' : 'ok') : 'muted';
    const ctxTitle = remPct != null
      ? (zh
        ? `上下文剩余 ${remPct}%（${formatCompactTokens(ctx.remainingTokens)}）· 已用 ${formatCompactTokens(ctx.usedTokens)} / ${formatCompactTokens(ctx.maxTokens)} (${pctCtx}%)`
        : `Context remaining ${remPct}% (${formatCompactTokens(ctx.remainingTokens)}) · Used ${formatCompactTokens(ctx.usedTokens)} / ${formatCompactTokens(ctx.maxTokens)} (${pctCtx}%)`)
      : (zh ? '点击查看上下文、额度与缓存详情' : 'Click for Context, Quota & Cache details');

    const ringR = 6.2;
    const ringC = 2 * Math.PI * ringR;
    const ringOffset = remFrac != null ? ringC * (1 - remFrac) : ringC;

    // Quota item HTML & independent per-window tones (5h and 7d colored separately!)
    let quotaInnerHtml = '<span>—</span>';
    if (activeGroup && activeGroup.buckets?.length) {
      const b5 = activeGroup.buckets.find((b) => b.windowKey === '5h');
      const bW = activeGroup.buckets.find((b) => b.windowKey === 'weekly');
      const pickTone = (p) => (p == null ? 'muted' : p <= 15 ? 'danger' : p <= 35 ? 'warn' : 'ok');

      if (b5 && bW) {
        const t5 = pickTone(b5.percent);
        const tW = pickTone(bW.percent);
        quotaInnerHtml = `<span class="tone-${t5}">5h ${b5.percent ?? '—'}%</span><span class="q-sep">·</span><span class="tone-${tW}">7d ${bW.percent ?? '—'}%</span>`;
      } else if (b5) {
        quotaInnerHtml = `<span class="tone-${pickTone(b5.percent)}">5h ${b5.percent ?? '—'}%</span>`;
      } else if (bW) {
        quotaInnerHtml = `<span class="tone-${pickTone(bW.percent)}">7d ${bW.percent ?? '—'}%</span>`;
      } else {
        const chosen = activeGroup.buckets[0];
        if (chosen) {
          const lbl = chosen.windowKey === 'weekly' ? '7d' : '5h';
          quotaInnerHtml = `<span class="tone-${pickTone(chosen.percent)}">${lbl} ${chosen.percent ?? '—'}%</span>`;
        }
      }
    }

    // Speed item
    const tpsVal = sess?.latestTps;
    const speedText = tpsVal && Number.isFinite(tpsVal) && tpsVal > 0 ? `${Math.round(tpsVal)} t/s` : '';

    const anchorW = Number(barAnchor?.clientWidth || 0);
    const showSpeed = Boolean(speedText) && (anchorW === 0 || anchorW >= 460);

    const warnColor = dark ? '#f59e0b' : '#d97706';
    const dangerColor = dark ? '#ef4444' : '#dc2626';
    const hostFont = detectHostFontFamily();

    barShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          appearance: none;
          border: none;
          background: transparent;
          display: inline-flex;
          align-items: center;
          gap: 9px;
          padding: 5px 8px;
          border-radius: 7px;
          font-family: ${hostFont};
          font-size: 12.5px;
          font-weight: 400;
          line-height: 1;
          letter-spacing: -0.015em;
          -webkit-font-smoothing: antialiased;
          color: ${dark ? 'rgba(228, 228, 231, 0.72)' : 'rgba(63, 63, 70, 0.84)'};
          max-width: 100%;
          overflow: hidden;
          user-select: none;
          cursor: pointer;
          transition: background-color 0.14s ease, color 0.14s ease;
        }
        .bar:hover, .bar.active {
          background: ${dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.055)'};
          color: ${dark ? '#f4f4f5' : '#18181b'};
        }
        .item {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
        }
        .tone-warn { color: ${warnColor}; }
        .tone-danger { color: ${dangerColor}; }
        .q-sep { opacity: 0.55; margin: 0 1px; }
        .ico {
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          display: block;
          opacity: 0.85;
        }
        .ring {
          width: 15px;
          height: 15px;
          flex-shrink: 0;
          display: block;
        }
        .ring-track {
          fill: none;
          stroke: ${dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)'};
          stroke-width: 2;
        }
        .ring-arc {
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          transition: stroke-dashoffset 0.25s ease;
        }
        .ring-arc.muted {
          stroke: ${dark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.22)'};
        }
      </style>
      <button type="button" class="bar ${popoverOpen ? 'active' : ''}" data-act="toggle" aria-label="${zh ? '实时遥测状态条' : 'Live Telemetry Bar'}">
        ${showContext ? `
          <span class="item tone-${ctxTone}" title="${ctxTitle}">
            <svg class="ring" viewBox="0 0 18 18" aria-hidden="true">
              <circle class="ring-track" cx="9" cy="9" r="${ringR}"></circle>
              ${remFrac != null ? `<circle class="ring-arc" cx="9" cy="9" r="${ringR}" transform="rotate(-90 9 9)" stroke-dasharray="${ringC.toFixed(2)}" stroke-dashoffset="${ringOffset.toFixed(2)}"></circle>` : ''}
            </svg>
            <span>${ctxText}</span>
          </span>
        ` : ''}
        <span class="item" title="${zh ? '点击查看模型额度详情' : 'Click for Model Quota details'}">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6"></circle>
            <path d="M8 4.6V8l2.3 1.4"></path>
          </svg>
          ${quotaInnerHtml}
        </span>
        ${showSpeed ? `
          <span class="item" title="${zh ? '最新流式输出速度' : 'Latest streaming output speed'}">
            <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 1.8L3.6 9.1H8L7 14.2L12.4 6.9H8L9 1.8Z"></path>
            </svg>
            <span>${speedText}</span>
          </span>
        ` : ''}
      </button>
    `;

    barShadow.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        popoverOpen = !popoverOpen;
        if (popoverOpen) {
          closeSettingsModal();
          renderComposerBar(true);
          renderTelemetryPopover(true);
          void pollSnapshot(false);
        } else {
          closeTelemetryPopover();
          renderComposerBar(true);
        }
      });
    });

    if (popoverOpen && !skipPopoverSync) renderTelemetryPopover();
  }

  // ---------------------------------------------------------------------------
  // Piece 2b: New Chat Home Page Usage Dashboard (Prism-style Placement, Clean-Room MIT)
  // ---------------------------------------------------------------------------
  let homeHost = null;
  let homeShadow = null;
  let homeAnchorParent = null;

  function unmountHomeDashboard() {
    if (homeHost && homeHost.isConnected) homeHost.remove();
    homeHost = null;
    homeShadow = null;
    homeAnchorParent = null;
  }

  function findHomeGreetingMountTarget() {
    if (extractRouteConversationId()) return null;
    const hasMessages = Boolean(document.querySelector('[data-testid="cascade-system-message-toolbar"], [data-testid="user-message"]'));
    if (hasMessages) return null;

    // Measure visible composer width so the Studio card aligns seamlessly with the input box
    const composer = document.querySelector('.surface-composer');
    const composerW = (composer && isElementVisibleInComposer(composer))
      ? Math.round(composer.getBoundingClientRect().width)
      : 0;
    const widthPx = composerW >= 420 ? Math.min(720, composerW) : 640;

    // 1. Primary: mount right below the center greeting ("很高兴见到你..." / "欢迎回来...")
    const greeting = document.querySelector('[data-testid="home-greeting"]');
    if (greeting && isElementVisibleInComposer(greeting) && greeting.parentElement) {
      let anchor = greeting;
      let parent = greeting.parentElement;
      for (let i = 0; i < 3 && parent && parent !== document.body; i++) {
        const cs = getComputedStyle(parent);
        if (cs.display === 'flex' && cs.flexDirection === 'row') {
          anchor = parent;
          parent = parent.parentElement;
        } else {
          break;
        }
      }
      if (parent && parent !== document.body) {
        return { parent, refNode: anchor, position: 'afterend', widthPx };
      }
    }

    // 2. Fallback: insert directly ABOVE the composer block (never underneath it)
    if (composer && isElementVisibleInComposer(composer) && composer.parentElement) {
      let block = composer;
      const p = composer.parentElement;
      if (p && p.parentElement && p.parentElement !== document.body && p.children.length <= 3) {
        const pr = p.getBoundingClientRect();
        if (pr.height > 0 && pr.height <= 260) block = p;
      }
      if (block.parentElement) {
        return { parent: block.parentElement, refNode: block, position: 'beforebegin', widthPx };
      }
    }

    return null;
  }

  async function refreshUsageSummary(force = false) {
    const api = window.__AGY_TELEMETRY_API__;
    if (!api || typeof api.getUsageSummary !== 'function') return;
    if (usageSummaryLoading && !force) return;
    usageSummaryLoading = true;
    renderHomeDashboard();
    try {
      const res = await api.getUsageSummary({ force });
      if (res && res.ok) {
        usageSummary = res;
      }
    } catch (_e) {}
    usageSummaryLoading = false;
    renderHomeDashboard();
  }

  function renderHomeDashboard() {
    if (settings?.telemetry?.showHomeDashboard === false) {
      unmountHomeDashboard();
      return;
    }
    const target = findHomeGreetingMountTarget();
    if (!target || !target.parent || !target.refNode) {
      unmountHomeDashboard();
      return;
    }

    if (!homeHost || !homeHost.isConnected || homeAnchorParent !== target.parent) {
      unmountHomeDashboard();
      homeAnchorParent = target.parent;
      homeHost = document.createElement('div');
      homeHost.id = 'agy-home-dashboard-host';
      homeHost.setAttribute('data-agy-i18n-ignore', '1');
      homeHost.setAttribute('data-agy-telemetry-ignore', '1');
      homeShadow = homeHost.attachShadow({ mode: 'open' });
      target.refNode.insertAdjacentElement(target.position, homeHost);
    }

    homeHost.style.cssText = `display:block;width:min(${target.widthPx}px, calc(100% - 24px));max-width:100%;margin:16px auto 20px;box-sizing:border-box;flex-shrink:0;`;

    if (!usageSummary && !usageSummaryLoading) {
      void refreshUsageSummary(false);
    }

    const dark = detectDarkTheme();
    const accent = detectAccentColor();
    const hostFont = detectHostFontFamily();
    const zh = isZh();

    // Softer, composer-matched translucent glass so it sits naturally on the wallpaper
    const vib = settings?.vibrancy || window.__AGY_VIBRANCY_CFG__ || null;
    const vibOn = Boolean(vib && vib.enabled);
    const op = typeof vib?.opacity === 'number' && Number.isFinite(vib.opacity) ? vib.opacity : 0.55;
    const cardRgb = dark ? '26, 28, 38' : '255, 255, 255';
    const cardAlpha = vibOn
      ? (dark ? Math.min(0.68, Math.max(0.36, +(op + 0.08).toFixed(2))) : Math.min(0.76, Math.max(0.46, +(op + 0.14).toFixed(2))))
      : (dark ? 0.72 : 0.78);
    const hairline = dark ? 'rgba(255, 255, 255, 0.095)' : 'rgba(15, 20, 35, 0.085)';
    const innerHi = dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.85)';
    const cardShadow = dark
      ? `inset 0 1px 0 ${innerHi}, 0 0 0 1px ${hairline}, 0 12px 32px -12px rgba(0, 0, 0, 0.42)`
      : `inset 0 1px 0 ${innerHi}, 0 0 0 1px ${hairline}, 0 10px 28px -12px rgba(15, 20, 35, 0.12)`;

    const rangeData = usageSummary?.ranges?.[homeRangeKey] || usageSummary?.ranges?.['30d'] || null;
    const totalTok = rangeData ? formatCompactTokens(rangeData.totalTokens) : (usageSummaryLoading ? '…' : '0');
    const outTok = rangeData ? formatCompactTokens(rangeData.totalOutput) : '—';
    const cacheStr = rangeData?.cacheHitPct != null ? `${rangeData.cacheHitPct}%` : '—';
    const convCount = rangeData ? rangeData.conversations : 0;
    const callCount = rangeData ? rangeData.calls : 0;

    const formatUsd = (v) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
      if (v >= 100) return `≈ $${v.toFixed(0)}`;
      if (v >= 10) return `≈ $${v.toFixed(1)}`;
      return `≈ $${v.toFixed(2)}`;
    };
    const usdStr = rangeData?.estUsd > 0 ? formatUsd(rangeData.estUsd) : '';

    const daily = Array.isArray(rangeData?.daily) ? rangeData.daily : [];
    const maxDayTok = daily.reduce((m, d) => Math.max(m, d.totalTokens || 0), 0);
    const models = Array.isArray(rangeData?.models) ? rangeData.models.slice(0, 5) : [];

    // Distinct refined colors for top 5 models (first model follows user's live accent color)
    const modelColors = [
      accent,
      dark ? '#60a5fa' : '#2563eb',
      dark ? '#2dd4bf' : '#0d9488',
      dark ? '#fbbf24' : '#d97706',
      dark ? '#94a3b8' : '#64748b',
    ];

    // Left column visual:
    // - all (总览): Prism/GitHub-style 7-row x 20-col contribution heatmap
    // - 30d: 10x3 luminous tile grid
    // - 7d: 7 crisp vertical bars with subtle labels
    // - today: stacked model share bar + cache efficiency bar
    let visualHtml = '';
    let hoverDayList = [];
    const heatCells = Array.isArray(usageSummary?.heatmap?.cells) ? usageSummary.heatmap.cells : [];
    if (homeRangeKey === 'all') {
      const cells = heatCells.length > 0
        ? heatCells
        : Array.from({ length: 140 }, () => ({ dateKey: '', label: '', totalTokens: 0, outputTokens: 0, calls: 0, conversations: 0, cacheHitPct: null, estUsd: 0, models: [], level: 0 }));
      hoverDayList = cells;
      const cellsHtml = cells.map((c, idx) => `<div class="h-cell lv-${c.level || 0}" data-day-idx="${idx}"></div>`).join('');
      const firstLbl = cells[0]?.label || '';
      const midLbl = cells[Math.floor(cells.length / 2)]?.label || '';
      const lastLbl = cells[cells.length - 1]?.label || '';
      visualHtml = `
        <div class="heat-grid" data-hover-zone="1">${cellsHtml}</div>
        <div class="axis-row">
          <span>${firstLbl}</span>
          <span>${midLbl}</span>
          <span>${lastLbl}</span>
        </div>
      `;
    } else if (homeRangeKey === '30d' && daily.length > 0) {
      hoverDayList = daily;
      const tiles = daily.map((d, idx) => {
        const ratio = maxDayTok > 0 ? (d.totalTokens || 0) / maxDayTok : 0;
        const lvl = d.totalTokens <= 0 ? 0 : (ratio >= 0.72 ? 4 : ratio >= 0.40 ? 3 : ratio >= 0.14 ? 2 : 1);
        return `<div class="tile lv-${lvl}" data-day-idx="${idx}"></div>`;
      }).join('');
      visualHtml = `
        <div class="tile-grid" data-hover-zone="1">${tiles}</div>
        <div class="axis-row">
          <span>${daily[0]?.label || ''}</span>
          <span>${daily[Math.floor(daily.length / 2)]?.label || ''}</span>
          <span>${daily[daily.length - 1]?.label || ''}</span>
        </div>
      `;
    } else if (homeRangeKey === '7d' && daily.length > 0) {
      hoverDayList = daily;
      visualHtml = `
        <div class="bars-7" data-hover-zone="1">
          ${daily.map((d, idx) => {
            const hPct = maxDayTok > 0 ? Math.max(d.totalTokens > 0 ? 12 : 4, Math.round((d.totalTokens / maxDayTok) * 100)) : 4;
            return `
              <div class="b7-col" data-day-idx="${idx}">
                <div class="b7-track"><div class="b7-fill ${d.totalTokens > 0 ? 'on' : ''}" style="height:${hPct}%;"></div></div>
                <span class="b7-lbl">${d.label}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else {
      const segs = models.length > 0
        ? models.map((m, idx) => `<div class="seg-bar-part" style="width:${Math.max(2, m.sharePct)}%;background:${modelColors[idx % modelColors.length]};" title="${m.name} · ${formatCompactTokens(m.totalTokens)} (${m.sharePct}%)"></div>`).join('')
        : `<div class="seg-bar-part" style="width:100%;background:${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};"></div>`;
      const hitNum = rangeData?.cacheHitPct != null ? rangeData.cacheHitPct : 0;
      visualHtml = `
        <div class="today-vis">
          <div class="tv-lbl"><span>${zh ? '今日模型占比' : 'Today Model Mix'}</span><span>${convCount} ${zh ? '对话' : 'chats'}</span></div>
          <div class="seg-bar">${segs}</div>
          <div class="tv-lbl" style="margin-top:10px;"><span>${zh ? '提示词缓存命中' : 'Prompt Cache Hit'}</span><span>${cacheStr}</span></div>
          <div class="seg-bar"><div class="seg-bar-part" style="width:${hitNum}%;background:var(--agy-accent);"></div></div>
        </div>
      `;
    }

    const renderModelsListHtml = (list, emptyText) => {
      const arr = Array.isArray(list) ? list.slice(0, 5) : [];
      if (arr.length === 0) {
        return `<div class="empty-msg">${emptyText}</div>`;
      }
      return arr.map((m, idx) => {
        const c = modelColors[idx % modelColors.length];
        const mUsd = m.estUsd > 0 ? ` · ${formatUsd(m.estUsd)}` : '';
        return `
          <div class="m-item" title="${m.name} · ${formatCompactTokens(m.totalTokens)}${mUsd} (${zh ? '输出' : 'Out'} ${formatCompactTokens(m.outputTokens)} · ${m.calls}${zh ? '次' : 'x'})">
            <div class="m-top">
              <span class="m-name"><i class="m-dot" style="background:${c};"></i>${m.name}</span>
              <span class="m-pct">${m.sharePct}%</span>
            </div>
            <div class="m-track"><div class="m-fill" style="width:${Math.max(4, m.sharePct)}%;background:${c};"></div></div>
          </div>
        `;
      }).join('');
    };

    const defaultEmptyModelMsg = usageSummaryLoading
      ? (zh ? '正在统计历史对话…' : 'Scanning history…')
      : (zh ? '该时间段暂无记录' : 'No activity yet');
    const modelsHtml = renderModelsListHtml(models, defaultEmptyModelMsg);

    // Quiet footer quota line in right column
    const quota = snapshot?.quota || null;
    const g0 = pickActiveQuotaGroup(quota, getDisplayedModelLabelFromDom());
    const b5 = g0?.buckets?.find((b) => b.windowKey === '5h');
    const bW = g0?.buckets?.find((b) => b.windowKey === 'weekly');
    const quotaFootParts = [];
    if (b5?.percent != null) quotaFootParts.push(`5h ${b5.percent}%`);
    if (bW?.percent != null) quotaFootParts.push(`7d ${bW.percent}%`);
    const otherAppLabel = settings?.variant === 'insiders' ? (zh ? '普通版' : 'Stable') : 'Insiders';
    const mergeHint = (usageSummary?.mergeEnabled && usageSummary?.otherVariantMissing)
      ? (zh ? ` · 需打开一次${otherAppLabel}同步` : ` · Open ${otherAppLabel} once to sync`)
      : '';
    const planBadge = (quota?.planName || (settings?.variant === 'insiders' ? 'Insiders' : (zh ? '正式版' : 'Stable'))) + mergeHint;

    homeShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .studio {
          --agy-accent: ${accent};
          width: 100%;
          height: 248px;
          box-sizing: border-box;
          display: grid;
          grid-template-columns: 1.32fr 1fr;
          border-radius: 16px;
          font-family: ${hostFont};
          font-size: 12px;
          line-height: 1.4;
          -webkit-font-smoothing: antialiased;
          color: ${dark ? 'rgba(244, 246, 252, 0.92)' : 'rgba(18, 20, 28, 0.90)'};
          background: rgba(${cardRgb}, ${cardAlpha});
          backdrop-filter: blur(24px) saturate(160%);
          -webkit-backdrop-filter: blur(24px) saturate(160%);
          box-shadow: ${cardShadow};
          overflow: hidden;
          user-select: none;
        }
        @media (max-width: 560px) {
          .studio { grid-template-columns: 1fr; height: auto; }
          .col-r { border-left: none !important; border-top: 1px solid ${hairline}; }
        }
        .col-l, .col-r {
          padding: 13px 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          min-width: 0;
          height: 100%;
          box-sizing: border-box;
        }
        .vis-box {
          height: 126px;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .col-r {
          border-left: 1px solid ${hairline};
        }
        .col-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 10px;
        }
        .lbl {
          font-size: 11px;
          font-weight: 500;
          opacity: 0.58;
          letter-spacing: 0.01em;
        }
        .ranges {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          border-radius: 7px;
          background: ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,20,35,0.05)'};
        }
        .r-btn {
          appearance: none;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          font-size: 10.5px;
          font-weight: 500;
          padding: 2px 7px;
          border-radius: 5px;
          cursor: pointer;
          opacity: 0.62;
          transition: background-color 0.14s ease, opacity 0.14s ease, color 0.14s ease;
        }
        .r-btn:hover { opacity: 1; }
        .r-btn.active {
          opacity: 1;
          background: ${dark ? 'rgba(255,255,255,0.14)' : 'rgba(15,20,35,0.09)'};
        }
        .ref-btn {
          appearance: none;
          border: none;
          background: transparent;
          color: inherit;
          width: 22px;
          height: 22px;
          border-radius: 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          opacity: 0.52;
          transition: opacity 0.14s ease, background-color 0.14s ease;
        }
        .ref-btn:hover {
          opacity: 1;
          background: ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,20,35,0.06)'};
        }
        /* Overview GitHub/Prism-style 7-row contribution heatmap */
        .heat-grid {
          display: grid;
          grid-template-rows: repeat(7, 1fr);
          grid-auto-flow: column;
          grid-auto-columns: minmax(0, 1fr);
          gap: 3px;
        }
        .h-cell {
          aspect-ratio: 1 / 1;
          min-height: 8px;
          border-radius: 2.5px;
          transition: transform 0.12s ease, filter 0.12s ease;
        }
        .h-cell:hover { transform: scale(1.25); filter: brightness(1.12); position: relative; z-index: 2; }
        /* 30d luminous tile grid (10 x 3) */
        .tile-grid {
          display: grid;
          grid-template-columns: repeat(10, minmax(0, 1fr));
          gap: 5px;
        }
        .tile {
          height: 26px;
          border-radius: 5px;
          transition: transform 0.12s ease, filter 0.12s ease;
        }
        .tile:hover { transform: scale(1.16); filter: brightness(1.1); }
        .lv-0 { background: ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,20,35,0.055)'}; }
        .lv-1 { background: color-mix(in srgb, var(--agy-accent) 26%, ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.5)'}); }
        .lv-2 { background: color-mix(in srgb, var(--agy-accent) 50%, transparent); }
        .lv-3 { background: color-mix(in srgb, var(--agy-accent) 76%, transparent); }
        .lv-4 { background: var(--agy-accent); }
        .axis-row {
          display: flex;
          justify-content: space-between;
          margin-top: 5px;
          font-size: 9.5px;
          opacity: 0.45;
        }
        /* 7d vertical bars */
        .bars-7 {
          display: grid;
          grid-template-columns: repeat(7, minmax(0, 1fr));
          gap: 7px;
          align-items: end;
        }
        .b7-col {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .b7-track {
          width: 100%;
          height: 86px;
          display: flex;
          align-items: flex-end;
        }
        .b7-fill {
          width: 100%;
          border-radius: 4px 4px 2px 2px;
          background: ${dark ? 'rgba(255,255,255,0.07)' : 'rgba(15,20,35,0.06)'};
          transition: height 0.25s ease;
        }
        .b7-fill.on {
          background: color-mix(in srgb, var(--agy-accent) 76%, transparent);
        }
        .b7-col:hover .b7-fill.on { background: var(--agy-accent); }
        .b7-lbl { font-size: 9.5px; opacity: 0.5; }
        /* Today visual */
        .today-vis { padding: 2px 0 4px; }
        .tv-lbl {
          display: flex;
          justify-content: space-between;
          font-size: 10.5px;
          opacity: 0.62;
          margin-bottom: 5px;
        }
        .seg-bar {
          display: flex;
          height: 6px;
          border-radius: 999px;
          overflow: hidden;
          gap: 2px;
          background: ${dark ? 'rgba(255,255,255,0.07)' : 'rgba(15,20,35,0.06)'};
        }
        .seg-bar-part { height: 100%; border-radius: 999px; }

        /* Hero summary line */
        .hero {
          margin-top: 12px;
          padding-top: 9px;
          border-top: 1px solid ${hairline};
        }
        .hero-main {
          display: flex;
          align-items: baseline;
          gap: 6px;
        }
        .hero-num {
          font-size: 19px;
          font-weight: 600;
          letter-spacing: -0.025em;
          line-height: 1.15;
        }
        .hero-unit {
          font-size: 11px;
          opacity: 0.56;
        }
        .lbl-date {
          margin-left: 6px;
          font-size: 11px;
          font-weight: 600;
          color: var(--agy-accent);
          opacity: 0.95;
        }
        .h-cell, .tile, .b7-col { cursor: pointer; }
        .h-cell.hovered, .tile.hovered { outline: 1.5px solid var(--agy-accent); outline-offset: 1px; }
        .b7-col.hovered .b7-lbl { opacity: 1; color: var(--agy-accent); font-weight: 600; }
        .hero-usd {
          margin-left: auto;
          font-size: 12px;
          font-weight: 600;
          color: var(--agy-accent);
          opacity: 0.92;
          white-space: nowrap;
        }
        .hero-sub {
          margin-top: 3px;
          font-size: 11px;
          opacity: 0.62;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* Right column: models */
        .m-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          flex: 1;
          justify-content: center;
        }
        .m-item { display: flex; flex-direction: column; gap: 2.5px; }
        .m-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          font-size: 11.5px;
        }
        .m-name {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0.88;
        }
        .m-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .m-pct {
          font-size: 11px;
          font-weight: 500;
          opacity: 0.68;
          flex-shrink: 0;
        }
        .m-track {
          height: 3.5px;
          border-radius: 999px;
          background: ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,20,35,0.07)'};
          overflow: hidden;
        }
        .m-fill {
          height: 100%;
          border-radius: 999px;
          opacity: 0.88;
        }
        .r-foot {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid ${hairline};
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 10.5px;
          opacity: 0.56;
        }
        .empty-msg {
          font-size: 11px;
          opacity: 0.52;
          text-align: center;
          padding: 14px 0;
        }
      </style>
      <div class="studio">
        <div class="col-l">
          <div>
            <div class="col-head">
              <span class="lbl">${zh ? '活跃轨迹' : 'Activity'}<span class="lbl-date" id="agy-hover-date"></span></span>
              <div class="ranges">
                <button type="button" class="r-btn ${homeRangeKey === 'all' ? 'active' : ''}" data-range="all">${zh ? '总览' : 'All'}</button>
                <button type="button" class="r-btn ${homeRangeKey === 'today' ? 'active' : ''}" data-range="today">${zh ? '今日' : 'Today'}</button>
                <button type="button" class="r-btn ${homeRangeKey === '7d' ? 'active' : ''}" data-range="7d">${zh ? '7天' : '7d'}</button>
                <button type="button" class="r-btn ${homeRangeKey === '30d' ? 'active' : ''}" data-range="30d">${zh ? '30天' : '30d'}</button>
              </div>
            </div>
            <div class="vis-box">${visualHtml}</div>
          </div>
          <div class="hero">
            <div class="hero-main">
              <span class="hero-num" id="agy-hero-num">${totalTok}</span>
              <span class="hero-unit">tokens</span>
              <span class="hero-usd" id="agy-hero-usd" title="${zh ? '按官方 Developer API 公开费率折算的参考金额（已区分普通输入、缓存读与输出）' : 'Estimated equivalent Developer API cost (separating uncached input, cache reads, and output)'}">${usdStr}</span>
            </div>
            <div class="hero-sub" id="agy-hero-sub">${zh ? `输出 ${outTok} · 缓存 ${cacheStr} · ${convCount} 对话 · ${callCount} 次` : `Out ${outTok} · Cache ${cacheStr} · ${convCount} chats · ${callCount} calls`}</div>
          </div>
        </div>
        <div class="col-r">
          <div class="col-head">
            <span class="lbl">${zh ? '模型分布' : 'Models'}</span>
            <button type="button" class="ref-btn" id="btn-home-ref" title="${zh ? '刷新统计' : 'Refresh usage'}">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7"></path>
                <path d="M13.5 2.5v2.8h-2.8"></path>
              </svg>
            </button>
          </div>
          <div class="m-list" id="agy-models-list">${modelsHtml}</div>
          <div class="r-foot">
            <span>${planBadge}</span>
            <span>${quotaFootParts.length ? quotaFootParts.join(' · ') : (zh ? '本地统计' : 'Local rollup')}</span>
          </div>
        </div>
      </div>
    `;

    // Live hover-to-inspect daily stats on All / 30d / 7d (restores full range stats on mouseleave)
    const hoverZone = homeShadow.querySelector('[data-hover-zone="1"]');
    if (hoverZone && hoverDayList.length > 0) {
      const heroNumEl = homeShadow.getElementById('agy-hero-num');
      const heroUsdEl = homeShadow.getElementById('agy-hero-usd');
      const heroSubEl = homeShadow.getElementById('agy-hero-sub');
      const hoverDateEl = homeShadow.getElementById('agy-hover-date');
      const modelsListEl = homeShadow.getElementById('agy-models-list');

      const defaultSubText = zh
        ? `输出 ${outTok} · 缓存 ${cacheStr} · ${convCount} 对话 · ${callCount} 次`
        : `Out ${outTok} · Cache ${cacheStr} · ${convCount} chats · ${callCount} calls`;

      let activeHoverEl = null;

      const showDayStats = (dayObj) => {
        if (!dayObj) return;
        const dTok = dayObj.totalTokens > 0 ? formatCompactTokens(dayObj.totalTokens) : '0';
        const dOut = formatCompactTokens(dayObj.outputTokens || 0);
        const dCache = dayObj.cacheHitPct != null ? `${dayObj.cacheHitPct}%` : '—';
        const dConvs = dayObj.conversations || 0;
        const dCalls = dayObj.calls || 0;
        const dUsd = dayObj.estUsd > 0 ? formatUsd(dayObj.estUsd) : '';
        if (hoverDateEl) hoverDateEl.textContent = dayObj.dateKey || dayObj.label || '';
        if (heroNumEl) heroNumEl.textContent = dTok;
        if (heroUsdEl) heroUsdEl.textContent = dUsd;
        if (heroSubEl) {
          heroSubEl.textContent = dCalls > 0
            ? (zh ? `输出 ${dOut} · 缓存 ${dCache} · ${dConvs} 对话 · ${dCalls} 次` : `Out ${dOut} · Cache ${dCache} · ${dConvs} chats · ${dCalls} calls`)
            : (zh ? `${dayObj.dateKey || dayObj.label || ''} · 当日无用量记录` : `${dayObj.dateKey || dayObj.label || ''} · No activity`);
        }
        if (modelsListEl) {
          modelsListEl.innerHTML = renderModelsListHtml(
            dayObj.models || [],
            zh ? '当日无模型调用' : 'No model calls on this day'
          );
        }
      };

      const restoreRangeStats = () => {
        if (activeHoverEl) {
          activeHoverEl.classList.remove('hovered');
          activeHoverEl = null;
        }
        if (hoverDateEl) hoverDateEl.textContent = '';
        if (heroNumEl) heroNumEl.textContent = totalTok;
        if (heroUsdEl) heroUsdEl.textContent = usdStr;
        if (heroSubEl) heroSubEl.textContent = defaultSubText;
        if (modelsListEl) modelsListEl.innerHTML = modelsHtml;
      };

      hoverZone.addEventListener('mouseover', (ev) => {
        const cell = ev.target?.closest?.('[data-day-idx]');
        if (!cell) return;
        if (cell === activeHoverEl) return;
        if (activeHoverEl) activeHoverEl.classList.remove('hovered');
        activeHoverEl = cell;
        cell.classList.add('hovered');
        const idx = Number(cell.getAttribute('data-day-idx'));
        if (Number.isInteger(idx) && hoverDayList[idx]) {
          showDayStats(hoverDayList[idx]);
        }
      });

      hoverZone.addEventListener('mouseleave', () => restoreRangeStats());
    }

    homeShadow.querySelectorAll('[data-range]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        homeRangeKey = b.getAttribute('data-range') || '7d';
        renderHomeDashboard();
      });
    });
    homeShadow.getElementById('btn-home-ref')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void refreshUsageSummary(true);
    });

    // Notify smooth-caret to re-sync position after layout insertion
    window.dispatchEvent(new Event('agy-layout-shift'));
  }

  // ---------------------------------------------------------------------------
  // Piece 3: Bottom-Right Floating Settings Icon & Unified Settings Modal
  // ---------------------------------------------------------------------------
  let settingsHost = null;
  let settingsShadow = null;
  let settingsBtnEl = null;
  let settingsPanelEl = null;

  let settingsCloseTimer = null;

  function closeSettingsModal(immediate = false) {
    settingsOpen = false;
    if (settingsBtnEl) settingsBtnEl.classList.remove('active');
    if (!settingsPanelEl) return;
    if (settingsCloseTimer) {
      clearTimeout(settingsCloseTimer);
      settingsCloseTimer = null;
    }
    if (immediate || settingsPanelEl.style.display === 'none') {
      settingsPanelEl.style.display = 'none';
      return;
    }
    settingsPanelEl.style.pointerEvents = 'none';
    const panel = settingsPanelEl.querySelector('.panel');
    if (panel) {
      panel.classList.remove('pop-in');
      panel.classList.add('pop-out');
    }
    settingsCloseTimer = setTimeout(() => {
      settingsCloseTimer = null;
      if (!settingsOpen && settingsPanelEl) {
        settingsPanelEl.style.display = 'none';
      }
    }, 115);
  }

  function openSettingsModal() {
    closeTelemetryPopover();
    settingsOpen = true;
    ensureSettingsWidgetMounted();
    if (settingsCloseTimer) {
      clearTimeout(settingsCloseTimer);
      settingsCloseTimer = null;
    }
    syncSettingsSurfaceVars();
    renderSettingsPanel(true);
    if (settingsPanelEl) {
      settingsPanelEl.style.pointerEvents = 'auto';
      settingsPanelEl.style.display = 'block';
    }
    if (settingsBtnEl) settingsBtnEl.classList.add('active');
  }

  function renderSettingsPanel(animateOpen = false) {
    if (!settingsShadow || !settingsPanelEl) return;
    const dark = detectDarkTheme();
    const accent = detectAccentColor();
    const zh = isZh();
    const loc = settings?.i18n?.locale || 'zh-CN';
    const showFloat = settings?.i18n?.showFloatingToggle !== false;
    const vib = settings?.vibrancy;
    const tel = settings?.telemetry || {
      showComposerBar: true,
      showTurnFooter: true,
      showHomeDashboard: true,
      mergeVariantUsage: false,
      fileOpenMode: 'sidebar',
      codeBlockEnhance: true,
      streamFadeIn: true,
      smoothCaret: true,
    };
    const variantLabel = settings?.variant === 'insiders' ? 'Insiders' : (zh ? '正式版' : 'Stable');
    const opacityPct = vib ? Math.round((vib.opacity ?? 0.55) * 100) : 55;
    const fileMode = ['sidebar', 'finder', 'external'].includes(tel.fileOpenMode) ? tel.fileOpenMode : 'sidebar';
    const fileModeDesc = fileMode === 'finder'
      ? (zh ? '在 Finder 中定位选中' : 'Reveal file in Finder')
      : (fileMode === 'external'
        ? (zh ? '用默认软件打开（按住 ⌘ 仍用侧边栏）' : 'Open in default app (⌘-click for sidebar)')
        : (zh ? '在右侧边栏内预览' : 'Preview in right sidebar'));

    const vibSectionHtml = vib ? `
      <div class="sec">
        <div class="sec-title">${zh ? '毛玻璃' : 'Vibrancy'}</div>
        <div class="row">
          <span>${zh ? '开启毛玻璃' : 'Enable Vibrancy'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-vib-enabled" ${vib.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="sub-block ${vib.enabled ? '' : 'dim'}">
          <div class="sub-lbl row-inline">
            <span>${zh ? '不透明度' : 'Opacity'}</span>
            <span class="mono" id="lbl-vib-op">${opacityPct}%</span>
          </div>
          <input type="range" id="rng-vib-op" min="20" max="85" step="5" value="${opacityPct}" />
        </div>
      </div>
    ` : '';

    const generalTabHtml = `
      <div class="sec">
        <div class="sec-title">${zh ? '界面语言' : 'Language'}</div>
        <div class="seg">
          <button type="button" class="seg-btn ${loc === 'zh-CN' ? 'active' : ''}" data-locale="zh-CN">简体中文</button>
          <button type="button" class="seg-btn ${loc === 'en' ? 'active' : ''}" data-locale="en">English</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <span>${zh ? '右下角设置图标' : 'Floating Settings Icon'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-show-float" ${showFloat ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      ${vibSectionHtml}

      <div class="sec">
        <div class="sec-title">${zh ? '状态监控' : 'Telemetry'}</div>
        <div class="row">
          <span>${zh ? '底栏状态条' : 'Composer Bar'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-tel-bar" ${tel.showComposerBar !== false ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="row">
          <span>${zh ? '回答末尾汇总' : 'Turn Summary'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-tel-turn" ${tel.showTurnFooter !== false ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="row">
          <span>${zh ? '首页用量看板' : 'Home Usage Card'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-tel-home" ${tel.showHomeDashboard !== false ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="row ${tel.showHomeDashboard === false ? 'dim' : ''}">
          <span>${zh ? '合并双版本用量' : 'Merge Stable & Insiders'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-tel-merge" ${tel.mergeVariantUsage === true ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <button type="button" class="action-btn" id="btn-tel-refresh">${zh ? '刷新数据' : 'Refresh Data'}</button>
      </div>
    `;

    const experienceTabHtml = `
      <div class="sec">
        <div class="sec-title">${zh ? '点击文件链接' : 'File Link Action'}</div>
        <div class="seg seg-3">
          <button type="button" class="seg-btn ${fileMode === 'sidebar' ? 'active' : ''}" data-file-mode="sidebar">${zh ? '侧边栏' : 'Sidebar'}</button>
          <button type="button" class="seg-btn ${fileMode === 'finder' ? 'active' : ''}" data-file-mode="finder">Finder</button>
          <button type="button" class="seg-btn ${fileMode === 'external' ? 'active' : ''}" data-file-mode="external">${zh ? '默认应用' : 'Default App'}</button>
        </div>
        <div class="mode-desc">${fileModeDesc}</div>
      </div>

      <div class="sec">
        <div class="sec-title">${zh ? '阅读与动效' : 'Reading & Motion'}</div>
        <div class="row">
          <span>${zh ? '代码块吸顶与折叠' : 'Sticky & Fold Code Blocks'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-code-enh" ${tel.codeBlockEnhance !== false ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="row">
          <span>${zh ? '吐字淡入动效' : 'Streaming Fade-in'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-stream-fade" ${tel.streamFadeIn !== false ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="row">
          <span>${zh ? '平滑光标' : 'Smooth Caret'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-smooth-caret" ${tel.smoothCaret !== false ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;

    settingsPanelEl.innerHTML = `
      <div class="panel ${dark ? 'dark' : 'light'}${animateOpen ? ' pop-in' : ''}" style="--agy-accent:${accent};">
        <div class="p-head">
          <div class="p-title">
            <span>antigravity-zh</span>
            <span class="v-badge">${variantLabel}</span>
          </div>
          <button type="button" class="close-btn" id="btn-close" aria-label="Close">✕</button>
        </div>

        <div class="nav-tabs" role="tablist">
          <button type="button" role="tab" class="nav-tab ${settingsTab === 'general' ? 'active' : ''}" data-stab="general">${zh ? '常规' : 'General'}</button>
          <button type="button" role="tab" class="nav-tab ${settingsTab === 'experience' ? 'active' : ''}" data-stab="experience">${zh ? '体验' : 'Experience'}</button>
        </div>

        ${settingsTab === 'experience' ? experienceTabHtml : generalTabHtml}
      </div>
    `;

    const api = window.__AGY_TELEMETRY_API__;
    settingsPanelEl.querySelector('#btn-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSettingsModal();
    });

    settingsPanelEl.querySelectorAll('[data-stab]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsTab = b.getAttribute('data-stab') === 'experience' ? 'experience' : 'general';
        renderSettingsPanel();
      });
    });

    settingsPanelEl.querySelectorAll('[data-locale]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = b.getAttribute('data-locale');
        if (window.__AGY_I18N_ENGINE__?.setLocale) {
          window.__AGY_I18N_ENGINE__.setLocale(next);
        }
        if (api?.setLocale) {
          api.setLocale(next).then((s) => { if (s) applySettings(s); }).catch(() => {});
        }
      });
    });

    settingsPanelEl.querySelector('#chk-show-float')?.addEventListener('change', (e) => {
      const checked = Boolean(e.target.checked);
      if (api?.setFloatingButton) {
        api.setFloatingButton(checked).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    settingsPanelEl.querySelector('#chk-vib-enabled')?.addEventListener('change', (e) => {
      if (api?.setVibrancy) {
        api.setVibrancy({ enabled: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    const rngOp = settingsPanelEl.querySelector('#rng-vib-op');
    const lblOp = settingsPanelEl.querySelector('#lbl-vib-op');
    if (rngOp) {
      rngOp.addEventListener('input', () => {
        if (lblOp) lblOp.textContent = `${rngOp.value}%`;
      });
      rngOp.addEventListener('change', () => {
        const opVal = Number(rngOp.value) / 100;
        if (api?.setVibrancy) {
          api.setVibrancy({ enabled: true, opacity: opVal }).then((s) => { if (s) applySettings(s); }).catch(() => {});
        }
      });
    }

    settingsPanelEl.querySelector('#chk-tel-bar')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ showComposerBar: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    settingsPanelEl.querySelector('#chk-tel-turn')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ showTurnFooter: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    settingsPanelEl.querySelector('#chk-tel-home')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ showHomeDashboard: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    settingsPanelEl.querySelector('#chk-tel-merge')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ mergeVariantUsage: Boolean(e.target.checked) }).then((s) => {
          if (s) applySettings(s);
          void refreshUsageSummary(true);
        }).catch(() => {});
      }
    });

    settingsPanelEl.querySelectorAll('[data-file-mode]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = b.getAttribute('data-file-mode');
        if (api?.setTelemetry) {
          api.setTelemetry({ fileOpenMode: mode }).then((s) => { if (s) applySettings(s); }).catch(() => {});
        }
      });
    });

    settingsPanelEl.querySelector('#chk-code-enh')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ codeBlockEnhance: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    settingsPanelEl.querySelector('#chk-stream-fade')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ streamFadeIn: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    settingsPanelEl.querySelector('#chk-smooth-caret')?.addEventListener('change', (e) => {
      if (api?.setTelemetry) {
        api.setTelemetry({ smoothCaret: Boolean(e.target.checked) }).then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    });

    const btnRef = settingsPanelEl.querySelector('#btn-tel-refresh');
    if (btnRef) {
      btnRef.addEventListener('click', async (e) => {
        e.stopPropagation();
        btnRef.textContent = zh ? '刷新中…' : 'Refreshing…';
        await Promise.allSettled([pollSnapshot(true), refreshUsageSummary(true)]);
        btnRef.textContent = zh ? '✓ 已更新' : '✓ Updated';
        setTimeout(() => {
          if (btnRef.isConnected) btnRef.textContent = zh ? '刷新数据' : 'Refresh Data';
        }, 1200);
      });
    }
  }

  function syncSettingsSurfaceVars() {
    if (!settingsHost) return;
    const dark = detectDarkTheme();
    const glass = computeGlassSurface(dark);
    const hostFont = detectHostFontFamily();
    settingsHost.style.setProperty('--agy-font-sans', hostFont);
    settingsHost.style.setProperty('--agy-panel-bg', glass.panelBg);
    settingsHost.style.setProperty('--agy-panel-blur', glass.blur);
    settingsHost.style.setProperty('--agy-panel-shadow', glass.panelShadow);
    settingsHost.style.setProperty('--agy-fab-bg', glass.fabBg);
    settingsHost.style.setProperty('--agy-fab-blur', glass.fabBlur);
    settingsHost.style.setProperty('--agy-fab-shadow', glass.fabShadow);
  }

  function updateSettingsButtonAppearance() {
    if (!settingsHost || !settingsBtnEl) return;
    const dark = detectDarkTheme();
    const show = settings?.i18n?.showFloatingToggle !== false;
    syncSettingsSurfaceVars();
    settingsBtnEl.style.display = show ? 'inline-flex' : 'none';
    settingsBtnEl.classList.toggle('dark', dark);
    settingsBtnEl.classList.toggle('light', !dark);
    settingsBtnEl.title = isZh()
      ? 'antigravity-zh 设置（汉化 · 毛玻璃 · 遥测）· 拖动移动 · 双击复位'
      : 'antigravity-zh Settings (Language · Vibrancy · Telemetry) · Drag to move · Double-click to reset';
    if (settingsOpen) renderSettingsPanel();
  }

  function ensureSettingsWidgetMounted() {
    if (settingsHost && settingsHost.isConnected) return;
    if (!document.documentElement) return;

    settingsHost = document.createElement('div');
    settingsHost.id = 'agy-settings-host';
    settingsHost.setAttribute('data-agy-i18n-ignore', '1');
    settingsHost.setAttribute('data-agy-telemetry-ignore', '1');
    settingsHost.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483641;pointer-events:auto;user-select:none;';

    try {
      const saved = JSON.parse(localStorage.getItem('agy-settings-btn-pos') || 'null');
      if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
        const maxR = Math.max(20, window.innerWidth - 52);
        const maxB = Math.max(20, window.innerHeight - 52);
        settingsHost.style.right = `${Math.min(Math.max(8, saved.right), maxR)}px`;
        settingsHost.style.bottom = `${Math.min(Math.max(8, saved.bottom), maxB)}px`;
      }
    } catch (_e) {}

    settingsShadow = settingsHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        -webkit-font-smoothing: antialiased;
        font-family: var(--agy-font-sans, "Google Sans Flex", "Google Sans", "Google Sans Text", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif);
      }
      .fab {
        appearance: none;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        opacity: 0.82;
        border: none;
        background: var(--agy-fab-bg, rgba(30, 32, 42, 0.72));
        box-shadow: var(--agy-fab-shadow, 0 4px 14px rgba(0, 0, 0, 0.32));
        transition: opacity 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
        backdrop-filter: var(--agy-fab-blur, blur(20px) saturate(155%));
        -webkit-backdrop-filter: var(--agy-fab-blur, blur(20px) saturate(155%));
      }
      .fab.light { color: #3f3f46; }
      .fab.dark { color: #e4e4e7; }
      .fab:hover, .fab.active {
        opacity: 1;
        transform: translateY(-1px);
      }
      .fab.dragging { cursor: grabbing; opacity: 1; transform: none; }
      .fab svg { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

      @keyframes agy-panel-pop-in {
        from { opacity: 0; transform: translateY(8px) scale(0.96); }
        to { opacity: 1; transform: none; }
      }
      @keyframes agy-panel-pop-out {
        from { opacity: 1; transform: none; }
        to { opacity: 0; transform: translateY(5px) scale(0.97); }
      }
      .panel-slot {
        position: absolute;
        right: 0;
        bottom: 44px;
        display: none;
      }
      .panel {
        width: 320px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 72px);
        overflow-y: auto;
        scrollbar-width: none;
        border-radius: 15px;
        padding: 14px 15px;
        font-size: 12px;
        line-height: 1.45;
        box-sizing: border-box;
        border: none;
        background: var(--agy-panel-bg, rgba(24, 26, 35, 0.78));
        backdrop-filter: var(--agy-panel-blur, blur(26px) saturate(160%));
        -webkit-backdrop-filter: var(--agy-panel-blur, blur(26px) saturate(160%));
        box-shadow: var(--agy-panel-shadow, 0 16px 40px -10px rgba(0, 0, 0, 0.46));
        transform-origin: bottom right;
      }
      .panel.pop-in {
        animation: agy-panel-pop-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .panel.pop-out {
        animation: agy-panel-pop-out 110ms ease-in forwards;
        pointer-events: none;
      }
      .panel::-webkit-scrollbar { display: none; }
      .panel.light { color: rgba(18, 20, 28, 0.94); }
      .panel.dark { color: rgba(244, 246, 252, 0.95); }
      .p-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .p-title {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 13.5px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .v-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--agy-accent, #3b82f6) 15%, transparent);
        color: var(--agy-accent, #3b82f6);
      }
      .close-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.65;
        width: 24px;
        height: 24px;
        border-radius: 7px;
        cursor: pointer;
        font-size: 12px;
      }
      .close-btn:hover { opacity: 1; background: rgba(128, 128, 138, 0.16); }
      .sec {
        padding-top: 0;
        margin-top: 0;
        border-top: none;
      }
      .sec + .sec {
        padding-top: 11px;
        margin-top: 11px;
        border-top: 1px solid rgba(128, 128, 138, 0.16);
      }
      .sec-title {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.01em;
        opacity: 0.62;
        margin-bottom: 8px;
      }
      .nav-tabs {
        display: flex;
        align-items: center;
        gap: 16px;
        border-bottom: 1px solid rgba(128, 128, 138, 0.18);
        margin: -2px 0 12px;
      }
      .nav-tab {
        appearance: none;
        border: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        padding: 4px 2px 7px;
        cursor: pointer;
        opacity: 0.52;
        transition: opacity 0.14s ease, border-color 0.14s ease, color 0.14s ease;
      }
      .nav-tab:hover { opacity: 0.85; }
      .nav-tab.active {
        opacity: 1;
        color: var(--agy-accent, #3b82f6);
        border-bottom-color: var(--agy-accent, #3b82f6);
      }
      .mode-desc {
        font-size: 11px;
        opacity: 0.6;
        margin-top: 6px;
        line-height: 1.4;
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: 7px 0;
        font-size: 12px;
      }
      .sub-block { transition: opacity 0.16s ease; }
      .sub-block.dim { opacity: 0.45; }
      .sub-lbl {
        font-size: 11px;
        opacity: 0.72;
        margin: 8px 0 5px;
      }
      .row-inline { display: flex; justify-content: space-between; align-items: center; }
      .mono { font-family: "Google Sans Code", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
      .seg {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 3px;
        padding: 3px;
        border-radius: 9px;
        background: rgba(128, 128, 138, 0.12);
      }
      .seg.seg-3 { grid-template-columns: repeat(3, 1fr); }
      .seg.seg-4 { grid-template-columns: repeat(4, 1fr); }
      .seg-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 11.5px;
        font-weight: 600;
        padding: 5px 6px;
        border-radius: 7px;
        cursor: pointer;
        white-space: nowrap;
        opacity: 0.78;
        transition: background-color 0.14s ease, opacity 0.14s ease, color 0.14s ease;
      }
      .seg-btn:hover { opacity: 1; }
      .seg-btn.active {
        opacity: 1;
        background: var(--agy-accent, #3b82f6);
        color: #ffffff;
      }
      .pills {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      .preset-row { margin-top: 6px; }
      .pill-btn {
        appearance: none;
        border: 1px solid rgba(128, 128, 138, 0.24);
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 7px;
        cursor: pointer;
        opacity: 0.85;
      }
      .pill-btn:hover { opacity: 1; background: rgba(128, 128, 138, 0.12); }
      .pill-btn.active {
        opacity: 1;
        border-color: transparent;
        background: #3b82f6;
        color: #ffffff;
      }
      input[type="range"] {
        width: 100%;
        accent-color: var(--agy-accent, #3b82f6);
        cursor: pointer;
      }
      .switch {
        position: relative;
        display: inline-block;
        width: 34px;
        height: 19px;
        flex-shrink: 0;
      }
      .switch input { opacity: 0; width: 0; height: 0; }
      .slider {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: rgba(128, 128, 138, 0.34);
        cursor: pointer;
        transition: background-color 0.18s ease;
      }
      .slider::before {
        content: "";
        position: absolute;
        width: 15px;
        height: 15px;
        left: 2px;
        top: 2px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
        transition: transform 0.18s ease;
      }
      .switch input:checked + .slider { background: var(--agy-accent, #3b82f6); }
      .switch input:checked + .slider::before { transform: translateX(15px); }
      .hint {
        font-size: 10.5px;
        opacity: 0.56;
        margin-top: 5px;
        line-height: 1.4;
      }
      .action-btn {
        appearance: none;
        width: 100%;
        margin-top: 9px;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid rgba(128, 128, 138, 0.24);
        background: rgba(128, 128, 138, 0.10);
        color: inherit;
        font: inherit;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .action-btn:hover { background: rgba(128, 128, 138, 0.18); }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    settingsPanelEl = document.createElement('div');
    settingsPanelEl.className = 'panel-slot';

    settingsBtnEl = document.createElement('button');
    settingsBtnEl.type = 'button';
    settingsBtnEl.className = 'fab';
    settingsBtnEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>`;

    wrap.appendChild(settingsPanelEl);
    wrap.appendChild(settingsBtnEl);
    settingsShadow.appendChild(style);
    settingsShadow.appendChild(wrap);
    document.documentElement.appendChild(settingsHost);

    // Drag with >5px threshold before pointer capture so clicks are never swallowed
    let dragging = false;
    let moved = false;
    let capturedId = null;
    let startX = 0, startY = 0, startRight = 14, startBottom = 14;

    settingsBtnEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      capturedId = null;
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseFloat(settingsHost.style.right) || 14;
      startBottom = parseFloat(settingsHost.style.bottom) || 14;
    });

    settingsBtnEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        moved = true;
        settingsBtnEl.classList.add('dragging');
        try {
          settingsBtnEl.setPointerCapture(e.pointerId);
          capturedId = e.pointerId;
        } catch (_err) {}
      }
      if (moved) {
        const nextR = Math.min(Math.max(8, startRight - dx), window.innerWidth - 48);
        const nextB = Math.min(Math.max(8, startBottom - dy), window.innerHeight - 48);
        settingsHost.style.right = `${nextR}px`;
        settingsHost.style.bottom = `${nextB}px`;
      }
    });

    settingsBtnEl.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      settingsBtnEl.classList.remove('dragging');
      if (capturedId !== null) {
        try { settingsBtnEl.releasePointerCapture(capturedId); } catch (_err) {}
        capturedId = null;
      }
      if (moved) {
        try {
          localStorage.setItem('agy-settings-btn-pos', JSON.stringify({
            right: parseFloat(settingsHost.style.right) || 14,
            bottom: parseFloat(settingsHost.style.bottom) || 14,
          }));
        } catch (_err) {}
        setTimeout(() => { moved = false; }, 50);
      }
    });

    settingsBtnEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      settingsHost.style.right = '14px';
      settingsHost.style.bottom = '14px';
      try { localStorage.removeItem('agy-settings-btn-pos'); } catch (_err) {}
    });

    settingsBtnEl.addEventListener('click', (e) => {
      if (moved) { e.preventDefault(); return; }
      e.stopPropagation();
      if (settingsOpen) closeSettingsModal();
      else openSettingsModal();
    });

    updateSettingsButtonAppearance();
  }

  // ---------------------------------------------------------------------------
  // Polling, Route Tracking & Sync Orchestration
  // ---------------------------------------------------------------------------
  function applySettings(next) {
    if (!next || typeof next !== 'object') return;
    settings = {
      ...settings,
      ...next,
      i18n: { ...(settings.i18n || {}), ...(next.i18n || {}) },
      telemetry: { ...(settings.telemetry || {}), ...(next.telemetry || {}) },
    };
    if (window.__AGY_ENHANCEMENTS__?.applySettings) {
      window.__AGY_ENHANCEMENTS__.applySettings(settings);
    }
    updateSettingsButtonAppearance();
    renderComposerBar();
    renderTurnFooters();
    renderHomeDashboard();
  }

  async function pollSnapshot(forceQuota = false) {
    const api = window.__AGY_TELEMETRY_API__;
    if (!api || typeof api.getSnapshot !== 'function') return;
    const needTelemetry = settings?.telemetry?.showComposerBar !== false || settings?.telemetry?.showTurnFooter !== false;
    if (!needTelemetry && !forceQuota) return;

    const routeId = extractRouteConversationId();
    if (routeId !== currentRouteId) {
      currentRouteId = routeId;
      snapshot = { ...snapshot, session: null };
      renderComposerBar();
      renderTurnFooters();
      renderHomeDashboard();
      if (!routeId && settings?.telemetry?.showHomeDashboard !== false) {
        void refreshUsageSummary(false);
      }
    }

    const mySeq = ++fetchSeq;
    try {
      const res = await api.getSnapshot({ routeId, forceQuota });
      if (mySeq !== fetchSeq) return;
      if (res && res.ok) {
        snapshot = {
          quota: res.quota || snapshot.quota,
          session: routeId ? (res.session || null) : null,
        };
        renderComposerBar();
        renderTurnFooters();
        renderHomeDashboard();
      }
    } catch (_e) {}
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (document.hidden) return;
    const onConv = Boolean(extractRouteConversationId());
    const delay = onConv ? 2500 : 12000;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!document.hidden) {
        await pollSnapshot(false);
        schedulePoll();
      }
    }, delay);
  }

  function scheduleDomSync() {
    if (domSyncTimer) return;
    domSyncTimer = setTimeout(() => {
      domSyncTimer = null;
      const routeId = extractRouteConversationId();
      if (routeId !== currentRouteId) {
        void pollSnapshot(false);
      } else {
        renderComposerBar();
        renderTurnFooters();
        renderHomeDashboard();
      }
    }, 180);
  }

  function hookHistoryNavigation() {
    if (window.__AGY_TELEMETRY_HIST_HOOKED__) return;
    window.__AGY_TELEMETRY_HIST_HOOKED__ = true;
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      if (typeof orig === 'function') {
        history[fn] = function patchedHistory() {
          const out = orig.apply(this, arguments);
          scheduleDomSync();
          return out;
        };
      }
    }
    window.addEventListener('popstate', () => scheduleDomSync());
  }

  function startDomObserver() {
    if (domObserver || !document.body) return;
    domObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const t = m.target;
        if (t && t.nodeType === 1 && (t.closest?.('#agy-settings-host, #agy-telemetry-bar-host, #agy-telemetry-popover-host, #agy-home-dashboard-host, #agy-smooth-caret, .agy-turn-footer, .agy-code-fold-btn, .agy-code-fold-bar'))) {
          continue;
        }
        scheduleDomSync();
        break;
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    const themeObs = new MutationObserver(() => {
      updateSettingsButtonAppearance();
      renderComposerBar();
      renderHomeDashboard();
      if (popoverOpen) renderTelemetryPopover();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    if (document.body) {
      themeObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-agy-theme'] });
    }
  }

  // Outside-click & Esc close for both popovers
  document.addEventListener('click', (ev) => {
    const pathArr = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const hitBar = barHost && pathArr.includes(barHost);
    const hitPop = popoverHost && pathArr.includes(popoverHost);
    const hitSet = settingsHost && pathArr.includes(settingsHost);
    if (popoverOpen && !hitBar && !hitPop) closeTelemetryPopover();
    if (settingsOpen && !hitSet) closeSettingsModal();
  }, true);

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (popoverOpen) closeTelemetryPopover();
      if (settingsOpen) closeSettingsModal();
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    } else {
      void pollSnapshot(false);
      schedulePoll();
    }
  });

  window.addEventListener('resize', () => {
    if (popoverOpen) renderTelemetryPopover();
    scheduleDomSync();
  });

  window.addEventListener('agy-i18n:state', (ev) => {
    const detail = ev?.detail;
    if (detail) {
      applySettings({ i18n: { locale: detail.locale, showFloatingToggle: detail.showFloatingToggle } });
    }
  });

  function init(initialSettings) {
    if (initialSettings) applySettings(initialSettings);

    const boot = () => {
      ensureSettingsWidgetMounted();
      hookHistoryNavigation();
      startDomObserver();
      renderComposerBar();
      renderTurnFooters();
      renderHomeDashboard();
      void pollSnapshot(true).then(() => schedulePoll());
    };

    if (document.body) boot();
    else window.addEventListener('DOMContentLoaded', boot, { once: true });

    const api = window.__AGY_TELEMETRY_API__;
    if (api) {
      if (typeof api.onSettingsChanged === 'function') {
        api.onSettingsChanged((next) => applySettings(next));
      }
      if (typeof api.onOpenSettings === 'function') {
        api.onOpenSettings(() => openSettingsModal());
      }
      if (typeof api.getAllSettings === 'function') {
        api.getAllSettings().then((s) => { if (s) applySettings(s); }).catch(() => {});
      }
    }
  }

  window.__AGY_TELEMETRY_UI__ = {
    version: '1.0.0',
    init,
    applySettings,
    openSettings: openSettingsModal,
    refresh: () => pollSnapshot(true),
  };
})();
