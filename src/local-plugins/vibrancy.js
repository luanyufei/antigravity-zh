'use strict';

/**
 * macOS native Vibrancy (毛玻璃) plugin for Antigravity - Insiders.
 * Installed to ~/.config/antigravity-insiders-i18n/local-plugins/
 * and loaded automatically by main-hook.js.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const electron = require('electron');

module.exports = function initVibrancyPlugin(api) {
  if (process.platform !== 'darwin') return;

  const PLUGIN_DIR = path.join(api.I18N_DIR, 'local-plugins');
  const ASSETS_DIR = path.join(PLUGIN_DIR, 'vibrancy-assets');
  const VARIANT = (api.appInfo && api.appInfo.variant) || (/insider/i.test(process.execPath || '') ? 'insiders' : 'stable');
  const CFG_FILENAME = `vibrancy-${VARIANT}.json`;
  const CFG_PATH = path.join(PLUGIN_DIR, CFG_FILENAME);
  const LEGACY_CFG_PATH = path.join(PLUGIN_DIR, 'vibrancy.json');
  const STYLE_MODULE_PATH = path.join(ASSETS_DIR, 'style.js');
  const DEFAULT_CFG = { enabled: true, material: 'fullscreen-ui', opacity: 0.55 };
  const MATERIALS = [
    { id: 'under-window', zh: '标准磨砂 (under-window)', en: 'Standard (under-window)' },
    { id: 'sidebar', zh: '侧栏磨砂 (sidebar)', en: 'Sidebar (sidebar)' },
    { id: 'hud', zh: '深邃磨砂 (hud)', en: 'HUD Dark (hud)' },
    { id: 'fullscreen-ui', zh: '全屏磨砂 (fullscreen-ui)', en: 'Fullscreen UI (fullscreen-ui)' },
  ];
  const OPACITIES = [
    { value: 0.35, zh: '通透 (35%)', en: 'Airy (35%)' },
    { value: 0.55, zh: '均衡 (55%)', en: 'Balanced (55%)' },
    { value: 0.75, zh: '轻磨砂 (75%)', en: 'Subtle (75%)' },
  ];

  function loadCfg() {
    try {
      const srcPath = fs.existsSync(CFG_PATH)
        ? CFG_PATH
        : (VARIANT === 'insiders' && fs.existsSync(LEGACY_CFG_PATH) ? LEGACY_CFG_PATH : null);
      if (!srcPath) return { ...DEFAULT_CFG };
      const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      return {
        enabled: raw.enabled !== false,
        material: typeof raw.material === 'string' ? raw.material : DEFAULT_CFG.material,
        opacity: typeof raw.opacity === 'number' && raw.opacity >= 0.1 && raw.opacity <= 0.95 ? raw.opacity : DEFAULT_CFG.opacity,
      };
    } catch (_e) {
      return { ...DEFAULT_CFG };
    }
  }

  function saveCfg(next) {
    try {
      const tmp = `${CFG_PATH}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, CFG_PATH);
    } catch (err) {
      api.log('[vibrancy] saveCfg error', err);
    }
  }

  function buildRendererApplyCode(state) {
    try {
      const resolved = require.resolve(STYLE_MODULE_PATH);
      delete require.cache[resolved];
      const builder = require(resolved);
      if (typeof builder === 'function') return builder(state);
    } catch (err) {
      api.log('[vibrancy] Failed to load vibrancy-style.js', err);
    }
    return '';
  }

  let cfg = loadCfg();
  const origBgMap = new WeakMap();
  const trackedWindows = new Set();
  const trackedViews = new Set();

  // Hook BaseWindow.prototype.setBackgroundColor so we remember original opaque color
  // and keep it transparent while vibrancy is active.
  const BaseWinProto = electron.BaseWindow && electron.BaseWindow.prototype;
  const origWinSetBg = BaseWinProto && BaseWinProto.setBackgroundColor;
  if (origWinSetBg && !BaseWinProto.__agyVibrancyWrapped) {
    BaseWinProto.setBackgroundColor = function patchedWinSetBg(color) {
      trackedWindows.add(this);
      if (typeof color === 'string' && color.toLowerCase() !== '#00000000') {
        origBgMap.set(this, color);
      }
      if (cfg.enabled) {
        try {
          if (typeof this.setVibrancy === 'function') this.setVibrancy(cfg.material);
        } catch (_e) {}
        return origWinSetBg.call(this, '#00000000');
      }
      return origWinSetBg.call(this, color);
    };
    BaseWinProto.__agyVibrancyWrapped = true;
  }

  // Hook WebContentsView.prototype.setBackgroundColor for hubWcv transparency
  const WcvProto = electron.WebContentsView && electron.WebContentsView.prototype;
  const origWcvSetBg = WcvProto && WcvProto.setBackgroundColor;
  if (origWcvSetBg && !WcvProto.__agyVibrancyWrapped) {
    WcvProto.setBackgroundColor = function patchedWcvSetBg(color) {
      trackedViews.add(this);
      if (typeof color === 'string' && color.toLowerCase() !== '#00000000') {
        origBgMap.set(this, color);
      }
      const url = this.webContents && !this.webContents.isDestroyed?.() ? (this.webContents.getURL?.() || '') : '';
      const isHubOrBooting = url === '' || url === 'about:blank' || api.isHubUrl(url);
      if (cfg.enabled && isHubOrBooting) {
        return origWcvSetBg.call(this, '#00000000');
      }
      return origWcvSetBg.call(this, color);
    };
    WcvProto.__agyVibrancyWrapped = true;
  }

  // CRITICAL (Electron macOS NativeWindowMac):
  // Chromium only creates a translucent compositor (`WindowOpacity::kTranslucent`)
  // when `vibrancy` is passed to the BaseWindow/BrowserWindow constructor.
  function wrapWindowCtor(RealCtor, label, shouldPatchOpts) {
    if (typeof RealCtor !== 'function') return RealCtor;
    return new Proxy(RealCtor, {
      construct(target, args) {
        const rawOpts = args[0] && typeof args[0] === 'object' ? args[0] : null;
        if (!rawOpts || !shouldPatchOpts(rawOpts)) {
          return Reflect.construct(target, args, target);
        }
        const origBg = typeof rawOpts.backgroundColor === 'string' ? rawOpts.backgroundColor : undefined;
        const nextOpts = {
          ...rawOpts,
          vibrancy: rawOpts.vibrancy || cfg.material || 'fullscreen-ui',
          visualEffectState: rawOpts.visualEffectState || 'active',
          backgroundColor: cfg.enabled ? '#00000000' : (origBg || '#00000000'),
        };
        const win = Reflect.construct(target, [nextOpts, ...args.slice(1)], target);
        trackedWindows.add(win);
        if (origBg && origBg.toLowerCase() !== '#00000000') {
          origBgMap.set(win, origBg);
        }
        if (!cfg.enabled) {
          try {
            if (typeof win.setVibrancy === 'function') win.setVibrancy(null);
            if (origBg && origWinSetBg) origWinSetBg.call(win, origBg);
          } catch (_e) {}
        }
        api.log(`[vibrancy] Intercepted new ${label} (kTranslucent=true, enabled=${cfg.enabled}, material=${nextOpts.vibrancy})`);
        return win;
      },
    });
  }

  if (!Module._load.__agyVibrancyElectronWrapped) {
    const RealBaseWindow = electron.BaseWindow;
    const RealBrowserWindow = electron.BrowserWindow;
    const PatchedBaseWindow = wrapWindowCtor(RealBaseWindow, 'BaseWindow', () => true);
    const PatchedBrowserWindow = wrapWindowCtor(
      RealBrowserWindow,
      'BrowserWindow',
      (opts) => opts.titleBarStyle === 'hidden' && !(opts.webPreferences && opts.webPreferences.offscreen)
    );

    const proxiedElectron = new Proxy(electron, {
      get(target, prop) {
        if (prop === 'BaseWindow') return PatchedBaseWindow;
        if (prop === 'BrowserWindow') return PatchedBrowserWindow;
        return Reflect.get(target, prop, target);
      },
    });

    const origModuleLoad = Module._load;
    const patchedLoad = function agyVibrancyModuleLoad(request, parent, isMain) {
      if (request === 'electron') {
        return proxiedElectron;
      }
      return origModuleLoad.apply(this, arguments);
    };
    patchedLoad.__agyVibrancyElectronWrapped = true;
    Module._load = patchedLoad;
  }

  function isCurtainDataUrl(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('data:text/html')) return false;
    return !url.includes('background:transparent') && (url.includes('background:') || url.includes('background%3A') || url.includes('height:100%'));
  }

  function applyViewVibrancy(view) {
    if (!view || !view.webContents || view.webContents.isDestroyed?.()) {
      trackedViews.delete(view);
      return;
    }
    const url = view.webContents.getURL?.() || '';
    // Stable Antigravity (three-layer stack OFF) uses an opaque data:text/html curtainView behind hubWcv.
    // Hide it while vibrancy is enabled and restore visibility when vibrancy is turned off.
    if (isCurtainDataUrl(url)) {
      try {
        if (typeof view.setVisible === 'function') view.setVisible(!cfg.enabled);
        if (cfg.enabled && origWcvSetBg) origWcvSetBg.call(view, '#00000000');
      } catch (_e) {}
      return;
    }
    if (!api.isHubUrl(url)) return;
    try {
      if (cfg.enabled) {
        if (origWcvSetBg) origWcvSetBg.call(view, '#00000000');
      } else {
        const orig = origBgMap.get(view);
        if (origWcvSetBg && orig) origWcvSetBg.call(view, orig);
      }
    } catch (_e) {}
  }

  function applyWindowVibrancy(win) {
    if (!win || win.isDestroyed?.()) {
      trackedWindows.delete(win);
      return;
    }
    trackedWindows.add(win);
    try {
      if (cfg.enabled) {
        if (typeof win.setVibrancy === 'function') win.setVibrancy(cfg.material);
        if (origWinSetBg) origWinSetBg.call(win, '#00000000');
      } else {
        if (typeof win.setVibrancy === 'function') win.setVibrancy(null);
        const orig = origBgMap.get(win);
        if (origWinSetBg && orig) origWinSetBg.call(win, orig);
      }
      if (typeof win.invalidateShadow === 'function') win.invalidateShadow();
      const children = win.contentView?.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child && child.webContents) {
            trackedViews.add(child);
            applyViewVibrancy(child);
          }
        }
      }
    } catch (err) {
      api.log('[vibrancy] applyWindowVibrancy error', err);
    }
  }

  function applyRendererVibrancy(wc) {
    if (!wc || wc.isDestroyed?.()) return;
    const code = buildRendererApplyCode(cfg);
    if (code) wc.executeJavaScript(code, true).catch(() => {});
  }

  function applyAll() {
    if (electron.BaseWindow && typeof electron.BaseWindow.getAllWindows === 'function') {
      for (const w of electron.BaseWindow.getAllWindows()) applyWindowVibrancy(w);
    }
    for (const w of Array.from(trackedWindows)) applyWindowVibrancy(w);
    for (const v of Array.from(trackedViews)) applyViewVibrancy(v);
    for (const wc of api.getActiveHubContents()) applyRendererVibrancy(wc);
    api.syncAllNativeMenus();
  }

  const changeListeners = new Set();
  function notifyChange() {
    const snap = { ...cfg };
    for (const fn of changeListeners) {
      try { fn(snap); } catch (_e) {}
    }
  }

  function updateCfg(patch) {
    cfg = { ...cfg, ...patch };
    saveCfg(cfg);
    applyAll();
    notifyChange();
    api.log(`[vibrancy] Updated: enabled=${cfg.enabled}, material=${cfg.material}, opacity=${cfg.opacity}`);
  }

  api.onHubWebContentsReady((wc) => {
    const refresh = () => {
      if (electron.BaseWindow && typeof electron.BaseWindow.getAllWindows === 'function') {
        for (const w of electron.BaseWindow.getAllWindows()) applyWindowVibrancy(w);
      }
      for (const v of Array.from(trackedViews)) applyViewVibrancy(v);
      applyRendererVibrancy(wc);
    };
    refresh();
    // Re-apply once after initial boot/update overlay settles so NSVisualEffectView never stalls
    setTimeout(() => {
      if (!wc.isDestroyed?.()) refresh();
    }, 800);
  });

  electron.app.on('browser-window-created', (_ev, win) => {
    applyWindowVibrancy(win);
  });

  // Hide Stable's opaque curtainView immediately once its data:text/html document loads
  electron.app.on('web-contents-created', (_ev, contents) => {
    if (!contents) return;
    const checkCurtain = () => {
      try {
        if (contents.isDestroyed?.()) return;
        const u = contents.getURL?.() || '';
        if (isCurtainDataUrl(u) && electron.BaseWindow && typeof electron.BaseWindow.getAllWindows === 'function') {
          for (const w of electron.BaseWindow.getAllWindows()) applyWindowVibrancy(w);
        }
      } catch (_e) {}
    };
    contents.on('did-navigate', checkCurtain);
    contents.on('dom-ready', checkCurtain);
  });

  // Vibrancy submenu in the macOS App menu right below Language.
  api.registerMenuEnhancer((appMenu, i18nCfg) => {
    const appSubmenu = appMenu?.items?.[0]?.submenu;
    if (!appSubmenu || !Array.isArray(appSubmenu.items)) return;
    const isZh = (i18nCfg?.locale || 'zh-CN') === 'zh-CN';
    const subId = 'agy-i18n-vibrancy-submenu';

    const existing = appSubmenu.items.find((i) => i.id === subId);
    if (existing) {
      existing.label = isZh ? '毛玻璃效果 / Vibrancy' : 'Vibrancy / 毛玻璃效果';
      const sub = existing.submenu;
      if (sub && Array.isArray(sub.items)) {
        const enItem = sub.items.find((i) => i.id === 'agy-i18n-vib-toggle');
        if (enItem) {
          enItem.label = isZh ? '开启毛玻璃效果' : 'Enable Vibrancy';
          enItem.checked = cfg.enabled;
        }
        for (const m of MATERIALS) {
          const mi = sub.items.find((i) => i.id === `agy-i18n-vib-mat-${m.id}`);
          if (mi) {
            mi.label = isZh ? m.zh : m.en;
            mi.checked = cfg.material === m.id;
          }
        }
        for (const o of OPACITIES) {
          const oi = sub.items.find((i) => i.id === `agy-i18n-vib-op-${Math.round(o.value * 100)}`);
          if (oi) {
            oi.label = isZh ? o.zh : o.en;
            oi.checked = Math.abs(cfg.opacity - o.value) < 0.05;
          }
        }
      }
      return;
    }

    const template = [
      {
        id: 'agy-i18n-vib-toggle',
        label: isZh ? '开启毛玻璃效果' : 'Enable Vibrancy',
        type: 'checkbox',
        checked: cfg.enabled,
        accelerator: 'CommandOrControl+Alt+T',
        click: () => updateCfg({ enabled: !cfg.enabled }),
      },
      { type: 'separator' },
      ...MATERIALS.map((m) => ({
        id: `agy-i18n-vib-mat-${m.id}`,
        label: isZh ? m.zh : m.en,
        type: 'checkbox',
        checked: cfg.material === m.id,
        click: () => updateCfg({ enabled: true, material: m.id }),
      })),
      { type: 'separator' },
      ...OPACITIES.map((o) => ({
        id: `agy-i18n-vib-op-${Math.round(o.value * 100)}`,
        label: isZh ? o.zh : o.en,
        type: 'checkbox',
        checked: Math.abs(cfg.opacity - o.value) < 0.05,
        click: () => updateCfg({ enabled: true, opacity: o.value }),
      })),
    ];

    const langIdx = appSubmenu.items.findIndex((i) => i.id === 'agy-i18n-lang-submenu');
    const insertAt = langIdx !== -1 ? langIdx + 1 : Math.min(3, appSubmenu.items.length);
    appSubmenu.insert(insertAt, new electron.MenuItem({
      id: subId,
      label: isZh ? '毛玻璃效果 / Vibrancy' : 'Vibrancy / 毛玻璃效果',
      submenu: electron.Menu.buildFromTemplate(template),
    }));
  });

  // Watch this app's own vibrancy-<variant>.json and shared vibrancy-assets/style.js
  let reloadTimer = null;
  function scheduleReload(label) {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      cfg = loadCfg();
      applyAll();
      notifyChange();
      api.log(`[vibrancy] Hot-reloaded ${label} (enabled=${cfg.enabled}, material=${cfg.material}, opacity=${cfg.opacity})`);
    }, 100);
  }
  try {
    fs.watch(PLUGIN_DIR, { persistent: false }, (_eventType, filename) => {
      if (filename === CFG_FILENAME) scheduleReload(CFG_FILENAME);
    });
  } catch (_e) {}
  try {
    if (fs.existsSync(ASSETS_DIR)) {
      fs.watch(ASSETS_DIR, { persistent: false }, (_eventType, filename) => {
        if (!filename || filename === 'style.js') scheduleReload('vibrancy-assets/style.js');
      });
    }
  } catch (_e) {}

  api.vibrancy = {
    getConfig: () => ({ ...cfg }),
    updateConfig: (patch) => {
      if (!patch || typeof patch !== 'object') return { ...cfg };
      const next = {};
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (typeof patch.material === 'string' && MATERIALS.some((m) => m.id === patch.material)) {
        next.material = patch.material;
      }
      if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) {
        next.opacity = Math.min(0.95, Math.max(0.15, Math.round(patch.opacity * 100) / 100));
      }
      updateCfg(next);
      return { ...cfg };
    },
    onChange: (fn) => {
      if (typeof fn !== 'function') return () => {};
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    materials: MATERIALS,
    opacities: OPACITIES,
  };

  api.log(`[vibrancy] Plugin initialized (enabled=${cfg.enabled}, material=${cfg.material}, opacity=${cfg.opacity})`);
};
