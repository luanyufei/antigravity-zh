#!/usr/bin/env python3
"""
Antigravity - Insiders Localization Manager & Update-Preserving Patcher (macOS)

Features:
  - Minimal, version-agnostic fail-safe bootstrap hook in app.asar (all logic & dicts externalized)
  - Atomic file replacement (safe even while Antigravity - Insiders is running)
  - Recomputes per-file ASAR SHA256 integrity blocks & Info.plist ElectronAsarIntegrity hash
  - Signs ONLY outer .app bundle with stable Apple Development / Code Signing identity
    (preserves all nested Google-signed frameworks, Helpers, Squirrel, language_server & TCC permissions)
  - Verifies Google's official downloaded update zip (codesign --verify --deep --strict + TeamIdentifier EQHXZ8M8AV)
    and cross-validates patched update against running app's Designated Requirement via Security.framework
  - Full reversible backup & one-command restore to bit-for-bit original Google-signed app
  - LaunchAgent WatchPaths safety net for manual DMG/ZIP updates
  - Instant live EN <-> ZH language switching from CLI, Menu Bar, Tray, Shortcut, or UI Pill
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
DEFAULT_APP_PATH = Path("/Applications/Antigravity - Insiders.app")
GOOGLE_TEAM_ID = "EQHXZ8M8AV"

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
        "appPath": str(DEFAULT_APP_PATH),
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
    pl_path = app_path / "Contents" / "Info.plist"
    pl = plistlib.loads(pl_path.read_bytes())
    return str(pl.get("CFBundleShortVersionString") or pl.get("CFBundleVersion") or "unknown")


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


def backup_original_app_files(app_path: Path, version: str) -> Path:
    """Save bit-for-bit originals of every file we touch (only when app is Google-signed & unpatched)."""
    bdir = BACKUPS_DIR / version
    if (bdir / "meta.json").exists():
        return bdir
    cs = get_codesign_info(app_path)
    if cs.get("team_id") != GOOGLE_TEAM_ID:
        log(f"Skipping original backup for {version}: current team_id={cs.get('team_id')} (not original Google signature)")
        return bdir

    bdir.mkdir(parents=True, exist_ok=True)
    rel_files = [
        "Contents/Resources/app.asar",
        "Contents/Info.plist",
        "Contents/MacOS/Antigravity - Insiders",
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
        json.dumps({"version": version, "team_id": cs["team_id"], "saved_at": time.time(), "files": saved}, indent=2),
        encoding="utf-8",
    )
    log(f"Saved original Google-signed backup for version {version} -> {bdir}")
    # Keep at most 3 most recent backups to avoid disk bloat
    try:
        all_backups = sorted(
            [d for d in BACKUPS_DIR.iterdir() if d.is_dir() and (d / "meta.json").exists()],
            key=lambda d: d.stat().st_mtime,
            reverse=True,
        )
        for stale in all_backups[3:]:
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
            f"No write permission on {app_path}. Run with elevated privileges or adjust ownership: "
            f'sudo chown -R "$(whoami):staff" "{app_path}"'
        )

    asar_path = app_path / "Contents" / "Resources" / "app.asar"
    plist_path = app_path / "Contents" / "Info.plist"
    version = get_app_version(app_path)

    if not force and is_asar_patched(asar_path):
        # Verify Info.plist hash & codesign still valid
        _, raw_json, _ = read_asar(asar_path)
        actual_hash = hashlib.sha256(raw_json).hexdigest()
        pl = plistlib.loads(plist_path.read_bytes())
        expected_hash = pl.get("ElectronAsarIntegrity", {}).get("Resources/app.asar", {}).get("hash", "")
        vchk = subprocess.run(["codesign", "--verify", str(app_path)], capture_output=True)
        if actual_hash == expected_hash and vchk.returncode == 0:
            return {"status": "already_patched", "version": version}

    # Backup original Google-signed files before modifying anything
    backup_original_app_files(app_path, version)

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

    log(f"Successfully patched & signed {app_path} (version={version}, identity={identity}, asar_sha256={new_asar_hash[:12]}...)")
    return {"status": "patched", "version": version, "identity": identity, "asar_hash": new_asar_hash}


def cmd_patch(args) -> int:
    cfg = load_config()
    app_path = Path(args.app or cfg.get("appPath") or DEFAULT_APP_PATH)
    I18N_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "w") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        res = inject_bootstrap_and_sign(app_path, cfg, force=args.force)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def cmd_patch_zip(args) -> int:
    """Called by MacUpdater hook to verify, pre-patch, re-sign, cross-validate, and re-zip Google's update."""
    cfg = load_config()
    in_zip = Path(args.input)
    out_zip = Path(args.output)
    running_app = Path(args.running_app or cfg.get("appPath") or DEFAULT_APP_PATH)

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
        if running_app.exists():
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

    log(f"patch-zip succeeded for version {res.get('version')} -> {out_zip}")
    print(json.dumps({"status": "ok", "version": res.get("version"), "output": str(out_zip)}, ensure_ascii=False))
    return 0


def cmd_restore(args) -> int:
    cfg = load_config()
    app_path = Path(args.app or cfg.get("appPath") or DEFAULT_APP_PATH)
    version = get_app_version(app_path)
    bdir = BACKUPS_DIR / version
    if not (bdir / "meta.json").exists():
        print(f"未找到版本 {version} 的原始备份目录：{bdir}", file=sys.stderr)
        return 1
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
    print(json.dumps({
        "status": "restored",
        "version": version,
        "codesign_valid": vp.returncode == 0,
        "team_id": cs.get("team_id"),
        "authority": cs.get("authorities", [""])[0] if cs.get("authorities") else "",
    }, ensure_ascii=False, indent=2))
    return 0 if vp.returncode == 0 else 1


def cmd_install_agent(_args) -> int:
    cfg = load_config()
    app_path = Path(cfg.get("appPath") or DEFAULT_APP_PATH)
    LAUNCH_AGENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    plist_obj = {
        "Label": LAUNCH_AGENT_LABEL,
        "ProgramArguments": ["/usr/bin/python3", str(I18N_DIR / "patcher.py"), "watch-trigger"],
        "WatchPaths": [
            str(app_path / "Contents" / "Info.plist"),
            str(app_path / "Contents" / "Resources" / "app.asar"),
        ],
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
        # Fallback for older launchctl behavior
        subprocess.run(["launchctl", "load", "-w", str(LAUNCH_AGENT_PATH)], capture_output=True)
    log(f"Installed and loaded LaunchAgent {LAUNCH_AGENT_LABEL}")
    print(f"LaunchAgent 已安装并启动: {LAUNCH_AGENT_PATH}")
    return 0


def cmd_uninstall_agent(_args) -> int:
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    LAUNCH_AGENT_PATH.unlink(missing_ok=True)
    print(f"LaunchAgent 已卸载: {LAUNCH_AGENT_LABEL}")
    return 0


def cmd_watch_trigger(_args) -> int:
    """Invoked automatically by macOS launchd whenever Antigravity - Insiders updates on disk."""
    cfg = load_config()
    if cfg.get("autoPatchOnUpdate") is False:
        return 0
    app_path = Path(cfg.get("appPath") or DEFAULT_APP_PATH)
    asar_path = app_path / "Contents" / "Resources" / "app.asar"
    if not asar_path.exists():
        return 0
    if is_asar_patched(asar_path):
        return 0
    # Wait briefly in case DMG copy / ShipIt swap is still settling
    time.sleep(0.5)
    if is_asar_patched(asar_path):
        return 0
    try:
        with open(LOCK_PATH, "w") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            if not is_asar_patched(asar_path):
                res = inject_bootstrap_and_sign(app_path, cfg, force=False)
                log(f"LaunchAgent auto-healed update: {res}")
    except Exception as e:
        log(f"LaunchAgent watch-trigger error: {e}")
    return 0


def cmd_lang(args) -> int:
    cfg = load_config()
    if args.locale == "toggle":
        next_locale = "en" if cfg.get("locale", "zh-CN") == "zh-CN" else "zh-CN"
    elif args.locale.lower() in ("zh", "zh-cn", "cn", "chinese"):
        next_locale = "zh-CN"
    elif args.locale.lower() in ("en", "en-us", "english"):
        next_locale = "en"
    else:
        print(f"不支持的语言: {args.locale}（可选：zh-CN / en / toggle）", file=sys.stderr)
        return 1
    cfg["locale"] = next_locale
    save_config(cfg)
    label = "简体中文 (zh-CN)" if next_locale == "zh-CN" else "English (en)"
    print(f"已切换语言为：{label}（运行中的 Antigravity - Insiders 将实时热更新，无需重启）")
    return 0


def cmd_status(_args) -> int:
    cfg = load_config()
    app_path = Path(cfg.get("appPath") or DEFAULT_APP_PATH)
    asar_path = app_path / "Contents" / "Resources" / "app.asar"
    plist_path = app_path / "Contents" / "Info.plist"
    version = get_app_version(app_path) if plist_path.exists() else "N/A"
    patched = is_asar_patched(asar_path) if asar_path.exists() else False
    cs = get_codesign_info(app_path) if app_path.exists() else {}
    vchk = subprocess.run(["codesign", "--verify", str(app_path)], capture_output=True)
    uid = os.getuid()
    la_chk = subprocess.run(["launchctl", "print", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    dict_data = json.loads((I18N_DIR / "dict" / "zh-CN.json").read_text(encoding="utf-8")) if (I18N_DIR / "dict" / "zh-CN.json").exists() else {}

    out = {
        "app_path": str(app_path),
        "app_version": version,
        "patched": patched,
        "locale": cfg.get("locale", "zh-CN"),
        "show_floating_toggle": cfg.get("showFloatingToggle", True),
        "auto_patch_on_update": cfg.get("autoPatchOnUpdate", True),
        "codesign_valid": vchk.returncode == 0,
        "signing_authority": cs.get("authorities", ["adhoc" if cs.get("adhoc") else "unknown"])[0] if cs else "unknown",
        "team_id": cs.get("team_id", ""),
        "launch_agent_loaded": la_chk.returncode == 0,
        "backup_available_for_current_version": (BACKUPS_DIR / version / "meta.json").exists(),
        "dict_exact_entries": len(dict_data.get("exact", {})),
        "dict_pattern_entries": len(dict_data.get("patterns", [])),
        "dict_menu_entries": len(dict_data.get("menus", {})),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="agy-i18n", description="Antigravity - Insiders 汉化与中英文实时切换管理工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_patch = sub.add_parser("patch", help="为 Antigravity - Insiders 注入轻量汉化引导并签名")
    p_patch.add_argument("--app", default=None)
    p_patch.add_argument("--force", action="store_true")
    p_patch.set_defaults(func=cmd_patch)

    p_pz = sub.add_parser("patch-zip", help="供自动更新拦截器使用：校验并预处理官方更新包")
    p_pz.add_argument("--input", required=True)
    p_pz.add_argument("--output", required=True)
    p_pz.add_argument("--running-app", default=None)
    p_pz.set_defaults(func=cmd_patch_zip)

    p_res = sub.add_parser("restore", help="从备份一键恢复 100% 原始 Google 签名版")
    p_res.add_argument("--app", default=None)
    p_res.set_defaults(func=cmd_restore)

    p_ia = sub.add_parser("install-agent", help="安装并启动 macOS LaunchAgent 更新守护")
    p_ia.set_defaults(func=cmd_install_agent)

    p_ua = sub.add_parser("uninstall-agent", help="卸载 macOS LaunchAgent 更新守护")
    p_ua.set_defaults(func=cmd_uninstall_agent)

    p_wt = sub.add_parser("watch-trigger", help="LaunchAgent 自动触发入口")
    p_wt.set_defaults(func=cmd_watch_trigger)

    p_lang = sub.add_parser("lang", help="实时切换中英文（zh-CN / en / toggle）")
    p_lang.add_argument("locale", help="zh-CN | en | toggle")
    p_lang.set_defaults(func=cmd_lang)

    p_st = sub.add_parser("status", help="查看当前汉化、签名、更新守护与词典状态")
    p_st.set_defaults(func=cmd_status)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
