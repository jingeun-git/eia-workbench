#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HWP/HWPX → PDF 일괄 변환 엔진 (공유 모듈)

한컴오피스(한글) COM 자동화로 HWP·HWPX 문서를 PDF로 변환한다.
GUI(hwp2pdf_gui.py)·CLI(hwp2pdf.py)가 공통으로 호출한다.

전제:
  · Windows 네이티브 Python (COM은 WSL 불가)
  · 한컴오피스(한글) 설치
  · pywin32 (필수) / pyhwpx (선택, 보안모듈 자동 등록으로 권장)

변환 정책(고정):
  · 경로 = PrintToPDFEx (한컴 PDF 가상프린터) + PrintMethod=0
    → 문서에 저장된 2쪽 모아찍기 등 인쇄설정을 무시하고 항상 1쪽=1페이지(단면)·원용지.
      한컴 개발자 포럼 권장 방식. (SaveAs/FileSaveAs_S 계열은 모아찍기를 상속하므로 폴백 전용)
  · 텍스트·벡터 보존 — 페이지를 이미지로 래스터화하지 않음 (save_pdf_as_image 미사용)
  · 해상도 = 가상프린터 기본(자동)
  · 한컴 PDF 프린터가 없으면 SaveAs로 폴백(모아찍기 상속 가능) + 경고
"""

import os
import sys
import time

# ── 확장자 ─────────────────────────────────────────────────────────────────
HWP_EXTS = (".hwp", ".hwpx")


# ── 입력 수집 ──────────────────────────────────────────────────────────────

def is_hwp(path):
    return path.lower().endswith(HWP_EXTS)


def collect_files(paths, recursive=False):
    """파일/폴더 경로 목록 → 변환 대상 HWP/HWPX 절대경로 목록(중복 제거·정렬).

    · 파일 경로  → 확장자가 맞으면 포함
    · 폴더 경로  → 내부 .hwp/.hwpx 스캔(recursive=True 시 하위폴더 포함)
    """
    found = []
    seen = set()

    def _add(p):
        ap = os.path.abspath(p)
        key = os.path.normcase(ap)
        if key not in seen and is_hwp(ap) and os.path.isfile(ap):
            seen.add(key)
            found.append(ap)

    for raw in paths:
        p = raw.strip().strip('"').strip("'")
        if not p:
            continue
        if os.path.isdir(p):
            if recursive:
                for root, _dirs, files in os.walk(p):
                    for f in files:
                        _add(os.path.join(root, f))
            else:
                for f in os.listdir(p):
                    _add(os.path.join(p, f))
        else:
            _add(p)

    return sorted(found, key=lambda x: os.path.normcase(x))


def resolve_pdf_path(src, out_dir=None, skip_existing=False):
    """원본 경로 → 저장할 PDF 경로 결정.

    · out_dir=None → 원본과 같은 폴더(기본)
    · 중복 시 ' (2)' 접미어 부여
    · skip_existing=True 면 기존 PDF가 있을 때 None 반환(건너뜀)
    반환: (pdf_path 또는 None, skipped 여부)
    """
    base = os.path.splitext(os.path.basename(src))[0]
    target_dir = out_dir if out_dir else os.path.dirname(src)
    os.makedirs(target_dir, exist_ok=True)

    pdf_path = os.path.join(target_dir, base + ".pdf")
    if os.path.exists(pdf_path):
        if skip_existing:
            return None, True
        c = 2
        while os.path.exists(os.path.join(target_dir, f"{base} ({c}).pdf")):
            c += 1
        pdf_path = os.path.join(target_dir, f"{base} ({c}).pdf")
    return pdf_path, False


def human_size(num_bytes):
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes // 1024 // 1024} MB"
    if num_bytes >= 1024:
        return f"{num_bytes // 1024} KB"
    return f"{num_bytes} B"


# ── 변환 엔진 ──────────────────────────────────────────────────────────────

class HwpError(Exception):
    pass


class HwpNotInstalled(HwpError):
    """한컴오피스(한글) 미설치 또는 COM 등록 안 됨."""
    pass


class HwpConverter:
    """한글 인스턴스 1개를 열어 여러 파일을 순차 변환한다.

    사용:
        conv = HwpConverter()
        conv.start()                 # 한글 기동 (스레드면 CoInitialize 포함)
        conv.convert(src, pdf_path)  # 파일별 호출
        conv.quit()                  # 종료 (반드시 호출)
    GUI 워커 스레드에서 사용 시 start()가 pythoncom.CoInitialize()를 수행하므로
    반드시 같은 스레드에서 start()~quit()을 호출해야 한다.
    """

    def __init__(self):
        self.hwp = None
        self.mode = None          # "pyhwpx" | "win32com"
        self._co_init = False
        self.pdf_printer = None   # 한컴 PDF 가상프린터 실명 (없으면 None)

    # -- 기동 / 종료 -------------------------------------------------------

    def start(self):
        # 스레드 안에서 COM을 쓰려면 CoInitialize 필요 (메인 스레드도 무해)
        try:
            import pythoncom
            pythoncom.CoInitialize()
            self._co_init = True
        except Exception:
            self._co_init = False

        # 1순위: pyhwpx (보안모듈 DLL 자동 등록 → 파일열기 보안팝업 차단)
        try:
            from pyhwpx import Hwp
            self.hwp = Hwp(visible=False)
            self.mode = "pyhwpx"
            self._after_start()
            return
        except ImportError:
            pass
        except Exception:
            # pyhwpx는 있으나 한글 미설치 등으로 실패 → win32com 재시도
            pass

        # 2순위: raw win32com
        try:
            import win32com.client
        except ImportError:
            raise HwpNotInstalled(
                "pywin32 미설치 — 'pip install pywin32' 후 다시 실행하세요.")
        try:
            self.hwp = win32com.client.gencache.EnsureDispatch("HWPFrame.HwpObject")
        except Exception as e:
            raise HwpNotInstalled(
                "한컴오피스(한글)를 찾을 수 없습니다. 한글 설치 여부를 확인하세요.\n"
                f"(원인: {str(e)[:120]})")
        # 보안 승인 팝업 차단 (보안모듈 등록 — 미등록 시 변환 중 팝업이 뜰 수 있음)
        try:
            self.hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        except Exception:
            pass
        # 자동화 중 메시지박스 무시
        try:
            self.hwp.SetMessageBoxMode(0x00020000)
        except Exception:
            pass
        self.mode = "win32com"
        self._after_start()

    def _after_start(self):
        try:
            self.hwp.XHwpWindows.Item(0).Visible = False
        except Exception:
            pass
        self.pdf_printer = self._find_pdf_printer()

    @staticmethod
    def _find_pdf_printer():
        """한컴 PDF 가상프린터의 정확한 이름을 찾는다. 없으면 None.

        ⚠ 물리 프린터로 잘못 출력되는 사고를 막기 위해 '한컴 PDF'로 확신되는
        프린터만 반환한다(임의 PDF 프린터/기본 프린터로 보내지 않음).
        """
        try:
            import win32print
            names = [p[2] for p in win32print.EnumPrinters(
                win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)]
        except Exception:
            return None
        # 1) 정확히 'Hancom PDF'
        for n in names:
            if n.strip().lower() == "hancom pdf":
                return n
        # 2) (Hancom/한컴) + PDF 조합
        for n in names:
            low = n.lower()
            if ("hancom" in low or "한컴" in n) and "pdf" in low:
                return n
        return None

    def quit(self):
        if self.hwp is not None:
            try:
                self.hwp.Quit()
            except Exception:
                pass
            self.hwp = None
        if self._co_init:
            try:
                import pythoncom
                pythoncom.CoUninitialize()
            except Exception:
                pass
            self._co_init = False

    # -- 변환 --------------------------------------------------------------

    def convert(self, src, pdf_path):
        """단일 파일 변환. 실패 시 HwpError 발생. 성공 시 pdf_path 반환."""
        if self.hwp is None:
            raise HwpError("엔진이 시작되지 않았습니다 (start() 미호출).")
        if not os.path.isfile(src):
            raise HwpError("원본 파일을 찾을 수 없습니다.")

        # 열기 (forceopen: 변환 안 묻고 강제 열기)
        try:
            opened = self.hwp.Open(src, "", "forceopen:true")
        except Exception as e:
            raise HwpError(f"문서 열기 실패: {str(e)[:120]}")
        if opened is False:
            raise HwpError("문서 열기 실패(손상·암호·지원되지 않는 형식 가능)")

        # PDF 저장 (PrintToPDFEx로 모아찍기 무시·단면 → 실패 시 SaveAs 폴백)
        saved = self._save_pdf(pdf_path)

        # 문서 닫기 (저장 안 함)
        try:
            self.hwp.Clear(1)
        except Exception:
            pass

        if not saved or not os.path.isfile(pdf_path):
            raise HwpError("PDF 저장에 실패했습니다.")
        return pdf_path

    def _save_pdf(self, pdf_path):
        """PDF 저장.

        1순위: PrintToPDFEx (한컴 PDF 가상프린터) + PrintMethod=0
               → 문서에 저장된 2쪽 모아찍기 등 인쇄설정을 무시하고 항상 단면.
                 텍스트·벡터가 보존되는 정상 PDF(이미지 래스터화 아님).
        2순위(폴백): FileSaveAs_S / SaveAs — 가상프린터가 없을 때만.
                     (모아찍기가 상속될 수 있으나 변환은 보장)
        """
        # 1순위: 한컴 PDF 프린터가 확인된 경우에만 PrintToPDFEx 사용
        if self.pdf_printer and self._print_to_pdf_ex(pdf_path):
            return True

        # 2순위: SaveAs 계열 (FileSaveAs_S → SaveAs)
        try:
            hwp = self.hwp
            pset = hwp.HParameterSet.HFileOpenSave
            hwp.HAction.GetDefault("FileSaveAs_S", pset.HSet)
            pset.filename = pdf_path
            pset.Format = "PDF"
            pset.Attributes = 0
            if hwp.HAction.Execute("FileSaveAs_S", pset.HSet) and os.path.isfile(pdf_path):
                return True
        except Exception:
            pass
        try:
            self.hwp.SaveAs(pdf_path, "PDF")
            return os.path.isfile(pdf_path)
        except Exception:
            return False

    def _print_to_pdf_ex(self, pdf_path):
        """한컴 PDF 가상프린터로 인쇄해 PDF 생성. 모아찍기 무시(PrintMethod=0).

        한컴 개발자 포럼 권장 방식. 출력 경로는 HPrint.FileName으로 지정.
        가상프린터 출력은 비동기일 수 있어 파일 생성까지 대기한다.
        """
        # 기존 파일이 있으면 생성 감지를 위해 제거
        try:
            if os.path.isfile(pdf_path):
                os.remove(pdf_path)
        except Exception:
            pass
        try:
            hwp = self.hwp
            pset = hwp.HParameterSet.HPrint
            hwp.HAction.GetDefault("PrintToPDFEx", pset.HSet)
            pset.PrinterName = self.pdf_printer       # 확인된 한컴 PDF 프린터 실명
            pset.PrintMethod = 0                       # 0=한 페이지씩 (모아찍기 해제)
            pset.Collate = 1
            pset.UserOrder = 0
            try:
                pset.Pause = 0                         # 대화상자 없이 진행
            except Exception:
                pass
            try:
                pset.PrintToFile = 0
            except Exception:
                pass
            # 출력 PDF 경로 (필드명 버전별 차이 방어)
            for fld in ("FileName", "filename"):
                try:
                    setattr(pset, fld, pdf_path)
                except Exception:
                    pass
            ok = hwp.HAction.Execute("PrintToPDFEx", pset.HSet)
        except Exception:
            return False

        if not ok:
            return False
        # 비동기 생성 대기 (최대 ~60초, 크기 안정화 확인)
        last = -1
        for _ in range(120):
            if os.path.isfile(pdf_path):
                sz = os.path.getsize(pdf_path)
                if sz > 0 and sz == last:
                    return True
                last = sz
            time.sleep(0.5)
        return os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 0


# ── 일괄 변환 (제너레이터) ──────────────────────────────────────────────────

def convert_batch(files, out_dir=None, skip_existing=False):
    """파일 목록을 순차 변환. 진행 상황을 dict로 yield 한다.

    yield 형식:
      {"phase": "start",  "total": n}
      {"phase": "engine", "mode": "pyhwpx|win32com", "pdf_printer": str|None}
      {"phase": "item",   "index": i, "total": n, "src": ..,
       "ok": bool, "pdf": ..|None, "size": str|None, "error": str|None, "skipped": bool}
      {"phase": "done",   "ok": x, "fail": y, "skip": z, "total": n}

    한글 미설치 등 치명 오류는 HwpNotInstalled 예외로 전파한다.
    """
    total = len(files)
    yield {"phase": "start", "total": total}

    conv = HwpConverter()
    conv.start()  # 실패 시 HwpNotInstalled 전파
    yield {"phase": "engine", "mode": conv.mode, "pdf_printer": conv.pdf_printer}
    ok = fail = skip = 0
    try:
        for i, src in enumerate(files, 1):
            pdf_path, skipped = resolve_pdf_path(src, out_dir, skip_existing)
            if skipped:
                skip += 1
                yield {"phase": "item", "index": i, "total": total, "src": src,
                       "ok": True, "pdf": None, "size": None, "error": None,
                       "skipped": True}
                continue
            try:
                conv.convert(src, pdf_path)
                size = human_size(os.path.getsize(pdf_path))
                ok += 1
                yield {"phase": "item", "index": i, "total": total, "src": src,
                       "ok": True, "pdf": pdf_path, "size": size, "error": None,
                       "skipped": False}
            except Exception as e:
                fail += 1
                yield {"phase": "item", "index": i, "total": total, "src": src,
                       "ok": False, "pdf": None, "size": None,
                       "error": str(e)[:160], "skipped": False}
    finally:
        conv.quit()

    yield {"phase": "done", "ok": ok, "fail": fail, "skip": skip, "total": total}


def win_path(p):
    """WSL 경로(/mnt/d/..)를 표시용 Windows 경로(D:\\..)로 변환."""
    if p.startswith("/mnt/") and len(p) > 6:
        rest = p[5:]
        drive, _, tail = rest.partition("/")
        return drive.upper() + ":\\" + tail.replace("/", "\\")
    return p
