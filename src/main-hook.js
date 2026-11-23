'use strict';

if (global.__AGY_INSIDERS_I18N_MAIN_LOADED__) {
  module.exports = global.__AGY_INSIDERS_I18N_MAIN_LOADED__;
  return;
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFile } = require('child_process');
const electron = require('electron');

const I18N_DIR = path.join(os.homedir(), '.config', 'antigravity-insiders-i18n');
const CONFIG_PATH = path.join(I18N_DIR, 'config.json');
const DICT_PATH = path.join(I18N_DIR, 'dict', 'zh-CN.json');
const CUSTOM_DICT_PATH = path.join(I18N_DIR, 'dict', 'custom.json');
const RENDERER_SCRIPT_PATH = path.join(I18N_DIR, 'renderer-i18n.js');
const PATCHER_PATH = path.join(I18N_DIR, 'patcher.py');
const LOG_PATH = path.join(I18N_DIR, 'i18n.log');

function log(msg, err) {
  const line = `[${new Date().toISOString()}] [agy-i18n] ${msg}${err ? ' :: ' + (err.stack || err.message || String(err)) : ''}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (_e) {}
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function loadConfig() {
  const raw = readJsonSafe(CONFIG_PATH, {});
  return {
    locale: raw.locale === 'en' ? 'en' : 'zh-CN',
    showFloatingToggle: raw.showFloatingToggle !== false,
    autoPatchOnUpdate: raw.autoPatchOnUpdate !== false,
    shortcut: raw.shortcut || 'CmdOrCtrl+Option+L',
    signingIdentity: raw.signingIdentity || '',
    appPath: raw.appPath || '/Applications/Antigravity - Insiders.app',
  };
}

function saveConfig(next) {
  try {
    const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    log('Failed to save config.json', err);
  }
}

function loadMergedDict() {
  const base = readJsonSafe(DICT_PATH, { exact: {}, patterns: [], menus: {} });
  const custom = readJsonSafe(CUSTOM_DICT_PATH, { exact: {}, patterns: [], menus: {} });
  return {
    exact: { ...(base.exact || {}), ...(custom.exact || {}) },
    patterns: [...(custom.patterns || []), ...(base.patterns || [])],
    menus: { ...(base.menus || {}), ...(custom.menus || {}) },
  };
}

let config = loadConfig();
let mergedDict = loadMergedDict();
let cachedRendererScript = '';
try {
  cachedRendererScript = fs.readFileSync(RENDERER_SCRIPT_PATH, 'utf8');
} catch (err) {
  log('Failed to read renderer-i18n.js', err);
}

// ---------------------------------------------------------------------------
// Menu / Tray / Dock / Dialog Translation Helpers
// ---------------------------------------------------------------------------
const menuItemState = new WeakMap(); // MenuItem -> { orig, lastApplied }
const activeHubContents = new Set();
const activeHubFrames = new Set();
const menuEnhancers = [];
const hubReadyListeners = [];
let lastAppMenu = null;
let lastDockMenu = null;
let activeTray = null;
let lastTrayMenu = null;
let isSyncingMenus = false;
let updaterModuleRef = null;

function translateMenuLabel(origLabel) {
  if (!origLabel || typeof origLabel !== 'string') return origLabel;
  if (config.locale !== 'zh-CN') return origLabel;
  const menus = mergedDict.menus || {};
  if (menus[origLabel]) return menus[origLabel];
  const exact = mergedDict.exact || {};
  if (exact[origLabel]) return exact[origLabel];

  // Dynamic patterns (e.g. "2 agents running", "Open Antigravity - Insiders")
  const mAgents = /^(\d+)\s+agents?\s+running$/.exec(origLabel);
  if (mAgents) return `${mAgents[1]} 个 Agent 运行中`;
  const mOpen = /^Open (.+)$/.exec(origLabel);
  if (mOpen) return `打开 ${mOpen[1]}`;
  const mAbout = /^About (.+)$/.exec(origLabel);
  if (mAbout) return `关于 ${mAbout[1]}`;
  const mHide = /^Hide (.+)$/.exec(origLabel);
  if (mHide) return `隐藏 ${mHide[1]}`;
  const mQuit = /^Quit (.+)$/.exec(origLabel);
  if (mQuit) return `退出 ${mQuit[1]}`;
  return origLabel;
}

function registerUpdaterChineseAliases(updaterMod) {
  if (!updaterMod || !updaterMod.updateActions || !updaterMod.MenuUpdateStep) return;
  const steps = updaterMod.MenuUpdateStep;
  const actions = updaterMod.updateActions;
  const menus = mergedDict.menus || {};
  for (const key of Object.keys(steps)) {
    const enLabel = steps[key];
    const zhLabel = menus[enLabel];
    if (enLabel && zhLabel && actions[enLabel] !== undefined) {
      actions[zhLabel] = actions[enLabel];
    }
  }
}

function captureAndTranslateMenu(menu) {
  if (!menu || !Array.isArray(menu.items)) return;
  for (const item of menu.items) {
    if (!item || item.type === 'separator') continue;
    if (item.id && String(item.id).startsWith('agy-i18n-')) continue;

    let rec = menuItemState.get(item);
    if (!rec) {
      if (item.label) {
        rec = { orig: item.label, lastApplied: item.label };
        menuItemState.set(item, rec);
      }
    } else if (item.label && item.label !== rec.lastApplied && item.label !== rec.orig) {
      // Underlying app dynamically changed label (e.g., Check for Updates -> Restart to Update)
      rec.orig = item.label;
    }

    if (rec && rec.orig) {
      const target = translateMenuLabel(rec.orig);
      rec.lastApplied = target;
      if (item.label !== target) {
        try {
          item.label = target;
        } catch (_e) {}
      }
    }
    if (item.submenu) {
      captureAndTranslateMenu(item.submenu);
    }
  }
}

function buildLanguageSubmenu() {
  const isZh = config.locale === 'zh-CN';
  return new electron.MenuItem({
    id: 'agy-i18n-lang-submenu',
    label: isZh ? '语言 / Language' : 'Language / 语言',
    submenu: electron.Menu.buildFromTemplate([
      {
        id: 'agy-i18n-lang-zh',
        label: '简体中文',
        type: 'radio',
        checked: isZh,
        click: () => setLocale('zh-CN'),
      },
      {
        id: 'agy-i18n-lang-en',
        label: 'English',
        type: 'radio',
        checked: !isZh,
        click: () => setLocale('en'),
      },
      { type: 'separator' },
      {
        id: 'agy-i18n-lang-toggle',
        label: isZh ? '快速切换中英文' : 'Toggle Chinese / English',
        accelerator: 'CommandOrControl+Alt+L',
        click: () => toggleLocale(),
      },
      {
        id: 'agy-i18n-pill-toggle',
        label: isZh ? '显示悬浮语言切换按钮' : 'Show Floating Language Pill',
        type: 'checkbox',
        checked: config.showFloatingToggle !== false,
        click: (mi) => setShowFloatingToggle(Boolean(mi.checked)),
      },
    ]),
  });
}

function ensureAppMenuLanguageItem(menu) {
  if (!menu || !Array.isArray(menu.items) || menu.items.length === 0) return;
  const appSubmenu = menu.items[0]?.submenu;
  if (!appSubmenu || !Array.isArray(appSubmenu.items)) return;

  // Remove old i18n submenu if present so radio checkmarks & labels refresh cleanly
  const existingIdx = appSubmenu.items.findIndex((i) => i.id === 'agy-i18n-lang-submenu');
  if (existingIdx !== -1) {
    // Electron Menu doesn't have removeAt directly; update in place if possible, or rebuild submenu cleanly
    const existing = appSubmenu.items[existingIdx];
    const isZh = config.locale === 'zh-CN';
    existing.label = isZh ? '语言 / Language' : 'Language / 语言';
    const sub = existing.submenu;
    if (sub && Array.isArray(sub.items)) {
      const zhItem = sub.items.find((i) => i.id === 'agy-i18n-lang-zh');
      const enItem = sub.items.find((i) => i.id === 'agy-i18n-lang-en');
      const togItem = sub.items.find((i) => i.id === 'agy-i18n-lang-toggle');
      const pillItem = sub.items.find((i) => i.id === 'agy-i18n-pill-toggle');
      if (zhItem) zhItem.checked = isZh;
      if (enItem) enItem.checked = !isZh;
      if (togItem) togItem.label = isZh ? '快速切换中英文' : 'Toggle Chinese / English';
      if (pillItem) {
        pillItem.label = isZh ? '显示悬浮语言切换按钮' : 'Show Floating Language Pill';
        pillItem.checked = config.showFloatingToggle !== false;
      }
    }
    return;
  }

  const updIdx = appSubmenu.items.findIndex((i) => i.id === 'check-for-updates');
  const insertAt = updIdx !== -1 ? updIdx + 1 : Math.min(2, appSubmenu.items.length);
  appSubmenu.insert(insertAt, buildLanguageSubmenu());
}

function runMenuEnhancers(menu) {
  for (const fn of menuEnhancers) {
    try {
      fn(menu, config);
    } catch (err) {
      log('Menu enhancer error', err);
    }
  }
}

function ensureTrayLanguageItem(menu) {
  if (!menu || !Array.isArray(menu.items)) return;
  const isZh = config.locale === 'zh-CN';
  const existing = menu.items.find((i) => i.id === 'agy-i18n-tray-toggle');
  const targetLabel = isZh ? '切换语言：中文 → English' : 'Switch Language: EN → 简体中文';
  if (existing) {
    existing.label = targetLabel;
    return;
  }
  const quitIdx = menu.items.findIndex((i) => {
    const rec = menuItemState.get(i);
    return (rec && rec.orig === 'Quit') || i.label === 'Quit' || i.label === '退出';
  });
  const pos = quitIdx !== -1 ? quitIdx : menu.items.length;
  menu.insert(pos, new electron.MenuItem({
    id: 'agy-i18n-tray-toggle',
    label: targetLabel,
    click: () => toggleLocale(),
  }));
}

// Hook Electron Menu, Popup Context Menu, Tray, Dock, and Dialog APIs cleanly
const origSetApplicationMenu = electron.Menu.setApplicationMenu.bind(electron.Menu);
electron.Menu.setApplicationMenu = function patchedSetApplicationMenu(menu) {
  if (isSyncingMenus || !menu) {
    return origSetApplicationMenu(menu);
  }
  lastAppMenu = menu;
  isSyncingMenus = true;
  try {
    captureAndTranslateMenu(menu);
    ensureAppMenuLanguageItem(menu);
    runMenuEnhancers(menu);
    if (updaterModuleRef) registerUpdaterChineseAliases(updaterModuleRef);
    return origSetApplicationMenu(menu);
  } finally {
    isSyncingMenus = false;
  }
};

if (electron.Menu && electron.Menu.prototype && typeof electron.Menu.prototype.popup === 'function') {
  const origMenuPopup = electron.Menu.prototype.popup;
  electron.Menu.prototype.popup = function patchedMenuPopup(...args) {
    if (!isSyncingMenus) {
      isSyncingMenus = true;
      try {
        captureAndTranslateMenu(this);
      } catch (_e) {
      } finally {
        isSyncingMenus = false;
      }
    }
    return origMenuPopup.apply(this, args);
  };
}

if (electron.Tray && electron.Tray.prototype && electron.Tray.prototype.setContextMenu) {
  const origSetContextMenu = electron.Tray.prototype.setContextMenu;
  electron.Tray.prototype.setContextMenu = function patchedSetContextMenu(menu) {
    activeTray = this;
    lastTrayMenu = menu;
    if (!isSyncingMenus && menu) {
      isSyncingMenus = true;
      try {
        captureAndTranslateMenu(menu);
        ensureTrayLanguageItem(menu);
      } finally {
        isSyncingMenus = false;
      }
    }
    return origSetContextMenu.call(this, menu);
  };
}

if (electron.app && electron.app.dock && typeof electron.app.dock.setMenu === 'function') {
  const origDockSetMenu = electron.app.dock.setMenu.bind(electron.app.dock);
  electron.app.dock.setMenu = function patchedDockSetMenu(menu) {
    lastDockMenu = menu;
    if (!isSyncingMenus && menu) {
      isSyncingMenus = true;
      try {
        captureAndTranslateMenu(menu);
      } finally {
        isSyncingMenus = false;
      }
    }
    return origDockSetMenu(menu);
  };
}

function translateDialogOptions(opts) {
  if (!opts || typeof opts !== 'object' || config.locale !== 'zh-CN') return opts;
  const copy = { ...opts };
  if (typeof copy.title === 'string') copy.title = translateMenuLabel(copy.title);
  if (typeof copy.message === 'string') copy.message = translateMenuLabel(copy.message);
  if (typeof copy.detail === 'string') copy.detail = translateMenuLabel(copy.detail);
  if (Array.isArray(copy.buttons)) {
    copy.buttons = copy.buttons.map((b) => (typeof b === 'string' ? translateMenuLabel(b) : b));
  }
  return copy;
}

if (electron.dialog) {
  const origShowMessageBox = electron.dialog.showMessageBox.bind(electron.dialog);
  electron.dialog.showMessageBox = function patchedShowMessageBox(...args) {
    if (args.length === 1) return origShowMessageBox(translateDialogOptions(args[0]));
    if (args.length >= 2) return origShowMessageBox(args[0], translateDialogOptions(args[1]));
    return origShowMessageBox(...args);
  };
  const origShowMessageBoxSync = electron.dialog.showMessageBoxSync.bind(electron.dialog);
  electron.dialog.showMessageBoxSync = function patchedShowMessageBoxSync(...args) {
    if (args.length === 1) return origShowMessageBoxSync(translateDialogOptions(args[0]));
    if (args.length >= 2) return origShowMessageBoxSync(args[0], translateDialogOptions(args[1]));
    return origShowMessageBoxSync(...args);
  };
  const origShowOpenDialog = electron.dialog.showOpenDialog.bind(electron.dialog);
  electron.dialog.showOpenDialog = function patchedShowOpenDialog(...args) {
    if (args.length === 1) return origShowOpenDialog(translateDialogOptions(args[0]));
    if (args.length >= 2) return origShowOpenDialog(args[0], translateDialogOptions(args[1]));
    return origShowOpenDialog(...args);
  };
}

function syncAllNativeMenus() {
  if (isSyncingMenus) return;
  isSyncingMenus = true;
  try {
    const appMenu = electron.Menu.getApplicationMenu() || lastAppMenu;
    if (appMenu) {
      captureAndTranslateMenu(appMenu);
      ensureAppMenuLanguageItem(appMenu);
      runMenuEnhancers(appMenu);
      origSetApplicationMenu(appMenu);
    }
    if (activeTray && lastTrayMenu) {
      captureAndTranslateMenu(lastTrayMenu);
      ensureTrayLanguageItem(lastTrayMenu);
      activeTray.setContextMenu(lastTrayMenu);
    }
    if (electron.app.dock && lastDockMenu) {
      captureAndTranslateMenu(lastDockMenu);
      electron.app.dock.setMenu(lastDockMenu);
    }
  } catch (err) {
    log('syncAllNativeMenus error', err);
  } finally {
    isSyncingMenus = false;
  }
}

// ---------------------------------------------------------------------------
// State Sync & Renderer Injection (Hub-Only, Never Touches Guest Browser Tabs)
// ---------------------------------------------------------------------------
function getRendererStatePayload() {
  return {
    locale: config.locale,
    showFloatingToggle: config.showFloatingToggle !== false,
    dict: {
      exact: mergedDict.exact,
      patterns: mergedDict.patterns,
    },
  };
}

function broadcastStateToRenderers() {
  const payload = getRendererStatePayload();
  const payloadJson = JSON.stringify(payload);
  for (const wc of Array.from(activeHubContents)) {
    if (!wc || wc.isDestroyed()) {
      activeHubContents.delete(wc);
      continue;
    }
    try {
      wc.send('agy-i18n:state-changed', payload);
    } catch (_e) {}
  }
  for (const frame of Array.from(activeHubFrames)) {
    if (!frame || frame.isDestroyed()) {
      activeHubFrames.delete(frame);
      continue;
    }
    try {
      frame.executeJavaScript(`try{window.__AGY_I18N_ENGINE__&&window.__AGY_I18N_ENGINE__.applyState(${payloadJson});}catch(e){}`, true).catch(() => {});
    } catch (_e) {
      activeHubFrames.delete(frame);
    }
  }
}

function setLocale(nextLocale, persist = true) {
  const normalized = nextLocale === 'en' ? 'en' : 'zh-CN';
  if (config.locale === normalized) return config.locale;
  config.locale = normalized;
  if (persist) saveConfig(config);
  syncAllNativeMenus();
  broadcastStateToRenderers();
  log(`Switched locale to ${normalized}`);
  return normalized;
}

function toggleLocale() {
  return setLocale(config.locale === 'zh-CN' ? 'en' : 'zh-CN', true);
}

function setShowFloatingToggle(show, persist = true) {
  config.showFloatingToggle = Boolean(show);
  if (persist) saveConfig(config);
  syncAllNativeMenus();
  broadcastStateToRenderers();
  return config.showFloatingToggle;
}

function isHubUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (process.env.DEV_URL && url.startsWith(process.env.DEV_URL)) return true;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url);
}

function isLocalUiSubframeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('plugin://') || isHubUrl(url);
}

function injectIntoHubWebContents(wc) {
  if (!wc || wc.isDestroyed()) return;
  if (wc.getType && wc.getType() === 'webview') return;
  const url = wc.getURL ? wc.getURL() : '';
  if (!isHubUrl(url)) return;

  activeHubContents.add(wc);
  try {
    cachedRendererScript = fs.readFileSync(RENDERER_SCRIPT_PATH, 'utf8');
  } catch (err) {
    if (!cachedRendererScript) {
      log('Cannot read renderer-i18n.js for injection', err);
      return;
    }
  }

  const initPayload = JSON.stringify(getRendererStatePayload());
  const code = `${cachedRendererScript}\n;try{window.__AGY_I18N_ENGINE__&&window.__AGY_I18N_ENGINE__.init(${initPayload});}catch(e){}`;
  wc.executeJavaScript(code, true).catch((err) => {
    log(`executeJavaScript warning on ${url}`, err);
  });
  for (const fn of hubReadyListeners) {
    try {
      fn(wc);
    } catch (err) {
      log('Hub ready listener error', err);
    }
  }
}

function injectIntoLocalSubframe(frame) {
  if (!frame || frame.isDestroyed()) return;
  const url = frame.url || '';
  if (!isLocalUiSubframeUrl(url)) return;
  activeHubFrames.add(frame);
  try {
    cachedRendererScript = fs.readFileSync(RENDERER_SCRIPT_PATH, 'utf8');
  } catch (_e) {
    if (!cachedRendererScript) return;
  }
  const initPayload = JSON.stringify(getRendererStatePayload());
  const code = `${cachedRendererScript}\n;try{window.__AGY_I18N_ENGINE__&&window.__AGY_I18N_ENGINE__.init(${initPayload});}catch(e){}`;
  frame.executeJavaScript(code, true).catch(() => {});
}

// Register IPC handlers
if (electron.ipcMain) {
  electron.ipcMain.handle('agy-i18n:get-state', () => getRendererStatePayload());
  electron.ipcMain.handle('agy-i18n:set-locale', (_ev, next) => setLocale(next, true));
  electron.ipcMain.handle('agy-i18n:toggle-locale', () => toggleLocale());
  electron.ipcMain.handle('agy-i18n:set-floating-toggle', (_ev, show) => setShowFloatingToggle(show, true));
}

electron.app.on('web-contents-created', (_event, contents) => {
  if (!contents || (contents.getType && contents.getType() === 'webview')) return;
  contents.on('dom-ready', () => injectIntoHubWebContents(contents));
  contents.on('did-finish-load', () => injectIntoHubWebContents(contents));
  contents.on('did-frame-finish-load', (_ev, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    try {
      if (electron.webFrameMain && typeof electron.webFrameMain.fromId === 'function') {
        const frame = electron.webFrameMain.fromId(frameProcessId, frameRoutingId);
        if (frame) injectIntoLocalSubframe(frame);
      }
    } catch (_e) {}
  });
  contents.on('destroyed', () => activeHubContents.delete(contents));
});

// ---------------------------------------------------------------------------
// Hot-reload watcher for config.json (CLI `agy-i18n lang ...`) & custom.json
// ---------------------------------------------------------------------------
let reloadTimer = null;
function scheduleExternalReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const nextCfg = loadConfig();
    const nextDict = loadMergedDict();
    const changed =
      nextCfg.locale !== config.locale ||
      nextCfg.showFloatingToggle !== config.showFloatingToggle ||
      JSON.stringify(nextDict) !== JSON.stringify(mergedDict);
    config = nextCfg;
    mergedDict = nextDict;
    if (changed) {
      if (updaterModuleRef) registerUpdaterChineseAliases(updaterModuleRef);
      syncAllNativeMenus();
      broadcastStateToRenderers();
      log(`Hot-reloaded external config/dict (locale=${config.locale})`);
    }
  }, 150);
}

for (const watchTarget of [CONFIG_PATH, DICT_PATH, CUSTOM_DICT_PATH]) {
  try {
    fs.watch(watchTarget, { persistent: false }, () => scheduleExternalReload());
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Layer 1 Seamless Auto-Update Preservation: Hook MacUpdater & ./updater
// ---------------------------------------------------------------------------
function resolveRunningAppBundlePath() {
  // process.execPath is /Applications/Antigravity - Insiders.app/Contents/MacOS/Antigravity - Insiders
  const m = /^(.*\.app)\/Contents\/MacOS\//.exec(process.execPath);
  return m ? m[1] : config.appPath;
}

function patchUpdateZipAsync(inputZip, outputZip) {
  return new Promise((resolve, reject) => {
    const runningApp = resolveRunningAppBundlePath();
    const args = [
      PATCHER_PATH,
      'patch-zip',
      '--input', inputZip,
      '--output', outputZip,
      '--running-app', runningApp,
    ];
    execFile('/usr/bin/python3', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) log(`patch-zip stdout: ${stdout.trim()}`);
      if (stderr && stderr.trim()) log(`patch-zip stderr: ${stderr.trim()}`);
      if (err) return reject(err);
      resolve(outputZip);
    });
  });
}

function wrapElectronUpdater(mod) {
  if (!mod || mod.__agyI18nWrapped) return mod;
  try {
    const MacUpdater = mod.MacUpdater || (mod.autoUpdater && mod.autoUpdater.constructor);
    if (MacUpdater && MacUpdater.prototype && typeof MacUpdater.prototype.updateDownloaded === 'function' && !MacUpdater.prototype.__agyI18nWrapped) {
      const origUpdateDownloaded = MacUpdater.prototype.updateDownloaded;
      MacUpdater.prototype.updateDownloaded = async function patchedUpdateDownloaded(zipFileInfo, event) {
        if (process.platform === 'darwin' && config.autoPatchOnUpdate !== false && event && event.downloadedFile) {
          const patchedZip = `${event.downloadedFile}.agy-i18n.zip`;
          try {
            log(`[AutoUpdate] Intercepted downloaded update zip: ${event.downloadedFile}`);
            await patchUpdateZipAsync(event.downloadedFile, patchedZip);
            const st = fs.statSync(patchedZip);
            log(`[AutoUpdate] Pre-patched & signed update zip cleanly (${st.size} bytes), forwarding to Squirrel.Mac`);
            const nextZipFileInfo = {
              ...zipFileInfo,
              info: { ...(zipFileInfo && zipFileInfo.info ? zipFileInfo.info : {}), size: st.size },
            };
            const nextEvent = { ...event, downloadedFile: patchedZip };
            return await origUpdateDownloaded.call(this, nextZipFileInfo, nextEvent);
          } catch (err) {
            log('[AutoUpdate] Pre-patch failed, falling back to original zip', err);
            try { if (fs.existsSync(patchedZip)) fs.unlinkSync(patchedZip); } catch (_e) {}
          }
        }
        return await origUpdateDownloaded.call(this, zipFileInfo, event);
      };
      MacUpdater.prototype.__agyI18nWrapped = true;
      mod.__agyI18nWrapped = true;
      log('Hooked MacUpdater.prototype.updateDownloaded for seamless update preservation');
    }
    // Keep "Check for Updates" menu label synced whenever autoUpdater transitions state
    if (mod.autoUpdater && typeof mod.autoUpdater.on === 'function' && !mod.autoUpdater.__agyI18nMenuSynced) {
      for (const evName of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) {
        mod.autoUpdater.on(evName, () => {
          setTimeout(() => syncAllNativeMenus(), 30);
        });
      }
      mod.autoUpdater.__agyI18nMenuSynced = true;
    }
  } catch (err) {
    log('Failed to wrap electron-updater', err);
  }
  return mod;
}

const origModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = origModuleLoad.apply(this, arguments);
  if (request === 'electron-updater') {
    return wrapElectronUpdater(loaded);
  }
  if (request === './updater' && loaded && loaded.updateActions && loaded.MenuUpdateStep) {
    updaterModuleRef = loaded;
    registerUpdaterChineseAliases(loaded);
    if (typeof loaded.broadcastState === 'function' && !loaded.__agyI18nBroadcastWrapped) {
      const origBroadcast = loaded.broadcastState;
      loaded.broadcastState = function patchedBroadcastState(st) {
        const res = origBroadcast.apply(this, arguments);
        setTimeout(() => syncAllNativeMenus(), 20);
        return res;
      };
      loaded.__agyI18nBroadcastWrapped = true;
    }
  }
  return loaded;
};

log(`Antigravity - Insiders i18n main hook initialized (locale=${config.locale})`);

const api = {
  getConfig: () => ({ ...config }),
  setLocale,
  toggleLocale,
  syncAllNativeMenus,
  registerMenuEnhancer: (fn) => {
    if (typeof fn === 'function') menuEnhancers.push(fn);
  },
  onHubWebContentsReady: (fn) => {
    if (typeof fn === 'function') hubReadyListeners.push(fn);
  },
  getActiveHubContents: () => Array.from(activeHubContents),
  isHubUrl,
  log,
  I18N_DIR,
};
global.__AGY_INSIDERS_I18N_MAIN_LOADED__ = api;

// Load optional user local plugins from ~/.config/antigravity-insiders-i18n/local-plugins/*.js
const LOCAL_PLUGINS_DIR = path.join(I18N_DIR, 'local-plugins');
try {
  if (fs.existsSync(LOCAL_PLUGINS_DIR)) {
    for (const file of fs.readdirSync(LOCAL_PLUGINS_DIR).sort()) {
      if (!file.endsWith('.js')) continue;
      try {
        const plugin = require(path.join(LOCAL_PLUGINS_DIR, file));
        if (typeof plugin === 'function') plugin(api);
        log(`Loaded local plugin: ${file}`);
      } catch (err) {
        log(`Failed to load local plugin ${file}`, err);
      }
    }
  }
} catch (err) {
  log('Failed to scan local-plugins directory', err);
}

module.exports = api;
