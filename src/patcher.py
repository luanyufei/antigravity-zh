#!/usr/bin/env python3
"""
Antigravity (Insiders & Stable) Localization Manager & Update-Preserving Patcher (macOS)

Features:
  - Auto-detects installed Antigravity - Insiders.app and/or Antigravity.app on macOS
  - Minimal, version-agnostic fail-safe bootstrap hook in app.asar (all logic & dicts externalized)
  - Atomic file replacement (safe even while apps are running)
  - Recomputes per-file ASAR SHA256 integrity blocks & Info.plist ElectronAsarIntegrity hash
  - Signs ONLY outer .app bundle with stable Apple Development / Code Signing identity
    (preserves all nested Google-signed frameworks, Helpers, Squirrel, language_server & TCC permissions)
  - Verifies Google's official downloaded update zip (codesign --verify --deep --strict + TeamIdentifier EQHXZ8M8AV)
    and cross-validates patched update against running app's Designated Requirement via Security.framework
  - Per-app reversible backups & one-command restore to bit-for-bit original Google-signed apps
  - Dual-app LaunchAgent WatchPaths safety net for manual DMG/ZIP updates
  - Instant live EN <-> ZH language switching & macOS Vibrancy control
"""

import argparse
import ctypes
import fcntl
import hashlib
import json
import os
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

I18N_DIR = Path.home() / ".config" / "antigravity-insiders-i18n"
CONFIG_PATH = I18N_DIR / "config.json"
BACKUPS_DIR = I18N_DIR / "backups"
LOCK_PATH = I18N_DIR / ".patch.lock"
LOG_PATH = I18N_DIR / "i18n.log"
LAUNCH_AGENT_LABEL = "com.user.antigravity-insiders-i18n"
LAUNCH_AGENT_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
GOOGLE_TEAM_ID = "EQHXZ8M8AV"

KNOWN_APPS = [
    {
        "key": "insiders",
        "name": "Antigravity - Insiders",
        "bundle_id": "com.google.antigravity.insiders",
        "default_path": Path("/Applications/Antigravity - Insiders.app"),
    },
    {
        "key": "stable",
        "name": "Antigravity",
        "bundle_id": "com.google.antigravity",
        "default_path": Path("/Applications/Antigravity.app"),
    },
]
DEFAULT_APP_PATH = KNOWN_APPS[0]["default_path"]

MAIN_MARKER = "/* __AGY_INSIDERS_I18N_MAIN_V1__ */"
PRELOAD_MARKER = "/* __AGY_INSIDERS_I18N_PRELOAD_V1__ */"

MAIN_BOOTSTRAP = (
    f'{MAIN_MARKER} try {{ require(require("path").join(require("os").homedir(), '
    f'".config", "antigravity-insiders-i18n", "main-hook.js")); }} '
    f'catch (_agyI18nErr) {{ console.error("[agy-i18n] bootstrap skipped:", _agyI18nErr && _agyI18nErr.message); }}\n'
)

PRELOAD_BOOTSTRAP = f"""
{PRELOAD_MARKER}
try {{
  electron_1.contextBridge.exposeInMainWorld('__AGY_I18N_BRIDGE__', {{
    getState: () => electron_1.ipcRenderer.invoke('agy-i18n:get-state'),
    setLocale: (locale) => electron_1.ipcRenderer.invoke('agy-i18n:set-locale', locale),
    toggleLocale: () => electron_1.ipcRenderer.invoke('agy-i18n:toggle-locale'),
    setFloatingToggle: (show) => electron_1.ipcRenderer.invoke('agy-i18n:set-floating-toggle', show),
    onStateChanged: (cb) => {{
      const h = (_ev, st) => cb(st);
      electron_1.ipcRenderer.on('agy-i18n:state-changed', h);
      return () => electron_1.ipcRenderer.removeListener('agy-i18n:state-changed', h);
    }},
  }});
}} catch (_agyI18nPreloadErr) {{}}
"""


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"[{ts}] [patcher] {msg}\n"
    try:
        I18N_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "locale": "zh-CN",
        "showFloatingToggle": True,
        "autoPatchOnUpdate": True,
        "shortcut": "CmdOrCtrl+Option+L",
        "signingIdentity": "",
        "appPaths": [str(a["default_path"]) for a in KNOWN_APPS if a["default_path"].exists()],
    }


def save_config(cfg: dict) -> None:
    I18N_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)


def atomic_write_bytes(dest: Path, data: bytes, stat_src: Path = None) -> None:
    tmp = dest.parent / f".{dest.name}.tmp.{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    if stat_src is not None:
        shutil.copystat(stat_src, tmp)
    os.replace(tmp, dest)


def read_info_plist(app_path: Path) -> dict:
    pl_path = app_path / "Contents" / "Info.plist"
    if not pl_path.exists():
        return {}
    return plistlib.loads(pl_path.read_bytes())


def get_app_metadata(app_path: Path) -> dict:
    pl = read_info_plist(app_path)
    bundle_id = str(pl.get("CFBundleIdentifier") or "")
    name = str(pl.get("CFBundleDisplayName") or pl.get("CFBundleName") or app_path.stem)
    executable = str(pl.get("CFBundleExecutable") or app_path.stem)
    version = str(pl.get("CFBundleShortVersionString") or pl.get("CFBundleVersion") or "unknown")

    key = ""
    for k in KNOWN_APPS:
        if bundle_id == k["bundle_id"]:
            key = k["key"]
            break
    if not key:
        low = (bundle_id + " " + name + " " + app_path.name).lower()
        if "insider" in low:
            key = "insiders"
        elif "antigravity" in low:
            key = "stable"
        else:
            key = re.sub(r"[^a-z0-9]+", "-", app_path.stem.lower()).strip("-") or "app"

    return {
        "key": key,
        "name": name,
        "bundle_id": bundle_id,
        "executable": executable,
        "version": version,
        "path": app_path,
    }


def is_supported_asar_app(app_path: Path) -> bool:
    return (
        app_path.is_dir()
        and (app_path / "Contents" / "Info.plist").exists()
        and (app_path / "Contents" / "Resources" / "app.asar").exists()
    )


def detect_target_apps(cfg: dict, explicit_app: str = None) -> list:
    """Return list of target .app Paths. Auto-detects Insiders and Stable if explicit_app is omitted."""
    if explicit_app:
        return [Path(explicit_app)]

    candidates = []
    seen = set()

    def add_candidate(p: Path):
        try:
            rp = str(p.resolve())
        except Exception:
            rp = str(p)
        if rp not in seen:
            seen.add(rp)
            candidates.append(p)

    # Always check both standard macOS locations first
    for item in KNOWN_APPS:
        if is_supported_asar_app(item["default_path"]):
            add_candidate(item["default_path"])

    # Also honor any additional custom app paths recorded in config.json
    extra_paths = []
    if isinstance(cfg.get("appPaths"), list):
        extra_paths.extend(cfg["appPaths"])
    if isinstance(cfg.get("appPath"), str) and cfg["appPath"]:
        extra_paths.append(cfg["appPath"])
    for raw in extra_paths:
        p = Path(raw)
        if is_supported_asar_app(p):
            add_candidate(p)

    return candidates


def read_asar(asar_path: Path):
    with open(asar_path, "rb") as f:
        hdr = f.read(16)
        p1, hdr_size, p2, json_len = struct.unpack("<IIII", hdr)
        raw_json = f.read(json_len)
        tree = json.loads(raw_json.decode("utf-8"))
        f.seek(8 + hdr_size)
        payload = f.read()
    return tree, raw_json, payload


def get_asar_file_bytes(tree: dict, payload: bytes, rel_path: str) -> bytes:
    cur = tree
    for part in rel_path.split("/"):
        cur = cur["files"][part]
    off = int(cur["offset"])
    sz = int(cur["size"])
    return payload[off : off + sz]


def is_asar_patched(asar_path: Path) -> bool:
    try:
        tree, _, payload = read_asar(asar_path)
        main_js = get_asar_file_bytes(tree, payload, "dist/main.js").decode("utf-8", errors="replace")
        preload_js = get_asar_file_bytes(tree, payload, "dist/preload.js").decode("utf-8", errors="replace")
        return MAIN_MARKER in main_js and PRELOAD_MARKER in preload_js
    except Exception:
        return False


def get_app_version(app_path: Path) -> str:
    return get_app_metadata(app_path)["version"]


def get_codesign_info(app_path: Path) -> dict:
    p = subprocess.run(["codesign", "-dvvv", str(app_path)], capture_output=True, text=True)
    text = (p.stderr or "") + "\n" + (p.stdout or "")
    info = {"raw": text, "authorities": [], "team_id": "", "identifier": "", "adhoc": False}
    for line in text.splitlines():
        if line.startswith("Authority="):
            info["authorities"].append(line.split("=", 1)[1].strip())
        elif line.startswith("TeamIdentifier="):
            info["team_id"] = line.split("=", 1)[1].strip()
        elif line.startswith("Identifier="):
            info["identifier"] = line.split("=", 1)[1].strip()
        elif "Signature=adhoc" in line:
            info["adhoc"] = True
    return info


def discover_signing_identity(cfg: dict) -> str:
    """Choose a stable code-signing identity from Keychain (never random ad-hoc if a real cert exists)."""
    p = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], capture_output=True, text=True)
    lines = (p.stdout or "").splitlines()
    available = []
    for line in lines:
        m = re.match(r'\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"', line)
        if m:
            available.append((m.group(1).upper(), m.group(2)))

    preferred = (cfg.get("signingIdentity") or "").upper()
    if preferred:
        for sha1, name in available:
            if sha1 == preferred:
                return sha1
    for sha1, name in available:
        if "Apple Development" in name or "Developer ID Application" in name:
            return sha1
    if available:
        return available[0][0]
    return "-"


def verify_cross_build_signature(reference_app: Path, candidate_app: Path) -> int:
    """Simulate Squirrel.Mac: verify candidate_app satisfies reference_app's Designated Requirement."""
    sec = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    cf.CFURLCreateFromFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_bool]
    cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p
    sec.SecStaticCodeCreateWithPath.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
    sec.SecStaticCodeCreateWithPath.restype = ctypes.c_int32
    sec.SecCodeCopyDesignatedRequirement.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
    sec.SecCodeCopyDesignatedRequirement.restype = ctypes.c_int32
    sec.SecStaticCodeCheckValidityWithErrors.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    sec.SecStaticCodeCheckValidityWithErrors.restype = ctypes.c_int32

    def cfurl(p: Path):
        b = str(p).encode("utf-8")
        return cf.CFURLCreateFromFileSystemRepresentation(None, b, len(b), True)

    ref_sc, cand_sc, req = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    if sec.SecStaticCodeCreateWithPath(cfurl(reference_app), 0, ctypes.byref(ref_sc)) != 0:
        return -1
    if sec.SecStaticCodeCreateWithPath(cfurl(candidate_app), 0, ctypes.byref(cand_sc)) != 0:
        return -2
    if sec.SecCodeCopyDesignatedRequirement(ref_sc, 0, ctypes.byref(req)) != 0:
        return -3
    # kSecCSCheckNestedCode (8) | kSecCSStrictValidate (16) | kSecCSCheckAllArchitectures (1) = 25
    return int(sec.SecStaticCodeCheckValidityWithErrors(cand_sc, 25, req, None))


def resolve_backup_dir(app_key: str, version: str, for_read: bool = False) -> Path:
    """Namespaced per-app backup dir (`backups/<app_key>-<version>`), with legacy fallback for Insiders."""
    namespaced = BACKUPS_DIR / f"{app_key}-{version}"
    if for_read:
        if (namespaced / "meta.json").exists():
            return namespaced
        legacy = BACKUPS_DIR / version
        if app_key == "insiders" and (legacy / "meta.json").exists():
            return legacy
    return namespaced


def backup_original_app_files(app_path: Path, meta_info: dict) -> Path:
    """Save bit-for-bit originals of every file we touch (only when app is Google-signed & unpatched)."""
    app_key = meta_info["key"]
    version = meta_info["version"]
    executable = meta_info["executable"]

    existing = resolve_backup_dir(app_key, version, for_read=True)
    if (existing / "meta.json").exists():
        return existing

    bdir = resolve_backup_dir(app_key, version, for_read=False)
    cs = get_codesign_info(app_path)
    if cs.get("team_id") != GOOGLE_TEAM_ID:
        log(f"[{app_key}] Skipping original backup for {version}: current team_id={cs.get('team_id')} (not original Google signature)")
        return bdir

    bdir.mkdir(parents=True, exist_ok=True)
    rel_files = [
        "Contents/Resources/app.asar",
        "Contents/Info.plist",
        f"Contents/MacOS/{executable}",
        "Contents/_CodeSignature/CodeResources",
        "Contents/CodeResources",
    ]
    saved = []
    for rel in rel_files:
        src = app_path / rel
        if src.exists() and not src.is_symlink():
            dst = bdir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            saved.append(rel)
    (bdir / "meta.json").write_text(
        json.dumps(
            {
                "app_key": app_key,
                "app_name": meta_info["name"],
                "bundle_id": meta_info["bundle_id"],
                "version": version,
                "team_id": cs["team_id"],
                "saved_at": time.time(),
                "files": saved,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    log(f"[{app_key}] Saved original Google-signed backup for version {version} -> {bdir}")

    # Keep at most 3 most recent backups PER APP so Insiders daily builds never evict Stable backups
    try:
        same_app_backups = []
        for d in BACKUPS_DIR.iterdir():
            if not (d.is_dir() and (d / "meta.json").exists()):
                continue
            try:
                m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
                d_key = m.get("app_key") or "insiders"
            except Exception:
                d_key = "insiders"
            if d_key == app_key:
                same_app_backups.append(d)
        same_app_backups.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        for stale in same_app_backups[3:]:
            shutil.rmtree(stale, ignore_errors=True)
    except Exception:
        pass
    return bdir


def inject_bootstrap_and_sign(app_path: Path, cfg: dict, force: bool = False) -> dict:
    """Patch app.asar + Info.plist + sign outer bundle atomically."""
    if not app_path.exists():
        raise FileNotFoundError(f"App bundle not found: {app_path}")
    if not os.access(app_path, os.W_OK) or not os.access(app_path / "Contents" / "Resources", os.W_OK):
        raise PermissionError(
            f"无权修改 {app_path}（macOS「App 管理」隐私保护拦截了跨应用修改）。\n"
            f"解决方法（二选一）：\n"
            f"  1. 打开系统「终端 (Terminal.app)」直接运行：agy-i18n patch\n"
            f"  2. 或前往「系统设置 → 隐私与安全性 → App 管理」允许当前应用修改其他 App 后重试。"
        )

    meta_info = get_app_metadata(app_path)
    app_key = meta_info["key"]
    version = meta_info["version"]
    asar_path = app_path / "Contents" / "Resources" / "app.asar"
    plist_path = app_path / "Contents" / "Info.plist"

    if not force and is_asar_patched(asar_path):
        _, raw_json, _ = read_asar(asar_path)
        actual_hash = hashlib.sha256(raw_json).hexdigest()
        pl = plistlib.loads(plist_path.read_bytes())
        expected_hash = pl.get("ElectronAsarIntegrity", {}).get("Resources/app.asar", {}).get("hash", "")
        vchk = subprocess.run(["codesign", "--verify", str(app_path)], capture_output=True)
        if actual_hash == expected_hash and vchk.returncode == 0:
            return {
                "app_key": app_key,
                "app_name": meta_info["name"],
                "app_path": str(app_path),
                "status": "already_patched",
                "version": version,
            }

    # Backup original Google-signed files before modifying anything
    backup_original_app_files(app_path, meta_info)

    # Extract original entitlements BEFORE modifying anything
    ent_proc = subprocess.run(
        ["codesign", "-d", "--entitlements", "-", "--xml", str(app_path)],
        capture_output=True,
    )
    ent_xml = ent_proc.stdout if ent_proc.returncode == 0 and ent_proc.stdout.strip() else b""

    # Read & patch app.asar in memory
    tree, _, payload = read_asar(asar_path)
    entries = []

    def collect(node, parts=()):
        for k, v in node.get("files", {}).items():
            if "files" in v:
                collect(v, parts + (k,))
            elif "offset" in v and not v.get("unpacked"):
                entries.append((parts + (k,), v))

    collect(tree)

    new_parts = []
    cur = 0
    patched_main = False
    patched_preload = False

    for parts, meta in entries:
        blob = payload[int(meta["offset"]) : int(meta["offset"]) + int(meta["size"])]
        if parts == ("dist", "main.js"):
            text = blob.decode("utf-8")
            if MAIN_MARKER not in text:
                if text.startswith('"use strict";'):
                    text = '"use strict";\n' + MAIN_BOOTSTRAP + text[len('"use strict";'):]
                else:
                    text = MAIN_BOOTSTRAP + text
            blob = text.encode("utf-8")
            patched_main = True
        elif parts == ("dist", "preload.js"):
            text = blob.decode("utf-8")
            if PRELOAD_MARKER not in text:
                text = text.rstrip() + "\n" + PRELOAD_BOOTSTRAP
            blob = text.encode("utf-8")
            patched_preload = True

        meta["offset"] = str(cur)
        meta["size"] = len(blob)
        if "integrity" in meta:
            bs = int(meta["integrity"].get("blockSize", 4194304))
            meta["integrity"]["hash"] = hashlib.sha256(blob).hexdigest()
            if blob:
                meta["integrity"]["blocks"] = [
                    hashlib.sha256(blob[i : i + bs]).hexdigest() for i in range(0, len(blob), bs)
                ]
            else:
                meta["integrity"]["blocks"] = [hashlib.sha256(b"").hexdigest()]
        new_parts.append(blob)
        cur += len(blob)

    if not patched_main or not patched_preload:
        raise RuntimeError(f"Expected dist/main.js and dist/preload.js inside {asar_path}")

    new_json = json.dumps(tree, separators=(",", ":")).encode("utf-8")
    pad = (4 - (len(new_json) % 4)) % 4
    padded_json = new_json + b"\x00" * pad
    header = struct.pack("<IIII", 4, 8 + len(padded_json), 4 + len(padded_json), len(new_json)) + padded_json
    new_asar_hash = hashlib.sha256(new_json).hexdigest()

    # Atomic write app.asar
    asar_tmp = asar_path.parent / f".app.asar.tmp.{os.getpid()}"
    with open(asar_tmp, "wb") as f:
        f.write(header)
        for part in new_parts:
            f.write(part)
        f.flush()
        os.fsync(f.fileno())
    os.replace(asar_tmp, asar_path)

    # Atomic update Info.plist ElectronAsarIntegrity
    pl = plistlib.loads(plist_path.read_bytes())
    if "ElectronAsarIntegrity" in pl and "Resources/app.asar" in pl["ElectronAsarIntegrity"]:
        pl["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = new_asar_hash
        atomic_write_bytes(plist_path, plistlib.dumps(pl))

    # Sign ONLY outer bundle (NEVER --deep, preserving Google's nested frameworks/Helpers/language_server!)
    identity = discover_signing_identity(cfg)
    if identity != "-" and cfg.get("signingIdentity") != identity:
        cfg["signingIdentity"] = identity
        save_config(cfg)

    with tempfile.NamedTemporaryFile(suffix=".plist", delete=False) as tf:
        ent_file = Path(tf.name)
        tf.write(ent_xml)
    try:
        cmd = ["codesign", "--force", "--sign", identity]
        if ent_xml:
            cmd += ["--entitlements", str(ent_file)]
        cmd.append(str(app_path))
        sp = subprocess.run(cmd, capture_output=True, text=True)
        if sp.returncode != 0:
            raise RuntimeError(f"codesign failed ({sp.returncode}): {sp.stderr.strip()}")
    finally:
        ent_file.unlink(missing_ok=True)

    # Verify outer signature cleanly
    vp = subprocess.run(["codesign", "--verify", "--verbose=2", str(app_path)], capture_output=True, text=True)
    if vp.returncode != 0:
        raise RuntimeError(f"codesign --verify failed after signing: {vp.stderr.strip()}")

    log(f"[{app_key}] Successfully patched & signed {app_path} (version={version}, identity={identity}, asar_sha256={new_asar_hash[:12]}...)")
    return {
        "app_key": app_key,
        "app_name": meta_info["name"],
        "app_path": str(app_path),
        "status": "patched",
        "version": version,
        "identity": identity,
        "asar_hash": new_asar_hash,
    }


def cmd_patch(args) -> int:
    cfg = load_config()
    targets = detect_target_apps(cfg, explicit_app=args.app)
    if not targets:
        print(
            "未检测到已安装的 Antigravity - Insiders.app 或 Antigravity.app。\n"
            "如果安装在其他路径，请使用 --app \"/path/to/Antigravity.app\" 指定。",
            file=sys.stderr,
        )
        return 1

    I18N_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    had_error = False
    with open(LOCK_PATH, "w") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        for app_path in targets:
            try:
                results.append(inject_bootstrap_and_sign(app_path, cfg, force=args.force))
            except Exception as exc:
                had_error = True
                meta = get_app_metadata(app_path)
                results.append({
                    "app_key": meta["key"],
                    "app_name": meta["name"],
                    "app_path": str(app_path),
                    "status": "error",
                    "error": str(exc),
                })

    cfg["appPaths"] = [str(p) for p in targets]
    save_config(cfg)
    print(json.dumps(results[0] if len(results) == 1 and args.app else {"apps": results}, ensure_ascii=False, indent=2))
    return 1 if had_error else 0


def cmd_patch_zip(args) -> int:
    """Called by MacUpdater hook to verify, pre-patch, re-sign, cross-validate, and re-zip Google's update."""
    cfg = load_config()
    in_zip = Path(args.input)
    out_zip = Path(args.output)
    running_app = Path(args.running_app) if args.running_app else None

    if not in_zip.exists():
        raise FileNotFoundError(f"Input zip not found: {in_zip}")

    with tempfile.TemporaryDirectory(prefix="agy-i18n-upd-") as tmpdir:
        tmp = Path(tmpdir)
        extract_dir = tmp / "extracted"
        extract_dir.mkdir()
        p = subprocess.run(["ditto", "-x", "-k", str(in_zip), str(extract_dir)], capture_output=True, text=True)
        if p.returncode != 0:
            raise RuntimeError(f"ditto extract failed: {p.stderr.strip()}")

        apps = list(extract_dir.glob("*.app"))
        if not apps:
            raise RuntimeError("No .app bundle found inside downloaded update zip")
        upd_app = apps[0]
        upd_meta = get_app_metadata(upd_app)

        if running_app is None:
            for item in KNOWN_APPS:
                if item["key"] == upd_meta["key"]:
                    running_app = item["default_path"]
                    break

        # 1. Security verification: Ensure the update is genuinely Google-signed before touching it!
        verify_orig = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(upd_app)], capture_output=True, text=True)
        if verify_orig.returncode != 0:
            raise RuntimeError(f"Downloaded update failed original codesign check: {verify_orig.stderr.strip()}")
        cs_orig = get_codesign_info(upd_app)
        if cs_orig.get("team_id") != GOOGLE_TEAM_ID:
            raise RuntimeError(f"Unexpected update TeamIdentifier: {cs_orig.get('team_id')} (expected {GOOGLE_TEAM_ID})")

        # 2. Patch + re-sign with same stable signing identity
        with open(LOCK_PATH, "w") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            res = inject_bootstrap_and_sign(upd_app, cfg, force=True)

        # 3. Cross-validate against currently running app's Designated Requirement (exact Squirrel.Mac check!)
        if running_app and running_app.exists():
            rc = verify_cross_build_signature(running_app, upd_app)
            if rc != 0:
                raise RuntimeError(
                    f"Patched update failed cross-build signature check against running app (OSStatus={rc}). "
                    f"Ensure both use the same Apple Development signing identity."
                )

        # 4. Re-zip cleanly preserving macOS symlinks, permissions, and bundle metadata
        out_tmp = out_zip.parent / f".{out_zip.name}.tmp.{os.getpid()}"
        zp = subprocess.run(["ditto", "-c", "-k", "--keepParent", str(upd_app), str(out_tmp)], capture_output=True, text=True)
        if zp.returncode != 0:
            raise RuntimeError(f"ditto re-zip failed: {zp.stderr.strip()}")
        os.replace(out_tmp, out_zip)

    log(f"[{upd_meta['key']}] patch-zip succeeded for version {res.get('version')} -> {out_zip}")
    print(json.dumps({"status": "ok", "app_key": upd_meta["key"], "version": res.get("version"), "output": str(out_zip)}, ensure_ascii=False))
    return 0


def restore_single_app(app_path: Path) -> dict:
    meta_info = get_app_metadata(app_path)
    app_key = meta_info["key"]
    version = meta_info["version"]
    bdir = resolve_backup_dir(app_key, version, for_read=True)
    if not (bdir / "meta.json").exists():
        return {
            "app_key": app_key,
            "app_name": meta_info["name"],
            "app_path": str(app_path),
            "status": "backup_not_found",
            "version": version,
            "backup_dir": str(bdir),
        }
    meta = json.loads((bdir / "meta.json").read_text(encoding="utf-8"))
    with open(LOCK_PATH, "w") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        for rel in meta.get("files", []):
            src = bdir / rel
            dst = app_path / rel
            if src.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_bytes(dst, src.read_bytes(), stat_src=src)

    vp = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app_path)], capture_output=True, text=True)
    cs = get_codesign_info(app_path)
    return {
        "app_key": app_key,
        "app_name": meta_info["name"],
        "app_path": str(app_path),
        "status": "restored",
        "version": version,
        "codesign_valid": vp.returncode == 0,
        "team_id": cs.get("team_id"),
        "authority": cs.get("authorities", [""])[0] if cs.get("authorities") else "",
    }


def cmd_restore(args) -> int:
    cfg = load_config()
    targets = detect_target_apps(cfg, explicit_app=args.app)
    if not targets:
        print("未检测到可还原的 Antigravity 应用。", file=sys.stderr)
        return 1
    results = [restore_single_app(p) for p in targets]
    print(json.dumps(results[0] if len(results) == 1 and args.app else {"apps": results}, ensure_ascii=False, indent=2))
    ok = all(r.get("status") == "restored" and r.get("codesign_valid") for r in results)
    return 0 if ok else 1


def cmd_install_agent(_args) -> int:
    cfg = load_config()
    watch_paths = []
    seen = set()

    def add_app_watches(p: Path):
        for rel in ("Contents/Info.plist", "Contents/Resources/app.asar"):
            s = str(p / rel)
            if s not in seen:
                seen.add(s)
                watch_paths.append(s)

    # Always watch both standard macOS app paths (so installing the other variant later also auto-heals)
    for item in KNOWN_APPS:
        add_app_watches(item["default_path"])
    for p in detect_target_apps(cfg):
        add_app_watches(p)

    LAUNCH_AGENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    plist_obj = {
        "Label": LAUNCH_AGENT_LABEL,
        "ProgramArguments": ["/usr/bin/python3", str(I18N_DIR / "patcher.py"), "watch-trigger"],
        "WatchPaths": watch_paths,
        "RunAtLoad": True,
        "ThrottleInterval": 2,
        "StandardOutPath": str(I18N_DIR / "agent.out.log"),
        "StandardErrorPath": str(I18N_DIR / "agent.err.log"),
    }
    atomic_write_bytes(LAUNCH_AGENT_PATH, plistlib.dumps(plist_obj))
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    bp = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(LAUNCH_AGENT_PATH)], capture_output=True, text=True)
    if bp.returncode != 0:
        subprocess.run(["launchctl", "load", "-w", str(LAUNCH_AGENT_PATH)], capture_output=True)
    log(f"Installed and loaded dual-app LaunchAgent {LAUNCH_AGENT_LABEL} (watching {len(watch_paths)} paths)")
    print(f"LaunchAgent 已安装并启动: {LAUNCH_AGENT_PATH}")
    return 0


def cmd_uninstall_agent(_args) -> int:
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    LAUNCH_AGENT_PATH.unlink(missing_ok=True)
    print(f"LaunchAgent 已卸载: {LAUNCH_AGENT_LABEL}")
    return 0


def cmd_watch_trigger(_args) -> int:
    """Invoked automatically by macOS launchd whenever Antigravity / Insiders updates on disk."""
    cfg = load_config()
    if cfg.get("autoPatchOnUpdate") is False:
        return 0
    targets = detect_target_apps(cfg)
    for app_path in targets:
        asar_path = app_path / "Contents" / "Resources" / "app.asar"
        if not asar_path.exists() or is_asar_patched(asar_path):
            continue
        # Wait briefly in case DMG copy / ShipIt swap is still settling
        time.sleep(0.5)
        if is_asar_patched(asar_path):
            continue
        try:
            with open(LOCK_PATH, "w") as lf:
                fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
                if not is_asar_patched(asar_path):
                    res = inject_bootstrap_and_sign(app_path, cfg, force=False)
                    log(f"LaunchAgent auto-healed update: {res}")
        except Exception as e:
            log(f"LaunchAgent watch-trigger error on {app_path}: {e}")
    return 0


def app_state_path(app_key: str) -> Path:
    return I18N_DIR / f"state-{app_key}.json"


def load_app_state(app_key: str, global_cfg: dict) -> dict:
    p = app_state_path(app_key)
    if p.exists():
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            return {
                "locale": "en" if raw.get("locale") == "en" else "zh-CN",
                "showFloatingToggle": raw.get("showFloatingToggle") is not False,
            }
        except Exception:
            pass
    return {
        "locale": "en" if global_cfg.get("locale") == "en" else "zh-CN",
        "showFloatingToggle": global_cfg.get("showFloatingToggle") is not False,
    }


def save_app_state(app_key: str, state: dict) -> None:
    I18N_DIR.mkdir(parents=True, exist_ok=True)
    p = app_state_path(app_key)
    tmp = p.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, p)


def load_app_vibrancy(app_key: str) -> dict:
    plugin_dir = I18N_DIR / "local-plugins"
    p = plugin_dir / f"vibrancy-{app_key}.json"
    if not p.exists() and app_key == "insiders":
        legacy = plugin_dir / "vibrancy.json"
        if legacy.exists():
            p = legacy
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"enabled": True, "material": "fullscreen-ui", "opacity": 0.55}


def cmd_lang(args) -> int:
    cfg = load_config()
    target = (args.target or "all").lower()
    if target == "all":
        keys = [get_app_metadata(p)["key"] for p in detect_target_apps(cfg)] or ["insiders", "stable"]
    elif target in ("insiders", "stable"):
        keys = [target]
    else:
        print(f"不支持的目标应用: {args.target}（可选：all / insiders / stable）", file=sys.stderr)
        return 1

    for key in keys:
        st = load_app_state(key, cfg)
        if args.locale == "toggle":
            next_locale = "en" if st["locale"] == "zh-CN" else "zh-CN"
        elif args.locale.lower() in ("zh", "zh-cn", "cn", "chinese"):
            next_locale = "zh-CN"
        elif args.locale.lower() in ("en", "en-us", "english"):
            next_locale = "en"
        else:
            print(f"不支持的语言: {args.locale}（可选：zh-CN / en / toggle）", file=sys.stderr)
            return 1
        st["locale"] = next_locale
        save_app_state(key, st)
        label = "简体中文 (zh-CN)" if next_locale == "zh-CN" else "English (en)"
        print(f"[{key}] 已切换语言为：{label}（实时热更新，无需重启）")
    return 0


def cmd_status(_args) -> int:
    cfg = load_config()
    targets = detect_target_apps(cfg)
    uid = os.getuid()
    la_chk = subprocess.run(["launchctl", "print", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    dict_data = json.loads((I18N_DIR / "dict" / "zh-CN.json").read_text(encoding="utf-8")) if (I18N_DIR / "dict" / "zh-CN.json").exists() else {}

    apps_status = []
    for app_path in targets:
        meta = get_app_metadata(app_path)
        asar_path = app_path / "Contents" / "Resources" / "app.asar"
        patched = is_asar_patched(asar_path) if asar_path.exists() else False
        cs = get_codesign_info(app_path)
        vchk = subprocess.run(["codesign", "--verify", str(app_path)], capture_output=True)
        bdir = resolve_backup_dir(meta["key"], meta["version"], for_read=True)
        app_st = load_app_state(meta["key"], cfg)
        apps_status.append({
            "app_key": meta["key"],
            "app_name": meta["name"],
            "bundle_id": meta["bundle_id"],
            "app_path": str(app_path),
            "app_version": meta["version"],
            "patched": patched,
            "locale": app_st["locale"],
            "show_floating_toggle": app_st["showFloatingToggle"],
            "vibrancy": load_app_vibrancy(meta["key"]),
            "codesign_valid": vchk.returncode == 0,
            "signing_authority": cs.get("authorities", ["adhoc" if cs.get("adhoc") else "unknown"])[0] if cs else "unknown",
            "team_id": cs.get("team_id", ""),
            "backup_available_for_current_version": (bdir / "meta.json").exists(),
        })

    out = {
        "detected_apps": len(apps_status),
        "apps": apps_status,
        "auto_patch_on_update": cfg.get("autoPatchOnUpdate", True),
        "launch_agent_loaded": la_chk.returncode == 0,
        "dict_exact_entries": len(dict_data.get("exact", {})),
        "dict_pattern_entries": len(dict_data.get("patterns", [])),
        "dict_menu_entries": len(dict_data.get("menus", {})),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="agy-i18n",
        description="Antigravity / Antigravity - Insiders 汉化与毛玻璃管理工具（自动检测双版本）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_patch = sub.add_parser("patch", help="自动检测并为已安装的 Antigravity / Insiders 注入引导并签名")
    p_patch.add_argument("--app", default=None, help="可选：只处理指定 .app 路径")
    p_patch.add_argument("--force", action="store_true")
    p_patch.set_defaults(func=cmd_patch)

    p_pz = sub.add_parser("patch-zip", help="供自动更新拦截器使用：校验并预处理官方更新包")
    p_pz.add_argument("--input", required=True)
    p_pz.add_argument("--output", required=True)
    p_pz.add_argument("--running-app", default=None)
    p_pz.set_defaults(func=cmd_patch_zip)

    p_res = sub.add_parser("restore", help="从备份一键恢复 100% 原始 Google 签名版")
    p_res.add_argument("--app", default=None, help="可选：只还原指定 .app 路径")
    p_res.set_defaults(func=cmd_restore)

    p_ia = sub.add_parser("install-agent", help="安装并启动 macOS LaunchAgent 双版本更新守护")
    p_ia.set_defaults(func=cmd_install_agent)

    p_ua = sub.add_parser("uninstall-agent", help="卸载 macOS LaunchAgent 更新守护")
    p_ua.set_defaults(func=cmd_uninstall_agent)

    p_wt = sub.add_parser("watch-trigger", help="LaunchAgent 自动触发入口")
    p_wt.set_defaults(func=cmd_watch_trigger)

    p_lang = sub.add_parser("lang", help="实时切换中英文（zh-CN / en / toggle，可按应用独立切换）")
    p_lang.add_argument("locale", help="zh-CN | en | toggle")
    p_lang.add_argument("--target", default="all", choices=["all", "insiders", "stable"], help="切换目标应用（默认 all）")
    p_lang.set_defaults(func=cmd_lang)

    p_st = sub.add_parser("status", help="查看所有已检测应用的汉化、签名、更新守护与词典状态")
    p_st.set_defaults(func=cmd_status)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
