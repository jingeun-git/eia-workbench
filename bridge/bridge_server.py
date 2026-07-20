#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EIA Workbench 로컬 브리지 (SYS-29 7단계)

웹 UI(GitHub Pages)가 브라우저에서 할 수 없는 작업을 대신 실행한다:
  - md 고품질 변환  : convert_core.py (HWP·HWPX·OCR·듀얼엔진) — import 참조
  - EIASS 자동탐색  : eiass_doc_resolver.py — 서브프로세스(검증된 CLI 그대로)
  - HWP→PDF        : hwp2pdf_core.py — import 참조 (한컴 COM)
  - 차례/쪽번호     : hwpContent1.1.py·hwpPageNum2.0.py — 서브프로세스(cwd=대상 폴더)
  ※ 끼워넣기(.Egg)는 한컴 매크로라 자동화 불가 — 기능 목록에서 false로 노출

설계 원칙 (1단계 PoC 실측 반영):
  - CORS: ACAO "*" 고정 (Origin 헤더는 경로상 변조가 실측되어 신뢰하지 않는다)
  - PNA: Access-Control-Allow-Private-Network: true 상시 부착 (향후 강제 대비)
  - 캐시: no-store (캐시된 CORS 응답 오진 사고 재발 방지)
  - 인증: Bearer 토큰 (GET /ping 제외 전 요청) — 최초 실행 시 생성·콘솔 표시
  - 파일 접근: /pick으로 사용자가 승인한 폴더 하위만 허용 (화이트리스트)
  - 작업: 순차 처리 (동시 1개 — 한컴 COM 특성상 병렬 불가이기도 함)

기존 도구 폴더의 코드를 그대로 참조한다 — 복제 금지(두 벌 관리 방지).
"""

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

BRIDGE_VERSION = "1.0.0"
PORTS = [8765, 8766, 8767, 8768, 8769, 8770]

# ── 경로 (D:\Claude 표준 배치 기준) ─────────────────────────────────────────
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent

BRIDGE_DIR = _base_dir()
TOOLS_DIR  = BRIDGE_DIR.parent.parent            # 99.Tools/
CONFIG     = BRIDGE_DIR / "bridge_config.json"

CONVERT_DIR  = TOOLS_DIR / "convert_to_md"
EIASS_DIR    = TOOLS_DIR / "EIASS"
HWP2PDF_DIR  = TOOLS_DIR / "hwp2pdf"
TOC_SCRIPT   = TOOLS_DIR / "배포용/hwpContent1.2/hwpContent1.1.py"
PAGE_SCRIPT  = TOOLS_DIR / "배포용/hwpPageNum2.1/hwpPageNum2.0.py"
RESOLVER     = EIASS_DIR / "eiass_doc_resolver.py"

for p in (CONVERT_DIR, HWP2PDF_DIR):
    if p.exists():
        sys.path.insert(0, str(p))

IS_WINDOWS = os.name == "nt"

# ── 기능 가용성 탐지 (파일 실재·임포트 가능 여부로 판정 — 표기만으로 단정 금지) ──
def detect_features():
    feats = {"convert": False, "ocr": False, "eiass": False,
             "hwp2pdf": False, "toc": False, "pagenum": False, "merge": False}
    try:
        import convert_core  # noqa
        feats["convert"] = True
        feats["ocr"] = bool(getattr(convert_core, "_HAS_OCR", False))
    except Exception:
        pass
    feats["eiass"] = RESOLVER.exists()
    if IS_WINDOWS:
        try:
            import hwp2pdf_core  # noqa
            feats["hwp2pdf"] = True
        except Exception:
            pass
        feats["toc"] = TOC_SCRIPT.exists()
        feats["pagenum"] = PAGE_SCRIPT.exists()
    return feats

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

def path_allowed(p: Path) -> bool:
    try:
        rp = p.resolve()
    except Exception:
        return False
    return any(str(rp).startswith(str(root)) for root in ALLOWED_ROOTS)

def job_log(job, msg):
    job["log"].append(str(msg))

# ── 폴더/파일 선택 (tkinter — 요청 스레드에서 개별 Tk 루트 생성) ─────────────
def pick_dialog(kind: str, patterns=None):
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if kind == "folder":
            path = filedialog.askdirectory(title="EIA Workbench — 폴더 선택")
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

def run_eiass(job, params):
    code = params["code"]
    out_dir = Path(params["out_dir"])
    if not path_allowed(out_dir):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다")
    cmd = [sys.executable if not getattr(sys, "frozen", False) else "python",
           str(RESOLVER), code, "-o", str(out_dir), "-g", params.get("gubn", "auto")]
    if params.get("keyword"):
        cmd += ["-d", params["keyword"]]
    else:
        cmd += ["--all"]
    job_log(job, f"실행: {' '.join(cmd[1:])}")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace",
                            cwd=str(EIASS_DIR))
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            job_log(job, line)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"resolver 종료 코드 {proc.returncode}")

def run_hwp2pdf(job, params):
    import hwp2pdf_core
    paths = [Path(p) for p in params.get("paths", [])]
    files = hwp2pdf_core.collect_files([str(p) for p in paths], recursive=True)
    if not files:
        raise RuntimeError("HWP/HWPX 파일이 없습니다")
    out_dir = params.get("out_dir")
    job["progress"] = {"done": 0, "total": len(files), "stage": "한컴 변환 중"}
    job_log(job, f"HWP→PDF 일괄 변환 {len(files)}건 시작")
    results = hwp2pdf_core.convert_batch(files, out_dir=out_dir)
    ok = sum(1 for r in results if r and r[0]) if results else len(files)
    job_log(job, f"─── 변환 완료 ({ok}건)")
    job["progress"] = {"done": len(files), "total": len(files), "stage": "완료"}

def run_hwptool(job, params):
    tool = params["tool"]
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다")
    script = TOC_SCRIPT if tool == "toc" else PAGE_SCRIPT
    cmd = ["python", str(script)]
    if tool == "pagenum":
        cmd.append(str(int(params.get("start_num", 1))))
    job_log(job, f"[{tool}] 대상 폴더: {folder} — 폴더 내 전체 .hwp 처리")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="cp949", errors="replace",
                            cwd=str(folder))
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            job_log(job, line)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"{tool} 종료 코드 {proc.returncode}")

RUNNERS = {"convert": run_convert, "eiass": run_eiass,
           "hwp2pdf": run_hwp2pdf, "hwptool": run_hwptool}

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
                        "error": job.get("error")})
            return
        self._json({"ok": False, "error": "unknown endpoint"}, 404)

    def do_POST(self):
        if not self._auth_ok():
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        url = urlparse(self.path)
        body = self._body()

        if url.path == "/pick":
            patterns = body.get("patterns")
            paths = pick_dialog(body.get("kind", "folder"), patterns)
            for p in paths:
                root = Path(p)
                root = root if root.is_dir() else root.parent
                if root not in ALLOWED_ROOTS:
                    ALLOWED_ROOTS.append(root.resolve())
            self._json({"ok": True,
                        "path": paths[0] if len(paths) == 1 else None,
                        "paths": paths})
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
def main():
    import argparse
    ap = argparse.ArgumentParser(description="EIA Workbench 로컬 브리지")
    ap.add_argument("--allow", action="append", default=[],
                    help="사전 승인 폴더 (테스트·자동화용 — 웹의 [폴더 선택] 없이 접근 허용)")
    args = ap.parse_args()
    for a in args.allow:
        ALLOWED_ROOTS.append(Path(a).resolve())

    threading.Thread(target=worker, daemon=True).start()

    srv = None
    port = None
    for p in PORTS:
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), Handler)
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
    miss = [k for k, v in feats.items() if not v and k != "merge"]
    if miss:
        print(f"  비활성 : {', '.join(miss)} (해당 도구 미설치 또는 Windows 아님)")
    print()
    print("  ── 웹 UI 연결 방법 ──────────────────────────────────")
    print("  1) https://jingeun-git.github.io/eia-workbench/ 접속")
    print("  2) 우상단 ⚙ 설정 → 브리지 토큰에 아래 값 입력:")
    print()
    print(f"     {TOKEN}")
    print()
    print("  이 창을 켜 둔 동안에만 브리지 기능이 활성화됩니다. 종료: Ctrl+C")
    print("-" * 64, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  종료했습니다.")

if __name__ == "__main__":
    main()
