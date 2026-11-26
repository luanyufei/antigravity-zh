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
  const ENHANCEMENTS_PATH = path.join(ASSETS_DIR, 'enhancements.js');
  const OVERLAY_PATH = path.join(ASSETS_DIR, 'overlay.js');
  const VARIANT = (api.appInfo && api.appInfo.variant) || (/insider/i.test(process.execPath || '') ? 'insiders' : 'stable');
  const APP_NAME = (api.appInfo && api.appInfo.appName) || (VARIANT === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity');
  const CFG_FILENAME = `telemetry-${VARIANT}.json`;
  const CFG_PATH = path.join(PLUGIN_DIR, CFG_FILENAME);
  const OTHER_VARIANT = VARIANT === 'insiders' ? 'stable' : 'insiders';
  const ROLLUP_CACHE_PATH = path.join(PLUGIN_DIR, `telemetry-rollup-${VARIANT}.json`);
  const OTHER_ROLLUP_CACHE_PATH = path.join(PLUGIN_DIR, `telemetry-rollup-${OTHER_VARIANT}.json`);
  const VARIANT_DATA_DIR = path.join(
    os.homedir(),
    '.gemini',
    VARIANT === 'insiders' ? 'antigravity-insiders' : 'antigravity'
  );
  const OTHER_VARIANT_DATA_DIR = path.join(
    os.homedir(),
    '.gemini',
    OTHER_VARIANT === 'insiders' ? 'antigravity-insiders' : 'antigravity'
  );
  const DAEMON_DIR = path.join(VARIANT_DATA_DIR, 'daemon');
  const CONVERSATIONS_DIR = path.join(VARIANT_DATA_DIR, 'conversations');

  const DEFAULT_CFG = {
    showComposerBar: true,
    showTurnFooter: true,
    showHomeDashboard: true,
    mergeVariantUsage: false,
    fileOpenMode: 'sidebar', // 'sidebar' | 'finder' | 'external'
    codeBlockEnhance: true,
    streamFadeIn: true,
    smoothCaret: true,
    quotaWindow: 'both',
  };

  function loadCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      const qw = ['auto', '5h', 'weekly', 'both'].includes(raw.quotaWindow) ? raw.quotaWindow : 'both';
      const fom = ['sidebar', 'finder', 'external'].includes(raw.fileOpenMode) ? raw.fileOpenMode : 'sidebar';
      return {
        showComposerBar: raw.showComposerBar !== false,
        showTurnFooter: raw.showTurnFooter !== false,
        showHomeDashboard: raw.showHomeDashboard !== false,
        mergeVariantUsage: raw.mergeVariantUsage === true,
        fileOpenMode: fom,
        codeBlockEnhance: raw.codeBlockEnhance !== false,
        streamFadeIn: raw.streamFadeIn !== false,
        smoothCaret: raw.smoothCaret !== false,
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
    if (typeof patch?.showHomeDashboard === 'boolean') next.showHomeDashboard = patch.showHomeDashboard;
    if (typeof patch?.mergeVariantUsage === 'boolean') {
      if (next.mergeVariantUsage !== patch.mergeVariantUsage) {
        usageSummaryCache = null;
      }
      next.mergeVariantUsage = patch.mergeVariantUsage;
    }
    if (['sidebar', 'finder', 'external'].includes(patch?.fileOpenMode)) next.fileOpenMode = patch.fileOpenMode;
    if (typeof patch?.codeBlockEnhance === 'boolean') next.codeBlockEnhance = patch.codeBlockEnhance;
    if (typeof patch?.streamFadeIn === 'boolean') next.streamFadeIn = patch.streamFadeIn;
    if (typeof patch?.smoothCaret === 'boolean') next.smoothCaret = patch.smoothCaret;
    if (['auto', '5h', 'weekly', 'both'].includes(patch?.quotaWindow)) next.quotaWindow = patch.quotaWindow;
    cfg = next;
    saveCfg(cfg);
    api.syncAllNativeMenus();
    broadcastSettings();
    api.log(`[telemetry] Updated: bar=${cfg.showComposerBar}, turn=${cfg.showTurnFooter}, home=${cfg.showHomeDashboard}, merge=${cfg.mergeVariantUsage}, fileOpen=${cfg.fileOpenMode}, code=${cfg.codeBlockEnhance}, fade=${cfg.streamFadeIn}, caret=${cfg.smoothCaret}`);
    return { ...cfg };
  }

  // ---------------------------------------------------------------------------
  // Safe Local File Opener (Finder / System Default App)
  // ---------------------------------------------------------------------------
  const EXEC_BLOCK_EXTS = new Set([
    '.app', '.command', '.sh', '.zsh', '.bash', '.csh', '.fish',
    '.pkg', '.mpkg', '.dmg', '.scpt', '.applescript', '.workflow', '.action',
    '.exe', '.bat', '.cmd', '.msi', '.jar',
  ]);

  function resolveLocalFilePath(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return null;
    let s = rawInput.trim();
    if (!s) return null;
    if (/^file:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        if (u.protocol !== 'file:') return null;
        s = decodeURIComponent(u.pathname || '');
      } catch (_e) {
        s = s.replace(/^file:\/\//i, '');
        try { s = decodeURIComponent(s); } catch (_e2) {}
      }
    }
    // Strip hash/query/line suffixes (e.g. #L10-L20 or :12:4)
    s = s.split('#')[0].split('?')[0];
    s = s.replace(/:(\d+)(?::\d+)?$/, '');
    if (!s.startsWith('/')) return null;
    const normalized = path.normalize(s);
    if (!normalized.startsWith('/')) return null;
    try {
      if (!fs.existsSync(normalized)) return null;
      return normalized;
    } catch (_e) {
      return null;
    }
  }

  async function handleOpenLocalFile(opts) {
    const mode = opts?.mode === 'external' ? 'external' : 'finder';
    const resolved = resolveLocalFilePath(opts?.targetPath);
    if (!resolved) return { ok: false, reason: 'not-found' };
    try {
      if (mode === 'finder') {
        electron.shell.showItemInFolder(resolved);
        return { ok: true, mode: 'finder', path: resolved };
      }
      const stat = fs.statSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      if (stat.isDirectory() || EXEC_BLOCK_EXTS.has(ext)) {
        electron.shell.showItemInFolder(resolved);
        return { ok: true, mode: 'finder-safe', path: resolved };
      }
      const errMsg = await electron.shell.openPath(resolved);
      if (errMsg) return { ok: false, error: errMsg };
      return { ok: true, mode: 'external', path: resolved };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-Session Historical Usage Rollup (Variant-Isolated & Disk-Cached)
  // ---------------------------------------------------------------------------
  let rollupDiskCache = null;
  let usageSummaryCache = null; // { at, origin, data, promise }

  function loadRollupDiskCacheAt(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && (parsed.version === 4 || parsed.version === 3) && parsed.items && typeof parsed.items === 'object') {
        parsed.version = 4;
        return parsed;
      }
    } catch (_e) {}
    return { version: 4, items: {} };
  }

  function loadRollupDiskCache() {
    if (rollupDiskCache) return rollupDiskCache;
    rollupDiskCache = loadRollupDiskCacheAt(ROLLUP_CACHE_PATH);
    return rollupDiskCache;
  }

  function saveRollupDiskCacheAt(filePath, cacheObj) {
    try {
      const tmp = `${filePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(cacheObj), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (_e) {}
  }

  function saveRollupDiskCache(cacheObj) {
    saveRollupDiskCacheAt(ROLLUP_CACHE_PATH, cacheObj);
  }

  function localDateKey(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function listRecentConversationFilesInDir(dirPath, maxAgeDays = 190, maxCount = 400) {
    const results = [];
    const cutoffMs = Date.now() - maxAgeDays * 86400 * 1000;
    try {
      if (!fs.existsSync(dirPath)) return results;
      const entries = fs.readdirSync(dirPath);
      for (const name of entries) {
        if (!name.endsWith('.db')) continue;
        const id = name.slice(0, -3);
        if (!UUID_RE.test(id)) continue;
        const dbPath = path.join(dirPath, name);
        let birthMs = 0;
        let cacheStampMs = 0;
        try {
          const st = fs.statSync(dbPath);
          // birthtimeMs is immutable on macOS APFS even when SQLite touches/checkpoints the .db file
          birthMs = (st.birthtimeMs && st.birthtimeMs > 946684800000) ? st.birthtimeMs : (st.mtimeMs || 0);
          cacheStampMs = st.mtimeMs || birthMs;
          const walPath = `${dbPath}-wal`;
          if (fs.existsSync(walPath)) {
            const walM = fs.statSync(walPath).mtimeMs || 0;
            if (walM > cacheStampMs) cacheStampMs = walM;
          }
        } catch (_e) {
          continue;
        }
        if (cacheStampMs >= cutoffMs) {
          results.push({ id, mtimeMs: Math.floor(cacheStampMs), dbMtimeMs: Math.floor(birthMs) });
        }
      }
    } catch (_e) {}
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results.slice(0, maxCount);
  }

  function listRecentConversationFiles(maxAgeDays = 190, maxCount = 400) {
    return listRecentConversationFilesInDir(CONVERSATIONS_DIR, maxAgeDays, maxCount);
  }

  function callExplicitHubRpc(origin, token, method, body = {}, timeoutMs = 8000) {
    const url = `${origin}/exa.language_server_pb.LanguageServerService/${method}`;
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
            if (total > 32 * 1024 * 1024) { req.destroy(new Error('limit')); return; }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (e) { reject(e); }
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  async function tryRefreshOtherVariantRollup() {
    const otherDaemonDir = path.join(OTHER_VARIANT_DATA_DIR, 'daemon');
    const otherConvDir = path.join(OTHER_VARIANT_DATA_DIR, 'conversations');
    const otherDisk = loadRollupDiskCacheAt(OTHER_ROLLUP_CACHE_PATH);
    const otherFiles = listRecentConversationFilesInDir(otherConvDir, 190, 400);
    if (otherFiles.length === 0) {
      return { items: [], otherVariantMissing: false };
    }

    // If the other variant happens to have a live hub running right now, incrementally refresh its rollup cache too!
    const stale = otherFiles.filter((f) => {
      const cached = otherDisk.items[f.id];
      return !cached || cached.mtimeMs !== f.mtimeMs;
    });
    if (stale.length > 0 && fs.existsSync(otherDaemonDir)) {
      try {
        const hubFiles = fs.readdirSync(otherDaemonDir)
          .filter((f) => f.startsWith('hub_') && f.endsWith('.json'))
          .map((f) => ({ p: path.join(otherDaemonDir, f), m: fs.statSync(path.join(otherDaemonDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        let liveHub = null;
        for (const hf of hubFiles.slice(0, 4)) {
          try {
            const d = JSON.parse(fs.readFileSync(hf.p, 'utf8'));
            if (!d?.httpsPort || !d?.csrfToken) continue;
            const orig = `https://127.0.0.1:${d.httpsPort}`;
            await callExplicitHubRpc(orig, d.csrfToken, 'GetAvailableModels', { forceRefresh: false }, 1500);
            liveHub = { origin: orig, token: d.csrfToken };
            break;
          } catch (_e) {}
        }
        if (liveHub) {
          let dirty = false;
          let idx = 0;
          async function w() {
            while (idx < stale.length) {
              const item = stale[idx++];
              try {
                const gRes = await callExplicitHubRpc(
                  liveHub.origin,
                  liveHub.token,
                  'GetCascadeTrajectoryGeneratorMetadata',
                  { cascadeId: item.id, includeMessages: false },
                  6000
                );
                const rawGens = Array.isArray(gRes?.generatorMetadata) ? gRes.generatorMetadata : [];
                otherDisk.items[item.id] = summarizeGeneratorListForRollup(rawGens, item.mtimeMs, item.dbMtimeMs);
                dirty = true;
              } catch (_e) {}
            }
          }
          const ws = [];
          for (let i = 0; i < Math.min(5, stale.length); i++) ws.push(w());
          await Promise.all(ws);
          if (dirty) saveRollupDiskCacheAt(OTHER_ROLLUP_CACHE_PATH, otherDisk);
        }
      } catch (_e) {}
    }

    const items = otherFiles.map((f) => ({ id: f.id, rec: otherDisk.items[f.id] })).filter((x) => x.rec);
    const otherVariantMissing = items.length === 0 && otherFiles.length > 0;
    return { items, otherVariantMissing };
  }

  function summarizeGeneratorListForRollup(rawGens, cacheStampMs, fallbackDateMs) {
    let totalInput = 0;
    let cacheRead = 0;
    let totalOutput = 0;
    let calls = 0;
    let latestCallMs = 0;
    const byModel = {};
    const byDay = {}; // dateKey -> { input, cache, output, calls, byModel }
    const fallbackDk = localDateKey(fallbackDateMs || cacheStampMs);

    for (let i = 0; i < rawGens.length; i++) {
      const c = metrics.normalizeGeneratorEntry(rawGens[i], i);
      if (!c || (c.totalInput === 0 && c.outputTokens === 0)) continue;
      totalInput += c.totalInput;
      cacheRead += c.cacheReadTokens;
      totalOutput += c.outputTokens;
      calls += 1;

      const callMs = c.createdAtMs || fallbackDateMs || cacheStampMs;
      if (callMs > latestCallMs) latestCallMs = callMs;
      const dk = c.createdAtMs ? localDateKey(c.createdAtMs) : fallbackDk;

      const mName = c.shortModelName || c.displayName || c.modelId || 'Unknown';
      if (!byModel[mName]) byModel[mName] = { input: 0, cache: 0, output: 0, calls: 0 };
      byModel[mName].input += c.totalInput;
      byModel[mName].cache += c.cacheReadTokens;
      byModel[mName].output += c.outputTokens;
      byModel[mName].calls += 1;

      if (!byDay[dk]) byDay[dk] = { input: 0, cache: 0, output: 0, calls: 0, byModel: {} };
      const dObj = byDay[dk];
      dObj.input += c.totalInput;
      dObj.cache += c.cacheReadTokens;
      dObj.output += c.outputTokens;
      dObj.calls += 1;
      if (!dObj.byModel[mName]) dObj.byModel[mName] = { input: 0, cache: 0, output: 0, calls: 0 };
      dObj.byModel[mName].input += c.totalInput;
      dObj.byModel[mName].cache += c.cacheReadTokens;
      dObj.byModel[mName].output += c.outputTokens;
      dObj.byModel[mName].calls += 1;
    }

    const effectiveMs = latestCallMs || fallbackDateMs || cacheStampMs;
    return {
      mtimeMs: cacheStampMs,
      effectiveMs,
      dateKey: localDateKey(effectiveMs),
      totalInput,
      cacheRead,
      totalOutput,
      calls,
      byModel,
      byDay,
    };
  }

  function finalizeDayBucket(b) {
    const totalTokens = b.totalTokens || 0;
    const models = Array.from(b._models.values())
      .sort((a, b2) => b2.totalTokens - a.totalTokens)
      .slice(0, 5)
      .map((m) => ({
        name: m.name,
        totalTokens: m.totalTokens,
        outputTokens: m.outputTokens,
        calls: m.calls,
        estUsd: Math.round(m.estUsd * 100) / 100,
        sharePct: totalTokens > 0 ? Math.round((m.totalTokens / totalTokens) * 100) : 0,
      }));
    return {
      dateKey: b.dateKey,
      label: b.label,
      totalTokens,
      inputTokens: b.inputTokens,
      cacheRead: b.cacheRead,
      outputTokens: b.outputTokens,
      cacheHitPct: b.inputTokens > 0 ? Math.round((b.cacheRead / b.inputTokens) * 100) : null,
      conversations: b.conversations,
      calls: b.calls,
      estUsd: Math.round(b.estUsd * 100) / 100,
      models,
    };
  }

  function createDayBucket(dateKey, label) {
    return {
      dateKey,
      label,
      totalTokens: 0,
      inputTokens: 0,
      cacheRead: 0,
      outputTokens: 0,
      conversations: 0,
      calls: 0,
      estUsd: 0,
      _models: new Map(),
    };
  }

  function accumulateDayBucket(bucket, dObj) {
    if (!bucket || !dObj) return 0;
    const dIn = dObj.input || 0;
    const dCache = dObj.cache || 0;
    const dOut = dObj.output || 0;
    const dCalls = dObj.calls || 0;
    bucket.inputTokens += dIn;
    bucket.cacheRead += dCache;
    bucket.outputTokens += dOut;
    bucket.totalTokens += dIn + dOut;
    bucket.calls += dCalls;
    bucket.conversations += 1;

    let dUsd = 0;
    for (const [rawModelName, mv] of Object.entries(dObj.byModel || {})) {
      const mName = metrics.shortenModelName(rawModelName) || rawModelName;
      const mIn = mv.input || 0;
      const mCache = mv.cache || 0;
      const mOut = mv.output || 0;
      const mUsd = metrics.estimateModelCostUsd(mName, mIn, mCache, mOut);
      dUsd += mUsd;
      if (!bucket._models.has(mName)) {
        bucket._models.set(mName, { name: mName, totalTokens: 0, outputTokens: 0, calls: 0, estUsd: 0 });
      }
      const cm = bucket._models.get(mName);
      cm.totalTokens += mIn + mOut;
      cm.outputTokens += mOut;
      cm.calls += mv.calls || 0;
      cm.estUsd += mUsd;
    }
    bucket.estUsd += dUsd;
    return dUsd;
  }

  function buildRangeAggregate(items, daysBack) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const isAll = !daysBack || daysBack <= 0;

    const dayKeys = [];
    const dayMap = new Map();
    const spanDays = isAll ? 140 : daysBack;
    for (let i = spanDays - 1; i >= 0; i--) {
      const dMs = todayStart - i * 86400 * 1000;
      const dk = localDateKey(dMs);
      const dt = new Date(dMs);
      const label = `${dt.getMonth() + 1}/${dt.getDate()}`;
      dayKeys.push(dk);
      dayMap.set(dk, createDayBucket(dk, label));
    }
    const minDayKey = isAll ? '' : dayKeys[0];

    let totalInput = 0;
    let cacheRead = 0;
    let totalOutput = 0;
    let totalEstUsd = 0;
    let calls = 0;
    let conversations = 0;
    const modelTotals = new Map();

    for (const rec of items) {
      if (!rec || rec.calls <= 0) continue;
      const dayEntries = rec.byDay && typeof rec.byDay === 'object'
        ? Object.entries(rec.byDay)
        : [[rec.dateKey, { input: rec.totalInput, cache: rec.cacheRead, output: rec.totalOutput, calls: rec.calls, byModel: rec.byModel }]];

      let convMatched = false;
      for (const [dk, dObj] of dayEntries) {
        if (!dObj || dObj.calls <= 0) continue;
        if (!isAll && dk < minDayKey) continue;
        convMatched = true;
        const dIn = dObj.input || 0;
        const dCache = dObj.cache || 0;
        const dOut = dObj.output || 0;
        const dCalls = dObj.calls || 0;
        totalInput += dIn;
        cacheRead += dCache;
        totalOutput += dOut;
        calls += dCalls;

        let dUsd = 0;
        for (const [rawModelName, mv] of Object.entries(dObj.byModel || {})) {
          const mName = metrics.shortenModelName(rawModelName) || rawModelName;
          const mIn = mv.input || 0;
          const mCache = mv.cache || 0;
          const mOut = mv.output || 0;
          const mUsd = metrics.estimateModelCostUsd(mName, mIn, mCache, mOut);
          dUsd += mUsd;
          if (!modelTotals.has(mName)) {
            modelTotals.set(mName, { name: mName, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, estUsd: 0 });
          }
          const cur = modelTotals.get(mName);
          cur.inputTokens += mIn;
          cur.outputTokens += mOut;
          cur.totalTokens += mIn + mOut;
          cur.calls += mv.calls || 0;
          cur.estUsd += mUsd;
        }
        totalEstUsd += dUsd;

        const bucket = dayMap.get(dk);
        if (bucket) accumulateDayBucket(bucket, dObj);
      }
      if (convMatched) conversations += 1;
    }

    const totalTokens = totalInput + totalOutput;
    const models = Array.from(modelTotals.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 6)
      .map((m) => ({
        ...m,
        estUsd: Math.round(m.estUsd * 100) / 100,
        sharePct: totalTokens > 0 ? Math.round((m.totalTokens / totalTokens) * 100) : 0,
      }));

    return {
      days: isAll ? 0 : daysBack,
      conversations,
      calls,
      totalInput,
      cacheRead,
      totalOutput,
      totalTokens,
      estUsd: Math.round(totalEstUsd * 100) / 100,
      cacheHitPct: totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : null,
      daily: dayKeys.map((dk) => finalizeDayBucket(dayMap.get(dk))),
      models,
    };
  }

  function buildHeatmapGrid(items, weeks = 20) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    // Align start to Sunday so each column is a full Sun..Sat week
    start.setDate(start.getDate() - start.getDay());

    const byDate = new Map();
    for (const rec of items) {
      if (!rec || rec.calls <= 0) continue;
      const dayEntries = rec.byDay && typeof rec.byDay === 'object'
        ? Object.entries(rec.byDay)
        : (rec.dateKey ? [[rec.dateKey, { input: rec.totalInput, cache: rec.cacheRead, output: rec.totalOutput, calls: rec.calls, byModel: rec.byModel }]] : []);

      for (const [dk, dObj] of dayEntries) {
        if (!dk || !dObj || dObj.calls <= 0) continue;
        if (!byDate.has(dk)) byDate.set(dk, createDayBucket(dk, dk.slice(5).replace(/^0/, '').replace('-0', '/').replace('-', '/')));
        accumulateDayBucket(byDate.get(dk), dObj);
      }
    }

    const cells = [];
    let peak = 0;
    for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const dk = localDateKey(cursor.getTime());
      const lbl = `${cursor.getMonth() + 1}/${cursor.getDate()}`;
      const raw = byDate.get(dk);
      const finalized = raw ? finalizeDayBucket({ ...raw, label: lbl }) : finalizeDayBucket(createDayBucket(dk, lbl));
      if (finalized.totalTokens > peak) peak = finalized.totalTokens;
      cells.push({ ...finalized, level: 0 });
    }
    for (const c of cells) {
      if (c.totalTokens > 0 && peak > 0) {
        const sr = Math.sqrt(c.totalTokens / peak);
        c.level = sr >= 0.72 ? 4 : sr >= 0.48 ? 3 : sr >= 0.25 ? 2 : 1;
      }
    }
    return { weeks, cells, peak };
  }

  async function fetchUsageSummary(origin, force = false) {
    const now = Date.now();
    if (!force && usageSummaryCache && usageSummaryCache.origin === origin && usageSummaryCache.data && (now - usageSummaryCache.at) < 25000) {
      return usageSummaryCache.data;
    }
    if (usageSummaryCache && usageSummaryCache.promise && !force) {
      return usageSummaryCache.promise;
    }

    const promise = (async () => {
      const disk = loadRollupDiskCache();
      const recent = listRecentConversationFiles(190, 400);
      const stale = recent.filter((f) => {
        const cached = disk.items[f.id];
        return !cached || cached.mtimeMs !== f.mtimeMs;
      });

      let dirty = false;
      const CONCURRENCY = 5;
      let cursor = 0;
      async function worker() {
        while (cursor < stale.length) {
          const item = stale[cursor++];
          try {
            const gRes = await callLsRpc(
              origin,
              'GetCascadeTrajectoryGeneratorMetadata',
              { cascadeId: item.id, includeMessages: false },
              8000
            );
            const rawGens = Array.isArray(gRes?.generatorMetadata) ? gRes.generatorMetadata : [];
            disk.items[item.id] = summarizeGeneratorListForRollup(rawGens, item.mtimeMs, item.dbMtimeMs);
            dirty = true;
          } catch (_e) {
            // Skip unreadable/unindexed trajectory gracefully
          }
        }
      }

      if (stale.length > 0) {
        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, stale.length); i++) workers.push(worker());
        await Promise.all(workers);
      }

      // Prune entries older than 210 days to keep rollup cache bounded
      const pruneCutoff = Date.now() - 210 * 86400 * 1000;
      for (const [k, v] of Object.entries(disk.items)) {
        if (!v || (v.mtimeMs || 0) < pruneCutoff) {
          delete disk.items[k];
          dirty = true;
        }
      }
      if (dirty) saveRollupDiskCache(disk);

      const mergedById = new Map();
      for (const f of recent) {
        if (disk.items[f.id]) mergedById.set(f.id, disk.items[f.id]);
      }

      let merged = false;
      let otherVariantMissing = false;
      if (cfg.mergeVariantUsage === true) {
        const otherRes = await tryRefreshOtherVariantRollup();
        otherVariantMissing = otherRes.otherVariantMissing;
        for (const { id, rec } of otherRes.items) {
          const existing = mergedById.get(id);
          if (!existing || (rec.mtimeMs || 0) > (existing.mtimeMs || 0)) {
            mergedById.set(id, rec);
          }
        }
        merged = otherRes.items.length > 0;
      }

      const combinedItems = Array.from(mergedById.values());

      const data = {
        ok: true,
        variant: VARIANT,
        merged,
        mergeEnabled: cfg.mergeVariantUsage === true,
        otherVariantMissing,
        scannedCount: combinedItems.length,
        updatedAtMs: Date.now(),
        heatmap: buildHeatmapGrid(combinedItems, 20),
        ranges: {
          all: buildRangeAggregate(combinedItems, 0),
          today: buildRangeAggregate(combinedItems, 1),
          '7d': buildRangeAggregate(combinedItems, 7),
          '30d': buildRangeAggregate(combinedItems, 30),
        },
      };
      usageSummaryCache = { at: Date.now(), origin, data, promise: null };
      return data;
    })();

    usageSummaryCache = {
      at: usageSummaryCache?.at || 0,
      origin,
      data: usageSummaryCache?.data || null,
      promise,
    };
    try {
      return await promise;
    } catch (err) {
      if (usageSummaryCache) usageSummaryCache.promise = null;
      return { ok: false, error: err?.message || String(err) };
    }
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

    reg('agy-telemetry:get-usage-summary', async (event, opts) => {
      const origin = assertLocalMainFrameOrigin(event);
      if (!origin) return { ok: false, error: 'Forbidden origin' };
      return await fetchUsageSummary(origin, opts?.force === true);
    });

    reg('agy-telemetry:open-local-file', async (event, opts) => {
      const origin = assertLocalMainFrameOrigin(event);
      if (!origin) return { ok: false, error: 'Forbidden origin' };
      return await handleOpenLocalFile(opts || {});
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
      const enhScript = fs.existsSync(ENHANCEMENTS_PATH) ? fs.readFileSync(ENHANCEMENTS_PATH, 'utf8') : '';
      const script = fs.readFileSync(OVERLAY_PATH, 'utf8');
      const initSnap = JSON.stringify(getAllSettingsSnapshot());
      const code = `${enhScript}\n;${script}\n;try{window.__AGY_ENHANCEMENTS__&&window.__AGY_ENHANCEMENTS__.applySettings(${initSnap});window.__AGY_TELEMETRY_UI__&&window.__AGY_TELEMETRY_UI__.init(${initSnap});}catch(e){console.error('[agy-telemetry]',e);}`;
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
