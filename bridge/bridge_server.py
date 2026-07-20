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

BRIDGE_VERSION = "3.3.2"
PORTS = [8765, 8766, 8767, 8768, 8769, 8770]
WEB_URL = "https://jingeun-git.github.io/eia-workbench/"

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
# 차례(hwpContent)·끼워넣기(.Egg): 2026-07-20 사용자 지시로 기능 삭제
# ⚠ hwpPageNum2.0.py는 `import intro`를 하는데 intro.py가 저장소에 없다(2026-07-20 실측)
#   → .py 직접 실행은 ModuleNotFoundError로 즉사한다. 동봉된 .exe는 자립형이라 그쪽을 우선한다.
#   SYS-31에서 규칙 3종과 함께 재구현되면 이 의존 자체가 사라진다.
PAGE_EXE     = TOOLS_DIR / "배포용/hwpPageNum2.1/hwpPageNum2.1.exe"
PAGE_SCRIPT  = TOOLS_DIR / "배포용/hwpPageNum2.1/hwpPageNum2.0.py"
RESOLVER     = EIASS_DIR / "eiass_doc_resolver.py"

for p in (BRIDGE_DIR, CONVERT_DIR, HWP2PDF_DIR, EIASS_DIR):
    if p.exists():
        sys.path.insert(0, str(p))

IS_WINDOWS = os.name == "nt"

# ── 기능 가용성 탐지 (파일 실재·임포트 가능 여부로 판정 — 표기만으로 단정 금지) ──
def detect_features():
    feats = {"convert": False, "ocr": False, "eiass": False,
             "hwp2pdf": False, "pagenum": False}
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
        feats["pagenum"] = PAGE_EXE.exists() or PAGE_SCRIPT.exists()
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

def run_eiass_dl(job, params):
    """선택 파일 다운로드 (+옵션 zip 번들) — eiass_doc_resolver를 import 참조.
    사후(after)는 회차(rounds) 단위 선택 — 회차별 하위폴더 {연도}_{seq}에 저장."""
    import eiass_doc_resolver as edr
    code = params["code"].strip().upper()
    out_root = Path(params["out_dir"])
    if not path_allowed(out_root):
        raise RuntimeError("저장 폴더가 승인된 경로가 아닙니다 — [폴더 선택]으로 다시 지정하세요")

    r = edr.EIASSDocResolver()
    base_dir = out_root / edr._safe_filename(code)
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
        targets = [d for d in docs if str(d.file_seq) in seqs]
        if not targets:
            raise RuntimeError("선택한 FILE_SEQ가 현재 목록과 일치하지 않습니다 — 다시 조회하세요")
        base_dir.mkdir(parents=True, exist_ok=True)
        for i, d in enumerate(targets, 1):
            job["progress"] = {"done": i - 1, "total": len(targets), "stage": d.filename}
            dl(d, base_dir, f"{code}/")

    job["progress"] = {"done": 1, "total": 1, "stage": "완료"}
    if params.get("zip") and saved:
        import zipfile
        zip_path = out_root / f"{edr._safe_filename(code)}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for p, arc in saved:
                z.write(p, arcname=arc)
        job_log(job, f"  ✓ ZIP 번들: {zip_path.name} ({len(saved)}건)")
    job_log(job, f"─── 다운로드 완료: 성공 {ok} / 실패 {fail} → {base_dir}")

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

def run_hwptool(job, params):
    tool = params["tool"]
    folder = Path(params["folder"])
    if not path_allowed(folder):
        raise RuntimeError("대상 폴더가 승인된 경로가 아닙니다")
    if tool != "pagenum":
        raise RuntimeError(f"지원하지 않는 도구: {tool}")
    start = str(int(params.get("start_num", 1)))
    if PAGE_EXE.exists():
        cmd = [str(PAGE_EXE), start]          # 자립 exe (intro 번들됨)
    elif PAGE_SCRIPT.exists():
        cmd = ["python", str(PAGE_SCRIPT), start]
        job_log(job, "⚠ exe가 없어 .py로 실행합니다 — intro 모듈이 없으면 실패합니다")
    else:
        raise RuntimeError("쪽번호 도구를 찾을 수 없습니다 (exe·py 모두 없음)")
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
                      a3_back=params.get("a3_back", "skip")),
        start_num=int(params.get("start_num", 1)),
    )
    # UI 표에 실을 요약(무거운 pages 배열은 제외)
    job["result"] = [{
        "name": f["name"], "path": f["path"], "chapter": f["chapter"],
        "is_chapter_head": f["is_chapter_head"], "skip": f["skip"],
        "phys_pages": f.get("phys_pages"), "a3_count": len(f.get("a3_pages") or []),
        "a3_pages": f.get("a3_pages") or [],
        "start": f["start"], "end": f["end"],
        "marks": f["marks"], "divider": f.get("divider", False),
        # ↓ 표가 '현재 상태'를 보여주는 데 쓰는 값들.
        #   화이트리스트 직렬화라 여기에 안 적으면 조용히 사라진다
        #   (2026-07-20: 스캔은 정상인데 UI만 비어 원인을 한참 헤맸다)
        "start_page": f.get("start_page"), "end_page": f.get("end_page"),
        "hide_pages": f.get("hide_pages") or [],
        "gap_count": f.get("gap_count", 0),
        # 적용 단계가 웹 파라미터에 의존하지 않도록 계획 조건을 결과에 실어 보낸다.
        # (웹이 구버전이라 옵션을 안 보내면 브리지가 기본값으로 다시 계산해
        #  스캔 표와 다른 번호가 나온다 — 2026-07-20)
        "divider_mode": f.get("divider_mode", "none"),
        "a3_back": f.get("a3_back", "skip"),
        "pgct_pages": f.get("pgct_pages") or [],
        "pgct_phys": f.get("pgct_phys") or [],
        "div_skip": f.get("div_skip", 0),
        "expect_hide": f.get("expect_hide") or [],
        "stray_hide": f.get("stray_hide") or [],
        "error": f.get("error"),
    } for f in plan]
    job_log(job, f"─── 스캔 완료: {len(files)}개 파일")


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
                        "result": job.get("result") if job["status"] == "done" else None,
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
    print("  이 창을 켜 둔 동안에만 브리지 기능이 활성화됩니다. 종료: Ctrl+C")
    print("-" * 64, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  종료했습니다.")

if __name__ == "__main__":
    main()
