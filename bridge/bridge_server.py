#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EIA Workbench 로컬 브리지 (SYS-29 7단계)

웹 UI(GitHub Pages)가 브라우저에서 할 수 없는 작업을 대신 실행한다:
  - md 변환(한글·스캔·일괄) : convert_core.py (HWP·HWPX·OCR·듀얼엔진) — import 참조
  - EIASS 자동탐색  : eiass_doc_resolver.py — 서브프로세스(검증된 CLI 그대로)
  - HWP→PDF        : hwp2pdf_core.py — import 참조 (한컴 COM)
  - 쪽번호          : hwp_pagenum.py — 같은 폴더의 자체 엔진(SYS-31, 한컴 COM)
  ※ 차례(hwpContent)·끼워넣기(.Egg)는 2026-07-20 기능 삭제.
    구 배포용/hwpPageNum2.1 의존은 2026-07-21 제거 — 그 exe 유무가 쪽번호 탭
    활성화를 좌우하던 구조였다.

설계 원칙 (1단계 PoC 실측 반영):
  - CORS: ACAO "*" 고정 (Origin 헤더는 경로상 변조가 실측되어 신뢰하지 않는다)
  - PNA: Access-Control-Allow-Private-Network: true 상시 부착 (향후 강제 대비)
  - 캐시: no-store (캐시된 CORS 응답 오진 사고 재발 방지)
  - 인증: Bearer 토큰 (GET /ping 제외 전 요청) — 최초 실행 시 생성·콘솔 표시
  - 파일 접근: /pick으로 사용자가 승인한 폴더 하위만 허용 (화이트리스트)
  - 작업: 순차 처리 (동시 1개 — 한컴 COM 특성상 병렬 불가이기도 함)

기존 도구 폴더의 코드를 그대로 참조한다 — 복제 금지(두 벌 관리 방지).
"""

import http.client
import json
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

# Windows cmd(cp949)에서 한글·특수문자 출력 크래시 방지
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BRIDGE_VERSION = "3.23.0"
PORTS = [8765, 8766, 8767, 8768, 8769, 8770]
WEB_URL = "https://jingeun-git.github.io/eia-workbench/"

# ── 경로 (D:\Claude 표준 배치 기준) ─────────────────────────────────────────
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent

BRIDGE_DIR = _base_dir()

# --noconsole로 빌드하면 화면에 아무것도 안 나온다 — 문제가 생겨도 사용자는
# "안 켜진다"만 알게 된다. 그래서 표준출력을 파일로도 흘린다(2026-07-21).
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
            try: self._f.write(t); self._f.flush()
            except Exception: pass
        return len(t)

    def flush(self):
        for x in (self._s, self._f):
            try: x and x.flush()
            except Exception: pass


if getattr(sys, "frozen", False):
    _logp = BRIDGE_DIR / "bridge.log"
    try:
        if _logp.exists() and _logp.stat().st_size > 2_000_000:
            _logp.unlink()                       # 무한히 자라지 않게
    except Exception:
        pass
    sys.stdout = _Tee(sys.stdout, _logp)
    sys.stderr = _Tee(sys.stderr, _logp)
TOOLS_DIR  = BRIDGE_DIR.parent.parent            # 99.Tools/
CONFIG     = BRIDGE_DIR / "bridge_config.json"

# 참조 도구의 위치를 코드에 적지 않는다 — 폴더가 재편돼도 인덱스만 다시 만들면 된다.
#   (2026-07-21 SYS-33: 경로 하드코딩 때문에 폴더 정리 범위를 줄여야 했다)
# 리졸버를 못 찾는 환경(브리지만 떼어 배포 등)에서도 죽지 않게 종전 경로로 폴백한다.
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
# 차례(hwpContent)·끼워넣기(.Egg): 2026-07-20 사용자 지시로 기능 삭제
# 쪽번호: SYS-31에서 hwp_pagenum.py로 전면 재구현(2026-07-21) — 구
#   `배포용/hwpPageNum2.1`(exe·py) 의존은 제거됐다. 구 .py는 `import intro`인데
#   intro.py가 저장소에 없어 원래 실행 불가였다.
PAGENUM_MOD  = BRIDGE_DIR / "hwp_pagenum.py"
RESOLVER     = EIASS_DIR / "eiass_doc_resolver.py"

# 브라우저가 CORS 때문에 직접 못 부르는 공공 API를 대신 호출해 준다.
# 공공데이터포털은 Access-Control-Allow-Origin을 주지 않아(2026-07-21 실측)
# fetch가 통째로 실패하고, 그 실패가 조용히 "건물없음"으로 표시되고 있었다.
# 남의 서버로 요청을 대신 보내는 통로이므로 **호스트를 화이트리스트로 못박는다.**
PROXY_HOSTS = ("apis.data.go.kr",)

for p in (BRIDGE_DIR, CONVERT_DIR, HWP2PDF_DIR, EIASS_DIR, PDF2XLSX_DIR):
    if p.exists():
        sys.path.insert(0, str(p))

IS_WINDOWS = os.name == "nt"

# ── 기능 가용성 탐지 (파일 실재·임포트 가능 여부로 판정 — 표기만으로 단정 금지) ──
def detect_features():
    feats = {"convert": False, "ocr": False, "eiass": False,
             "hwp2pdf": False, "pagenum": False, "pdf2excel": False,
             "photo": False, "photo_shp": False, "photo_heic": False}
    try:
        import pdf2excel_core  # noqa
        feats["pdf2excel"] = True
    except Exception:
        pass
    try:
        import photo_exif  # noqa
        feats["photo"] = True
        # SHP 저장과 HEIC 읽기는 선택 의존이다. 없어도 사진 탭 자체는 돌아가고
        # KML은 나가므로, 기능 전체를 끄지 않고 **무엇이 빠졌는지**를 알린다.
        feats["photo_heic"] = bool(getattr(photo_exif, "HEIF_OK", False))
        try:
            import shapefile  # noqa
            feats["photo_shp"] = True
        except Exception:
            pass
    except Exception:
        pass
    try:
        import convert_core  # noqa
        feats["convert"] = True
        feats["ocr"] = bool(getattr(convert_core, "_HAS_OCR", False))
    except Exception:
        pass
    # ⚠ 파일 존재로 판정하면 **번들 exe에서 항상 False**가 된다 — 번들은 모듈을
    #   내장하지 실제 경로에 두지 않는다(2026-07-21 번들 시뮬레이션에서 확인).
    #   다른 기능과 같이 '임포트 가능한가'로 판정하고, 실패 시에만 경로를 본다.
    try:
        import eiass_doc_resolver  # noqa
        feats["eiass"] = True
    except Exception:
        feats["eiass"] = RESOLVER.exists()
    if IS_WINDOWS:
        try:
            import hwp2pdf_core  # noqa
            feats["hwp2pdf"] = True
        except Exception:
            pass
        # 실제 동작 주체가 판정 기준이어야 한다. 예전에는 구 exe 존재를 봤는데,
        # 그러면 그 exe를 치우는 순간 멀쩡한 기능이 비활성화된다(2026-07-21).
        try:
            import hwp_pagenum  # noqa
            feats["pagenum"] = True
        except Exception:
            feats["pagenum"] = PAGENUM_MOD.exists()
    return feats

_PROXY_LOCK = threading.Lock()
_PROXY_CONN = {}          # host -> HTTPSConnection (재사용)


def proxy_get(target: str):
    """화이트리스트 호스트로만 GET을 대리 수행한다. 반환: (bytes, content-type)

    ═══ 실측 근거 (2026-07-21, 연속 호출 기준) ═══
      · 기본 Python-urllib UA  → HTTP 200 + **빈 본문** (헤더를 갖추면 해소)
      · 요청마다 새 연결       → 5회 중 **0회 성공** (TLS 재수립이 상위에서 거부됨)
      · 연결 재사용            → 5회 중 **5회 성공**
    즉 필지 3번째부터 연속 실패하던 것은 주소·코드 문제가 아니라
    **매 요청 새 연결을 맺은 탓**이었다. 호스트별 연결을 유지한다.
    """
    from urllib.parse import urlparse as _up
    u = _up(target)
    if u.scheme != "https" or u.hostname not in PROXY_HOSTS:
        raise RuntimeError(f"허용되지 않은 대상: {u.scheme}://{u.hostname}")

    path = u.path + ("?" + u.query if u.query else "")
    headers = {"Accept": "*/*",
               "User-Agent": "Mozilla/5.0 (compatible; EIA-Workbench-Bridge)"}
    last = None
    with _PROXY_LOCK:                     # 스레드 서버라 연결을 직렬화한다
        for attempt in range(4):
            conn = _PROXY_CONN.get(u.hostname)
            if conn is None:
                conn = http.client.HTTPSConnection(u.hostname, timeout=25)
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
                _PROXY_CONN.pop(u.hostname, None)   # 끊긴 연결은 버리고 새로 맺는다
            if attempt < 3:
                time.sleep(0.5 * (2 ** attempt))    # 0.5 → 1.0 → 2.0초
    raise RuntimeError(f"상위 API 응답 실패(4회 재시도) — {last}")


# ── 설정·토큰 ────────────────────────────────────────────────────────────────
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

# ── 상태 ─────────────────────────────────────────────────────────────────────
ALLOWED_ROOTS: list[Path] = []        # /pick으로 승인된 폴더
JOBS: dict[str, dict] = {}            # job_id → {status, log[], progress, error, results}
JOB_QUEUE: list[str] = []
JOB_LOCK = threading.Lock()

# 웹 UI가 닫히면 브리지도 스스로 끝난다 — 사용자가 트레이에서 따로 끄지 않아도
# 되게 하기 위함(2026-07-21). 웹은 15초마다 /ping을 보내므로, 그 신호가
# 일정 시간 끊기면 아무도 안 쓰는 것으로 본다.
#   ⚠ 작업 중에는 절대 끝내지 않는다 — 변환이 수십 분 걸릴 수 있고,
#     그 사이 사용자가 탭을 닫아 두는 경우가 실제로 있다.
LAST_SEEN = time.time()
IDLE_EXIT_SEC = 90          # ping 15초 간격 기준 6회 연속 유실


def path_allowed(p: Path) -> bool:
    try:
        rp = p.resolve()
    except Exception:
        return False
    return any(str(rp).startswith(str(root)) for root in ALLOWED_ROOTS)

def job_log(job, msg):
    job["log"].append(str(msg))

# ── 폴더/파일 선택 (tkinter — 요청 스레드에서 개별 Tk 루트 생성) ─────────────
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
            # 저장 위치 지정 — 아직 없는 파일을 고르는 것이라 askopen으로는 안 된다.
            # patterns는 [(설명, 확장자), …] 형태로 받는다.
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

# ── 작업 실행기 (순차 — 사용자 지시: 기능별 배치·순차 처리) ────────────────
def run_convert(job, params):
    import convert_core
    paths = [Path(p) for p in params.get("paths", [])]
    files = []
    for p in paths:
        if p.is_dir():
            files += [f for f in sorted(p.rglob("*")) if f.suffix.lower() in convert_core.SUPPORTED]
        elif p.suffix.lower() in convert_core.SUPPORTED:
            files.append(p)
    if not files:
        raise RuntimeError("변환 대상 파일이 없습니다 (지원: pdf·xlsx·xls·docx·hwp·hwpx)")
    out_dir = Path(params.get("out_dir") or (files[0].parent / "markdown_output"))
    if not path_allowed(out_dir.parent if not out_dir.exists() else out_dir):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    total = len(files)
    ok = err = 0
    for i, src in enumerate(files, 1):
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
    """선택 파일 다운로드 (+옵션 zip 번들) — eiass_doc_resolver를 import 참조.
    사후(after)는 회차(rounds) 단위 선택 — 회차별 하위폴더 {연도}_{seq}에 저장."""
    import eiass_doc_resolver as edr
    code = params["code"].strip().upper()
    out_root = Path(params["out_dir"])
    if not path_allowed(out_root):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    r = edr.EIASSDocResolver()

    # ZIP으로 묶을 때는 **대상 폴더에 개별 파일을 아예 만들지 않는다.**
    #   예전에는 대상 폴더에 받아둔 뒤 zip을 만들고 지웠는데, OneDrive 동기화
    #   폴더에서 삭제가 실패해 빈 폴더가 남고 원본이 어긋나는 일이 반복됐다
    #   (2026-07-21). 임시 폴더에 받아 zip만 대상 폴더에 두면
    #   "지우다 실패" 자체가 생길 수 없다.
    want_zip = bool(params.get("zip"))
    work_root = Path(tempfile.mkdtemp(prefix="eiaw_zip_")) if want_zip else out_root
    base_dir = work_root / edr._safe_filename(code)
    saved = []          # (Path, zip 내 상대경로)
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
            # UI에서 파일 단위 부분 선택이 왔으면 그 파일들만 (2026-07-20 요구 3)
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
        for d in docs:                       # 같은 FILE_SEQ가 두 번 잡히면 한 번만
            if str(d.file_seq) in seqs and str(d.file_seq) not in _seen:
                _seen.add(str(d.file_seq))
                targets.append(d)
        if not targets:
            raise RuntimeError("선택한 FILE_SEQ가 현재 목록과 일치하지 않습니다 — 다시 조회하세요")
        # 절차(초안·본안·보완 등)별 하위 폴더로 나눠 저장한다.
        # 한 폴더에 전부 쏟으면 PDF가 뒤섞여 무엇이 어느 절차인지 알 수 없다
        # (2026-07-21 사용자 요구). stage_label은 EIASS 아코디언 원문 그대로다.
        base_dir.mkdir(parents=True, exist_ok=True)
        for i, d in enumerate(targets, 1):
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
            for p, arc in saved:                 # 같은 파일이 두 번 잡히면 한 번만
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
            # 임시 폴더는 대상 폴더 밖(시스템 temp)이라 정리 실패 위험이 없다
            shutil.rmtree(work_root, ignore_errors=True)
    else:
        job_log(job, f"─── 다운로드 완료: 성공 {ok} / 실패 {fail} → {base_dir}")


# ── 사진 좌표 ────────────────────────────────────────────────────────────
# 지오세터(GeoSetter)가 하던 일을 워크벤치로 옮긴 것이다. 계산 근거와 지오세터
# 실행 로그와의 정량 대조는 photo_exif.py / test_photo_exif.py에 있다.

def photo_scan(params):
    """폴더의 사진에서 촬영지점·방향을 뽑는다.

    좌표가 없는 사진도 **목록에서 지우지 않고** 사유와 함께 돌려준다 —
    조용히 빠지면 사용자는 몇 장이 누락됐는지조차 모른다.
    """
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
    """썸네일 JPEG 바이트. EXIF 회전을 반영해 세로사진이 눕지 않게 한다.

    HEIC도 여기서 JPEG로 바뀌어 나가므로 브라우저가 그대로 표시할 수 있다
    (브라우저는 HEIC를 디코드하지 못한다 — 브리지 경유를 택한 이유 중 하나).
    """
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
    """선택한 사진들을 KML 또는 SHP로 내보낸다."""
    import photo_exif as px

    fmt = (params.get("format") or "kml").lower()
    out = Path(params.get("out") or "")
    if not out.parent.is_dir():
        raise RuntimeError(f"저장 폴더가 없습니다: {out.parent}")
    if not path_allowed(out.parent):
        raise RuntimeError("승인된 폴더가 아닙니다 — [저장 위치]를 다시 지정하세요")

    # 웹이 보낸 dict를 그대로 다시 PhotoPoint로 만든다. 재스캔하지 않는 이유는
    # 사용자가 목록에서 고른 **그 부분집합**을 내보내야 하기 때문이다.
    pts = []
    for d in params.get("photos") or []:
        pts.append(px.PhotoPoint(**{k: v for k, v in d.items()
                                    if k in px.PhotoPoint.__dataclass_fields__}))
    geo = [p for p in pts if p.has_geo]
    if not geo:
        raise RuntimeError("좌표를 가진 사진이 없습니다")

    epsg = int(params.get("epsg") or 5186)
    if fmt == "kml":
        p = px.export_kml(geo, out, wedge_km=float(params.get("wedge_km") or 0.15))
    elif fmt == "shp":
        p = px.export_shp(geo, out, epsg=epsg)
    elif fmt == "csv":
        p = px.export_csv(geo, out, epsg=epsg)
    else:
        raise RuntimeError(f"알 수 없는 형식: {fmt}")
    return {"ok": True, "path": str(p), "count": len(geo)}


def run_pdf2excel_scan(job, params):
    """PDF에서 표를 찾아 목록만 돌려준다(파일은 만들지 않는다).

    검증 완료된 pdf2excel_core를 **그대로** 호출한다 — scan → group 순서와
    인자를 GUI(pdf2excel_gui.py)와 동일하게 맞춘다. 로직을 다시 짜지 않는다.
    """
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

    raws = pc.scan(src, spec, progress=on_prog)
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
    """선택한 표만 엑셀로 저장한다. 스캔을 다시 하므로 원본이 바뀌면 결과도 따라간다."""
    import pdf2excel_core as pc
    src = Path(params["path"])
    if not path_allowed(src):
        raise RuntimeError("대상 파일이 승인된 경로가 아닙니다")
    out_dir = Path(params.get("out_dir") or src.parent)
    if not path_allowed(out_dir):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    spec = (params.get("page_range") or "").strip()
    picked = params.get("picked")            # None이면 전체
    gap = int(params.get("gap_rows", 4))

    def on_prog(done, total):
        job["progress"] = {"done": done, "total": total, "stage": f"{done}/{total} 쪽"}

    raws = pc.scan(src, spec, progress=on_prog)
    if not raws:
        raise RuntimeError("표를 찾지 못했습니다 — 페이지 범위를 확인하세요")
    tables = pc.group(raws)

    if picked is not None:
        sel = set(int(i) for i in picked)
        tables = [t for i, t in enumerate(tables) if i in sel]
        if not tables:
            raise RuntimeError("선택한 표가 없습니다")

    out = out_dir / f"{src.stem}.xlsx"
    # write_xlsx는 표가 0개면 ValueError를 낸다 — 빈 엑셀을 만들지 않는 설계다
    path = pc.write_xlsx(tables, out, src.name, gap)
    size = Path(path).stat().st_size
    job_log(job, f"  ✓ {Path(path).name} ({size >> 10} KB · 표 {len(tables)}개)")
    job_log(job, f"─── 저장 완료 → {path}")
    job["result"] = {"path": str(path)}


def run_hwp2pdf(job, params):
    """convert_batch는 진행 dict를 yield하는 **제너레이터**다 — 순회해야 실행된다.
    (2026-07-20 실사고: 리스트로 취급해 dict에 [0] 인덱싱 → KeyError(0) → 로그 '✗ 0')"""
    import hwp2pdf_core
    paths = [Path(p) for p in params.get("paths", [])]
    files = hwp2pdf_core.collect_files([str(p) for p in paths], recursive=True)
    if not files:
        raise RuntimeError("HWP/HWPX 파일이 없습니다")
    out_dir = params.get("out_dir") or None

    ok = fail = 0
    for ev in hwp2pdf_core.convert_batch(files, out_dir=out_dir):
        ph = ev.get("phase")
        if ph == "start":
            job["progress"] = {"done": 0, "total": ev["total"], "stage": "한컴 기동 중"}
            job_log(job, f"HWP→PDF 일괄 변환 {ev['total']}건 시작")
        elif ph == "engine":
            job_log(job, f"  엔진: {ev.get('mode')} / PDF 프린터: {ev.get('pdf_printer') or '-'}")
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
        elif ph == "done":
            job_log(job, f"─── 변환 완료: 성공 {ev['ok']} / 실패 {ev['fail']} / 건너뜀 {ev['skip']}")
    if fail and not ok:
        raise RuntimeError("전건 변환 실패 — 한컴오피스 설치·한컴 PDF 프린터를 확인하세요")

def run_eiass_seq_dl(job, params):
    """FILE_SEQ 직접 다운로드 (SYS-32) — 웹 iframe 경로의 '조용한 누락'을 없애는 검증 가능 경로.
    브라우저는 저장 성공을 JS에 알려주지 않지만, 여기서는 응답 코드·크기·예외가 전부 남는다."""
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
        job["progress"] = {"done": i - 1, "total": total, "stage": f"FILE_SEQ {seq}"}
        try:
            # resolver.download는 DocFile 또는 FILE_SEQ 문자열을 받는다(시그니처 확인됨)
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
    """SYS-31 선행 COM 검증 — 읽기 전용. 원본을 수정하지 않는다.
    bat 실행이 반복 실패해(인코딩·괄호·한글 경로) 검증된 브리지 경로로 옮겼다(2026-07-20)."""
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
    """SYS-31 사전 스캔 — 파일별 쪽번호/물리쪽수/A3 위치 + 장 경계 판정(읽기 전용)."""
    import hwp_pagenum as hp
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")
    files = hp.scan_folder(
        folder,
        log=lambda m: job_log(job, m),
        progress=lambda d, t, s: job.__setitem__("progress", {"done": d, "total": t, "stage": s}),
    )
    plan = hp.assign_numbers(
        hp.build_plan(files, include_divider=params.get("divider", "none"),
                      a3_back=params.get("a3_back", "skip"),
                      ),
        start_num=int(params.get("start_num", 1)),
    )
    job["result"] = [_plan_row(f) for f in plan]
    job_log(job, f"─── 스캔 완료: {len(files)}개 파일")


def _plan_row(f: dict) -> dict:
    """UI 표에 실을 요약 — 스캔과 재계획이 **같은 형식**을 내야 표가 어긋나지 않는다.

    무거운 pages 배열은 빼되, **어떻게 그 번호가 나왔는지**는 함께 보낸다
    (간지·결번·본문 구간). 표에 결과만 있으면 사용자가 검산할 수 없다.
    """
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
            # 마지막이 A3면 그 뒷면은 이 파일 범위 밖에서 결번으로 소비된다
            "tail_a3_gap": (nums[-1] + 1) if pages[-1][2] else None,
        }
    return {
        "detail": detail,
        # 재계획(/replan)은 스캔 결과를 그대로 받아 다시 계산하므로, 스캔에만 있는
        # 키(path 등)가 없을 수 있다 — 없으면 빈 값으로 둔다(KeyError 방지).
        "name": f["name"], "path": f.get("path", ""), "chapter": f.get("chapter"),
        "is_chapter_head": f.get("is_chapter_head", False), "skip": f.get("skip", False),
        "phys_pages": f.get("phys_pages"), "a3_count": len(f.get("a3_pages") or []),
        "a3_pages": f.get("a3_pages") or [],
        "start": f["start"], "end": f["end"],
        "marks": f["marks"], "divider": f.get("divider", False),
        # ↓ 표가 '현재 상태'를 보여주는 데 쓰는 값들.
        #   화이트리스트 직렬화라 여기에 안 적으면 조용히 사라진다
        #   (2026-07-20: 스캔은 정상인데 UI만 비어 원인을 한참 헤맸다)
        "start_page": f.get("start_page"), "end_page": f.get("end_page"),
        "hide_pages": f.get("hide_pages") or [],
        "hide_targets": f.get("hide_targets") or [],
        "force_odd": f.get("force_odd") or [],
        "do_hide": f.get("do_hide", False),
        "gap_count": f.get("gap_count", 0),
        # 적용 단계가 웹 파라미터에 의존하지 않도록 계획 조건을 결과에 실어 보낸다.
        # (웹이 구버전이라 옵션을 안 보내면 브리지가 기본값으로 다시 계산해
        #  스캔 표와 다른 번호가 나온다 — 2026-07-20)
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
    """스캔 결과 행에 실려 온 계획 조건을 꺼낸다(번호가 부여된 첫 행 기준)."""
    for r in rows:
        if not r.get("skip") and r.get(key):
            return r[key]
    return default


def run_pagenum_apply(job, params):
    """계산된 계획을 문서에 적용. 원본을 수정하므로 사전 백업 안내가 UI에 필수."""
    import hwp_pagenum as hp
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다")
    files = params.get("files")
    if not files:
        raise RuntimeError("적용할 파일 목록이 없습니다 — 먼저 스캔하세요")
    # 계획을 재계산하되 **스캔과 똑같은 경로**(build_plan → assign_numbers)로 만든다.
    # assign_numbers만 부르면 build_plan이 채우는 divider_mode·a3_back이 비어
    # 결번이 통째로 빠진다 — 스캔은 9~31인데 실제로는 7~29가 찍히던 원인
    # (2026-07-20). 같은 결과를 내야 하는 두 경로는 같은 함수를 거쳐야 한다.
    plan = hp.assign_numbers(
        hp.build_plan(
            files,
            # 파라미터가 없으면 **스캔 결과에 실려 온 조건**을 쓴다.
            include_divider=params.get("divider") or _row_opt(files, "divider_mode", "none"),
            a3_back=params.get("a3_back") or _row_opt(files, "a3_back", "skip"),
        ),
        start_num=int(params.get("start_num", 1)),
    )
    # 스캔 표에 보여드린 값과 실제 적용할 계획이 같은지 먼저 대조한다.
    # 두 경로가 갈라지면 사용자는 표를 보고 승인했는데 다른 번호가 찍힌다.
    drift = [(f["name"], f.get("start"), g["start"], f.get("end"), g["end"])
             for f, g in zip(files, plan)
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
    )


RUNNERS = {"convert": run_convert, "eiass_dl": run_eiass_dl,
           "pagenum_scan": run_pagenum_scan, "pagenum_apply": run_pagenum_apply,
           "hwp_probe": run_hwp_probe,
           "eiass_seq_dl": run_eiass_seq_dl,
           "hwp2pdf": run_hwp2pdf,
           "pdf2excel_scan": run_pdf2excel_scan, "pdf2excel_write": run_pdf2excel_write}

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
        job["status"] = "running"
        try:
            RUNNERS[job["type"]](job, job["params"])
            job["status"] = "done"
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)
            job_log(job, f"✗ {e}")

# ── HTTP 핸들러 ──────────────────────────────────────────────────────────────
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

    def do_GET(self):
        global LAST_SEEN
        LAST_SEEN = time.time()
        url = urlparse(self.path)
        if url.path == "/ping":
            self._json({"ok": True, "bridge_version": BRIDGE_VERSION,
                        "features": detect_features(), "queue": len(JOB_QUEUE)})
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
            # 썸네일·미리보기. `<img src>`로 직접 부르면 토큰을 쿼리에 실어야 하고
            # 그러면 토큰이 브라우저 이력·로그에 남는다 — 다른 엔드포인트와 같이
            # 헤더 인증을 유지하고, 웹은 fetch로 받아 blob URL로 붙인다.
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
        LAST_SEEN = time.time()
        if not self._auth_ok():
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        url = urlparse(self.path)
        body = self._body()

        if url.path == "/pick":
            patterns = body.get("patterns")
            paths = pick_dialog(body.get("kind", "folder"), patterns,
                                initial=body.get("initial"),
                                initial_dir=body.get("initial_dir"))
            for p in paths:
                root = Path(p)
                # 저장 위치는 아직 파일이 없다 — is_dir()가 False라 부모를 잡는데,
                # 그게 정확히 승인해야 할 폴더다.
                root = root if root.is_dir() else root.parent
                if root not in ALLOWED_ROOTS:
                    ALLOWED_ROOTS.append(root.resolve())
            self._json({"ok": True,
                        "path": paths[0] if len(paths) == 1 else None,
                        "paths": paths})
            return

        if url.path == "/photo/scan":
            # EXIF만 읽으므로 픽셀 디코드가 없어 빠르다 — 작업큐를 쓰지 않는다.
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
            # 표에서 값을 고치면 문서를 다시 읽지 않고 계획만 다시 세운다.
            # 스캔은 한컴을 띄워 수 분이 걸리므로, 사용자가 숫자 하나 고칠 때마다
            # 재스캔하게 두면 쓸 수 없다(순수 계산이라 즉시 끝난다).
            import hwp_pagenum as hp
            files = body.get("files") or []
            plan = hp.assign_numbers(
                hp.build_plan(files,
                              include_divider=body.get("divider", "none"),
                              a3_back=body.get("a3_back", "skip"),
                              overrides=body.get("overrides") or {}),
                start_num=int(body.get("start_num", 1)),
            )
            self._json({"ok": True, "plan": [_plan_row(f) for f in plan]})
            return

        if url.path == "/eiass/resolve":
            # 동기 조회 — 사업코드 → 원문 파일목록 (절차단계·장코드·파일명)
            # 사후(after): 회차 목록(연도별)을 먼저 반환 (DAT-17)
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
                    if aes:   # 특정 회차의 파일목록 (UI [파일 보기] 펼침용)
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
                            "log": [], "progress": None, "error": None}
            with JOB_LOCK:
                JOB_QUEUE.append(job_id)
            self._json({"ok": True, "job_id": job_id})
            return

        self._json({"ok": False, "error": "unknown endpoint"}, 404)

# ── 기동 ─────────────────────────────────────────────────────────────────────
def _idle_watchdog(srv, on_exit=None):
    """웹 UI가 닫히면(=요청이 끊기면) 스스로 종료한다.

    사용자는 exe를 더블클릭해 쓰고 브라우저를 닫으면 끝이다 — 트레이에서
    따로 끄는 절차를 요구하지 않는다(2026-07-21 사용자 지시).
    작업 중에는 끝내지 않는다: 변환이 수십 분 걸릴 수 있고 그 사이 탭을
    닫아 두는 경우가 있다.
    """
    def loop():
        while True:
            time.sleep(10)
            busy = any(j.get("status") == "running" for j in JOBS.values()) or JOB_QUEUE
            if busy:
                continue
            if time.time() - LAST_SEEN > IDLE_EXIT_SEC:
                print(f"\n  웹 UI 연결이 {IDLE_EXIT_SEC}초 이상 끊겨 종료합니다.", flush=True)
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
    """트레이 아이콘을 만든다. 못 만들면 None을 돌려 콘솔 모드로 떨어진다.

    종료 수단이 사라지면 안 되므로, 트레이가 없으면 창을 없애지 않는다 —
    백그라운드로만 돌면 사용자가 끌 방법이 없어진다.
    """
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        return None

    try:
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((6, 6, 58, 58), fill=(27, 76, 140, 255))      # 남색 원
        d.text((22, 20), "E", fill=(255, 255, 255, 255))

        def open_web(*_):
            try:
                webbrowser.open(f"{WEB_URL}#bt={TOKEN}&bp={port}")
            except Exception:
                pass

        def copy_token(*_):
            """토큰을 클립보드로 — 자동 페어링이 막힌 환경의 수동 등록용."""
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


def main():
    import argparse
    ap = argparse.ArgumentParser(description="EIA Workbench 로컬 브리지")
    ap.add_argument("--allow", action="append", default=[],
                    help="사전 승인 폴더 (테스트·자동화용 — 웹의 [폴더 선택] 없이 접근 허용)")
    ap.add_argument("--no-browser", action="store_true",
                    help="시작 시 웹 UI 자동 열기 생략")
    args = ap.parse_args()
    for a in args.allow:
        ALLOWED_ROOTS.append(Path(a).resolve())

    threading.Thread(target=worker, daemon=True).start()

    # ⚠ Windows 함정: HTTPServer 기본 allow_reuse_address=True는 Windows에서
    # SO_REUSEADDR로 **이미 사용 중인 포트에도 바인딩이 성공**한다(2026-07-20 실사고 —
    # PoC 스텁이 8765를 쥔 채로 브리지가 "정상 기동"했지만 연결은 전부 스텁이 가로챔).
    # ① reuse 금지 ② 바인딩 전 실제 리스너 존재를 소켓 연결로 선확인.
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

    srv = None
    port = None
    for p in PORTS:
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
        print("포트 8765~8770이 모두 사용 중입니다. 다른 브리지가 떠 있는지 확인하세요.")
        sys.exit(1)

    feats = detect_features()
    print("=" * 64)
    print("  EIA Workbench 로컬 브리지")
    print("=" * 64)
    print(f"  주소   : http://127.0.0.1:{port}")
    print(f"  버전   : {BRIDGE_VERSION}")
    print(f"  기능   : " + ", ".join(k for k, v in feats.items() if v))
    miss = [k for k, v in feats.items() if not v]
    if miss:
        print(f"  비활성 : {', '.join(miss)} (해당 도구 미설치 또는 Windows 아님)")
    print()
    if args.no_browser:
        print("  수동 연결: 웹 UI ⚙ 설정 → 브리지 토큰에 아래 값 입력")
        print(f"     {TOKEN}")
    else:
        # 자동 페어링 — 웹 UI를 열면서 URL 해시로 토큰·포트 전달.
        # 웹이 해시를 읽어 localStorage에 저장하고 즉시 지운다(주소창·히스토리 잔존 방지).
        pair_url = f"{WEB_URL}#bt={TOKEN}&bp={port}"
        print("  브라우저에서 웹 UI를 자동으로 엽니다 — 토큰이 자동 등록됩니다.")
        print("  (안 열리면 수동 접속: " + WEB_URL + ")")
        print(f"  수동 등록용 토큰: {TOKEN}")
        try:
            webbrowser.open(pair_url)
        except Exception:
            pass
    print()

    # ── 트레이 상주 (검은 창 없이 백그라운드) ──────────────────────────
    # 배포 도구인데 콘솔 창을 계속 켜 두게 하는 것은 결함이다(2026-07-21 사용자 지적).
    # 서버를 스레드로 돌리고 트레이 아이콘을 띄운다. 트레이를 못 쓰는 환경
    # (pystray 미설치 등)에서는 종전대로 콘솔에서 돈다 — 종료 수단이 없어지면
    # 안 되므로 조용히 창만 없애지는 않는다.
    icon = _make_tray(srv, port)
    _idle_watchdog(srv, on_exit=(icon.stop if icon else None))
    if icon is None:
        print("  웹 UI를 닫으면 자동 종료됩니다. 즉시 종료: Ctrl+C")
        print("-" * 64, flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  종료했습니다.")
        return

    print("  트레이에 상주합니다 — 웹 UI를 닫으면 자동 종료됩니다(트레이 메뉴로도 종료 가능).")
    print("-" * 64, flush=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        icon.run()                      # 트레이가 주 스레드를 잡는다
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()

if __name__ == "__main__":
    main()
