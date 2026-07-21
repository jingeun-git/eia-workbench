"""
convert_core.py  — MD 변환 핵심 엔진 v2.0
──────────────────────────────────────────────────────────────
공통 변환 모듈: convert_to_md_gui.py 가 import 해 사용하며, CLI로도 직접 실행 가능.
n8n 파이프라인은 자체 생성 스크립트를 사용하므로 이 모듈과 독립적으로 동작한다.

지원 형식: PDF · Excel(.xlsx/.xls) · Word(.docx) · HWP · HWPX

CLI 사용:
    python convert_core.py <source_file> <output_dir>

OCR 업그레이드 (v2.0):
    - _is_garbled(): 구형 정부 PDF 폰트 깨짐 탐지 (유효문자 비율 40% 미만)
    - OCR 실행 조건 3가지: 텍스트 없음 / 깨진 텍스트 / 이미지+텍스트 150자 미만
    - fitz 200DPI 렌더링 후 EasyOCR/pytesseract 적용
"""

from __future__ import annotations

import html
import importlib
import os
import re
import subprocess
import sys
import threading
from pathlib import Path


# ─── 의존성 점검 ──────────────────────────────────────────────────────────────

def _has(pkg: str) -> bool:
    try:
        importlib.import_module(pkg)
        return True
    except ImportError:
        return False

_OCR_DISABLED    = os.environ.get("CONVERT_TO_MD_NO_OCR") == "1"

_HAS_PDFPLUMBER  = _has("pdfplumber")
_HAS_OPENPYXL    = _has("openpyxl")
_HAS_PANDAS      = _has("pandas")
_HAS_DOCX        = _has("docx")
_HAS_FITZ        = _has("fitz")
_HAS_PIL         = _has("PIL")
# OCR 비활성화 시 easyocr/pytesseract는 import 자체를 생략 — 두 패키지 임포트만
# 파일당 수 초가 걸려(easyocr는 torch 의존), 대량 배치 변환에서 불필요한 지연 유발.
_HAS_EASYOCR     = False if _OCR_DISABLED else _has("easyocr")
_HAS_PYTESSERACT = False if _OCR_DISABLED else _has("pytesseract")
_HAS_WIN32       = _has("win32com")
_HAS_PYHWP       = _has("hwp5")
_HAS_OCR         = (not _OCR_DISABLED) and _HAS_FITZ and _HAS_PIL and (_HAS_EASYOCR or _HAS_PYTESSERACT)


# ─── 지원 형식 ────────────────────────────────────────────────────────────────

SUPPORTED = {".pdf", ".xlsx", ".xls", ".docx", ".hwp", ".hwpx"}
FILE_KIND  = {
    ".pdf": "PDF", ".xlsx": "Excel", ".xls": "Excel",
    ".docx": "Word", ".hwp": "HWP", ".hwpx": "HWPX",
}


# ─── EasyOCR 전역 캐시 ────────────────────────────────────────────────────────

_ocr_reader      = None
_ocr_reader_lock = threading.Lock()


def _init_ocr_reader() -> bool:
    """EasyOCR Reader 사전 초기화 (최초 1회 — 모델 다운로드 포함)."""
    global _ocr_reader
    if not _HAS_EASYOCR:
        return False
    with _ocr_reader_lock:
        if _ocr_reader is None:
            try:
                import easyocr
                _ocr_reader = easyocr.Reader(["ko", "en"], gpu=False, verbose=False)
            except Exception:
                return False
    return True


def _ocr_image(pil_image) -> str:
    """PIL 이미지 → OCR 텍스트. pytesseract → easyocr 순으로 시도."""
    if _HAS_PYTESSERACT:
        try:
            import pytesseract
            return pytesseract.image_to_string(pil_image, lang="kor+eng")
        except Exception:
            pass

    if _HAS_EASYOCR:
        global _ocr_reader
        try:
            import numpy as np
            with _ocr_reader_lock:
                if _ocr_reader is None:
                    import easyocr
                    _ocr_reader = easyocr.Reader(["ko", "en"], gpu=False, verbose=False)
                reader = _ocr_reader
            result = reader.readtext(np.array(pil_image), detail=0)
            return "\n".join(result)
        except Exception:
            pass
    return ""


# ─── 변환 함수 ────────────────────────────────────────────────────────────────

# ─── 구조 헤딩 승격 (QA-11, 2026-07-15) ───────────────────────────────────────
# EIA 보고서 표준 번호체계(제N장 / N.N / N.N.N / 가.나.다. / 1)2)3))를 정규식으로
# 감지해 마크다운 헤딩(#~#####)으로 승격한다. 오탐 방지를 위해 "줄 맨 앞에서
# 매치"(정규식 자체가 이미 ^ 앵커) + "본문 대비 폰트 크기 우세"(review_toc.py의
# _toc_pdf() 판정 기준과 동일 — 본문 1.15배 이상) 이중 판정을 쓴다. 폰트 크기
# 정보가 없는 경로(예: OCR 대체 텍스트)는 정규식 판정만으로 승격한다.

_HEADING_PATTERNS = [
    (1, re.compile(r'^제?\s*\d+\s*장\b')),
    (3, re.compile(r'^\d+\.\d+\.\d+\s+\S')),   # N.N.N — N.N보다 먼저 검사(더 구체적)
    (2, re.compile(r'^\d+\.\d+\s+\S')),
    (4, re.compile(r'^[가-힣]\.\s+\S')),
    (5, re.compile(r'^\d+\)\s+\S')),
]

_HEADING_FONT_MIN_RATIO = 0.95  # 실측(송호리 EIA서) 결과 소제목이 본문보다 폰트 크기가
# 거의 안 커짐(가.나.다: 본문 대비 +4%, N.N: +13%)을 확인 — review_toc.py._toc_pdf()의
# "본문 대비 1.15배 이상" 가정은 이 문서군엔 과도하게 엄격해 실제 소제목 대부분을
# 놓쳤다(2026-07-15 실측). 정규식(줄 맨 앞 번호체계 매치)을 1차·주 판정으로 삼고,
# 폰트 크기는 "본문보다 뚜렷이 작지 않으면"(각주·캡션 등 오탐만 배제) 승격을 허용하는
# 완화된 게이트로 변경.


def _dedup_doubled_line(text: str) -> str | None:
    """PDF 의사볼드(문자를 연속 2회 겹쳐 찍어 굵게 보이게 하는 기법) 복원.
    실측(송호리 EIA서 "제1장") 확인: "제1장 사업의 개요" → "제제11장장 사사업업의의 개개요요"
    처럼 공백을 제외한 모든 문자가 연속 2회씩 나온다. 줄 전체가 이 엄격한
    쌍패턴을 만족할 때만(오탐 방지 — 숫자 등 부분적 우연 반복과 구분) 절반으로
    접은 텍스트를 반환하고, 아니면 None."""
    chars = list(text)
    non_space = sum(1 for c in chars if not c.isspace())
    if non_space < 4 or non_space % 2 != 0:
        return None
    out = []
    pending = None
    for c in chars:
        if c.isspace():
            if pending is not None:
                return None  # 쌍이 공백으로 끊김 — 의사볼드 패턴 아님
            out.append(c)
            continue
        if pending is None:
            pending = c
        elif pending == c:
            out.append(pending)
            pending = None
        else:
            return None  # 쌍이 안 맞음
    if pending is not None:
        return None  # 짝이 안 맞고 끝남
    return ''.join(out)


def _detect_heading_level(text: str) -> int | None:
    """줄 텍스트가 EIA 번호체계 패턴에 매치하면 레벨(1~5)을 반환, 아니면 None."""
    stripped = text.strip()
    if not stripped:
        return None
    if '┃' in stripped:
        # 실측(송호리 EIA서, pdfplumber·fitz 양쪽) 확인 — "┃"는 페이지 러닝헤더/푸터
        # 구분 기호로 일관되게 쓰인다("제1장 사업의 개요 ┃", "┃ 해남 송호 태양광...").
        # 매 페이지 반복 출력되는 헤더를 매번 새 섹션 경계로 오판하지 않도록 제외.
        return None
    for level, pattern in _HEADING_PATTERNS:
        if pattern.match(stripped):
            return level
    return None


def _promote_heading(text: str, size: float, body_size: float) -> str:
    """줄 텍스트를 필요 시 마크다운 헤딩으로 승격한다.
    폰트 크기 정보(size>0, body_size>0)가 있으면 본문 대비 우세할 때만 승격,
    정보가 없으면(OCR 등) 정규식 판정만으로 승격한다."""
    title = text
    level = _detect_heading_level(text)
    if level is None:
        # 의사볼드(문자 중복 출력)로 원문 그대로는 패턴이 안 맞을 수 있음 — 복원 후 재시도
        dedup = _dedup_doubled_line(text)
        if dedup is not None:
            level = _detect_heading_level(dedup)
            if level is not None:
                title = dedup
    if level is None:
        return text
    if size > 0 and body_size > 0 and size < body_size * _HEADING_FONT_MIN_RATIO:
        return text  # 본문보다 뚜렷이 작은 글자(각주·캡션 등) — 오탐으로 판단, 승격 보류
    return f"{'#' * level} {title.strip()}"


def _lines_with_size_pdfplumber(page, table_bboxes: list) -> list[tuple[str, float]]:
    """pdfplumber 페이지에서 표 영역을 제외한 텍스트를 줄 단위로, 대표 폰트크기와
    함께 추출(review_toc.py._toc_pdf()와 동일한 줄 재구성 방식 — top 좌표 반올림
    그룹핑). 표가 있어도 줄바꿈이 사라지지 않도록 extract_words 기반으로 직접
    재구성한다(기존 " ".join(parts) 방식은 표가 있는 페이지에서 줄 구조를 파괴함)."""
    words = page.extract_words(extra_attrs=['size'])
    lines: dict[int, list] = {}
    for w in words:
        cx = (w['x0'] + w['x1']) / 2
        cy = (w['top'] + w['bottom']) / 2
        if any(x0 <= cx <= x1 and y0 <= cy <= y1 for x0, y0, x1, y1 in table_bboxes):
            continue
        y_key = round(w['top'])
        lines.setdefault(y_key, []).append(w)

    result = []
    for y in sorted(lines):
        ws = lines[y]
        text = " ".join(w['text'] for w in ws)
        sizes = [w.get('size', 0) for w in ws if w.get('size', 0) > 0]
        avg_size = sum(sizes) / len(sizes) if sizes else 0
        result.append((text, avg_size))
    return result


def _lines_with_size_fitz(page, table_bboxes: list) -> list[tuple[str, float]]:
    """PyMuPDF 페이지에서 표 영역을 제외한 텍스트를 줄 단위로, 대표 폰트크기와
    함께 추출한다. get_text("words")는 폰트 크기가 없어 get_text("dict")의
    span 단위 정보를 사용한다."""
    result = []
    page_dict = page.get_text("dict")
    for block in page_dict.get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            x0, y0, x1, y1 = line.get("bbox", (0, 0, 0, 0))
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if any(bx0 <= cx <= bx1 and by0 <= cy <= by1
                   for bx0, by0, bx1, by1 in table_bboxes):
                continue
            text = "".join(s.get("text", "") for s in spans)
            if not text.strip():
                continue
            sizes = [s.get("size", 0) for s in spans if s.get("size", 0) > 0]
            avg_size = sum(sizes) / len(sizes) if sizes else 0
            result.append((text, avg_size))
    return result


def _build_page_text(lines: list[tuple[str, float]]) -> str:
    """줄 목록(텍스트+폰트크기)에서 본문 크기(중앙값 근사 — 최빈 크기대 사용)를
    추정하고, 각 줄을 헤딩 승격 판정해 최종 텍스트를 조립한다."""
    sizes = sorted(s for _, s in lines if s > 0)
    body_size = sizes[len(sizes) // 2] if sizes else 0  # 중앙값 근사(review_toc.py와 동일 방식)
    out = []
    for text, size in lines:
        if not text.strip():
            continue
        out.append(_promote_heading(text, size, body_size))

    # 의사볼드 이중렌더링(동일 텍스트를 수직 1px 오프셋으로 두 번 그리는 방식) —
    # 헤딩으로 승격된 줄이 바로 연속으로 완전히 동일하면 중복 렌더링으로 판단해
    # 하나만 남긴다. 헤딩이 아닌 본문 줄은 절대 건드리지 않는다(표 등 우연한
    # 반복을 잘못 지우지 않도록 범위를 헤딩 줄로만 한정).
    deduped = []
    for line in out:
        if (deduped and line == deduped[-1] and line.startswith('#')
                and not line.startswith('## Page ')):
            continue
        deduped.append(line)
    return "\n".join(deduped)


def pdf_to_markdown(src: Path, progress_cb=None) -> str:
    """PDF → Markdown. pdfplumber(표 추출 우수) 우선, 실패 시 PyMuPDF(fitz)로 폴백.

    progress_cb(current_page: int, total_pages: int)

    폴백 사유: 구형 정부·법제처 PDF는 xref/trailer가 비표준이라
    pdfminer(pdfplumber 백엔드)가 'No /Root object! - Is this really a PDF?'로
    전체 변환을 중단시킨다. fitz는 동일 파일을 관대하게 복구해 연다.
    """
    if _HAS_PDFPLUMBER:
        try:
            return _pdf_to_markdown_pdfplumber(src, progress_cb)
        except Exception as e:
            if _HAS_FITZ:
                try:
                    return _pdf_to_markdown_fitz(src, progress_cb)
                except Exception as e2:
                    raise RuntimeError(
                        f"PDF 변환 실패 — pdfplumber: {e} / PyMuPDF 폴백: {e2}"
                    )
            raise RuntimeError(
                f"PDF 변환 실패(pdfplumber): {e}\n→ pip install pymupdf  (폴백 엔진)"
            )

    # pdfplumber 미설치 — fitz 단독 폴백
    if _HAS_FITZ:
        return _pdf_to_markdown_fitz(src, progress_cb)
    raise RuntimeError("pdfplumber 미설치\n→ pip install pdfplumber  또는  pip install pymupdf")


def _pdf_to_markdown_pdfplumber(src: Path, progress_cb=None) -> str:
    """progress_cb(current_page: int, total_pages: int)"""
    import pdfplumber
    blocks = []
    _fitz_doc = None

    with pdfplumber.open(src) as pdf:
        total = len(pdf.pages)
        for i, page in enumerate(pdf.pages, 1):
            if progress_cb:
                progress_cb(i - 1, total)

            page_blocks = []

            # find_tables() 1회 호출 후 재사용 (중복 호출 제거)
            tables       = page.find_tables()
            table_bboxes = [t.bbox for t in tables]

            for tbl in tables:
                data = tbl.extract()
                if data:
                    md = _table_to_md(data)
                    if md:
                        page_blocks.append(md)

            # 표 영역 밖 텍스트 추출 — 줄 구조·폰트크기 보존(QA-11 헤딩승격용).
            # 기존 " ".join(parts)/extract_text() 방식은 표가 있는 페이지에서
            # 줄바꿈이 사라져 헤딩 감지(줄 맨 앞 패턴 매치)가 불가능했다.
            lines = _lines_with_size_pdfplumber(page, table_bboxes)
            text = _build_page_text(lines)
            text = _clean_text(text)

            # OCR 실행 조건 (QA-13 재설계, 2026-07-19):
            # 1) 텍스트 없음                        → 진짜 스캔본
            # 2) 깨진 텍스트 (_is_garbled)          → 구형 폰트 인코딩 오류
            # 3) 이미지 있고 텍스트 150자 미만이면서 도면 캡션이 없는 경우
            #      → 캡션이 있으면 '텍스트 레이어가 살아있는 도면 페이지'이므로
            #        OCR해도 얻을 정보가 없고 노이즈만 유입된다(기존 결함).
            _thin_image_page = bool(page.images) and len(text.strip()) < 150
            _ocr_needed = (
                not text.strip()
                or _is_garbled(text)
                or (_thin_image_page and not _has_figure_caption(text))
            )
            _ocr_tried = False
            if _ocr_needed and _HAS_OCR:
                _ocr_tried = True
                ocr_text = ""
                try:
                    import fitz
                    from PIL import Image as _Image
                    if _fitz_doc is None:
                        _fitz_doc = fitz.open(str(src))
                    _mat = fitz.Matrix(200 / 72, 200 / 72)
                    _pix = _fitz_doc[i - 1].get_pixmap(matrix=_mat)
                    _img = _Image.frombytes("RGB", [_pix.width, _pix.height], _pix.samples)
                    ocr_text = _clean_text(_ocr_image(_img))
                    del _pix, _img
                except Exception:
                    ocr_text = ""
                text = _resolve_page_text(text, ocr_text)

            if text.strip():
                page_blocks.append(text)
            # 자리표시자는 'OCR 이전 상태'가 아니라 '최종적으로 본문을 얻지 못했는가'로
            # 판단한다 — OCR이 성공해 본문이 확보된 페이지에까지 '본문 텍스트 없음'을
            # 붙이면 자기모순 표기가 된다(실측: 0900 부록 p.6, OCR 1,184자 확보).
            if bool(page.images) and len(text.strip()) < 150:
                page_blocks.append(
                    _figure_placeholder(i, len(page.images), ocr_tried=_ocr_tried))

            if page_blocks:
                blocks.append(f"## Page {i}")
                blocks.extend(page_blocks)

        if progress_cb:
            progress_cb(total, total)

    if _fitz_doc is not None:
        _fitz_doc.close()

    return "\n\n".join(blocks)


def _pdf_to_markdown_fitz(src: Path, progress_cb=None) -> str:
    """PyMuPDF(fitz) 기반 PDF 추출 — pdfplumber/pdfminer가 xref 손상 등으로
    실패할 때의 폴백. 표는 find_tables()(PyMuPDF 1.23+)로 추출하고,
    OCR 조건·정책은 pdfplumber 경로와 동일하게 적용한다."""
    import fitz

    doc    = fitz.open(str(src))
    total  = doc.page_count
    blocks = []

    for i in range(total):
        if progress_cb:
            progress_cb(i, total)

        page         = doc[i]
        page_blocks  = []
        table_bboxes = []

        # 표 추출 (find_tables는 일부 버전·페이지에서 예외 가능 → 방어적)
        try:
            for t in page.find_tables().tables:
                data = t.extract()
                if data:
                    md = _table_to_md(data)
                    if md:
                        page_blocks.append(md)
                    table_bboxes.append(t.bbox)
        except Exception:
            table_bboxes = []

        # 표 영역 밖 텍스트 추출 — 줄 구조·폰트크기 보존(QA-11 헤딩승격용).
        lines = _lines_with_size_fitz(page, table_bboxes)
        text = _build_page_text(lines)
        text = _clean_text(text)

        # OCR 조건 (pdfplumber 경로와 동일 — QA-13 재설계, 도면 캡션 있으면 미발동)
        _page_images = page.get_images()
        _thin_image_page = bool(_page_images) and len(text.strip()) < 150
        _ocr_needed = (
            not text.strip()
            or _is_garbled(text)
            or (_thin_image_page and not _has_figure_caption(text))
        )
        _ocr_tried = False
        if _ocr_needed and _HAS_OCR:
            _ocr_tried = True
            try:
                from PIL import Image as _Image
                _mat = fitz.Matrix(200 / 72, 200 / 72)
                _pix = page.get_pixmap(matrix=_mat)
                _img = _Image.frombytes("RGB", [_pix.width, _pix.height], _pix.samples)
                ocr_text = _clean_text(_ocr_image(_img))
                del _pix, _img
                text = _resolve_page_text(text, ocr_text)
            except Exception:
                pass

        if text.strip():
            page_blocks.append(text)
        if bool(_page_images) and len(text.strip()) < 150:
            page_blocks.append(
                _figure_placeholder(i + 1, len(_page_images), ocr_tried=_ocr_tried))

        if page_blocks:
            blocks.append(f"## Page {i + 1}")
            blocks.extend(page_blocks)

    if progress_cb:
        progress_cb(total, total)

    doc.close()
    return "\n\n".join(blocks)


def excel_to_markdown(src: Path, progress_cb=None) -> str:
    """progress_cb(current_sheet: int, total_sheets: int)"""
    if not (_HAS_OPENPYXL and _HAS_PANDAS):
        raise RuntimeError("openpyxl 또는 pandas 미설치\n→ pip install openpyxl pandas")

    import pandas as pd

    # pd.ExcelFile 단일 로드 (이중 파싱 제거)
    try:
        xl = pd.ExcelFile(src)
    except Exception as e:
        if src.suffix.lower() == ".xls":
            raise RuntimeError(
                f"XLS 읽기 실패: {e}\n→ pip install xlrd  (구형 .xls 지원)"
            )
        raise

    sheet_names = xl.sheet_names
    total  = len(sheet_names)
    blocks = []

    for idx, sheet_name in enumerate(sheet_names):
        if progress_cb:
            progress_cb(idx, total)
        try:
            df = xl.parse(sheet_name, header=0)
            df = df.dropna(how="all").fillna("")
            if df.empty:
                continue
            df.columns = [str(c).strip() for c in df.columns]
            blocks.append(f"## {sheet_name}\n\n" + _df_to_md(df))
        except Exception as e:
            blocks.append(f"## {sheet_name}\n\n*(읽기 실패: {e})*")

    if progress_cb:
        progress_cb(total, total)

    xl.close()
    return "\n\n".join(blocks)


def docx_to_markdown(src: Path, progress_cb=None) -> str:
    """progress_cb(current: int, total: int)"""
    if not _HAS_DOCX:
        raise RuntimeError("python-docx 미설치\n→ pip install python-docx")

    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc      = Document(src)
    elements = list(doc.element.body)
    total    = max(len(elements), 1)
    blocks   = []
    step     = max(total // 40, 1)

    for idx, child in enumerate(elements):
        if progress_cb and idx % step == 0:
            progress_cb(idx, total)

        tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
        if tag == "p":
            para = Paragraph(child, doc)
            text = para.text.strip()
            if not text:
                continue
            style = para.style.name
            if   "Heading 1" in style: blocks.append(f"# {text}")
            elif "Heading 2" in style: blocks.append(f"## {text}")
            elif "Heading 3" in style: blocks.append(f"### {text}")
            elif "Heading 4" in style: blocks.append(f"#### {text}")
            else:                      blocks.append(text)
        elif tag == "tbl":
            table = Table(child, doc)
            md    = _docx_table_to_md(table)
            if md:
                blocks.append(md)

    if progress_cb:
        progress_cb(total, total)

    return "\n\n".join(blocks)


def hwp_to_markdown(src: Path, progress_cb=None) -> str:
    if progress_cb:
        progress_cb(0, 1)

    # Method 1: pyhwp
    if _HAS_PYHWP:
        try:
            result = subprocess.run(
                [sys.executable, "-m", "hwp5.hwp5txt", str(src)],
                capture_output=True, text=True,
                encoding="utf-8", timeout=120,
            )
            if result.returncode == 0 and result.stdout.strip():
                if progress_cb:
                    progress_cb(1, 1)
                return _clean_text(result.stdout)
        except Exception:
            pass

    # Method 2: 한컴오피스 COM
    if _HAS_WIN32:
        try:
            import tempfile
            import win32com.client
            hwp = win32com.client.Dispatch("HWPFrame.HwpObject")
            hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
            hwp.Open(str(src.resolve()), "HWP", "forceopen:true")
            tmp = Path(tempfile.mktemp(suffix=".txt"))
            hwp.SaveAs(str(tmp), "TEXT", "")
            hwp.Quit()
            text = _read_text_auto(tmp)
            tmp.unlink(missing_ok=True)
            if progress_cb:
                progress_cb(1, 1)
            return _clean_text(text)
        except Exception:
            pass

    raise RuntimeError(
        "HWP 변환 실패\n해결 방법: pip install pyhwp  또는  한컴오피스 설치"
    )


# ── HWPX 스타일명 → 마크다운 헤딩 ───────────────────────────────────────
#  EIA 보고서는 한글 스타일로 목차 체계를 표현한다(header.xml 실측:
#  '제1장' '1.1' '1.1.1' '가.' '(1)' '(가)' '1)' …). 이 이름을 그대로 읽어
#  헤딩 깊이로 옮기면 원문 목차가 그대로 재현된다.
_HWPX_HEADING = [
    (re.compile(r"^제\s*\d+\s*장"),          "# "),
    (re.compile(r"^\d+\.\d+\.\d+(?!\S*본문)"), "### "),
    (re.compile(r"^\d+\.\d+(?!\S*본문)"),      "## "),
    (re.compile(r"^[가-힣]\.$"),               "#### "),
    (re.compile(r"^\(\d+\)(?!\S*본문)"),       "##### "),
    (re.compile(r"^\([가-힣]\)(?!\S*본문)"),    "###### "),
    (re.compile(r"^\d+\)(?!\S*본문)"),         "###### "),
]


def _hwpx_heading_prefix(style_name: str) -> str:
    """스타일명이 목차 항목이면 헤딩 접두어를, 본문이면 빈 문자열을 준다.
    '1.1본문'·'(1)본문'처럼 뒤에 '본문'이 붙은 것은 제목이 아니라 그 아래 문단이다."""
    n = (style_name or "").strip()
    if not n or n.endswith("본문") or n in ("바탕글", "표안", "자료,주"):
        return ""
    for pat, pre in _HWPX_HEADING:
        if pat.match(n):
            return pre
    return ""


def hwpx_to_markdown(src: Path, progress_cb=None) -> str:
    """HWPX → 마크다운. **ZIP+XML 직접 파싱이 기본 경로다.**

    ⚠ 예전에는 한컴 COM의 SaveAs(..., "TEXT")를 우선했는데, 그 경로는
      텍스트만 뽑아 **헤딩·표 구조를 통째로 버린다**(2026-07-21 실측:
      5,518줄 산출물에 헤딩 0줄·표 0줄). 한컴이 설치된 환경에서 항상
      그쪽이 선택돼, 구조가 살아 있는 XML 경로가 한 번도 쓰이지 않았다.
      또 XML 경로도 `paraStyle` 속성을 찾고 있었으나 실제 HWPX는
      `styleIDRef`로 header.xml을 참조한다(실측: paraStyle 등장 0회)
      — 즉 헤딩 매핑이 처음부터 동작하지 않았다.
    """
    if progress_cb:
        progress_cb(0, 1)

    import xml.etree.ElementTree as ET
    import zipfile

    def _local(tag):
        return tag.split("}")[-1] if "}" in tag else tag

    # 머리말·꼬리말·각주는 본문이 아니다. **문단 안에 중첩돼 있어서**
    # 텍스트를 모으는 단계에서 걸러야 한다 — 상위에서만 걸러내면
    # "4.1 일반 현황제4장 지역개황 ┃ 4-4- ┃ …"처럼 제목에 들러붙는다
    # (2026-07-21 실측: 상위 필터만으로는 제거되지 않음).
    _SKIP_TAGS = {"header", "footer", "footNote", "endNote", "masterPage"}

    def _text_of(elem):
        """문단·셀 안의 <hp:t> 텍스트를 이어 붙인다(머리말류 하위는 제외)."""
        buf = []

        def rec(node):
            for ch in node:
                if _local(ch.tag) in _SKIP_TAGS:
                    continue
                if _local(ch.tag) == "t":
                    buf.append(ch.text or "")
                rec(ch)

        rec(elem)
        return "".join(buf).strip()

    def _render_table(tbl):
        """<hp:tbl> → 마크다운 표. 셀 병합은 표현할 수 없어 텍스트만 옮긴다."""
        rows = []
        for tr in tbl.iter():
            if _local(tr.tag) != "tr":
                continue
            cells = [_text_of(tc).replace("\n", " ").replace("|", "\\|")
                     for tc in tr if _local(tc.tag) == "tc"]
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        out = ["| " + " | ".join(rows[0]) + " |",
               "|" + "|".join([" --- "] * width) + "|"]
        out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n".join(out)

    try:
        with zipfile.ZipFile(src) as z:
            # 스타일 ID → 이름 (header.xml의 등장 순서가 곧 styleIDRef 인덱스)
            style_names = []
            hdrs = [n for n in z.namelist() if n.endswith("header.xml")]
            if hdrs:
                hroot = ET.fromstring(z.read(hdrs[0]))
                style_names = [e.get("name", "") for e in hroot.iter()
                               if _local(e.tag) == "style"]

            sections = sorted(n for n in z.namelist()
                              if n.startswith("Contents/section") and n.endswith(".xml"))
            if not sections:
                sections = sorted(n for n in z.namelist()
                                  if "section" in n.lower() and n.endswith(".xml"))

            blocks = []
            for sfile in sections:
                root = ET.fromstring(z.read(sfile))

                # 머리말·꼬리말·각주는 본문이 아니다. 걸러내지 않으면
                # "4.1 일반 현황제4장 지역개황 ┃ 4-4- ┃ …"처럼 제목 뒤에
                # 쪽마다 반복되는 머리말이 들러붙는다(2026-07-21 실측).
                SKIP = {"header", "footer", "footNote", "endNote", "masterPage"}

                def walk(node):
                    """문서 순서대로 훑는다. 표를 만나면 표로 렌더하고
                    그 아래 문단은 다시 방문하지 않는다(셀 텍스트 중복 방지)."""
                    for child in node:
                        name = _local(child.tag)
                        if name in SKIP:
                            continue
                        if name == "tbl":
                            md = _render_table(child)
                            if md:
                                blocks.append(md)
                            continue                     # 셀 내부는 건너뛴다
                        if name == "p":
                            sid = child.get("styleIDRef")
                            style = ""
                            if sid is not None and sid.isdigit() and int(sid) < len(style_names):
                                style = style_names[int(sid)]
                            # 표를 품은 문단이면 표만 남기고 문단 텍스트는 버린다
                            has_tbl = any(_local(e.tag) == "tbl" for e in child.iter())
                            if not has_tbl:
                                line = _text_of(child)
                                if line:
                                    blocks.append(_hwpx_heading_prefix(style) + line)
                                continue
                        walk(child)

                walk(root)

        if not blocks:
            raise RuntimeError("텍스트 추출 결과 없음")
        if progress_cb:
            progress_cb(1, 1)
        return "\n\n".join(blocks)

    except Exception as e:
        raise RuntimeError(
            f"HWPX 변환 실패: {e}\n해결 방법: 파일이 손상되지 않았는지 확인하세요"
        )

def _decode_ok(text: str) -> bool:
    """디코드 결과가 '사람이 읽는 텍스트'인지 본다.

    ⚠ chardet가 성공을 반환해도 믿을 수 없다 — 단일바이트 인코딩(MacRoman·
      cp1252 등)은 **모든 바이트를 매핑**하므로 errors='strict'가 통과한다.
      실측(2026-07-21): UTF-16LE 한글 텍스트를 chardet가 MacRoman(0.62)으로
      오판했고 strict 디코드가 성공해, NUL이 그대로 남아 md가 이진 파일이 됐다.
      그래서 '예외가 안 났다'가 아니라 '결과가 말이 되는가'로 판정한다.
    """
    if not text:
        return True
    if "\x00" in text:
        return False                      # NUL은 텍스트가 아니다 — 대개 UTF-16 오독
    ctrl = sum(1 for c in text[:4000]
               if ord(c) < 32 and c not in "\t\n\r")
    return ctrl / min(len(text), 4000) < 0.02


def _read_text_auto(path: Path) -> str:
    """파일 인코딩 자동 감지. BOM → chardet(검증) → 수동 폴백 순."""
    raw = path.read_bytes()

    # 1단계: BOM은 추측이 아니라 선언이다 — 가장 먼저 본다
    for bom, enc in ((b"\xef\xbb\xbf", "utf-8-sig"),
                     (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if raw.startswith(bom):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                break

    # 2단계: BOM 없는 UTF-16 (한컴 TEXT 저장물에서 실제로 나온다).
    #        ASCII·한글 본문은 상위/하위 바이트 한쪽이 0x00으로 깔린다.
    if len(raw) >= 16 and raw.count(b"\x00") > len(raw) * 0.25:
        for enc in ("utf-16-le", "utf-16-be"):
            try:
                t = raw.decode(enc, errors="strict")
                if _decode_ok(t):
                    return t
            except UnicodeDecodeError:
                pass

    # 3단계: chardet — 단, 결과를 검증한다
    try:
        import chardet
        enc = (chardet.detect(raw) or {}).get("encoding")
        if enc and enc.lower() != "ascii":
            try:
                t = raw.decode(enc, errors="strict")
                if _decode_ok(t):
                    return t
            except (UnicodeDecodeError, LookupError):
                pass
    except ImportError:
        pass

    # 4단계: 수동 시도 (여기도 결과 검증을 거친다)
    # utf-16-le/be를 명시적으로 넣는다 — 한글은 BE에서 상위 바이트가 0이 아니라
    # 2단계 NUL 휴리스틱에 걸리지 않고, 파이썬의 "utf-16"은 BOM이 없으면 LE로 가정한다.
    for enc in ("utf-8", "cp949", "utf-16-le", "utf-16-be", "euc-kr"):
        try:
            t = raw.decode(enc, errors="strict")
            if _decode_ok(t):
                return t
        except (UnicodeDecodeError, LookupError):
            continue

    raise UnicodeDecodeError(
        "utf-8", b"", 0, 1,
        f"인코딩 자동감지 실패: {path.name} — 원본 파일 인코딩을 확인하세요"
    )


def _docx_table_to_md(table) -> str:
    # 셀 정규화는 PDF·Excel 경로와 동일하게 _escape_cell로 일원화한다
    # (QA-13 — docx 경로는 줄바꿈만 처리하고 파이프 이스케이프·칸수 패딩이 없었음).
    rows = [[_escape_cell(cell.text) for cell in row.cells] for row in table.rows]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows  = [r + [""] * (width - len(r)) for r in rows]
    header, *body = rows
    sep = ["---"] * width
    def fmt(r): return "| " + " | ".join(r) + " |"
    return "\n".join([fmt(header), fmt(sep)] + [fmt(r) for r in body])


def _escape_cell(c) -> str:
    """표 셀 텍스트를 마크다운 표 '한 칸'에 안전하게 담기는 형태로 정규화한다.

    QA-13(2026-07-19) — 셀 안 줄바꿈을 그대로 출력하면 마크다운 표 행이 물리적으로
    쪼개져 표 구조 자체가 파괴된다(실측: 0200 지역개황 표 287행 중 426줄 파열).
    파열된 표는 하류 검증 스크립트에서 행·열 좌표를 잃어 수치 비교가 불가능해지고,
    사람이 읽을 때도 어느 셀 값인지 식별할 수 없다.

    처리 3가지:
      · 줄바꿈 → 공백  (행 파열 방지. 셀 안 '◦'·'-' 등 항목 기호는 그대로 남아
                       원래의 항목 구분은 텍스트상으로 보존된다)
      · 파이프  → \\|   (열 파열 방지 — 셀 값에 '|'가 있으면 열이 하나 더 생김)
      · 연속 공백 정리
    """
    s = "" if c is None else str(c)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\n", " ")
    s = s.replace("|", "\\|")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def _table_to_md(table) -> str:
    rows = [[_escape_cell(c) for c in row] for row in table]
    if not rows:
        return ""
    # 병합셀 등으로 행마다 칸 수가 다를 수 있어 최대 열 수에 맞춰 패딩한다
    # (칸 수가 어긋나면 마크다운 표 렌더링·열 인덱싱이 모두 틀어짐).
    width = max(len(r) for r in rows)
    rows  = [r + [""] * (width - len(r)) for r in rows]
    header, *body = rows
    sep = ["---"] * width
    def fmt(r): return "| " + " | ".join(r) + " |"
    return "\n".join([fmt(header), fmt(sep)] + [fmt(r) for r in body])


def _df_to_md(df) -> str:
    header = [_escape_cell(h) for h in df.columns]
    rows   = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    for _, row in df.iterrows():
        rows.append("| " + " | ".join(_escape_cell(v) for v in row) + " |")
    return "\n".join(rows)


# 마크다운에 남으면 안 되는 제어문자 — 탭·개행만 남긴다.
# 실측(2026-07-21): 한글 PDF가 자간을 NUL로 채워두는 경우가 있어
# ("구\x00\x00\x00\x00\x00분") 추출 결과에 NUL이 그대로 실려 왔고,
# 그 md는 편집기가 이진 파일로 판정해 열리지 않았다.
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _strip_control(text: str) -> str:
    """제어문자를 공백으로 바꾼다 — 자간 채움 용도로 쓰인 경우가 있어 지우지 않고 띄운다."""
    return _CTRL_RE.sub(" ", text)


def _clean_text(text: str) -> str:
    text = _strip_control(text)
    text = html.unescape(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _is_garbled(text: str) -> bool:
    """한글 PDF의 폰트 인코딩 오류로 깨진 텍스트 여부를 판단한다.
    구형 정부 PDF(2000년대)는 텍스트 레이어가 있어도 사유 폰트 매핑으로 인해
    pdfplumber/PyMuPDF가 한글을 알아볼 수 없는 코드포인트로 변환한다.
    유효 문자(ASCII 출력 가능 + 한글) 비율이 40% 미만이면 깨진 것으로 판단."""
    non_ws = re.sub(r"\s+", "", text)
    if len(non_ws) < 10:
        return False
    korean = sum(1 for c in non_ws if "가" <= c <= "힣"
                 or "ᄀ" <= c <= "ᇿ"
                 or "㄰" <= c <= "㆏")
    ascii_ok = sum(1 for c in non_ws if "\x20" <= c <= "\x7E")
    return (korean + ascii_ok) / len(non_ws) < 0.4


# ─── OCR 발동·채택 판정 (QA-13, 2026-07-19) ──────────────────────────────────
# 배경: 기존 정책은 발동 조건이 "이미지 있고 텍스트 150자 미만"이라 도면·사진
# 페이지(그림 + 캡션만 있는 페이지)를 스캔문서로 오인했고, 채택 조건이 길이 비교
# (len(ocr) > len(text))뿐이라 도면을 OCR한 쓰레기가 원본 캡션을 덮어썼다.
# 실측(송호리 EIA서 21개 PDF): 전체 15,968줄 중 1,849줄(11.6%)이 이 경로로 유입된
# 판독불가 노이즈였고, 0900 부록은 51.9%에 달했다.
#
# 핵심 사실 — 도면 페이지도 텍스트 레이어를 갖고 있으며(페이지번호 + "(그림 N-N) OO도"
# 캡션, 실측 36~58자) 그 캡션이 바로 우리가 원하는 정보다. OCR은 이 정답을 쓰레기로
# 덮어쓰고 있었다. 따라서 캡션이 있으면 OCR을 아예 돌리지 않는다.

_FIGURE_CAPTION_RE = re.compile(
    r"[(<\[]\s*(?:그림|사진|도면|Figure|Fig)\s*[\d IVXivx.\-]*\s*[)>\]]"
    r"|<\s*표\s*[\d.\-]+\s*>"
)


def _has_figure_caption(text: str) -> bool:
    """'(그림 1-2) 사업지구 위치도' 같은 도면·사진 캡션이 있는가.

    캡션이 있다는 것은 이 페이지가 '텍스트 레이어가 살아있는 도면 페이지'라는
    뜻이며(스캔본이면 캡션 자체도 이미지라 텍스트로 안 잡힌다), OCR을 돌려도
    도면 선·기호가 무작위 문자로 변환될 뿐 얻을 정보가 없다.
    """
    return bool(_FIGURE_CAPTION_RE.search(text))


def _korean_wordlike_ratio(text: str) -> float:
    """전체 어절 중 '한글 2자 이상' 어절의 비율 (0~1).

    OCR 산출물이 읽을 수 있는 한국어 문서인지 판정하는 백스톱 지표.
    실측 대조(송호리 0100, 텍스트레이어 정상본문 4개 vs 도면 OCR 4개):
      · 정상 본문 : 0.473 ~ 0.873
      · 도면 OCR  : 0.068 ~ 0.417
    두 분포 사이 마진이 얇아(0.417/0.473) 이 지표를 단독 1차 판정으로 쓰지 않고,
    캡션 판정을 통과해 OCR까지 간 경우의 '명백한 쓰레기 차단용'으로만 쓴다.
    그래서 임계값은 분리 경계(0.45)가 아니라 훨씬 보수적인 0.15로 잡는다 —
    정상 텍스트를 잘못 버리는 쪽(치명적)보다 쓰레기를 일부 통과시키는 쪽(경미)이
    안전하기 때문이다.
    """
    tokens = [t for t in re.split(r"\s+", text) if t]
    if not tokens:
        return 0.0
    ko = sum(1 for t in tokens if len(re.findall(r"[가-힣]", t)) >= 2)
    return ko / len(tokens)


_OCR_QUALITY_MIN = 0.15


def _figure_placeholder(page_no: int, n_images: int, ocr_tried: bool = False) -> str:
    """본문 텍스트를 얻지 못한 이미지 페이지임을 명시하는 자리표시자.

    이 사실을 남기지 않으면 검토자가 '이 페이지는 원래 내용이 없다'고 오인해
    시각자료 확인 자체를 건너뛴다(조용한 누락). 무엇이 있고 어디를 봐야 하는지를
    반드시 본문에 남긴다.

    두 경우를 구분해 표기한다 — 검토자가 취해야 할 행동이 다르기 때문이다.
      · ocr_tried=False : 캡션이 살아있는 도면 페이지(OCR 생략) → 그림을 보면 된다
      · ocr_tried=True  : 스캔 이미지인데 OCR이 판독에 실패 → 원문 대조가 필요하다
    """
    if ocr_tried:
        return (f"[스캔 이미지 — OCR 판독 실패(이미지 {n_images}개). "
                f"내용 확인 필요 시 원본 PDF p.{page_no} 대조]")
    return (f"[그림 — 이미지 {n_images}개, 캡션 외 본문 텍스트 없음. "
            f"시각자료 확인 필요 시 원본 PDF p.{page_no} 참조]")


def _resolve_page_text(text: str, ocr_text: str) -> str:
    """OCR 결과를 채택할지 판정한다. 채택 실패 시 기존 텍스트를 그대로 유지.

    기존 정책(len(ocr) > len(text))은 '길면 좋다'는 가정이었으나, 도면 OCR은
    쓰레기일수록 길게 나오므로 정확히 반대로 동작했다.
    """
    if not ocr_text.strip():
        return text
    if _korean_wordlike_ratio(ocr_text) < _OCR_QUALITY_MIN:
        return text          # 명백한 판독불가 — 원본 유지
    if not text.strip():
        return ocr_text      # 원본이 아예 없으면 OCR이 유일한 정보원
    if _is_garbled(text):
        return ocr_text      # 원본이 깨졌으면 OCR 우선
    # 원본이 멀쩡한데 OCR이 더 길다는 이유만으로 덮어쓰지 않는다
    return ocr_text if len(ocr_text) > len(text) * 2 else text


# ─── 변환 디스패처 ────────────────────────────────────────────────────────────

def convert_file(src: Path, out_dir: Path, progress_cb=None) -> tuple:
    """단일 파일 변환. (True, 출력경로) 또는 (False, 오류메시지) 반환."""
    ext = src.suffix.lower()
    try:
        if   ext == ".pdf":            content = pdf_to_markdown(src, progress_cb)
        elif ext in {".xlsx", ".xls"}: content = excel_to_markdown(src, progress_cb)
        elif ext == ".docx":           content = docx_to_markdown(src, progress_cb)
        elif ext == ".hwp":            content = hwp_to_markdown(src, progress_cb)
        elif ext == ".hwpx":           content = hwpx_to_markdown(src, progress_cb)
        else:
            return False, f"지원하지 않는 형식: {ext}"
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / (src.stem + ".md")
        # 어느 경로로 왔든 제어문자가 md에 남지 않게 마지막에 한 번 더 거른다.
        # (_clean_text를 안 거치는 경로가 있어 여기가 최종 방어선이다)
        content = _strip_control(content)
        out.write_text(content, encoding="utf-8")
        return True, str(out)
    except Exception as e:
        return False, str(e)


# ─── 변환 품질 게이트 (CNV-01) ───────────────────────────────────────────────

class QualityGateError(Exception):
    """C등급 품질 파일 — 처리 파이프라인 진입 차단. chunk_eia.py 입력 불허."""


def score_quality(md_text: str, total_pages: int = 0,
                  pdf_table_count: int = 0) -> dict:
    """
    변환된 MD 텍스트의 품질 점수를 계산한다.

    Args:
        md_text:          변환 결과 MD 텍스트
        total_pages:      원본 PDF 페이지 수 (0이면 밀도 기준 완화)
        pdf_table_count:  pdfplumber 감지 표 수 (0이면 표 보존율 패널티 없음)

    Returns:
        dict: grade / score / breakdown / message / header_count / total_pages
            grade: "A"(90+) | "B"(70~89) | "C"(70미만)
    """
    scores: dict = {}

    # 1) 텍스트 밀도 — 페이지당 글자 수 (공백 제외)
    char_count = len(re.sub(r'\s+', '', md_text))
    if total_pages > 0:
        cpp = char_count / total_pages
        scores["density"] = 100 if cpp >= 200 else (70 if cpp >= 100 else 40)
    else:
        scores["density"] = min(100, char_count // 50)

    # 2) 한글 깨짐율 — '?' '□' 연속 2자 이상 패턴 비율
    garble_chars = sum(len(g) for g in re.findall(r'[?□]{2,}', md_text))
    garble_ratio = garble_chars / max(len(md_text), 1)
    scores["garble"] = 100 if garble_ratio < 0.01 else (70 if garble_ratio < 0.05 else 20)

    # 3) 표 보존율 — pdfplumber 표 수 대비 MD 표 줄 수
    if pdf_table_count > 0:
        md_tables = md_text.count('\n|')
        scores["table"] = int(min(md_tables / pdf_table_count, 1.0) * 100)
    else:
        scores["table"] = 100   # 표 미감지 또는 PDF 외 형식 — 패널티 없음

    # 4) 제목 구조 감지율 — EIA 보고서 최소 20개 헤더 기대
    header_count = len(re.findall(r'^#{1,4}\s+', md_text, re.MULTILINE))
    scores["structure"] = (
        100 if header_count >= 20 else
        70  if header_count >= 10 else
        50  if header_count >=  5 else 20
    )

    # 종합 점수 (가중 평균)
    weights = {"density": 0.30, "garble": 0.30, "table": 0.20, "structure": 0.20}
    total_score = round(sum(scores[k] * weights[k] for k in weights), 1)

    if total_score >= 90:
        grade, message = "A", "정상 — 처리 파이프라인 진행"
    elif total_score >= 70:
        grade, message = "B", "경고 — 일부 품질 저하, 진행하되 수동 검토 권장"
    else:
        grade, message = "C", "중단 — 원본 재확인 또는 수동 보완 필요"

    return {
        "grade": grade,
        "score": total_score,
        "breakdown": scores,
        "message": message,
        "header_count": header_count,
        "total_pages": total_pages,
    }


def assess_and_gate(md_text: str, src_path: str = "",
                    total_pages: int = 0,
                    pdf_table_count: int = 0,
                    raise_on_c: bool = True) -> dict:
    """
    품질 평가 후 등급 출력. C등급이면 QualityGateError 발생 (raise_on_c=True 시).

    chunk_eia.py 입력 전 반드시 호출:
        result = assess_and_gate(md_text, src_path, raise_on_c=True)

    C등급 차단 사유:
        더미값 추론·불완전 데이터로 EIA 사례 지식 DB를 오염시키지 않기 위함.
    """
    result = score_quality(md_text, total_pages, pdf_table_count)
    name = Path(src_path).name if src_path else "MD"
    grade, score = result["grade"], result["score"]
    bd = result["breakdown"]

    print(f"[품질 게이트] {name}")
    print(f"  등급: {grade}  점수: {score}")
    print(f"  세부: 밀도={bd['density']} 깨짐={bd['garble']} "
          f"표={bd['table']} 구조={bd['structure']}")
    print(f"  {result['message']}")

    if grade == "C" and raise_on_c:
        raise QualityGateError(
            f"\n[품질 게이트 차단] {name}\n"
            f"  등급 C (점수 {score}) — 원본 재확인 또는 수동 보완 필요.\n"
            f"  ▶ 더미값 추론·불완전 데이터로 처리 계속 절대 금지.\n"
            f"  ▶ 개선 후 재변환하거나 핵심 내용 수동 보완 후 진행."
        )
    return result


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python convert_core.py <source_file> <output_dir>", file=sys.stderr)
        sys.exit(1)
    _src     = Path(sys.argv[1])
    _out_dir = Path(sys.argv[2])
    _ok, _result = convert_file(_src, _out_dir)
    print(_result)
    sys.exit(0 if _ok else 1)
