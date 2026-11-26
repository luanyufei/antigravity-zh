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
    telemetry: { showComposerBar: true, showTurnFooter: true, quotaWindow: 'auto' },
  };

  let snapshot = { quota: null, session: null };
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

    const panelRgb = dark ? '30, 32, 42' : '252, 253, 255';
    const panelAlpha = vibOn
      ? (dark
        ? Math.min(0.80, Math.max(0.56, +(op + 0.24).toFixed(2)))
        : Math.min(0.86, Math.max(0.68, +(op + 0.30).toFixed(2))))
      : (dark ? 0.82 : 0.86);
    const fabAlpha = vibOn
      ? (dark
        ? Math.min(0.74, Math.max(0.46, +(op + 0.14).toFixed(2)))
        : Math.min(0.82, Math.max(0.60, +(op + 0.24).toFixed(2))))
      : (dark ? 0.78 : 0.84);

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

  function closeTelemetryPopover() {
    popoverOpen = false;
    if (popoverHost) popoverHost.style.display = 'none';
    if (barShadow) {
      barShadow.querySelectorAll('.bar').forEach((c) => c.classList.remove('active'));
    }
  }

  function ensurePopoverHost() {
    if (popoverHost && popoverHost.isConnected) return;
    popoverHost = document.createElement('div');
    popoverHost.id = 'agy-telemetry-popover-host';
    popoverHost.setAttribute('data-agy-i18n-ignore', '1');
    popoverHost.setAttribute('data-agy-telemetry-ignore', '1');
    popoverHost.style.cssText = 'position:fixed;z-index:2147483642;display:none;pointer-events:auto;';
    popoverShadow = popoverHost.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(popoverHost);
  }

  function renderTelemetryPopover() {
    if (!popoverOpen || !barHost || !barHost.isConnected) {
      closeTelemetryPopover();
      return;
    }
    ensurePopoverHost();

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
    const hostFont = detectHostFontFamily();

    popoverShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
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
          font-size: 10.5px;
          font-weight: 500;
          padding: 1px 7px;
          border-radius: 6px;
          white-space: nowrap;
          background: ${dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.055)'};
          color: ${dark ? '#d4d4d8' : '#3f3f46'};
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
        .fill.ok { background: ${dark ? '#d4d4d8' : '#3f3f46'}; }
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
      </style>
      <div class="card">
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
      </div>
    `;

    popoverShadow.getElementById('btn-refresh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void pollSnapshot(true);
    });

    // Anchor cleanly right above the composer bar without overflowing viewport
    const rect = barHost.getBoundingClientRect();
    popoverHost.style.display = 'block';
    const cardW = 316;
    const left = Math.min(Math.max(12, rect.right - cardW), window.innerWidth - cardW - 12);
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    popoverHost.style.left = `${Math.round(left)}px`;
    popoverHost.style.bottom = `${Math.round(bottom)}px`;
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

  function renderComposerBar() {
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

    // Quota item text & tone (always dual-display 5h + 7d when both available)
    let quotaText = '—';
    let quotaTone = 'muted';
    if (activeGroup && activeGroup.buckets?.length) {
      const b5 = activeGroup.buckets.find((b) => b.windowKey === '5h');
      const bW = activeGroup.buckets.find((b) => b.windowKey === 'weekly');
      const pickTone = (p) => (p == null ? 'muted' : p <= 15 ? 'danger' : p <= 35 ? 'warn' : 'ok');

      if (b5 && bW) {
        quotaText = `5h ${b5.percent ?? '—'}% · 7d ${bW.percent ?? '—'}%`;
        quotaTone = pickTone(Math.min(b5.percent ?? 100, bW.percent ?? 100));
      } else if (b5) {
        quotaText = `5h ${b5.percent ?? '—'}%`;
        quotaTone = pickTone(b5.percent);
      } else if (bW) {
        quotaText = `7d ${bW.percent ?? '—'}%`;
        quotaTone = pickTone(bW.percent);
      } else {
        const chosen = activeGroup.buckets[0];
        if (chosen) {
          const lbl = chosen.windowKey === 'weekly' ? '7d' : '5h';
          quotaText = `${lbl} ${chosen.percent ?? '—'}%`;
          quotaTone = pickTone(chosen.percent);
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
        .item.tone-warn { color: ${warnColor}; }
        .item.tone-danger { color: ${dangerColor}; }
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
        <span class="item tone-${quotaTone}" title="${zh ? '点击查看模型额度详情' : 'Click for Model Quota details'}">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6"></circle>
            <path d="M8 4.6V8l2.3 1.4"></path>
          </svg>
          <span>${quotaText}</span>
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
          renderTelemetryPopover();
          void pollSnapshot(false);
        } else {
          closeTelemetryPopover();
        }
        renderComposerBar();
      });
    });

    if (popoverOpen) renderTelemetryPopover();
  }

  // ---------------------------------------------------------------------------
  // Piece 3: Bottom-Right Floating Settings Icon & Unified Settings Modal
  // ---------------------------------------------------------------------------
  let settingsHost = null;
  let settingsShadow = null;
  let settingsBtnEl = null;
  let settingsPanelEl = null;

  function closeSettingsModal() {
    settingsOpen = false;
    if (settingsPanelEl) settingsPanelEl.style.display = 'none';
    if (settingsBtnEl) settingsBtnEl.classList.remove('active');
  }

  function openSettingsModal() {
    closeTelemetryPopover();
    settingsOpen = true;
    ensureSettingsWidgetMounted();
    renderSettingsPanel();
    if (settingsPanelEl) settingsPanelEl.style.display = 'block';
    if (settingsBtnEl) settingsBtnEl.classList.add('active');
  }

  function renderSettingsPanel() {
    if (!settingsShadow || !settingsPanelEl) return;
    const dark = detectDarkTheme();
    const accent = detectAccentColor();
    const zh = isZh();
    const loc = settings?.i18n?.locale || 'zh-CN';
    const showFloat = settings?.i18n?.showFloatingToggle !== false;
    const vib = settings?.vibrancy;
    const tel = settings?.telemetry || { showComposerBar: true, showTurnFooter: true, quotaWindow: 'auto' };
    const variantLabel = settings?.variant === 'insiders' ? 'Insiders' : (zh ? '正式版' : 'Stable');

    const opacityPct = vib ? Math.round((vib.opacity ?? 0.55) * 100) : 55;

    const vibSectionHtml = vib ? `
      <div class="sec">
        <div class="sec-title">${zh ? '毛玻璃效果 (Vibrancy)' : 'Native Vibrancy'}</div>
        <div class="row">
          <span>${zh ? '开启 macOS 原生毛玻璃' : 'Enable Native Vibrancy'}</span>
          <label class="switch">
            <input type="checkbox" id="chk-vib-enabled" ${vib.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="sub-block ${vib.enabled ? '' : 'dim'}">
          <div class="sub-lbl row-inline">
            <span>${zh ? '背景遮罩不透明度' : 'Tint Opacity'}</span>
            <span class="mono" id="lbl-vib-op">${opacityPct}%</span>
          </div>
          <input type="range" id="rng-vib-op" min="20" max="85" step="5" value="${opacityPct}" />
        </div>
      </div>
    ` : '';

    settingsPanelEl.innerHTML = `
      <div class="panel ${dark ? 'dark' : 'light'}" style="--agy-accent:${accent};">
        <div class="p-head">
          <div class="p-title">
            <span>antigravity-zh</span>
            <span class="v-badge">${variantLabel}</span>
          </div>
          <button type="button" class="close-btn" id="btn-close" aria-label="Close">✕</button>
        </div>

        <div class="sec">
          <div class="sec-title">${zh ? '界面汉化 (Language)' : 'Localization (Language)'}</div>
          <div class="seg">
            <button type="button" class="seg-btn ${loc === 'zh-CN' ? 'active' : ''}" data-locale="zh-CN">简体中文</button>
            <button type="button" class="seg-btn ${loc === 'en' ? 'active' : ''}" data-locale="en">English</button>
          </div>
          <div class="row" style="margin-top:8px;">
            <span>${zh ? '显示右下角浮动设置图标' : 'Show Floating Settings Icon'}</span>
            <label class="switch">
              <input type="checkbox" id="chk-show-float" ${showFloat ? 'checked' : ''} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        ${vibSectionHtml}

        <div class="sec">
          <div class="sec-title">${zh ? '状态监控 (Telemetry)' : 'Telemetry'}</div>
          <div class="row">
            <span>${zh ? '输入框底部状态条（上下文·额度·速度）' : 'Composer Bar (Context · Quota · Speed)'}</span>
            <label class="switch">
              <input type="checkbox" id="chk-tel-bar" ${tel.showComposerBar ? 'checked' : ''} />
              <span class="slider"></span>
            </label>
          </div>
          <div class="row">
            <span>${zh ? '回答末尾显示「本轮汇总」' : 'Show Per-Turn Summary Footer'}</span>
            <label class="switch">
              <input type="checkbox" id="chk-tel-turn" ${tel.showTurnFooter ? 'checked' : ''} />
              <span class="slider"></span>
            </label>
          </div>
          <button type="button" class="action-btn" id="btn-tel-refresh">${zh ? '立即刷新额度与本会话数据' : 'Refresh Quota & Session Now'}</button>
        </div>
      </div>
    `;

    const api = window.__AGY_TELEMETRY_API__;
    settingsPanelEl.querySelector('#btn-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSettingsModal();
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

    const btnRef = settingsPanelEl.querySelector('#btn-tel-refresh');
    if (btnRef) {
      btnRef.addEventListener('click', async (e) => {
        e.stopPropagation();
        btnRef.textContent = zh ? '刷新中…' : 'Refreshing…';
        await pollSnapshot(true);
        btnRef.textContent = zh ? '✓ 已更新' : '✓ Updated';
        setTimeout(() => {
          if (btnRef.isConnected) btnRef.textContent = zh ? '立即刷新额度与本会话数据' : 'Refresh Quota & Session Now';
        }, 1200);
      });
    }
  }

  function updateSettingsButtonAppearance() {
    if (!settingsHost || !settingsBtnEl) return;
    const dark = detectDarkTheme();
    const glass = computeGlassSurface(dark);
    const hostFont = detectHostFontFamily();
    const show = settings?.i18n?.showFloatingToggle !== false;
    settingsHost.style.setProperty('--agy-font-sans', hostFont);
    settingsHost.style.setProperty('--agy-panel-bg', glass.panelBg);
    settingsHost.style.setProperty('--agy-panel-blur', glass.blur);
    settingsHost.style.setProperty('--agy-panel-shadow', glass.panelShadow);
    settingsHost.style.setProperty('--agy-fab-bg', glass.fabBg);
    settingsHost.style.setProperty('--agy-fab-blur', glass.fabBlur);
    settingsHost.style.setProperty('--agy-fab-shadow', glass.fabShadow);
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
        background: var(--agy-panel-bg, rgba(30, 32, 42, 0.74));
        backdrop-filter: var(--agy-panel-blur, blur(26px) saturate(160%));
        -webkit-backdrop-filter: var(--agy-panel-blur, blur(26px) saturate(160%));
        box-shadow: var(--agy-panel-shadow, 0 16px 40px -10px rgba(0, 0, 0, 0.46));
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
        padding-top: 11px;
        margin-top: 11px;
        border-top: 1px solid rgba(128, 128, 138, 0.16);
      }
      .sec:first-of-type { padding-top: 0; margin-top: 0; border-top: none; }
      .sec-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        opacity: 0.62;
        margin-bottom: 8px;
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
      .seg-4 { grid-template-columns: repeat(4, 1fr); }
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
        opacity: 0.78;
        transition: background-color 0.14s ease, opacity 0.14s ease;
      }
      .seg-btn:hover { opacity: 1; }
      .seg-btn.active {
        opacity: 1;
        background: #18181b;
        color: #ffffff;
      }
      .panel.dark .seg-btn.active {
        background: #f4f4f5;
        color: #18181b;
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
    updateSettingsButtonAppearance();
    renderComposerBar();
    renderTurnFooters();
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
        if (t && t.nodeType === 1 && (t.closest?.('#agy-settings-host, #agy-telemetry-bar-host, #agy-telemetry-popover-host, .agy-turn-footer'))) {
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
