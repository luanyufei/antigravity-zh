'use strict';

/**
 * Lightweight native Telemetry & Unified Settings plugin for antigravity-zh.
 *
 * Design highlights:
 * - Zero app.asar edits, zero binary edits, zero window-close interception (100% Squirrel.Mac safe).
 * - Full dual-variant isolation: works simultaneously and independently on both
 *   Antigravity (Stable) and Antigravity - Insiders (Preview).
 * - Dual-layer local RPC auth: in-process host `./authBootstrap` singleton first,
 *   variant-isolated `~/.gemini/antigravity[-insiders]/daemon/hub_*.json` fallback second.
 * - Incremental delta fetching via GetCascadeTrajectoryGeneratorMetadata (includeMessages: false)
 *   + GetCascadeTrajectorySteps (verbosity: 2) for minimal CPU & memory footprint.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const Module = require('module');
const electron = require('electron');

const metrics = require('./telemetry-assets/metrics');

module.exports = function initTelemetryPlugin(api) {
  const PLUGIN_DIR = path.join(api.I18N_DIR, 'local-plugins');
  const ASSETS_DIR = path.join(PLUGIN_DIR, 'telemetry-assets');
  const PRELOAD_PATH = path.join(ASSETS_DIR, 'preload.js');
  const OVERLAY_PATH = path.join(ASSETS_DIR, 'overlay.js');
  const VARIANT = (api.appInfo && api.appInfo.variant) || (/insider/i.test(process.execPath || '') ? 'insiders' : 'stable');
  const APP_NAME = (api.appInfo && api.appInfo.appName) || (VARIANT === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity');
  const CFG_FILENAME = `telemetry-${VARIANT}.json`;
  const CFG_PATH = path.join(PLUGIN_DIR, CFG_FILENAME);
  const DAEMON_DIR = path.join(
    os.homedir(),
    '.gemini',
    VARIANT === 'insiders' ? 'antigravity-insiders' : 'antigravity',
    'daemon'
  );

  const DEFAULT_CFG = {
    showComposerBar: true,
    showTurnFooter: true,
    quotaWindow: 'auto', // 'auto' | '5h' | 'weekly' | 'both'
  };

  function loadCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      const qw = ['auto', '5h', 'weekly', 'both'].includes(raw.quotaWindow) ? raw.quotaWindow : 'auto';
      return {
        showComposerBar: raw.showComposerBar !== false,
        showTurnFooter: raw.showTurnFooter !== false,
        quotaWindow: qw,
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
      api.log('[telemetry] saveCfg error', err);
    }
  }

  let cfg = loadCfg();
  let hostAuthBootstrapRef = null;
  let preloadScriptId = null;

  // Capture host app's `./authBootstrap` singleton in main-process memory
  function resolveHostAuthBootstrap() {
    if (hostAuthBootstrapRef) return hostAuthBootstrapRef;
    try {
      for (const mod of Object.values(require.cache || {})) {
        const exp = mod && mod.exports;
        if (
          exp &&
          typeof exp === 'object' &&
          typeof exp.getActiveLsCsrfToken === 'function' &&
          typeof exp.getActiveLsPort === 'function'
        ) {
          hostAuthBootstrapRef = exp;
          return hostAuthBootstrapRef;
        }
      }
    } catch (_e) {}
    return null;
  }

  if (!Module._load.__agyTelemetryAuthWrapped) {
    const origLoad = Module._load;
    const wrappedLoad = function agyTelemetryModuleLoad(request, parent, isMain) {
      const loaded = origLoad.apply(this, arguments);
      if (
        !hostAuthBootstrapRef &&
        (request === './authBootstrap' || (typeof request === 'string' && request.endsWith('/authBootstrap'))) &&
        loaded &&
        typeof loaded === 'object' &&
        typeof loaded.getActiveLsCsrfToken === 'function' &&
        typeof loaded.getActiveLsPort === 'function'
      ) {
        hostAuthBootstrapRef = loaded;
        api.log('[telemetry] Captured host ./authBootstrap singleton');
      }
      return loaded;
    };
    wrappedLoad.__agyTelemetryAuthWrapped = true;
    Module._load = wrappedLoad;
  }

  // ---------------------------------------------------------------------------
  // Loopback Origin Validation & Dual-Layer CSRF Resolution
  // ---------------------------------------------------------------------------
  function normalizeLoopbackOrigin(rawUrl) {
    try {
      const u = new URL(String(rawUrl || '').trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
      return `${u.protocol}//127.0.0.1:${port}`;
    } catch (_e) {
      return null;
    }
  }

  function assertLocalMainFrameOrigin(event) {
    try {
      const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
      if (event?.senderFrame && event?.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) {
        return null;
      }
      return normalizeLoopbackOrigin(rawUrl);
    } catch (_e) {
      return null;
    }
  }

  function isPidAlive(pid) {
    const num = Number(pid);
    if (!Number.isInteger(num) || num <= 0) return false;
    try {
      process.kill(num, 0);
      return true;
    } catch (err) {
      return err && err.code === 'EPERM';
    }
  }

  function resolveCsrfToken(origin) {
    const safeOrigin = normalizeLoopbackOrigin(origin);
    if (!safeOrigin) return null;

    // Layer 1: Host in-process authBootstrap memory singleton
    try {
      const auth = resolveHostAuthBootstrap();
      if (auth) {
        let activeOrigin = null;
        if (typeof auth.getActiveLsBaseUrl === 'function') {
          activeOrigin = normalizeLoopbackOrigin(auth.getActiveLsBaseUrl());
        }
        if (!activeOrigin && typeof auth.getActiveLsPort === 'function') {
          const p = Number(auth.getActiveLsPort());
          if (Number.isInteger(p) && p > 0) activeOrigin = normalizeLoopbackOrigin(`https://127.0.0.1:${p}`);
        }
        const token = typeof auth.getActiveLsCsrfToken === 'function'
          ? String(auth.getActiveLsCsrfToken() || '').trim()
          : '';
        if (token && (!activeOrigin || activeOrigin === safeOrigin)) {
          return token;
        }
      }
    } catch (_e) {}

    // Layer 2: Variant-isolated daemon/hub_*.json fallback
    try {
      if (fs.existsSync(DAEMON_DIR)) {
        const hubs = [];
        for (const name of fs.readdirSync(DAEMON_DIR)) {
          if (!/^hub_.*\.json$/i.test(name)) continue;
          try {
            const fp = path.join(DAEMON_DIR, name);
            const st = fs.statSync(fp);
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const token = typeof raw?.csrfToken === 'string' ? raw.csrfToken.trim() : '';
            if (!token || !isPidAlive(raw?.pid)) continue;
            const httpsOrigin = raw?.httpsPort ? normalizeLoopbackOrigin(`https://127.0.0.1:${raw.httpsPort}`) : null;
            const httpOrigin = raw?.httpPort ? normalizeLoopbackOrigin(`http://127.0.0.1:${raw.httpPort}`) : null;
            hubs.push({ httpsOrigin, httpOrigin, token, mtimeMs: st.mtimeMs || 0 });
          } catch (_e) {}
        }
        hubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const h of hubs) {
          if (h.httpsOrigin === safeOrigin || h.httpOrigin === safeOrigin) {
            return h.token;
          }
        }
      }
    } catch (_e) {}

    return null;
  }

  // ---------------------------------------------------------------------------
  // Loopback LanguageServerService RPC Client
  // ---------------------------------------------------------------------------
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 6, rejectUnauthorized: false });
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 6 });

  function callLsRpc(origin, method, body = {}, timeoutMs = 12000) {
    const safeOrigin = normalizeLoopbackOrigin(origin);
    if (!safeOrigin) return Promise.reject(new Error('Invalid loopback origin'));
    const token = resolveCsrfToken(safeOrigin);
    if (!token) return Promise.reject(new Error('Local CSRF token not ready'));

    const url = `${safeOrigin}/exa.language_server_pb.LanguageServerService/${method}`;
    const isHttps = url.startsWith('https:');
    const payload = JSON.stringify(body || {});

    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        url,
        {
          agent: isHttps ? httpsAgent : httpAgent,
          rejectUnauthorized: false,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': token,
          },
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > 48 * 1024 * 1024) {
              req.destroy(new Error('RPC response exceeded safety limit'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              return reject(new Error(`${method} HTTP ${res.statusCode}`));
            }
            try {
              resolve(JSON.parse(text || '{}'));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} timeout`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  // ---------------------------------------------------------------------------
  // Short Caches & Incremental Conversation State (LRU, max 12 conversations)
  // ---------------------------------------------------------------------------
  const quotaCacheByOrigin = new Map(); // origin -> { at, quota, modelCatalog, promise }
  const convIdCacheByOrigin = new Map(); // origin -> { at, ids: string[] }
  const sessionStateCache = new Map(); // `${origin}|${cid}` -> { stepCount, userInputIndices, checkpointSteps, genCount, calls, lastAccess }
  const MAX_CACHED_SESSIONS = 12;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function setSessionCache(key, value) {
    if (sessionStateCache.has(key)) sessionStateCache.delete(key);
    sessionStateCache.set(key, value);
    while (sessionStateCache.size > MAX_CACHED_SESSIONS) {
      const oldest = sessionStateCache.keys().next().value;
      sessionStateCache.delete(oldest);
    }
  }

  async function fetchQuotaAndCatalog(origin, force = false) {
    const now = Date.now();
    const cached = quotaCacheByOrigin.get(origin);
    if (!force && cached && cached.quota && (now - cached.at) < 15000) {
      return cached;
    }
    if (cached && cached.promise && !force) {
      return cached.promise;
    }

    const promise = (async () => {
      try {
        const [uRes, qRes, aRes] = await Promise.allSettled([
          callLsRpc(origin, 'GetUserStatus', {}),
          callLsRpc(origin, 'RetrieveUserQuotaSummary', {}),
          callLsRpc(origin, 'GetAvailableModels', { forceRefresh: false }),
        ]);
        const userStatus = uRes.status === 'fulfilled' ? uRes.value : null;
        const quotaSummary = qRes.status === 'fulfilled' ? qRes.value : null;
        const availModels = aRes.status === 'fulfilled' ? aRes.value : null;

        if (!userStatus && !quotaSummary) {
          const err = uRes.status === 'rejected' ? uRes.reason : (qRes.status === 'rejected' ? qRes.reason : new Error('Quota unavailable'));
          return {
            at: cached?.at || 0,
            quota: cached?.quota
              ? { ...cached.quota, stale: true, error: err.message }
              : { ok: false, error: err.message, groups: [], fetchedAtMs: Date.now() },
            modelCatalog: cached?.modelCatalog || null,
          };
        }

        const quota = metrics.parseQuotaSnapshot(userStatus, quotaSummary, Date.now());
        const modelCatalog = (userStatus || availModels)
          ? metrics.buildModelCatalog(userStatus, availModels)
          : (cached?.modelCatalog || null);

        const next = { at: Date.now(), quota, modelCatalog };
        quotaCacheByOrigin.set(origin, next);
        return next;
      } catch (err) {
        return {
          at: cached?.at || 0,
          quota: cached?.quota
            ? { ...cached.quota, stale: true, error: err.message }
            : { ok: false, error: err.message, groups: [], fetchedAtMs: Date.now() },
          modelCatalog: cached?.modelCatalog || null,
        };
      }
    })();

    quotaCacheByOrigin.set(origin, { ...(cached || {}), promise });
    const result = await promise;
    const cur = quotaCacheByOrigin.get(origin);
    if (cur && cur.promise === promise) {
      quotaCacheByOrigin.set(origin, result);
    }
    return result;
  }

  async function resolveFullCascadeId(origin, rawId) {
    const clean = String(rawId || '').trim().toLowerCase();
    if (!clean) return null;
    if (UUID_RE.test(clean)) return clean;
    if (!/^[0-9a-f-]{4,36}$/i.test(clean)) return null;

    const now = Date.now();
    let entry = convIdCacheByOrigin.get(origin);
    const tryMatch = (ids) => {
      if (!Array.isArray(ids)) return null;
      const hits = ids.filter((id) => id.toLowerCase().startsWith(clean));
      return hits.length === 1 ? hits[0] : (hits[0] || null);
    };

    if (entry && (now - entry.at) < 10000) {
      const hit = tryMatch(entry.ids);
      if (hit) return hit;
    }

    try {
      const all = await callLsRpc(origin, 'GetAllCascadeTrajectories', {}, 6000);
      const summaries = all?.trajectorySummaries || {};
      const ids = Object.keys(summaries).sort((a, b) => {
        const ta = Date.parse(summaries[a]?.lastModifiedTime || '') || 0;
        const tb = Date.parse(summaries[b]?.lastModifiedTime || '') || 0;
        return tb - ta;
      });
      convIdCacheByOrigin.set(origin, { at: Date.now(), ids });
      return tryMatch(ids);
    } catch (_e) {
      return null;
    }
  }

  async function fetchSessionMetrics(origin, rawRouteId, modelCatalog) {
    const cascadeId = await resolveFullCascadeId(origin, rawRouteId);
    if (!cascadeId) return null;

    const cacheKey = `${origin}|${cascadeId}`;
    let state = sessionStateCache.get(cacheKey);
    if (!state) {
      state = {
        cascadeId,
        stepCount: 0,
        userInputIndices: [],
        checkpointSteps: [],
        genCount: 0,
        calls: [],
      };
    }

    // Incrementally fetch new steps (verbosity 2) and new generator metadata (includeMessages: false)
    let pageGuard = 0;
    while (pageGuard < 20) {
      pageGuard++;
      const stepRes = await callLsRpc(origin, 'GetCascadeTrajectorySteps', {
        cascadeId,
        stepOffset: state.stepCount,
        trajectoryVerbosity: 2,
      });
      const batch = Array.isArray(stepRes?.steps) ? stepRes.steps : [];
      if (batch.length === 0) break;
      for (let i = 0; i < batch.length; i++) {
        const idx = state.stepCount + i;
        const step = batch[i];
        const t = String(step?.type || '');
        if (t === 'CORTEX_STEP_TYPE_USER_INPUT') {
          state.userInputIndices.push(idx);
        } else if (t.includes('CHECKPOINT')) {
          const est = metrics.toSafeInt(
            step?.checkpoint?.estimatedTokensUsed
            ?? step?.metadata?.contextWindowMetadata?.estimatedTokensUsed
            ?? 0
          );
          state.checkpointSteps.push({ index: idx, estimatedTokens: est });
        }
      }
      state.stepCount += batch.length;
      if (batch.length < 500) break;
    }

    pageGuard = 0;
    while (pageGuard < 20) {
      pageGuard++;
      const gmRes = await callLsRpc(origin, 'GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId,
        generatorMetadataOffset: state.genCount,
        includeMessages: false,
      });
      const batch = Array.isArray(gmRes?.generatorMetadata) ? gmRes.generatorMetadata : [];
      if (batch.length === 0) break;
      for (let i = 0; i < batch.length; i++) {
        const norm = metrics.normalizeGeneratorEntry(batch[i], state.genCount + i);
        if (norm) state.calls.push(norm);
      }
      state.genCount += batch.length;
      if (batch.length < 200) break;
    }

    setSessionCache(cacheKey, state);
    const computed = metrics.computeSessionMetrics({
      userInputIndices: state.userInputIndices,
      checkpointSteps: state.checkpointSteps,
      calls: state.calls,
      modelCatalog,
    });
    return {
      cascadeId,
      stepCount: state.stepCount,
      ...computed,
    };
  }

  // ---------------------------------------------------------------------------
  // Unified Settings Snapshot & Broadcast
  // ---------------------------------------------------------------------------
  function getAllSettingsSnapshot() {
    const i18nCfg = api.getConfig ? api.getConfig() : { locale: 'zh-CN', showFloatingToggle: true };
    const vibCfg = api.vibrancy && typeof api.vibrancy.getConfig === 'function'
      ? api.vibrancy.getConfig()
      : null;
    return {
      variant: VARIANT,
      appName: APP_NAME,
      platform: process.platform,
      i18n: {
        locale: i18nCfg.locale === 'en' ? 'en' : 'zh-CN',
        showFloatingToggle: i18nCfg.showFloatingToggle !== false,
      },
      vibrancy: vibCfg,
      vibrancyMeta: api.vibrancy
        ? { materials: api.vibrancy.materials || [], opacities: api.vibrancy.opacities || [] }
        : null,
      telemetry: { ...cfg },
    };
  }

  function broadcastSettings() {
    const snap = getAllSettingsSnapshot();
    for (const wc of api.getActiveHubContents()) {
      if (wc && !wc.isDestroyed?.()) {
        try { wc.send('agy-settings:changed', snap); } catch (_e) {}
      }
    }
  }

  function updateTelemetryCfg(patch) {
    const next = { ...cfg };
    if (typeof patch?.showComposerBar === 'boolean') next.showComposerBar = patch.showComposerBar;
    if (typeof patch?.showTurnFooter === 'boolean') next.showTurnFooter = patch.showTurnFooter;
    if (['auto', '5h', 'weekly', 'both'].includes(patch?.quotaWindow)) next.quotaWindow = patch.quotaWindow;
    cfg = next;
    saveCfg(cfg);
    api.syncAllNativeMenus();
    broadcastSettings();
    api.log(`[telemetry] Updated: composerBar=${cfg.showComposerBar}, turnFooter=${cfg.showTurnFooter}, quotaWindow=${cfg.quotaWindow}`);
    return { ...cfg };
  }

  // Keep Settings modal synced if Vibrancy changes via macOS Menu Bar or ⌘⌥T
  function bindVibrancySync() {
    if (api.vibrancy && typeof api.vibrancy.onChange === 'function' && !api.vibrancy.__agyTelemetryBound) {
      api.vibrancy.__agyTelemetryBound = true;
      api.vibrancy.onChange(() => broadcastSettings());
    }
  }

  // ---------------------------------------------------------------------------
  // IPC Handlers
  // ---------------------------------------------------------------------------
  function registerIpcHandlers() {
    if (!electron.ipcMain) return;
    const reg = (channel, fn) => {
      try {
        if (typeof electron.ipcMain.removeHandler === 'function') {
          electron.ipcMain.removeHandler(channel);
        }
        electron.ipcMain.handle(channel, fn);
      } catch (err) {
        api.log(`[telemetry] Failed to register IPC ${channel}`, err);
      }
    };

    reg('agy-telemetry:get-quota', async (event, opts) => {
      const origin = assertLocalMainFrameOrigin(event);
      if (!origin) return { ok: false, error: 'Forbidden origin' };
      const res = await fetchQuotaAndCatalog(origin, opts?.force === true);
      return { ok: Boolean(res?.quota?.ok), quota: res?.quota || null };
    });

    reg('agy-telemetry:get-snapshot', async (event, opts) => {
      const origin = assertLocalMainFrameOrigin(event);
      if (!origin) return { ok: false, error: 'Forbidden origin' };
      const forceQuota = opts?.forceQuota === true || opts?.force === true;
      const quotaPack = await fetchQuotaAndCatalog(origin, forceQuota);
      let session = null;
      let sessionError = null;
      if (opts?.routeId) {
        try {
          session = await fetchSessionMetrics(origin, opts.routeId, quotaPack?.modelCatalog || null);
        } catch (err) {
          sessionError = err.message;
        }
      }
      return {
        ok: true,
        quota: quotaPack?.quota || null,
        session,
        sessionError,
      };
    });

    reg('agy-settings:get-all', (event) => {
      if (!assertLocalMainFrameOrigin(event)) return null;
      bindVibrancySync();
      return getAllSettingsSnapshot();
    });

    reg('agy-settings:set-locale', (event, locale) => {
      if (!assertLocalMainFrameOrigin(event)) return null;
      if (typeof api.setLocale === 'function') {
        api.setLocale(locale === 'en' ? 'en' : 'zh-CN', true);
      }
      broadcastSettings();
      return getAllSettingsSnapshot();
    });

    reg('agy-settings:set-floating', (event, show) => {
      if (!assertLocalMainFrameOrigin(event)) return null;
      if (typeof api.setShowFloatingToggle === 'function') {
        api.setShowFloatingToggle(Boolean(show), true);
      }
      broadcastSettings();
      return getAllSettingsSnapshot();
    });

    reg('agy-settings:set-vibrancy', (event, patch) => {
      if (!assertLocalMainFrameOrigin(event)) return null;
      bindVibrancySync();
      if (api.vibrancy && typeof api.vibrancy.updateConfig === 'function') {
        api.vibrancy.updateConfig(patch || {});
      }
      broadcastSettings();
      return getAllSettingsSnapshot();
    });

    reg('agy-settings:set-telemetry', (event, patch) => {
      if (!assertLocalMainFrameOrigin(event)) return null;
      updateTelemetryCfg(patch || {});
      return getAllSettingsSnapshot();
    });
  }

  // ---------------------------------------------------------------------------
  // Dynamic Preload Registration & Overlay Injection
  // ---------------------------------------------------------------------------
  function registerPreload() {
    try {
      const ses = electron.session && electron.session.defaultSession;
      if (!ses || preloadScriptId) return;
      if (!fs.existsSync(PRELOAD_PATH)) {
        api.log(`[telemetry] Missing preload at ${PRELOAD_PATH}`);
        return;
      }
      if (typeof ses.registerPreloadScript === 'function') {
        preloadScriptId = ses.registerPreloadScript({
          type: 'frame',
          filePath: PRELOAD_PATH,
          matches: [
            'https://127.0.0.1/*',
            'http://127.0.0.1/*',
            'https://localhost/*',
            'http://localhost/*',
          ],
        });
        api.log(`[telemetry] Registered dynamic preload (id=${preloadScriptId})`);
      } else if (typeof ses.setPreloads === 'function') {
        const existing = typeof ses.getPreloads === 'function' ? ses.getPreloads() : [];
        if (!existing.includes(PRELOAD_PATH)) {
          ses.setPreloads([...existing, PRELOAD_PATH]);
        }
        preloadScriptId = '__legacy__';
      }
    } catch (err) {
      api.log('[telemetry] registerPreload error', err);
    }
  }

  function injectOverlay(wc) {
    if (!wc || wc.isDestroyed?.()) return;
    if (!fs.existsSync(OVERLAY_PATH)) return;
    try {
      const script = fs.readFileSync(OVERLAY_PATH, 'utf8');
      const initSnap = JSON.stringify(getAllSettingsSnapshot());
      const code = `${script}\n;try{window.__AGY_TELEMETRY_UI__&&window.__AGY_TELEMETRY_UI__.init(${initSnap});}catch(e){console.error('[agy-telemetry]',e);}`;
      wc.executeJavaScript(code, true).catch(() => {});
    } catch (err) {
      api.log('[telemetry] injectOverlay error', err);
    }
  }

  function openSettingsInActiveWindow() {
    for (const wc of api.getActiveHubContents()) {
      if (wc && !wc.isDestroyed?.()) {
        try { wc.send('agy-settings:open'); } catch (_e) {}
      }
    }
  }

  registerIpcHandlers();
  if (electron.app && typeof electron.app.whenReady === 'function') {
    electron.app.whenReady().then(() => {
      bindVibrancySync();
      registerPreload();
    }).catch(() => {});
  }

  api.onHubWebContentsReady((wc) => {
    bindVibrancySync();
    registerPreload();
    injectOverlay(wc);
  });

  // macOS App Menu entry right below Vibrancy
  api.registerMenuEnhancer((appMenu, i18nCfg) => {
    const appSubmenu = appMenu?.items?.[0]?.submenu;
    if (!appSubmenu || !Array.isArray(appSubmenu.items)) return;
    const isZh = (i18nCfg?.locale || 'zh-CN') === 'zh-CN';
    const subId = 'agy-i18n-telemetry-submenu';

    const existing = appSubmenu.items.find((i) => i.id === subId);
    if (existing) {
      existing.label = isZh ? '状态监控 / Telemetry' : 'Telemetry / 状态监控';
      const sub = existing.submenu;
      if (sub && Array.isArray(sub.items)) {
        const barItem = sub.items.find((i) => i.id === 'agy-tel-bar');
        const turnItem = sub.items.find((i) => i.id === 'agy-tel-turn');
        const openItem = sub.items.find((i) => i.id === 'agy-tel-open-settings');
        if (barItem) {
          barItem.label = isZh ? '输入框底部状态条（上下文 / 额度 / 速度）' : 'Composer Status Bar (Context / Quota / Speed)';
          barItem.checked = cfg.showComposerBar;
        }
        if (turnItem) {
          turnItem.label = isZh ? '回答末尾显示本轮汇总' : 'Show Per-Turn Summary Footer';
          turnItem.checked = cfg.showTurnFooter;
        }
        if (openItem) {
          openItem.label = isZh ? '打开 antigravity-zh 设置面板…' : 'Open antigravity-zh Settings…';
        }
      }
      return;
    }

    const template = [
      {
        id: 'agy-tel-bar',
        label: isZh ? '输入框底部状态条（上下文 / 额度 / 速度）' : 'Composer Status Bar (Context / Quota / Speed)',
        type: 'checkbox',
        checked: cfg.showComposerBar,
        click: () => updateTelemetryCfg({ showComposerBar: !cfg.showComposerBar }),
      },
      {
        id: 'agy-tel-turn',
        label: isZh ? '回答末尾显示本轮汇总' : 'Show Per-Turn Summary Footer',
        type: 'checkbox',
        checked: cfg.showTurnFooter,
        click: () => updateTelemetryCfg({ showTurnFooter: !cfg.showTurnFooter }),
      },
      { type: 'separator' },
      {
        id: 'agy-tel-open-settings',
        label: isZh ? '打开 antigravity-zh 设置面板…' : 'Open antigravity-zh Settings…',
        click: () => openSettingsInActiveWindow(),
      },
    ];

    const vibIdx = appSubmenu.items.findIndex((i) => i.id === 'agy-i18n-vibrancy-submenu');
    const langIdx = appSubmenu.items.findIndex((i) => i.id === 'agy-i18n-lang-submenu');
    const insertAt = vibIdx !== -1 ? vibIdx + 1 : (langIdx !== -1 ? langIdx + 1 : Math.min(3, appSubmenu.items.length));
    appSubmenu.insert(insertAt, new electron.MenuItem({
      id: subId,
      label: isZh ? '状态监控 / Telemetry' : 'Telemetry / 状态监控',
      submenu: electron.Menu.buildFromTemplate(template),
    }));
  });

  // Watch telemetry-<variant>.json & overlay.js for instant hot-reload during tweaks
  try {
    fs.watch(PLUGIN_DIR, { persistent: false }, (_ev, filename) => {
      if (filename !== CFG_FILENAME) return;
      setTimeout(() => {
        cfg = loadCfg();
        api.syncAllNativeMenus();
        broadcastSettings();
      }, 120);
    });
  } catch (_e) {}

  api.log(`[telemetry] Plugin initialized (variant=${VARIANT}, composerBar=${cfg.showComposerBar}, turnFooter=${cfg.showTurnFooter}, daemonDir=${DAEMON_DIR})`);
};
