

"""."""






















import http.client
import json
import mimetypes
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BRIDGE_VERSION = "3.30.0"
PORTS = [8765, 8766, 8767, 8768, 8769, 8770]
WEB_URL = "https://jingeun-git.github.io/eia-workbench/"







LOCAL_WEB = False
WEB_ROOT = None


def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent

BRIDGE_DIR = _base_dir()



_LOG_CAP = 3_000_000

class _Tee:
    def __init__(self, stream, path):
        self._s = stream
        try:
            self._f = open(path, "a", encoding="utf-8", errors="replace")
        except Exception:
            self._f = None

    def write(self, t):
        if self._s:
            try: self._s.write(t)
            except Exception: pass
        if self._f:
            try:
                if self._f.tell() < _LOG_CAP:
                    self._f.write(t); self._f.flush()
            except Exception: pass
        return len(t)

    def flush(self):
        for x in (self._s, self._f):
            try: x and x.flush()
            except Exception: pass


if getattr(sys, "frozen", False):
    _logp = BRIDGE_DIR / "bridge.log"




    try:
        _logp.write_text("", encoding="utf-8")
    except Exception:
        pass
    sys.stdout = _Tee(sys.stdout, _logp)
    sys.stderr = _Tee(sys.stderr, _logp)
TOOLS_DIR  = BRIDGE_DIR.parent.parent
CONFIG     = BRIDGE_DIR / "bridge_config.json"




try:
    sys.path.insert(0, str(next(p for p in BRIDGE_DIR.resolve().parents
                                if (p / "CLAUDE_folder.md").exists())))
    from claude_paths import resolve as _resolve
    CONVERT_DIR  = _resolve("convert_core").parent
    EIASS_DIR    = _resolve("eiass_doc_resolver").parent
    HWP2PDF_DIR  = _resolve("hwp2pdf_core").parent
    PDF2XLSX_DIR = _resolve("pdf2excel_core").parent
except Exception:
    CONVERT_DIR  = TOOLS_DIR / "convert_to_md"
    EIASS_DIR    = TOOLS_DIR / "EIASS"
    HWP2PDF_DIR  = TOOLS_DIR / "hwp2pdf"
    PDF2XLSX_DIR = TOOLS_DIR / "pdf2excel"




PAGENUM_MOD  = BRIDGE_DIR / "hwp_pagenum.py"
RESOLVER     = EIASS_DIR / "eiass_doc_resolver.py"





PROXY_HOSTS = ("apis.data.go.kr",)

for p in (BRIDGE_DIR, CONVERT_DIR, HWP2PDF_DIR, EIASS_DIR, PDF2XLSX_DIR):
    if p.exists():
        sys.path.insert(0, str(p))

IS_WINDOWS = os.name == "nt"









_FROZEN = getattr(sys, "frozen", False)
LICENSE_DIR = BRIDGE_DIR / "license"
if LICENSE_DIR.exists():
    sys.path.insert(0, str(LICENSE_DIR))



LICENSE_ASSETS = (Path(sys._MEIPASS) / "license") if _FROZEN else LICENSE_DIR



ALLOWLIST_URL = os.environ.get("EIAWB_ALLOWLIST_URL", "")


_DEFAULT_CACHE = (Path(sys.executable).parent / ".nodelock_cache") if _FROZEN \
    else (LICENSE_DIR / ".cache")
NODELOCK_CACHE = Path(os.environ.get("EIAWB_NODELOCK_CACHE", str(_DEFAULT_CACHE)))


NODELOCK = {"ok": True, "reason": "unevaluated", "fp": "", "fp_display": ""}


def _gate_active() -> bool:
    """."""





    flag = os.environ.get("EIAWB_NODELOCK")
    if flag == "0":
        return False
    if flag == "1":
        return True
    if os.environ.get("EIAWB_CBUNDLE") == "1":
        return True
    return getattr(sys, "frozen", False)


def evaluate_nodelock() -> dict:
    """."""






    if not _gate_active():
        NODELOCK.update({"ok": True, "reason": "dev_bypass",
                         "fp": "", "fp_display": ""})
        return NODELOCK
    if os.environ.get("EIAWB_CBUNDLE") == "1":
        ok = os.environ.get("EIAWB_GATE_OK") == "1"
        NODELOCK.update({
            "ok": ok,
            "reason": "cbundle_gate_ok" if ok else "cbundle_gate_denied",
            "fp": "", "fp_display": os.environ.get("EIAWB_GATE_FP", "")})
        return NODELOCK
    try:
        import fingerprint as _fpmod
        import nodelock as _nl
        fp = _fpmod.compute_fingerprint()
        d = _nl.authorize(ALLOWLIST_URL, NODELOCK_CACHE, fp)
        NODELOCK.update({"ok": bool(d["ok"]), "reason": d["reason"],
                         "fp": fp, "fp_display": _fpmod.format_fp(fp)})
    except Exception as e:

        NODELOCK.update({"ok": False, "reason": f"nodelock_error: {e}",
                         "fp": "", "fp_display": ""})
    return NODELOCK


def detect_features():
    feats = {"convert": False, "ocr": False, "eiass": False,
             "hwp2pdf": False, "pagenum": False, "pdf2excel": False,
             "photo": False,



             "job_cancel": True}
    try:
        import pdf2excel_core
        feats["pdf2excel"] = True
    except Exception:
        pass
    try:
        import photo_exif
        feats["photo"] = True
    except Exception:
        pass
    try:
        import convert_core
        feats["convert"] = True
        feats["ocr"] = bool(getattr(convert_core, "_HAS_OCR", False))
    except Exception:
        pass



    try:
        import eiass_doc_resolver
        feats["eiass"] = True
    except Exception:
        feats["eiass"] = RESOLVER.exists()
    if IS_WINDOWS:
        try:
            import hwp2pdf_core
            feats["hwp2pdf"] = True
        except Exception:
            pass


        try:
            import hwp_pagenum
            feats["pagenum"] = True
        except Exception:
            feats["pagenum"] = PAGENUM_MOD.exists()
    return feats

def detect_deps():
    """."""










    out = {}
    for mod in ("pyproj", "pillow_heif", "pandas", "fitz", "pdfplumber"):
        try:
            __import__(mod)
            out[mod] = True
        except Exception:
            out[mod] = False
    return out


_PROXY_LOCK = threading.Lock()
_PROXY_CONN = {}
PROXY_CONN_TIMEOUT = 25
PROXY_BUDGET_SEC = 40


def proxy_get(target: str):
    """."""














    from urllib.parse import urlparse as _up
    u = _up(target)
    if u.scheme != "https" or u.hostname not in PROXY_HOSTS:
        raise RuntimeError(f"허용되지 않은 대상: {u.scheme}://{u.hostname}")

    path = u.path + ("?" + u.query if u.query else "")
    headers = {"Accept": "*/*",
               "User-Agent": "Mozilla/5.0 (compatible; EIA-Workbench-Bridge)"}
    last = None
    with _PROXY_LOCK:
        deadline = time.time() + PROXY_BUDGET_SEC
        for attempt in range(4):
            remain = deadline - time.time()
            if remain <= 0:
                last = last or f"제한시간 {PROXY_BUDGET_SEC}초 초과"
                break
            conn = _PROXY_CONN.get(u.hostname)
            if conn is None:

                conn = http.client.HTTPSConnection(
                    u.hostname, timeout=min(PROXY_CONN_TIMEOUT, remain))
                _PROXY_CONN[u.hostname] = conn
            try:
                conn.request("GET", path, headers=headers)
                resp = conn.getresponse()
                body = resp.read()
                if body:
                    return body, resp.getheader("Content-Type", "application/xml")
                last = f"빈 응답 (HTTP {resp.status})"
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
                try: conn.close()
                except Exception: pass
                _PROXY_CONN.pop(u.hostname, None)
            if attempt < 3:

                time.sleep(max(0.0, min(0.5 * (2 ** attempt),
                                        deadline - time.time())))
    raise RuntimeError(f"상위 API 응답 실패 — {last}")



def load_config():
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text(encoding="utf-8"))
        except Exception:
            pass
    cfg = {"token": secrets.token_urlsafe(24)}
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg

CFG = load_config()
TOKEN = CFG["token"]


ALLOWED_ROOTS: list[Path] = []
JOBS: dict[str, dict] = {}
JOB_QUEUE: list[str] = []
JOB_LOCK = threading.Lock()






LAST_SEEN = time.time()
IDLE_EXIT_SEC = 90
BYE_GRACE_SEC = 8


BYE_AT = 0.0


def path_allowed(p: Path) -> bool:
    try:
        rp = p.resolve()
    except Exception:
        return False





    return any(rp == root or rp.is_relative_to(root) for root in ALLOWED_ROOTS)

def job_log(job, msg):
    job["log"].append(str(msg))


JOB_KEEP = 40


def _prune_jobs():
    """."""









    done = [i for i, j in JOBS.items()
            if j.get("status") in ("done", "error", "cancelled")]
    for job_id in done[:-JOB_KEEP] if len(done) > JOB_KEEP else []:
        JOBS.pop(job_id, None)













def kill_automation_hwp() -> int:
    """."""
    if sys.platform != "win32":
        return 0
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name='Hwp.exe'\" | "
        "Where-Object { $_.CommandLine -match '-Automation|-Embedding' } | "
        "ForEach-Object { $_.ProcessId }"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        pids = [int(t) for t in out.stdout.split() if t.strip().isdigit()]
    except Exception:
        return 0
    killed = 0
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                           capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            killed += 1
        except Exception:
            pass
    return killed


def cancel_job(job_id: str) -> dict:
    """."""




    job = JOBS.get(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}



    if job["status"] in ("done", "error", "cancelled"):
        return {"ok": True, "was": job["status"], "hwp_killed": 0,
                "already_finished": True}
    job["cancel"] = True
    with JOB_LOCK:
        if job_id in JOB_QUEUE:
            JOB_QUEUE.remove(job_id)
            job["status"] = "cancelled"
            job_log(job, "─── 사용자 취소 — 대기 중이던 작업을 큐에서 제거했습니다")
            return {"ok": True, "was": "queued", "hwp_killed": 0}
    killed = kill_automation_hwp() if job["status"] == "running" else 0
    if killed:
        job_log(job, f"─── 사용자 취소 — 한컴 {killed}개를 종료했습니다"
                     " (여기까지 만들어진 파일은 그대로 남습니다)")
    else:
        job_log(job, "─── 사용자 취소 — 진행 중인 단계가 끝나면 멈춥니다")
    return {"ok": True, "was": job["status"], "hwp_killed": killed}


def cancel_all_jobs() -> dict:
    """."""
    ids = [i for i, j in JOBS.items() if j.get("status") in ("queued", "running")]
    for i in ids:
        JOBS[i]["cancel"] = True
    with JOB_LOCK:
        JOB_QUEUE.clear()
    killed = kill_automation_hwp() if ids else 0
    return {"jobs": len(ids), "hwp_killed": killed}


def pick_dialog(kind: str, patterns=None, initial=None, initial_dir=None):
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if kind == "folder":
            path = filedialog.askdirectory(title="EIA Workbench — 폴더 선택")
            paths = [path] if path else []
        elif kind == "save":


            ft = patterns if isinstance(patterns, list) else [("모든 파일", "*.*")]
            ft = [tuple(x) for x in ft] + [("모든 파일", "*.*")]
            path = filedialog.asksaveasfilename(
                title="EIA Workbench — 저장 위치 지정",
                defaultextension=ft[0][1].replace("*", "") if ft else "",
                initialfile=initial or "",
                initialdir=initial_dir or "",
                filetypes=ft)
            paths = [path] if path else []
        else:
            ft = [("대상 파일", patterns or "*.*"), ("모든 파일", "*.*")]
            paths = list(filedialog.askopenfilenames(title="EIA Workbench — 파일 선택", filetypes=ft))
    finally:
        root.destroy()
    return paths


def run_convert(job, params):
    import convert_core
    paths = [Path(p) for p in params.get("paths", [])]






    _supported = convert_core.SUPPORTED - {".hwp"}
    files, skipped_hwp = [], []
    for p in paths:
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                ext = f.suffix.lower()
                if ext in _supported:
                    files.append(f)
                elif ext == ".hwp":
                    skipped_hwp.append(f)
        elif p.suffix.lower() in _supported:
            files.append(p)
        elif p.suffix.lower() == ".hwp":
            skipped_hwp.append(p)
    if skipped_hwp:
        job_log(job, f"─── 구형 HWP(.hwp) {len(skipped_hwp)}건은 건너뜁니다 —"
                     " 한글에서 HWPX로 저장한 뒤 다시 변환해 주세요")
        for f in skipped_hwp[:10]:
            job_log(job, f"    · {f.name}")
        if len(skipped_hwp) > 10:
            job_log(job, f"    · … 외 {len(skipped_hwp) - 10}건")
    if not files:
        if skipped_hwp:
            raise RuntimeError(
                f"변환 대상이 구형 HWP(.hwp) {len(skipped_hwp)}건뿐입니다 — "
                "한글에서 HWPX로 저장한 뒤 다시 시도해 주세요")
        raise RuntimeError("변환 대상 파일이 없습니다 (지원: pdf·xlsx·xls·docx·hwpx)")
    out_dir = Path(params.get("out_dir") or (files[0].parent / "markdown_output"))
    if not path_allowed(out_dir.parent if not out_dir.exists() else out_dir):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    total = len(files)
    ok = err = 0
    for i, src in enumerate(files, 1):
        if job.get("cancel"):
            job_log(job, f"─── 사용자 취소 — {i - 1}/{total}개까지 변환됨"
                         f"(성공 {ok} / 실패 {err}) → {out_dir}")
            return
        job["progress"] = {"done": i - 1, "total": total, "stage": src.name}
        job_log(job, f"[{i}/{total}] {src.name}")
        success, result = convert_core.convert_file(src, out_dir)
        if success:
            ok += 1
            job_log(job, f"  ✓ {Path(result).name}")
        else:
            err += 1
            job_log(job, f"  ✗ {result}")
    job["progress"] = {"done": total, "total": total, "stage": "완료"}
    job_log(job, f"─── 변환 완료: 성공 {ok} / 실패 {err} → {out_dir}")

def run_eiass_dl(job, params):
    """."""

    import eiass_doc_resolver as edr
    code = params["code"].strip().upper()
    out_root = Path(params["out_dir"])
    if not path_allowed(out_root):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    r = edr.EIASSDocResolver()






    want_zip = bool(params.get("zip"))
    work_root = Path(tempfile.mkdtemp(prefix="eiaw_zip_")) if want_zip else out_root
    base_dir = work_root / edr._safe_filename(code)
    saved = []
    ok = fail = 0

    def dl(doc, dest, arc_prefix):
        nonlocal ok, fail
        try:
            path = r.download(doc, str(dest), overwrite=False)
            saved.append((Path(path), f"{arc_prefix}{os.path.basename(path)}"))
            size = os.path.getsize(path)
            sz = f"{size >> 20} MB" if size >= 1 << 20 else f"{size >> 10} KB"
            job_log(job, f"  ✓ {os.path.basename(path)} ({sz})")
            ok += 1
        except Exception as e:
            job_log(job, f"  ✗ {doc.filename}: {e}")
            fail += 1
        time.sleep(0.3)

    if params.get("gubn") == "after":
        rounds = params.get("rounds", [])
        if not rounds:
            raise RuntimeError("다운로드할 조사회차를 선택하세요")
        for ri, rd in enumerate(rounds, 1):
            seq, year = str(rd["seq"]), str(rd.get("year") or "회차")
            job_log(job, f"[{ri}/{len(rounds)}] {year}년 조사 (회차 {seq}) 파일목록 조회…")
            docs = r.resolve(code, "after", seq=seq)

            files_filter = set(map(str, rd.get("files") or []))
            if files_filter:
                docs = [d for d in docs if str(d.file_seq) in files_filter]
            if not docs:
                job_log(job, f"  ⚠ 회차 {seq}: 파일 없음")
                continue
            sub = base_dir / edr._safe_filename(f"{year}_{seq}")
            sub.mkdir(parents=True, exist_ok=True)
            for di, d in enumerate(docs, 1):
                job["progress"] = {"done": di - 1, "total": len(docs),
                                   "stage": f"{year}년 — {d.filename}"}
                dl(d, sub, f"{code}/{year}_{seq}/")
    else:
        seqs = set(map(str, params.get("seqs", [])))
        if not seqs:
            raise RuntimeError("다운로드할 파일을 선택하세요")
        docs = r.resolve(code, params.get("gubn", "auto"))
        targets, _seen = [], set()
        for d in docs:
            if str(d.file_seq) in seqs and str(d.file_seq) not in _seen:
                _seen.add(str(d.file_seq))
                targets.append(d)
        if not targets:
            raise RuntimeError("선택한 FILE_SEQ가 현재 목록과 일치하지 않습니다 — 다시 조회하세요")



        base_dir.mkdir(parents=True, exist_ok=True)
        for i, d in enumerate(targets, 1):
            if job.get("cancel"):
                job_log(job, f"─── 사용자 취소 — {i - 1}/{len(targets)}개까지 "
                             "받았습니다(내려받은 파일은 그대로 남습니다)")
                break
            job["progress"] = {"done": i - 1, "total": len(targets), "stage": d.filename}
            label = (getattr(d, "stage_label", None) or "").strip()
            if label:
                sub = base_dir / edr._safe_filename(label)
                sub.mkdir(parents=True, exist_ok=True)
                dl(d, sub, f"{code}/{edr._safe_filename(label)}/")
            else:
                dl(d, base_dir, f"{code}/")

    job["progress"] = {"done": 1, "total": 1, "stage": "완료"}
    if want_zip:
        import shutil, zipfile
        try:
            if not saved:
                raise RuntimeError("내려받은 파일이 없어 ZIP을 만들지 않았습니다")
            uniq, seen = [], set()
            for p, arc in saved:
                if arc not in seen and p.exists():
                    seen.add(arc)
                    uniq.append((p, arc))

            zip_path = out_root / f"{edr._safe_filename(code)}.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                for p, arc in uniq:
                    z.write(p, arcname=arc)
            size = zip_path.stat().st_size
            job_log(job, f"  ✓ ZIP 번들: {zip_path.name} "
                         f"({len(uniq)}건 · {size >> 20} MB)")
            job_log(job, f"─── 다운로드 완료: 성공 {ok} / 실패 {fail} → {zip_path}")
        finally:

            shutil.rmtree(work_root, ignore_errors=True)
    else:
        job_log(job, f"─── 다운로드 완료: 성공 {ok} / 실패 {fail} → {base_dir}")






def photo_scan(params):
    """."""




    import photo_exif as px
    from dataclasses import asdict

    folder = Path(params.get("folder") or "")
    if not path_allowed(folder):
        raise RuntimeError("승인된 폴더가 아닙니다 — [폴더 선택]으로 다시 지정하세요")
    if not folder.is_dir():
        raise RuntimeError(f"폴더가 없습니다: {folder}")

    pts = px.scan_folder(folder, recursive=bool(params.get("recursive")))
    rows = [asdict(p) for p in pts]
    geo = sum(1 for p in pts if p.has_geo)
    return {"ok": True, "folder": str(folder), "photos": rows,
            "total": len(rows), "with_geo": geo,
            "no_dir": sum(1 for p in pts if p.has_geo and p.direction is None)}


def photo_thumbnail(src: Path, size: int) -> bytes:
    """."""




    import io
    from PIL import Image, ImageOps

    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((size, size), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82, optimize=True)
        return buf.getvalue()


def photo_export(params):
    """."""




    import photo_exif as px

    fmt = (params.get("format") or "kml").lower()
    out = Path(params.get("out") or "")
    if not out.parent.is_dir():
        raise RuntimeError(f"저장 폴더가 없습니다: {out.parent}")
    if not path_allowed(out.parent):
        raise RuntimeError("승인된 폴더가 아닙니다 — [저장 위치]를 다시 지정하세요")



    pts = []
    for d in params.get("photos") or []:
        pts.append(px.PhotoPoint(**{k: v for k, v in d.items()
                                    if k in px.PhotoPoint.__dataclass_fields__}))
    geo = [p for p in pts if p.has_geo]
    if not geo:
        raise RuntimeError("좌표를 가진 사진이 없습니다")

    epsg = int(params.get("epsg") or 5186)
    warns: list[str] = []
    if fmt == "kml":
        p = px.export_kml(geo, out, wedge_km=float(params.get("wedge_km") or 0.15))
    elif fmt == "csv":


        p = px.export_csv(geo, out, epsg=epsg, on_warn=warns.append)
    else:
        raise RuntimeError(f"알 수 없는 형식: {fmt}")
    return {"ok": True, "path": str(p), "count": len(geo), "warnings": warns}


def run_pdf2excel_scan(job, params):
    """."""




    import pdf2excel_core as pc
    src = Path(params["path"])
    if not path_allowed(src):
        raise RuntimeError("대상 파일이 승인된 경로가 아닙니다 — [파일 선택]으로 다시 지정하세요")
    if src.suffix.lower() != ".pdf":
        raise RuntimeError("PDF 파일만 처리할 수 있습니다")

    spec = (params.get("page_range") or "").strip()
    job_log(job, f"표 스캔: {src.name}" + (f" (페이지 {spec})" if spec else " (전체)"))

    def on_prog(done, total):
        job["progress"] = {"done": done, "total": total, "stage": f"{done}/{total} 쪽"}



    raws = pc.scan(src, spec, progress=on_prog,
                   cancel=lambda: bool(job.get("cancel")))
    if job.get("cancel"):
        job_log(job, "─── 사용자 취소 — 표 스캔을 중단했습니다")
        return
    if not raws:
        raise RuntimeError(f"표를 찾지 못했습니다 ({spec or '전체'}) — 페이지 범위를 확인하세요. "
                           f"스캔 이미지 PDF는 표 추출이 불가합니다")
    tables = pc.group(raws)

    rows = []
    for i, t in enumerate(tables):
        rows.append({
            "idx": i,
            "caption": t.caption or "(표제 없음)",
            "pages": t.page_label,
            "cols": len(t.header or (t.rows[0] if t.rows else [])),
            "rows": len(t.rows),
            "removed_headers": t.removed_headers,
            "header_out_of_range": t.header_out_of_range,
            "filled_cells": t.filled_cells,
            "lost_chars": t.lost_chars,
            "preview": [r[:8] for r in ([t.header] if t.header else []) + t.rows[:3]],
        })
        job_log(job, f"  [{i + 1}] {t.caption or '(표제 없음)'} · {t.page_label} · "
                     f"{len(t.rows)}행"
                     + (f" · ⚠ 미포착 {t.lost_chars}자" if t.lost_chars else ""))

    job_log(job, f"─── 표 {len(tables)}개 발견")
    job["result"] = {"tables": rows, "path": str(src)}


def run_pdf2excel_write(job, params):
    """."""
    import pdf2excel_core as pc
    src = Path(params["path"])
    if not path_allowed(src):
        raise RuntimeError("대상 파일이 승인된 경로가 아닙니다")
    out_dir = Path(params.get("out_dir") or src.parent)
    if not path_allowed(out_dir):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    spec = (params.get("page_range") or "").strip()
    picked = params.get("picked")
    gap = int(params.get("gap_rows", 4))

    def on_prog(done, total):
        job["progress"] = {"done": done, "total": total, "stage": f"{done}/{total} 쪽"}

    raws = pc.scan(src, spec, progress=on_prog,
                   cancel=lambda: bool(job.get("cancel")))
    if job.get("cancel"):
        job_log(job, "─── 사용자 취소 — 엑셀을 만들지 않았습니다")
        return
    if not raws:
        raise RuntimeError("표를 찾지 못했습니다 — 페이지 범위를 확인하세요")
    tables = pc.group(raws)

    if picked is not None:
        sel = set(int(i) for i in picked)
        tables = [t for i, t in enumerate(tables) if i in sel]
        if not tables:
            raise RuntimeError("선택한 표가 없습니다")

    out = out_dir / f"{src.stem}.xlsx"

    path = pc.write_xlsx(tables, out, src.name, gap)
    size = Path(path).stat().st_size
    job_log(job, f"  ✓ {Path(path).name} ({size >> 10} KB · 표 {len(tables)}개)")
    job_log(job, f"─── 저장 완료 → {path}")
    job["result"] = {"path": str(path)}


def run_envdata_parse(job, params):
    """."""







    import pdf2excel_core as pc
    src = Path(params["path"])
    if not path_allowed(src):
        raise RuntimeError("대상 파일이 승인된 경로가 아닙니다 — [파일 선택]으로 다시 지정하세요")
    ext = src.suffix.lower()
    if ext not in (".hwp", ".hwpx", ".pdf"):
        raise RuntimeError("hwp·hwpx·pdf 파일만 처리할 수 있습니다")

    pdf_path = src
    if ext in (".hwp", ".hwpx"):
        import hwp2pdf_core
        job["progress"] = {"done": 0, "total": 1, "stage": "한컴으로 PDF 변환 중"}
        job_log(job, f"HWP→PDF 변환: {src.name}")
        tmp_out = Path(tempfile.mkdtemp(prefix="envdata_parse_"))
        result_pdf = None
        for ev in hwp2pdf_core.convert_batch([src], out_dir=str(tmp_out)):
            if ev.get("phase") == "item":
                if ev.get("ok"):
                    result_pdf = Path(ev["pdf"])
                else:
                    raise RuntimeError(f"HWP→PDF 변환 실패: {ev.get('error')}")
        if not result_pdf or not result_pdf.exists():
            raise RuntimeError("HWP→PDF 변환 결과 파일을 찾지 못했습니다")
        pdf_path = result_pdf
        job_log(job, f"  ✓ PDF 변환 완료 → {pdf_path.name}")

    def on_prog(done, total):
        job["progress"] = {"done": done, "total": total, "stage": f"{done}/{total} 쪽"}

    job_log(job, f"표 추출 중: {pdf_path.name}")
    raws = pc.scan(pdf_path, "", progress=on_prog)
    if not raws:
        raise RuntimeError("표를 찾지 못했습니다 — 스캔 이미지 PDF는 표 추출이 불가합니다")
    tables = pc.group(raws)
    if not tables:
        raise RuntimeError("표를 찾지 못했습니다")



    best = max(tables, key=lambda t: len(t.rows))
    aoa = ([best.header] if best.header else []) + best.rows
    if len(tables) > 1:
        job_log(job, f"  표 {len(tables)}개 중 가장 큰 표를 선택했습니다"
                     f"({best.caption or '표제 없음'} · {best.page_label} · {len(best.rows)}행)")
    job_log(job, f"─── 추출 완료: {len(aoa)}행 × {len(aoa[0]) if aoa else 0}열")
    job["result"] = {"aoa": aoa, "tableCount": len(tables),
                      "caption": best.caption, "lostChars": best.lost_chars}


def run_hwp2pdf(job, params):
    """."""

    import hwp2pdf_core
    paths = [Path(p) for p in params.get("paths", [])]
    files = hwp2pdf_core.collect_files([str(p) for p in paths], recursive=True)
    if not files:
        raise RuntimeError("HWP/HWPX 파일이 없습니다")
    out_dir = params.get("out_dir") or None

    ok = fail = 0
    for ev in hwp2pdf_core.convert_batch(
            files, out_dir=out_dir,
            should_cancel=lambda: bool(job.get("cancel"))):
        ph = ev.get("phase")
        if ph == "start":
            job["progress"] = {"done": 0, "total": ev["total"], "stage": "한컴 기동 중"}
            job_log(job, f"HWP→PDF 일괄 변환 {ev['total']}건 시작")
        elif ph == "engine":
            job_log(job, f"  엔진: {ev.get('mode')} / PDF 프린터: {ev.get('pdf_printer') or '-'}")
        elif ph == "begin":


            job["progress"] = {"done": ev["index"] - 1, "total": ev["total"],
                               "stage": os.path.basename(str(ev.get("src", "")))}
        elif ph == "item":
            name = os.path.basename(str(ev.get("src", "")))
            job["progress"] = {"done": ev["index"], "total": ev["total"], "stage": name}
            if ev.get("skipped"):
                job_log(job, f"  · {name} — 이미 존재, 건너뜀")
            elif ev.get("ok"):
                ok += 1
                job_log(job, f"  ✓ {name} → {os.path.basename(str(ev.get('pdf')))} ({ev.get('size')})")
            else:
                fail += 1
                job_log(job, f"  ✗ {name}: {ev.get('error')}")
        elif ph == "cancelled":
            job_log(job, f"─── 사용자 취소 — {ev.get('done')}/{ev.get('total')}건까지 "
                         f"변환됨(성공 {ev.get('ok')}). 만들어진 PDF는 그대로 남습니다")
            return
        elif ph == "done":
            job_log(job, f"─── 변환 완료: 성공 {ev['ok']} / 실패 {ev['fail']} / 건너뜀 {ev['skip']}")
    if job.get("cancel"):
        return
    if fail and not ok:
        raise RuntimeError("전건 변환 실패 — 한컴오피스 설치·한컴 PDF 프린터를 확인하세요")

def run_eiass_seq_dl(job, params):
    """."""

    import eiass_doc_resolver as edr
    seqs = [str(s).strip() for s in params.get("seqs", []) if str(s).strip().isdigit()]
    if not seqs:
        raise RuntimeError("유효한 FILE_SEQ가 없습니다")
    out_dir = Path(params["out_dir"])
    if not path_allowed(out_dir):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")
    out_dir.mkdir(parents=True, exist_ok=True)

    r = edr.EIASSDocResolver()
    total = len(seqs)
    ok = fail = 0
    saved = []
    for i, seq in enumerate(seqs, 1):
        if job.get("cancel"):
            job_log(job, f"─── 사용자 취소 — {i - 1}/{total}개까지 받았습니다")
            break
        job["progress"] = {"done": i - 1, "total": total, "stage": f"FILE_SEQ {seq}"}
        try:

            path = r.download(seq, str(out_dir), overwrite=False)
            p = Path(path)
            size = p.stat().st_size
            if size == 0:
                raise RuntimeError("응답 본문이 비어 있음(비공개·삭제된 파일일 수 있음)")
            sz = f"{size >> 20} MB" if size >= 1 << 20 else f"{size >> 10} KB"
            job_log(job, f"  ✓ [{seq}] {p.name} ({sz})")
            saved.append(p)
            ok += 1
        except Exception as e:
            job_log(job, f"  ✗ [{seq}] {e}")
            fail += 1
        time.sleep(0.3)
    job["progress"] = {"done": total, "total": total, "stage": "완료"}

    if params.get("zip") and saved:
        import zipfile
        from datetime import datetime
        zip_path = out_dir / f"EIASS_{datetime.now():%Y%m%d_%H%M}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for p in saved:
                z.write(p, arcname=p.name)
        job_log(job, f"  ✓ ZIP 번들: {zip_path.name} ({len(saved)}건)")
    job_log(job, f"─── 완료: 성공 {ok} / 실패 {fail} → {out_dir}")
    if fail and not ok:
        raise RuntimeError("전건 실패 — FILE_SEQ·네트워크를 확인하세요")


def run_hwp_probe(job, params):
    """."""

    import probe_hwp_pagenum as probe
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")
    job["progress"] = {"done": 0, "total": 1, "stage": "한컴 기동·문서 검사 중"}
    text = probe.run_probe(str(folder), sink=lambda line: job_log(job, line),
                           max_files=int(params.get("max_files", 5)))
    try:
        out = folder / "probe_result.txt"
        out.write_text(text, encoding="utf-8")
        job_log(job, f"\n결과 저장: {out}")
    except Exception as e:
        job_log(job, f"\n(파일 저장 실패 — 위 로그를 복사해 전달하세요: {e})")
    job["progress"] = {"done": 1, "total": 1, "stage": "완료"}


def run_pagenum_scan(job, params):
    """."""
    import hwp_pagenum as hp
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")
    files = hp.scan_folder(
        folder,
        log=lambda m: job_log(job, m),
        progress=lambda d, t, s: job.__setitem__("progress", {"done": d, "total": t, "stage": s}),
        should_cancel=lambda: bool(job.get("cancel")),
    )
    plan = hp.assign_numbers(
        hp.build_plan(files, include_divider=params.get("divider", "none"),
                      a3_back=params.get("a3_back", "skip"),
                      ),
        start_num=int(params.get("start_num", 1)),
        restart_per_chapter=bool(params.get("restart")),
    )
    job["result"] = [_plan_row(f) for f in plan]
    job_log(job, f"─── 스캔 완료: {len(files)}개 파일")


def _plan_row(f: dict) -> dict:
    """."""




    pages = f.get("pages") or []
    nums = [n for _, n, _ in pages]
    detail = None
    if nums:
        inside = set(nums)
        detail = {
            "divider": nums[0] if f.get("divider") else None,
            "gaps": [x for x in range(nums[0], nums[-1] + 1) if x not in inside],
            "body": [nums[1], nums[-1]] if f.get("divider") and len(nums) > 1
                    else [nums[0], nums[-1]],

            "tail_a3_gap": (nums[-1] + 1) if pages[-1][2] else None,
        }
    return {
        "detail": detail,


        "name": f["name"], "path": f.get("path", ""), "chapter": f.get("chapter"),
        "is_chapter_head": f.get("is_chapter_head", False), "skip": f.get("skip", False),
        "phys_pages": f.get("phys_pages"), "a3_count": len(f.get("a3_pages") or []),
        "a3_pages": f.get("a3_pages") or [],
        "start": f["start"], "end": f["end"],
        "marks": f["marks"], "divider": f.get("divider", False),



        "start_page": f.get("start_page"), "end_page": f.get("end_page"),
        "hide_pages": f.get("hide_pages") or [],
        "hide_targets": f.get("hide_targets") or [],
        "force_odd": f.get("force_odd") or [],
        "do_hide": f.get("do_hide", False),
        "gap_count": f.get("gap_count", 0),



        "divider_mode": f.get("divider_mode", "none"),
        "a3_back": f.get("a3_back", "skip"),
        "pgct_pages": f.get("pgct_pages") or [],
        "pgct_phys": f.get("pgct_phys") or [],
        "div_skip": f.get("div_skip", 0),
        "a3_bad": f.get("a3_bad") or [],
        "mismatch": f.get("mismatch"),
        "override": f.get("override") or {},
        "expect_hide": f.get("expect_hide") or [],
        "stray_hide": f.get("stray_hide") or [],
        "error": f.get("error"),
    }


def _row_opt(rows, key, default):
    """."""
    for r in rows:
        if not r.get("skip") and r.get(key):
            return r[key]
    return default


def run_pagenum_apply(job, params):
    """."""
    import hwp_pagenum as hp
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다")
    files = params.get("files")
    if not files:
        raise RuntimeError("적용할 파일 목록이 없습니다 — 먼저 스캔하세요")




    plan = hp.assign_numbers(
        hp.build_plan(
            files,

            include_divider=params.get("divider") or _row_opt(files, "divider_mode", "none"),
            a3_back=params.get("a3_back") or _row_opt(files, "a3_back", "skip"),


            overrides=params.get("overrides") or {},
        ),
        start_num=int(params.get("start_num", 1)),
        restart_per_chapter=bool(params.get("restart")),
    )


    drift = [(f["name"], f.get("start"), g["start"], f.get("end"), g["end"])
             for f, g in zip(files, plan, strict=False)
             if not f.get("skip") and (f.get("start") != g["start"] or f.get("end") != g["end"])]
    if drift:
        job_log(job, f"✗ 스캔 표와 계획이 다릅니다 ({len(drift)}건) — 적용을 중단합니다")
        for n, s1, s2, e1, e2 in drift[:5]:
            job_log(job, f"   {n}: 표 {s1}~{e1} / 계획 {s2}~{e2}")
        raise RuntimeError("스캔 표와 적용 계획이 일치하지 않습니다 — 다시 스캔해주세요")

    return hp.apply_plan(
        plan,
        log=lambda m: job_log(job, m),
        progress=lambda d, t, s: job.__setitem__("progress", {"done": d, "total": t, "stage": s}),
        dry_run=bool(params.get("dry_run")),
        extra_clear=bool(params.get("extra_clear")),
        should_cancel=lambda: bool(job.get("cancel")),
    )


RUNNERS = {"convert": run_convert, "eiass_dl": run_eiass_dl,
           "pagenum_scan": run_pagenum_scan, "pagenum_apply": run_pagenum_apply,
           "hwp_probe": run_hwp_probe,
           "eiass_seq_dl": run_eiass_seq_dl,
           "hwp2pdf": run_hwp2pdf,
           "pdf2excel_scan": run_pdf2excel_scan, "pdf2excel_write": run_pdf2excel_write,
           "envdata_parse": run_envdata_parse}

def worker():
    while True:
        job_id = None
        with JOB_LOCK:
            if JOB_QUEUE:
                job_id = JOB_QUEUE.pop(0)
        if not job_id:
            time.sleep(0.3)
            continue
        job = JOBS[job_id]

        if job.get("cancel"):
            job["status"] = "cancelled"
            continue
        job["status"] = "running"
        try:
            RUNNERS[job["type"]](job, job["params"])
            job["status"] = "cancelled" if job.get("cancel") else "done"
        except Exception as e:


            if job.get("cancel"):
                job["status"] = "cancelled"
                job_log(job, "─── 취소로 중단됨 (완료된 파일은 그대로 남아 있습니다)")
            else:
                job["status"] = "error"
                job["error"] = str(e)
                job_log(job, f"✗ {e}")









                killed = kill_automation_hwp()
                if killed:
                    job_log(job, f"─── 실패 정리: 한컴 {killed}개를 종료했습니다")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _headers(self, status=200, ctype="application/json; charset=utf-8", length=None):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._headers(status, length=len(body))
        self.wfile.write(body)

    def _auth_ok(self):
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {TOKEN}"

    def _serve_lockscreen(self):
        """."""

        try:
            html = (LICENSE_ASSETS / "lockscreen.html").read_text(encoding="utf-8")
        except Exception:
            html = ("<!doctype html><meta charset=utf-8>"
                    "<h1>이 PC는 승인되지 않았습니다</h1>"
                    "<p>고유생성값: <b>%%FINGERPRINT%%</b></p>")
        html = (html.replace("%%FINGERPRINT%%", NODELOCK.get("fp_display", "") or "(계산 실패)")
                    .replace("%%REASON%%", NODELOCK.get("reason", "")))
        body = html.encode("utf-8")
        self._headers(200, ctype="text/html; charset=utf-8", length=len(body))
        self.wfile.write(body)

    def _serve_web(self, path: str):
        """."""















        allow_dirs = ("shared", "modules", "vendor")
        rel = path[len("/app"):].lstrip("/") or "index.html"
        try:
            root = WEB_ROOT.resolve()
            target = (root / rel).resolve()
            relp = target.relative_to(root)
            parts = relp.parts
            if not (relp == Path("index.html") or (parts and parts[0] in allow_dirs)):
                self._json({"ok": False, "error": "not allowed"}, 403)
                return
            body = target.read_bytes()
        except Exception:
            self._json({"ok": False, "error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        self._headers(200, ctype=ctype, length=len(body))
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self._headers(204, length=0)

    def _bye(self):
        """."""











        global BYE_AT
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n).decode("utf-8", "replace").strip() if n else ""
        except Exception:
            body = ""
        if body == TOKEN:
            BYE_AT = time.time()
        self._headers(204, length=0)

    def do_GET(self):
        global LAST_SEEN
        LAST_SEEN = time.time()
        url = urlparse(self.path)
        if url.path == "/ping":


            locked = not NODELOCK["ok"]
            self._json({"ok": True, "bridge_version": BRIDGE_VERSION,
                        "features": {} if locked else detect_features(),
                        "deps": detect_deps(), "queue": len(JOB_QUEUE),
                        "nodelock": {"ok": NODELOCK["ok"],
                                     "reason": NODELOCK["reason"]}})
            return

        if not NODELOCK["ok"]:
            if url.path in ("/", "/lockscreen", "/lockscreen.html"):
                self._serve_lockscreen()
            else:
                self._json({"ok": False, "error": "locked",
                            "reason": NODELOCK["reason"]}, 403)
            return




        if LOCAL_WEB and (url.path == "/app" or url.path.startswith("/app/")):
            self._serve_web(url.path)
            return
        if not self._auth_ok():
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        if url.path.startswith("/jobs/"):
            job = JOBS.get(url.path.split("/")[2])
            if not job:
                self._json({"ok": False, "error": "job not found"}, 404)
                return
            log_from = int((parse_qs(url.query).get("log_from") or ["0"])[0])
            self._json({"ok": True, "status": job["status"],
                        "progress": job.get("progress"),
                        "log": job["log"][log_from:],
                        "result": job.get("result") if job["status"] == "done" else None,
                        "error": job.get("error")})
            return
        if url.path == "/photo/thumb":



            q = parse_qs(url.query)
            src = Path((q.get("path") or [""])[0])
            try:
                size = max(64, min(2400, int((q.get("size") or ["320"])[0])))
            except ValueError:
                size = 320
            if not path_allowed(src) or not src.is_file():
                self._json({"ok": False, "error": "허용되지 않은 경로입니다"}, 403)
                return
            try:
                body = photo_thumbnail(src, size)
            except Exception as e:
                self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)
                return
            self._headers(200, ctype="image/jpeg", length=len(body))
            self.wfile.write(body)
            return

        if url.path == "/proxy":
            target = (parse_qs(url.query).get("url") or [""])[0]
            try:
                body, ctype = proxy_get(target)
            except Exception as e:
                self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 502)
                return
            self._headers(200, ctype=ctype, length=len(body))
            self.wfile.write(body)
            return

        self._json({"ok": False, "error": "unknown endpoint"}, 404)

    def do_POST(self):
        global LAST_SEEN


        if urlparse(self.path).path == "/bye":
            self._bye()
            return
        LAST_SEEN = time.time()

        if not NODELOCK["ok"]:
            self._json({"ok": False, "error": "locked",
                        "reason": NODELOCK["reason"]}, 403)
            return
        if not self._auth_ok():
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        url = urlparse(self.path)
        body = self._body()

        if url.path == "/pick":


            try:
                patterns = body.get("patterns")
                paths = pick_dialog(body.get("kind", "folder"), patterns,
                                    initial=body.get("initial"),
                                    initial_dir=body.get("initial_dir"))
            except Exception as e:
                self._json({"ok": False,
                            "error": f"폴더·파일 선택창을 열지 못했습니다: {e}"}, 500)
                return
            for p in paths:
                root = Path(p)


                root = root if root.is_dir() else root.parent




                root = root.resolve()
                if root not in ALLOWED_ROOTS:
                    ALLOWED_ROOTS.append(root)
            self._json({"ok": True,
                        "path": paths[0] if len(paths) == 1 else None,
                        "paths": paths})
            return

        if url.path == "/photo/scan":

            try:
                self._json(photo_scan(body))
            except Exception as e:
                self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 400)
            return

        if url.path == "/photo/export":
            try:
                self._json(photo_export(body))
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
            return

        if url.path == "/replan":






            try:
                import hwp_pagenum as hp
                files = body.get("files") or []
                plan = hp.assign_numbers(
                    hp.build_plan(files,
                                  include_divider=body.get("divider", "none"),
                                  a3_back=body.get("a3_back", "skip"),
                                  overrides=body.get("overrides") or {}),
                    start_num=int(body.get("start_num", 1)),
                    restart_per_chapter=bool(body.get("restart")),
                )
            except Exception as e:
                self._json({"ok": False,
                            "error": f"계획을 다시 세우지 못했습니다: {e}"}, 400)
                return
            self._json({"ok": True, "plan": [_plan_row(f) for f in plan]})
            return

        if url.path == "/eiass/resolve":


            try:
                import eiass_doc_resolver as edr
                code = (body.get("code") or "").strip().upper()
                if not code:
                    self._json({"ok": False, "error": "사업코드를 입력하세요"}, 400)
                    return
                r = edr.EIASSDocResolver()
                gubn = body.get("gubn", "auto")
                if gubn == "after":
                    aes = body.get("aes_seq")
                    if aes:
                        docs = r.resolve(code, "after", seq=str(aes))
                        self._json({"ok": True, "code": code, "mode": "docs",
                                    "docs": [d.as_dict() for d in docs]})
                        return
                    rounds = r.list_after_rounds(code)
                    if not rounds:
                        self._json({"ok": False,
                                    "error": "사후 조사회차를 찾지 못했습니다 — 코드를 확인하세요"}, 404)
                        return
                    self._json({"ok": True, "code": code, "mode": "rounds", "rounds": rounds})
                    return
                docs = r.resolve(code, gubn)
                self._json({"ok": True, "code": code, "mode": "docs",
                            "docs": [d.as_dict() for d in docs]})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 500)
            return

        if url.path == "/jobs":
            jtype = body.get("type")
            if jtype not in RUNNERS:
                self._json({"ok": False, "error": f"unknown job type: {jtype}"}, 400)
                return
            job_id = uuid.uuid4().hex[:12]
            JOBS[job_id] = {"type": jtype, "params": body, "status": "queued",
                            "log": [], "progress": None, "error": None,
                            "cancel": False}
            _prune_jobs()
            with JOB_LOCK:
                JOB_QUEUE.append(job_id)
            self._json({"ok": True, "job_id": job_id})
            return



        if url.path.startswith("/jobs/") and url.path.endswith("/cancel"):
            job_id = url.path.split("/")[2]
            res = cancel_job(job_id)
            self._json(res, 200 if res.get("ok") else 404)
            return

        self._json({"ok": False, "error": "unknown endpoint"}, 404)


def teardown(reason: str) -> None:
    """."""






    st = cancel_all_jobs()
    if st["jobs"] or st["hwp_killed"]:
        print(f"  정리: 작업 {st['jobs']}건 취소 · 한컴 {st['hwp_killed']}개 종료"
              f" ({reason})", flush=True)


def _idle_watchdog(srv, on_exit=None):
    """."""
















    def bye_out():
        global BYE_AT
        if not BYE_AT:
            return False
        if LAST_SEEN > BYE_AT:
            BYE_AT = 0.0
            return False
        return time.time() - BYE_AT >= BYE_GRACE_SEC

    def loop():
        while True:
            time.sleep(2)
            if bye_out():
                reason = "앱 창이 닫혔습니다"
            elif time.time() - LAST_SEEN > IDLE_EXIT_SEC:
                reason = f"웹 UI 연결이 {IDLE_EXIT_SEC}초 이상 끊겼습니다"
            else:
                continue
            print(f"\n  {reason} — 종료합니다.", flush=True)
            teardown(reason)
            try:
                srv.shutdown()
            except Exception:
                pass
            if on_exit:
                try: on_exit()
                except Exception: pass
            return
    threading.Thread(target=loop, daemon=True).start()


def _make_tray(srv, port: int):
    """."""




    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        return None

    try:
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((6, 6, 58, 58), fill=(27, 76, 140, 255))
        d.text((22, 20), "E", fill=(255, 255, 255, 255))

        def open_web(*_):
            try:
                _open_ui(f"{WEB_URL}#bt={TOKEN}&bp={port}")
            except Exception:
                pass

        def copy_token(*_):
            """."""
            try:
                import tkinter as tk
                r = tk.Tk(); r.withdraw()
                r.clipboard_clear(); r.clipboard_append(TOKEN); r.update()
                r.destroy()
            except Exception:
                pass

        def quit_all(ic, *_):
            ic.visible = False
            ic.stop()

        menu = pystray.Menu(
            pystray.MenuItem(f"워크벤치 열기 (v{BRIDGE_VERSION})", open_web, default=True),
            pystray.MenuItem("브리지 토큰 복사", copy_token),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("종료", quit_all),
        )
        return pystray.Icon("eia_workbench_bridge", img,
                            f"EIA Workbench 브리지 v{BRIDGE_VERSION} — 127.0.0.1:{port}", menu)
    except Exception:
        return None


def _find_running_bridge():
    """."""





    import urllib.request

    for p in PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/ping", timeout=1.5) as r:
                d = json.loads(r.read())
            if d.get("features") is not None:
                return p, d.get("bridge_version", "?")
        except Exception:
            continue
    return None


def _open_ui(url: str) -> None:
    """."""

    try:
        cb = str(BRIDGE_DIR / "cbundle")
        if cb not in sys.path:
            sys.path.insert(0, cb)
        import applaunch
        applaunch.open_app(url)
    except Exception:
        webbrowser.open(url)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="EIA Workbench 로컬 브리지")
    ap.add_argument("--allow", action="append", default=[],
                    help="사전 승인 폴더 (테스트·자동화용 — 웹의 [폴더 선택] 없이 접근 허용)")
    ap.add_argument("--no-browser", action="store_true",
                    help="시작 시 웹 UI 자동 열기 생략")
    ap.add_argument("--force", action="store_true",
                    help="이미 브리지가 떠 있어도 하나 더 띄운다 (진단용 — 권장하지 않음)")
    ap.add_argument("--port", type=int, default=None,
                    help="바인딩 포트를 고정한다 (테스트·진단용 — 지정 시 기본 포트풀 대신 이 포트만 시도)")
    ap.add_argument("--web", default=None, metavar="local|URL",
                    help="열 웹 주소. 'local'이면 이 브리지가 옆 폴더의 워크벤치를 "
                         "직접 서빙한다 — **배포 전에 실제 앱에서 확인**할 때 쓴다")
    args = ap.parse_args()
    for a in args.allow:
        ALLOWED_ROOTS.append(Path(a).resolve())


    global WEB_URL, LOCAL_WEB, WEB_ROOT
    if args.web == "local":
        WEB_ROOT = BRIDGE_DIR.parent
        if not (WEB_ROOT / "index.html").is_file():
            print(f"  [ERROR] 로컬 웹을 찾지 못했습니다: {WEB_ROOT / 'index.html'}")
            sys.exit(1)
        LOCAL_WEB = True
    elif args.web:
        WEB_URL = args.web


    evaluate_nodelock()

    threading.Thread(target=worker, daemon=True).start()





    class StrictServer(ThreadingHTTPServer):
        allow_reuse_address = False

    def port_in_use(p):
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        try:
            return s.connect_ex(("127.0.0.1", p)) == 0
        finally:
            s.close()





    existing = _find_running_bridge()
    if existing and not args.force:
        ep, ever = existing
        print("=" * 64)
        print("  EIA Workbench 로컬 브리지")
        print("=" * 64)
        print(f"  이미 실행 중입니다 — 127.0.0.1:{ep} (v{ever})")
        print("  새로 띄우지 않고 웹 UI만 엽니다.")
        print("  ※ 굳이 하나 더 띄우려면 --force 를 붙이세요(권장하지 않습니다).")
        if not args.no_browser:
            try:
                _open_ui(WEB_URL)
            except Exception:
                pass
        return

    srv = None
    port = None
    ports_to_try = [args.port] if args.port else PORTS
    for p in ports_to_try:
        if port_in_use(p):
            print(f"  ※ 포트 {p} 사용 중 (다른 프로그램/PoC 스텁?) — 다음 포트 시도")
            continue
        try:
            srv = StrictServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if not srv:
        tried = ", ".join(str(p) for p in ports_to_try)
        print(f"포트 {tried}이(가) 모두 사용 중입니다. 다른 브리지가 떠 있는지 확인하세요.")
        sys.exit(1)


    if LOCAL_WEB:
        WEB_URL = f"http://127.0.0.1:{port}/app/index.html"

    feats = detect_features()
    print("=" * 64)
    print("  EIA Workbench 로컬 브리지")
    print("=" * 64)
    print(f"  주소   : http://127.0.0.1:{port}")
    print(f"  버전   : {BRIDGE_VERSION}")
    if LOCAL_WEB:
        print(f"  ⚠ 로컬 웹 : {WEB_ROOT}  (배포본이 아니라 이 폴더의 파일을 씁니다)")
    print("  기능   : " + ", ".join(k for k, v in feats.items() if v))
    miss = [k for k, v in feats.items() if not v]
    if miss:
        print(f"  비활성 : {', '.join(miss)} (해당 도구 미설치 또는 Windows 아님)")
    print()


    if not NODELOCK["ok"]:
        lock_url = f"http://127.0.0.1:{port}/"
        print("  ⛔ 이 PC는 아직 승인되지 않았습니다.")
        print(f"     고유생성값: {NODELOCK.get('fp_display') or '(계산 실패)'}")
        print(f"     사유: {NODELOCK['reason']}")
        print(f"     잠금화면: {lock_url}  (지문을 개발자에게 전달 후 재실행)")
        if not args.no_browser:
            try:
                _open_ui(lock_url)
            except Exception:
                pass
        print()
        icon = _make_tray(srv, port)
        _idle_watchdog(srv, on_exit=(icon.stop if icon else None))
        if icon is None:
            print("-" * 64, flush=True)
            try:
                srv.serve_forever()
            except KeyboardInterrupt:
                pass
            return
        print("-" * 64, flush=True)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            icon.run()
        except KeyboardInterrupt:
            pass
        finally:
            srv.shutdown()
        return

    if args.no_browser:
        print("  수동 연결: 웹 UI ⚙ 설정 → 브리지 토큰에 아래 값 입력")
        print(f"     {TOKEN}")
    else:


        pair_url = f"{WEB_URL}#bt={TOKEN}&bp={port}"
        print("  브라우저에서 웹 UI를 자동으로 엽니다 — 토큰이 자동 등록됩니다.")
        print("  (안 열리면 수동 접속: " + WEB_URL + ")")
        print(f"  수동 등록용 토큰: {TOKEN}")
        try:
            _open_ui(pair_url)
        except Exception:
            pass
    print()






    icon = _make_tray(srv, port)
    _idle_watchdog(srv, on_exit=(icon.stop if icon else None))
    if icon is None:
        print("  웹 UI를 닫으면 자동 종료됩니다. 즉시 종료: Ctrl+C")
        print("-" * 64, flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  종료했습니다.")
        finally:

            teardown("브리지 종료")
        return

    print("  트레이에 상주합니다 — 웹 UI를 닫으면 자동 종료됩니다(트레이 메뉴로도 종료 가능).")
    print("-" * 64, flush=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        icon.run()
    except KeyboardInterrupt:
        pass
    finally:

        teardown("브리지 종료")
        srv.shutdown()

if __name__ == "__main__":
    _code = 0
    try:
        main()
    except SystemExit as e:
        _code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)








    try:
        sys.stdout.flush(); sys.stderr.flush()
    except Exception:
        pass
    if getattr(sys, "frozen", False):
        os._exit(_code if isinstance(_code, int) else 0)
    sys.exit(_code)
