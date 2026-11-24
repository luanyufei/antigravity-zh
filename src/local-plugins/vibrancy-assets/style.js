'use strict';

/**
 * Hot-reloadable CSS generator for the local macOS Vibrancy plugin.
 * Editing this file immediately refreshes the live Antigravity - Insiders window
 * without restarting the app.
 */

module.exports = function buildRendererApplyCode(state) {
  const payload = JSON.stringify(state);
  return `(() => {
    const cfg = ${payload};
    const STYLE_ID = 'agy-vibrancy-style';

    function detectDark() {
      const html = document.documentElement;
      const body = document.body;
      const agyTheme = (body && body.getAttribute('data-agy-theme') || '').toLowerCase();
      if (agyTheme) {
        if (agyTheme.includes('light') || agyTheme.includes('snow') || agyTheme.includes('day')) return false;
        if (agyTheme.includes('dark') || agyTheme.includes('onyx') || agyTheme.includes('night')) return true;
      }
      if (body) {
        if (body.classList.contains('dark')) return true;
        if (body.classList.contains('light')) return false;
      }
      if (html) {
        if (html.classList.contains('dark') || html.classList.contains('vscode-dark')) return true;
        if (html.classList.contains('light') || html.classList.contains('vscode-light')) return false;
        const cs = (html.style && html.style.colorScheme) || '';
        if (cs.includes('dark')) return true;
        if (cs.includes('light')) return false;
      }
      try {
        const fg = getComputedStyle(body || html).color || '';
        const m = fg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (m) {
          const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
          return lum > 140;
        }
      } catch (_e) {}
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function renderCss() {
      let el = document.getElementById(STYLE_ID);
      if (!cfg.enabled) {
        if (el) el.remove();
        return;
      }

      const dark = detectDark();
      const op = cfg.opacity; // 0.35 (Airy), 0.55 (Balanced), 0.75 (Subtle)

      // Cohesive single-layer glass hierarchy (no double-stacked opaque-ish slabs):
      // - Outer shell & sidebar share one airy base tint
      // - Main content inset card has a gentle, unified glass tint + 1px specular hairline
      // - Sidebar rows & sticky headers stay transparent (no dark zebra stripes!)
      const shellOp = dark
        ? Math.min(0.62, Math.max(0.18, +(op * 0.62).toFixed(2)))
        : Math.min(0.55, Math.max(0.14, +(op * 0.52).toFixed(2)));
      const contentOp = dark
        ? Math.min(0.52, Math.max(0.14, +(op * 0.42).toFixed(2)))
        : Math.min(0.62, Math.max(0.18, +(op * 0.55).toFixed(2)));
      const cardOp = dark
        ? Math.min(0.68, Math.max(0.28, +(op * 0.68).toFixed(2)))
        : Math.min(0.76, Math.max(0.42, +(op * 0.80).toFixed(2)));
      const composerOp = dark
        ? Math.min(0.72, Math.max(0.38, +(op * 0.78).toFixed(2)))
        : Math.min(0.82, Math.max(0.50, +(op * 0.88).toFixed(2)));
      const popOp = dark
        ? Math.min(0.86, +(op + 0.28).toFixed(2))
        : Math.min(0.90, +(op + 0.28).toFixed(2));

      const shellRgb = dark ? '16, 17, 22' : '242, 244, 249';
      const contentRgb = dark ? '20, 21, 28' : '255, 255, 255';
      const cardRgb = dark ? '28, 30, 39' : '255, 255, 255';
      const popRgb = dark ? '24, 26, 35' : '252, 253, 255';

      // Crisp luminous hover/selection & specular borders for native macOS Liquid Glass feel
      const hoverTint = dark ? 'rgba(255, 255, 255, 0.065)' : 'rgba(15, 20, 35, 0.05)';
      const activePill = dark ? 'rgba(255, 255, 255, 0.115)' : 'rgba(255, 255, 255, 0.72)';
      const raisedPill = dark ? 'rgba(255, 255, 255, 0.085)' : 'rgba(255, 255, 255, 0.66)';
      const raisedHover = dark ? 'rgba(255, 255, 255, 0.13)' : 'rgba(255, 255, 255, 0.82)';
      const edgeHairline = dark ? 'rgba(255, 255, 255, 0.095)' : 'rgba(15, 20, 35, 0.09)';
      const innerHighlight = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.85)';
      const softBorder = dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 20, 35, 0.08)';
      const wellTint = dark ? 'rgba(0, 0, 0, 0.18)' : 'rgba(15, 20, 35, 0.055)';
      const keyTint = dark ? 'rgba(255, 255, 255, 0.13)' : 'rgba(255, 255, 255, 0.80)';
      const codeBg = dark ? 'rgba(10, 12, 18, 0.42)' : 'rgba(20, 24, 38, 0.06)';

      // Boost text legibility over translucent glass (especially dark mode over bright wallpapers)
      const fgColor = dark ? 'rgba(244, 246, 252, 0.96)' : 'rgba(18, 20, 28, 0.94)';
      const mutedFg = dark ? 'rgba(220, 225, 240, 0.66)' : 'rgba(30, 34, 48, 0.62)';
      const secFg = dark ? 'rgba(232, 236, 246, 0.82)' : 'rgba(24, 28, 40, 0.78)';
      const placeholderFg = dark ? 'rgba(210, 216, 232, 0.48)' : 'rgba(30, 34, 48, 0.45)';

      const css = \`
        /* 1. Transparent document root so native macOS NSVisualEffectView shines through */
        html, body, #root, .theme-standalone {
          background: transparent !important;
          background-color: transparent !important;
        }

        /* 2. Unified design tokens across :root, body[data-agy-theme], and shell containers */
        :root, html, body, body[data-agy-theme], body[data-agy-theme].dark, body[data-agy-theme].light,
        .dark, .light, .dark-theme, .vscode-dark, .vscode-light,
        .agy-shell, .agy-inset-shell, .agy-sheet {
          --shell: rgba(\${shellRgb}, \${shellOp}) !important;
          --shell-canvas: transparent !important;
          --background: rgba(\${contentRgb}, \${contentOp}) !important;
          --color-background: rgba(\${contentRgb}, \${contentOp}) !important;

          /* Keep sidebar surfaces transparent so sticky headers & expanded project rows NEVER zebra-stripe */
          --sidebar: transparent !important;
          --color-sidebar: transparent !important;
          --sidebar-muted: \${hoverTint} !important;
          --color-sidebar-muted: \${hoverTint} !important;
          --sidebar-secondary: \${raisedPill} !important;
          --color-sidebar-secondary: \${raisedPill} !important;

          --card: rgba(\${cardRgb}, \${cardOp}) !important;
          --color-card: rgba(\${cardRgb}, \${cardOp}) !important;
          --glass: rgba(\${cardRgb}, \${cardOp}) !important;
          --muted: \${hoverTint} !important;
          --color-muted: \${hoverTint} !important;
          --secondary: \${raisedPill} !important;
          --border: \${softBorder} !important;
          --card-edge: \${edgeHairline} !important;
          --card-border: \${softBorder} !important;
          --glass-border: \${edgeHairline} !important;
          --glass-highlight: \${innerHighlight} !important;

          /* Override hardcoded Onyx dark/light hex tokens so composer & sidebar pills match glass */
          --onyx-frame: transparent !important;
          --onyx-raised: rgba(\${cardRgb}, \${composerOp}) !important;
          --onyx-selected: \${activePill} !important;
          --onyx-well: \${wellTint} !important;
          --onyx-key: \${keyTint} !important;

          /* Enhanced readability over frosted glass */
          --foreground: \${fgColor} !important;
          --muted-foreground: \${mutedFg} !important;
          --color-muted-foreground: \${mutedFg} !important;
          --secondary-foreground: \${secFg} !important;
          --placeholder: \${placeholderFg} !important;
        }

        /* 3. Cohesive shell & inset content card (no double-stacked backgrounds!) */
        body[data-agy-theme] .agy-shell {
          background-color: var(--shell) !important;
        }
        body[data-agy-theme] .agy-sheet,
        body[data-agy-theme] .agy-sheet[data-sheet-inset] {
          background-color: transparent !important;
          background-image: none !important;
        }
        .agy-sheet[data-sheet-inset] [data-main-content-body],
        .agy-inset-shell [data-side-panel-body] {
          background-color: rgba(\${contentRgb}, \${contentOp}) !important;
          box-shadow: inset 0 0 0 1px \${edgeHairline}, 0 4px 24px -8px rgba(0, 0, 0, \${dark ? 0.28 : 0.08}) !important;
        }
        /* Prevent tiling-pane linear-gradient from double-painting --background inside [data-main-content-body] */
        [data-split-panes] .agy-sheet[data-sheet-inset] [data-tiling-pane],
        [data-split-panes] .agy-sheet[data-sheet-inset] :is([data-tiling-pane], [data-tiling-pane] > [data-pane-id]):not([data-has-browser-hole='true']) {
          background-image: none !important;
          background-color: transparent !important;
        }
        [data-split-panes] .agy-sheet[data-sheet-inset] [data-tiling-pane]::after {
          box-shadow: inset 0 0 0 0.5px \${edgeHairline} !important;
        }

        /* 4. Sidebar polish: remove dark project stripes, keep sticky headers clean, make pills glassy */
        body[data-agy-theme] [aria-expanded="true"].aria-expanded\\\\:bg-sidebar-muted {
          background-color: transparent !important;
        }
        body[data-agy-theme] [aria-expanded="true"].aria-expanded\\\\:bg-sidebar-muted:hover {
          background-color: \${hoverTint} !important;
        }
        body[data-agy-theme] .agy-sidebar-raised,
        body[data-agy-theme].dark .agy-sidebar-raised {
          background-color: \${raisedPill} !important;
          box-shadow: inset 0 1px 0 \${innerHighlight}, inset 0 0 0 1px \${edgeHairline} !important;
        }
        body[data-agy-theme] .agy-sidebar-raised:hover,
        body[data-agy-theme].dark .agy-sidebar-raised:hover {
          background-color: \${raisedHover} !important;
        }
        body[data-agy-theme] .agy-sidebar-row[data-selected="true"],
        body[data-agy-theme].dark .agy-sidebar-row[data-selected="true"] {
          background-color: \${activePill} !important;
          --row-bg: transparent !important;
          box-shadow: inset 0 1px 0 \${innerHighlight}, inset 0 0 0 1px \${edgeHairline} !important;
        }
        body[data-agy-theme] .agy-sidebar-row .agy-row-actions,
        body[data-agy-theme] .agy-sidebar-row .agy-row-actions::before,
        body[data-agy-theme] .agy-sidebar-row .agy-row-shortcut-badge::before {
          background: transparent !important;
        }

        /* 5. Remove the awkward 48px dark gradient fade strip right above the bottom composer */
        div.pointer-events-none[style*="linear-gradient(to top, var(--background)"],
        div.pointer-events-none[style*="linear-gradient(to bottom, var(--background)"],
        div.pointer-events-none[style*="linear-gradient(to left, var(--background)"],
        div.pointer-events-none[style*="linear-gradient(to right, transparent"] {
          background: transparent !important;
          background-image: none !important;
        }

        /* 6. Floating frosted-glass Composer (bottom input box) & User Message Bubbles */
        body[data-agy-theme] .surface-composer,
        body[data-agy-theme].dark .surface-composer {
          background-color: transparent !important;
          box-shadow: none !important;
        }
        body[data-agy-theme] .surface-composer > .surface-composer-card,
        body[data-agy-theme].dark .surface-composer > .surface-composer-card {
          background: rgba(\${cardRgb}, \${composerOp}) !important;
          backdrop-filter: blur(24px) saturate(160%) !important;
          -webkit-backdrop-filter: blur(24px) saturate(160%) !important;
          box-shadow: inset 0 1px 0 \${innerHighlight}, 0 0 0 1px \${edgeHairline}, 0 12px 32px -10px rgba(0, 0, 0, \${dark ? 0.42 : 0.14}) !important;
        }
        body[data-agy-theme] .surface-composer:focus-within > .surface-composer-card,
        body[data-agy-theme].dark .surface-composer:focus-within > .surface-composer-card {
          box-shadow: inset 0 1px 0 \${innerHighlight}, 0 0 0 1px \${dark ? 'rgba(255,255,255,0.18)' : 'rgba(15,20,35,0.16)'}, 0 14px 36px -10px rgba(0, 0, 0, \${dark ? 0.5 : 0.18}) !important;
        }
        body[data-agy-theme] .agy-user-bubble {
          background-color: rgba(\${cardRgb}, \${cardOp}) !important;
          backdrop-filter: blur(18px) saturate(140%) !important;
          -webkit-backdrop-filter: blur(18px) saturate(140%) !important;
          box-shadow: inset 0 1px 0 \${innerHighlight}, 0 0 0 1px \${edgeHairline}, 0 6px 20px -8px rgba(0, 0, 0, \${dark ? 0.35 : 0.10}) !important;
        }

        /* 7. Inline code & pre blocks blend softly with glass instead of muddy solid gray */
        :not(pre) > code {
          background-color: \${codeBg} !important;
        }
        pre {
          background-color: \${codeBg} !important;
          border: 1px solid \${softBorder} !important;
        }

        /* 7b. Keep inverted-surface icons/text (e.g. voice mode & send buttons using bg-foreground + text-background) 100% crisp & solid */
        .text-background {
          color: \${dark ? '#111218' : '#ffffff'} !important;
        }
        .group\\\\/option:hover .group-hover\\\\/option\\\\:text-background,
        .group\\\\/option:focus-within .group-focus-within\\\\/option\\\\:text-background,
        .group\\\\/option:focus-visible .group-focus-visible\\\\/option\\\\:text-background {
          color: \${dark ? '#111218' : '#ffffff'} !important;
        }

        /* 8. Popups, dropdown menus & command palette: crisp readable frosted glass */
        [role="menu"], [role="listbox"],
        [data-testid="context-menu-popup"], [data-testid="context-menu-submenu-popup"],
        body[data-agy-theme] .surface-glass,
        body[data-agy-theme] .agy-fastpick.surface-glass,
        body[data-agy-theme] .quick-input-widget.surface-glass {
          background: rgba(\${popRgb}, \${popOp}) !important;
          backdrop-filter: blur(26px) saturate(160%) !important;
          -webkit-backdrop-filter: blur(26px) saturate(160%) !important;
          box-shadow: inset 0 1px 0 \${innerHighlight}, 0 0 0 1px \${edgeHairline}, 0 16px 40px -10px rgba(0, 0, 0, \${dark ? 0.5 : 0.18}) !important;
        }

        /* 9. Settings modal & modal dialogs: 100% solid opaque so background chat never bleeds through */
        .settings-modal-container,
        .agy-dialog,
        [role="dialog"][aria-modal="true"],
        [role="dialog"][aria-label="Settings"] {
          --background: \${dark ? '#14151a' : '#fafafa'} !important;
          --color-background: \${dark ? '#14151a' : '#fafafa'} !important;
          --shell: \${dark ? '#101116' : '#f3f4f6'} !important;
          --shell-canvas: \${dark ? '#101116' : '#f3f4f6'} !important;
          --sidebar: \${dark ? '#101116' : '#f3f4f6'} !important;
          --color-sidebar: \${dark ? '#101116' : '#f3f4f6'} !important;
          --sidebar-muted: \${dark ? '#1e2028' : '#e9ebef'} !important;
          --color-sidebar-muted: \${dark ? '#1e2028' : '#e9ebef'} !important;
          --sidebar-secondary: \${dark ? '#23252f' : '#e5e7eb'} !important;
          --color-sidebar-secondary: \${dark ? '#23252f' : '#e5e7eb'} !important;
          --card: \${dark ? '#1b1d24' : '#ffffff'} !important;
          --color-card: \${dark ? '#1b1d24' : '#ffffff'} !important;
          --glass: \${dark ? '#1b1d24' : '#ffffff'} !important;
          --muted: \${dark ? '#1c1e26' : '#f1f2f5'} !important;
          --color-muted: \${dark ? '#1c1e26' : '#f1f2f5'} !important;
          --secondary: \${dark ? '#252732' : '#eceef2'} !important;
          --border: \${dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 20, 35, 0.10)'} !important;
          --card-border: \${dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 20, 35, 0.10)'} !important;
          --card-edge: \${dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 20, 35, 0.10)'} !important;
          --onyx-well: \${dark ? '#101115' : '#eceef2'} !important;
          --onyx-key: \${dark ? '#24252a' : '#ffffff'} !important;
          --onyx-selected: \${dark ? '#23252f' : '#ffffff'} !important;
          --onyx-raised: \${dark ? '#1b1d24' : '#ffffff'} !important;
          --onyx-frame: \${dark ? '#14151a' : '#f5f6f8'} !important;
          background: \${dark ? '#14151a' : '#fafafa'} !important;
          background-color: \${dark ? '#14151a' : '#fafafa'} !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
        }
        /* Keep nested sidebar rows inside Settings solid & crisp */
        .settings-modal-container .agy-sidebar-row[data-selected="true"],
        .agy-dialog .agy-sidebar-row[data-selected="true"] {
          background-color: \${dark ? '#23252f' : '#ffffff'} !important;
        }
      \`;

      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
    }

    window.__AGY_VIBRANCY_CFG__ = cfg;
    renderCss();
    if (!window.__AGY_VIBRANCY_OBS__) {
      const obs = new MutationObserver(() => {
        if (window.__AGY_VIBRANCY_CFG__ && window.__AGY_VIBRANCY_CFG__.enabled) renderCss();
      });
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      if (document.body) {
        obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-agy-theme', 'data-theme'] });
      }
      window.__AGY_VIBRANCY_OBS__ = obs;
    }
  })();`;
};
