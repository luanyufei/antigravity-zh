'use strict';

/**
 * Lightweight dynamic preload for antigravity-zh telemetry & unified settings.
 * Registered via Electron session.registerPreloadScript (never touches app.asar).
 * Runs ONLY on loopback Hub main frames (127.0.0.1 / localhost).
 */

const { contextBridge, ipcRenderer } = require('electron');

(function initAgyTelemetryPreload() {
  try {
    if (typeof window === 'undefined' || !window.location) return;
    const host = window.location.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return;
    if (window.self !== window.top) return;
    if (globalThis.__AGY_TELEMETRY_PRELOAD_DONE__) return;
    globalThis.__AGY_TELEMETRY_PRELOAD_DONE__ = true;

    contextBridge.exposeInMainWorld('__AGY_TELEMETRY_API__', {
      getSnapshot: (opts) => ipcRenderer.invoke('agy-telemetry:get-snapshot', opts || {}),
      getQuota: (opts) => ipcRenderer.invoke('agy-telemetry:get-quota', opts || {}),
      getUsageSummary: (opts) => ipcRenderer.invoke('agy-telemetry:get-usage-summary', opts || {}),
      openLocalFile: (opts) => ipcRenderer.invoke('agy-telemetry:open-local-file', opts || {}),
      getAllSettings: () => ipcRenderer.invoke('agy-settings:get-all'),
      setLocale: (locale) => ipcRenderer.invoke('agy-settings:set-locale', locale),
      setFloatingButton: (show) => ipcRenderer.invoke('agy-settings:set-floating', Boolean(show)),
      setVibrancy: (patch) => ipcRenderer.invoke('agy-settings:set-vibrancy', patch || {}),
      setTelemetry: (patch) => ipcRenderer.invoke('agy-settings:set-telemetry', patch || {}),
      onSettingsChanged: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const handler = (_ev, payload) => {
          try { cb(payload); } catch (_e) {}
        };
        ipcRenderer.on('agy-settings:changed', handler);
        return () => ipcRenderer.removeListener('agy-settings:changed', handler);
      },
      onOpenSettings: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const handler = () => {
          try { cb(); } catch (_e) {}
        };
        ipcRenderer.on('agy-settings:open', handler);
        return () => ipcRenderer.removeListener('agy-settings:open', handler);
      },
    });
  } catch (_e) {}
})();
