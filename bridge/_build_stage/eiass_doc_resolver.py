#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EIASS 원문 문서 해석기 (Document Resolver) — 핵심 연결고리 모듈
────────────────────────────────────────────────────────────────────
사업코드(관리번호) → 원문정보 파일목록(FILE_SEQ + 장별 PDF) → 다운로드

[2026-06-24 실측 확립한 흐름]
  1. 사업코드(EIA_CD/PER_CD, 예: WJ20260098)로 상세 페이지 POST 호출
       소규모EIA : /biz/base/info/perInfo.do   (PER_CD)
       정식EIA   : /biz/base/info/eiaInfo.do   (EIA_CD)
       사후관리  : /biz/base/info/afterInfo.do (EIA_CD)
  2. 응답 HTML의 원문정보 탭에서  viewFile('<FILE_SEQ>','<파일명>')  파싱
  3. /common/file/downloadFileByFileSeq.do?FILE_SEQ=<seq>  로 다운로드 (로그인 불필요)

[핵심] EIAGIS WFS(collect_smp_data.py)의 '관리번호(mgtno)' = 여기의 사업코드.
       즉 로컬 CSV 한 줄 → 원문 PDF 자동 다운로드 연결이 성립한다.

CLI 사용법:
  python3 eiass_doc_resolver.py WJ20260098                  # 파일목록 조회
  python3 eiass_doc_resolver.py WJ20260098 -d 동식물        # '동식물' 포함 장 다운로드
  python3 eiass_doc_resolver.py WJ20260098 -d 동식물 -o /경로
  python3 eiass_doc_resolver.py WJ20260098 --all -o /경로    # 전체 장 다운로드
  python3 eiass_doc_resolver.py WJ20260098 --json           # 목록을 JSON으로 출력

라이브러리 사용:
  from eiass_doc_resolver import EIASSDocResolver
  r = EIASSDocResolver()
  docs = r.resolve("WJ20260098")           # [DocFile, ...]
  hit  = r.find(docs, "동식물")            # [DocFile, ...]
  path = r.download(hit[0], "/out/dir")
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from urllib.parse import unquote

import requests
requests.packages.urllib3.disable_warnings()

BASE_URL       = "https://www.eiass.go.kr"
DOWNLOAD_URL   = f"{BASE_URL}/common/file/downloadFileByFileSeq.do"
# 원문 PDF 기본 저장 경로 (eia_cases/{사업코드}_{사업명}/)
BASE_EIA_CASES = str(Path(__file__).resolve().parents[2] / "eia_cases")

# 사업 상세(원문정보) 엔드포인트 — (경로, 사업코드 파라미터명)
INFO_ENDPOINTS = {
    "per":   ("/biz/base/info/perInfo.do",   "PER_CD"),   # 소규모환경영향평가
    "eia":   ("/biz/base/info/eiaInfo.do",   "EIA_CD"),   # 환경영향평가(정식)
    "after": ("/biz/base/info/afterInfo.do", "EIA_CD"),   # 사후환경영향조사
}

# viewFile('3228100','(본안) 0710 동식물상.pdf')
_VIEWFILE_RE = re.compile(r"viewFile\(\s*'(\d+)'\s*,\s*'([^']*)'")
# 파일명에서 장 코드(4자리) + 장명 추출:  "(본안) 0710 동식물상.pdf"
_CHAPTER_RE  = re.compile(r"(\d{3,4})\s+(.+?)(?:\.pdf|\.hwp|$)", re.IGNORECASE)

# 사업코드 두 계열 정규식 (참고 EXE 원문 기준)
_EIA_NO = re.compile(r'^[A-Z]{2}\d{4}[A-Z]\d+$')  # GG2021A007 형식
_PER_NO = re.compile(r'^[A-Z]{2}\d{8}$')          # WJ20260098 형식

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": f"{BASE_URL}/",
}


@dataclass
class DocFile:
    """원문정보 파일 1건."""
    file_seq: str          # FILE_SEQ (다운로드 키)
    filename: str          # 표시 파일명 (예: "(본안) 0710 동식물상.pdf")
    chapter_code: str      # 장 코드 (예: "0710") — 없으면 ""
    chapter_name: str      # 장명 (예: "동식물상") — 없으면 파일명
    biz_cd: str            # 사업코드
    gubn: str              # per / eia / after
    stage_label: str | None = None  # EIASS 원문 절차단계명(아코디언 <h4> 그대로,
                                     # 예: "초안"/"본안"/"보완1차"/"변경본안1차"/"협의의견(변경1차)")
                                     # — DB-EIA-10(2026-07-16) 신설. 파일명 추측이 아닌 EIASS
                                     # 원문 구조에서 직접 얻은 authoritative 값. 아코디언 구조가
                                     # 없는 응답(폴백 파싱)에서는 None.

    def as_dict(self) -> dict:
        return asdict(self)


def _safe_filename(name: str) -> str:
    """OS 금지문자 제거."""
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


def _get_biz_nm_from_cache(biz_cd: str) -> str:
    """WFS 캐시(raw_features.json)에서 사업명 조회. 없으면 빈 문자열."""
    cache_path = Path(__file__).parent / "data" / ".cache" / "raw_features.json"
    if not cache_path.exists():
        return ""
    try:
        target = biz_cd.upper()
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        for feat in data.get("features", []):  # 캐시 구조: {"features": [...], ...}
            props = feat.get("properties", {})
            if props.get("mgtno", "").upper() == target:
                return props.get("biz_nm", "")
    except Exception:
        pass
    return ""


def _parse_cd_filename(cd: str) -> str:
    """Content-Disposition 헤더에서 파일명 추출·디코딩."""
    if not cd:
        return ""
    m = re.search(r"filename[^=]*=\s*([^\r\n;]+)", cd, re.IGNORECASE)
    if not m:
        return ""
    raw = m.group(1).strip().strip('"')
    try:
        dec = unquote(raw, encoding="utf-8")
        if dec != raw:
            return dec.replace("+", " ")
    except Exception:
        pass
    try:
        return raw.encode("latin-1").decode("euc-kr")
    except Exception:
        return raw


def mgtno_kind(mgt: str) -> str | None:
    """사업코드 형식으로 협의 계열 판별 → 'eia' | 'per' | None."""
    mgt = (mgt or "").strip().upper()
    if not mgt:
        return None
    if _EIA_NO.match(mgt):
        return "eia"
    if _PER_NO.match(mgt):
        return "per"
    return None


def _search_projects(session: requests.Session, mgt: str, kind: str) -> tuple[str, str] | None:
    """
    EIASS 자유검색 API → (cd, seq) 튜플 반환.
    관리번호 → searchApi/search.do POST → HTML 파싱 → view('kind','cd','seq') 추출
    실패 시 None.
    """
    try:
        from urllib.parse import quote
        from bs4 import BeautifulSoup

        alias = "1" if kind == "eia" else "2"
        viewname_suffix = "Eia" if kind == "eia" else "Per"
        body = (
            f"query={quote(mgt, safe='')}"
            f"&collection=business"
            f"&urlString={quote(f'&alias={alias}&completeFl=&openFl=&businessExquery=&whrChFl=&aSYear=&aEYear=&rSYear=&rEYear=&orgnCd=&nrvFl=&bizGubunCd=', safe='')}"
            f"&viewName={quote(f'/eiass/user/biz/base/info/searchList{viewname_suffix}_searchApi', safe='')}"
            f"&currentPage=1&sort=DATE%2FDESC%2CAPPLY_DT%2FDESC&listCount=20"
        )

        resp = session.post(
            f"{BASE_URL}/searchApi/search.do",
            data=body.encode("utf-8"),
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "text/html, */*; q=0.01",
                "Referer": f"{BASE_URL}/",
                "Origin": BASE_URL,
            },
            timeout=15,
        )

        if resp.status_code != 200:
            return None

        soup = BeautifulSoup(resp.text, "html.parser")
        pc = soup.select_one("table.disPc")
        if not pc:
            return None

        for tr in pc.select("tbody tr"):
            tds = tr.find_all("td")
            if len(tds) < 3:
                continue
            a = tds[2].find("a")
            if not a:
                continue
            href = a.get("href", "")
            m = re.search(r"view\('(eia|per)','([^']+)','([^']+)'\)", href)
            if m and m.group(1) == kind:
                return (m.group(2), m.group(3))  # (cd, seq)
        return None
    except Exception:
        return None


def build_zip(out_path: str, project_name: str, files: list[tuple[str, bytes]]) -> None:
    """
    선택된 PDF 파일들을 zip으로 번들링.
    구조: <project_name>/pdf/<파일명>
    """
    import zipfile

    project_name = _safe_filename(project_name)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for fname, content in files:
            fname = _safe_filename(fname)
            arcname = f"{project_name}/pdf/{fname}"
            z.writestr(arcname, content)


class EIASSDocResolver:
    """사업코드 → 원문 파일목록 → 다운로드."""

    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update(_HEADERS)
        try:
            self.session.get(BASE_URL, timeout=10)  # 세션 쿠키 확보
        except Exception:
            pass
        self._last_referer = f"{BASE_URL}/"

    # ── 1) 사업코드 → 파일목록 ───────────────────────────────────────────
    def resolve(self, biz_cd: str, gubn: str = "auto",
                seq: str | None = None) -> list[DocFile]:
        """
        사업코드로 원문 파일목록을 반환.
        eia 계열(GG2021A007): 자유검색 API로 CD/SEQ 먼저 해석
        per 계열(ND20260152): 직접 POST (PER_CD=biz_cd)
        gubn="auto" → mgtno_kind 판별 후, 판별 실패 시 per/eia/after 순차 시도

        gubn 명시 시(2026-07-19 DB-EIA-12 버그 수정): 아래 mgtno_kind 단축경로보다 **우선**한다.
        이전에는 `kind = mgtno_kind(biz_cd)`가 "eia"면 그 분기 안에서 곧바로 return해버려
        호출자가 넘긴 `gubn` 인자를 **아예 읽지 않았다**(gubn은 kind가 None인 폴백 경로에서만
        유효했다). 그 결과 사후환경영향조사(gubn="after")를 요청해도 사업코드가 EIA 형식이면
        eiaInfo.do가 열려 원 EIA 보고서가 반환됐고, PEII는 코드상 도달 자체가 불가능했다.

        seq(2026-07-19 신설): 사후환경영향조사는 `(EIA_CD, AES_SEQ)` **쌍**이 있어야 파일목록이
        나온다(EIA_CD만 POST하면 0건). 즉 PEII에는 "사업코드 1개 → 원문" 모델이 성립하지 않아
        조사회차 식별자를 별도로 받는다. gubn="after"일 때만 사용된다.
        """
        biz_cd = biz_cd.strip().upper()

        if gubn == "after":
            return self._resolve_after(biz_cd, seq)

        kind = mgtno_kind(biz_cd) if gubn == "auto" else gubn

        # 계열 명확히 판별된 경우: 자유검색 기반 처리
        if kind == "eia":
            result = _search_projects(self.session, biz_cd, "eia")
            if result:
                cd, seq = result
                url = f"{BASE_URL}/biz/base/info/eiaInfo.do"
                try:
                    resp = self.session.post(
                        url, data={"EIA_CD": cd, "EIA_DISC_SEQ": seq, "menu": "biz"},
                        timeout=self.timeout,
                    )
                    if resp.status_code == 200:
                        self._last_referer = url
                        docs = self._parse_viewfiles(resp.text, biz_cd, "eia")
                        if docs:
                            return docs
                except Exception:
                    pass
            # 검색 실패 시 폴백: EIA_CD=biz_cd 직접 시도
            url = f"{BASE_URL}/biz/base/info/eiaInfo.do"
            try:
                resp = self.session.post(
                    url, data={"EIA_CD": biz_cd, "menu": "biz"},
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    self._last_referer = url
                    return self._parse_viewfiles(resp.text, biz_cd, "eia")
            except Exception:
                pass
            return []

        if kind == "per":
            path, param = INFO_ENDPOINTS["per"]
            url = f"{BASE_URL}{path}"
            try:
                resp = self.session.post(
                    url, data={param: biz_cd, "menu": "biz"},
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    self._last_referer = url
                    return self._parse_viewfiles(resp.text, biz_cd, "per")
            except Exception:
                pass
            return []

        # kind == None: 기존 순차 시도 (gubn != "auto" 일 경우 해당 gubn만)
        order = [gubn] if gubn in INFO_ENDPOINTS else ["per", "eia", "after"]

        best: list[DocFile] = []
        for g in order:
            path, param = INFO_ENDPOINTS[g]
            url = f"{BASE_URL}{path}"
            try:
                resp = self.session.post(
                    url, data={param: biz_cd, "menu": "biz"},
                    timeout=self.timeout,
                )
            except Exception:
                continue
            if resp.status_code != 200:
                continue
            docs = self._parse_viewfiles(resp.text, biz_cd, g)
            if docs:
                self._last_referer = url
                if len(docs) > len(best):
                    best = docs
                if gubn != "auto":
                    break
        return best

    def _resolve_after(self, biz_cd: str, seq: str | None) -> list[DocFile]:
        """사후환경영향조사(PEII) 전용 경로 — afterInfo.do (EIA_CD + AES_SEQ).

        AES_SEQ가 없으면 EIASS가 파일목록을 내주지 않는다(빈 목록 반환, 오류 아님).
        조사회차별로 seq가 달라 "최신 1개년도만" 같은 선별은 호출자가 seq를 골라 넘기는
        방식으로 처리한다 — 이 함수는 주어진 seq 하나만 조회한다(추정·자동선택 없음).
        """
        if not seq:
            raise ValueError(
                "사후환경영향조사(gubn='after')는 AES_SEQ가 필수입니다 — "
                "EIA_CD만으로는 EIASS가 파일목록을 반환하지 않습니다(0건). "
                "검색 결과의 조사회차 seq를 seq= 인자로 넘기세요."
            )
        path, param = INFO_ENDPOINTS["after"]
        url = f"{BASE_URL}{path}"
        try:
            resp = self.session.post(
                url, data={param: biz_cd, "AES_SEQ": str(seq), "menu": "biz"},
                timeout=self.timeout,
            )
        except Exception:
            return []
        if resp.status_code != 200:
            return []
        self._last_referer = url
        return self._parse_viewfiles(resp.text, biz_cd, "after")

    def _parse_viewfiles(self, html: str, biz_cd: str, gubn: str) -> list[DocFile]:
        """EIASS 원문정보 페이지에서 파일목록 추출.

        DB-EIA-10(2026-07-16): 페이지 자체가 절차단계별 아코디언 구조임을 실측 확인
        (`<ul class="accordion_list"><li><h4>{단계명}</h4>...<a href="javascript:viewFile(...)">
        ...</li></ul>`, 동두천·밀양·용인 3개 프로젝트 대조, 파일 수 100% 일치 검증). 이 구조를
        우선 사용해 `stage_label`을 EIASS 원문 그대로 채운다 — 이전에는 이 구조를 버리고 전체
        HTML에서 viewFile()만 flat하게 긁어와 파일명으로 절차단계를 사후 추측했음(오분류 원인).
        아코디언 구조가 없는 응답(소규모EIA·사후관리 등 미확인 페이지)에서는 flat 파싱으로 폴백
        — 이 경우 `stage_label=None`이며 호출측(collect_eia_case.py)이 기존 파일명 추측 로직으로
        처리한다."""
        seen: set[str] = set()
        docs: list[DocFile] = []

        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            ul = soup.select_one("ul.accordion_list")
            if ul:
                for li in ul.find_all("li", recursive=False):
                    h4 = li.find("h4")
                    stage = h4.get_text(strip=True) if h4 else None
                    for a in li.find_all("a", href=True):
                        m = _VIEWFILE_RE.search(a["href"])
                        if not m:
                            continue
                        seq, fname = m.group(1), m.group(2)
                        if seq in seen:
                            continue
                        seen.add(seq)
                        code, name = "", fname
                        cm = _CHAPTER_RE.search(fname)
                        if cm:
                            code, name = cm.group(1), cm.group(2).strip()
                        docs.append(DocFile(seq, fname, code, name, biz_cd, gubn, stage))
        except Exception:
            docs = []
            seen = set()

        if docs:
            return docs

        # 폴백: 아코디언 구조 없음 — 기존 flat 정규식 파싱(stage_label=None)
        for seq, fname in _VIEWFILE_RE.findall(html):
            if seq in seen:
                continue
            seen.add(seq)
            code, name = "", fname
            m = _CHAPTER_RE.search(fname)
            if m:
                code = m.group(1)
                name = m.group(2).strip()
            docs.append(DocFile(seq, fname, code, name, biz_cd, gubn, None))
        return docs

    # ── 1b) 사후환경영향조사 회차 목록 (DAT-17, 2026-07-20) ──────────────
    # 사후는 사업코드가 프로젝트당 1개라 연도별 조사결과가 같은 코드를 쓰고,
    # 파일목록은 (EIA_CD + AES_SEQ) 쌍으로만 나온다. 회차 목록은 EIASS 사후
    # 검색(alias=3)이 유일한 출처 — 요청 파라미터는 사용자 DevTools 실측
    # (2026-07-20) 원문 그대로다. ⚠ 응답의 view()는 쉼표 뒤 공백이 있다
    # (`view('after', 'CD', 'SEQ')`) — \s* 없이 파싱하면 0건으로 오판한다.
    _AFTER_VIEW_RE = re.compile(r"view\('after',\s*'([^']+)',\s*'([^']+)'\)")
    _YEAR_RE = re.compile(r"^20\d{2}$")

    def list_after_rounds(self, biz_cd: str) -> list[dict]:
        """사업코드 → 사후 조사회차 목록.

        반환: [{"aes_seq", "year", "biz_nm", "period", "status"}] — 연도 내림차순.
        같은 코드·같은 연도에 노선별 회차가 여럿일 수 있다(서해선 평택~송산/홍성~아산 실측).
        """
        from urllib.parse import quote
        from bs4 import BeautifulSoup

        biz_cd = biz_cd.strip().upper()
        rounds: dict[str, dict] = {}
        page = 1
        while page <= 10:   # 100건×10페이지 상한 — 단일 사업 회차로 충분
            body = (
                f"query={quote(biz_cd, safe='')}"
                f"&collection=business"
                f"&urlString={quote('&alias=3&approvFls=3&ivgtSYear=&ivgtEYear=&openFl=&orgnCd=', safe='')}"
                f"&viewName={quote('/eiass/user/biz/base/info/searchListAfter_searchApi', safe='')}"
                f"&currentPage={page}&sort=DATE%2FDESC&listCount=100"
            )
            try:
                resp = self.session.post(
                    f"{BASE_URL}/searchApi/search.do",
                    data=body.encode("utf-8"),
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept": "text/html, */*; q=0.01",
                        "Referer": f"{BASE_URL}/",
                        "Origin": BASE_URL,
                    },
                    timeout=self.timeout,
                )
            except Exception:
                break
            if resp.status_code != 200:
                break

            soup = BeautifulSoup(resp.text, "html.parser")
            found_this_page = 0
            table = soup.select_one("table.disPc") or soup
            for tr in table.select("tbody tr"):
                a = tr.find("a", href=self._AFTER_VIEW_RE)
                if not a:
                    continue
                m = self._AFTER_VIEW_RE.search(a.get("href", ""))
                if not m or m.group(1).upper() != biz_cd:
                    continue
                seq = m.group(2)
                tds = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
                year = next((t for t in tds if self._YEAR_RE.match(t)), "")
                dates = re.findall(r"20\d{2}\.\d{2}\.\d{2}", " ".join(tds))
                period = f"{dates[0]} ~ {dates[1]}" if len(dates) >= 2 else ""
                status = tds[-1] if tds else ""
                rounds[seq] = {
                    "aes_seq": seq,
                    "year": year,
                    "biz_nm": a.get_text(strip=True),
                    "period": period,
                    "status": status,
                }
                found_this_page += 1
            if found_this_page == 0:
                break
            page += 1

        return sorted(rounds.values(), key=lambda r: (r["year"], r["aes_seq"]), reverse=True)

    # ── 2) 키워드로 장 필터 ─────────────────────────────────────────────
    @staticmethod
    def find(docs: list[DocFile], keyword: str) -> list[DocFile]:
        """파일명·장명에 keyword가 포함된 항목."""
        kw = keyword.replace(" ", "")
        return [d for d in docs
                if kw in d.filename.replace(" ", "")
                or kw in d.chapter_name.replace(" ", "")]

    # ── 3) FILE_SEQ 다운로드 ────────────────────────────────────────────
    def download(self, doc: DocFile | str, out_dir: str,
                 filename: str | None = None, overwrite: bool = False,
                 skip_if_exists: bool = True) -> str:
        """
        DocFile 또는 FILE_SEQ 문자열을 받아 다운로드. 저장 경로 반환.
        skip_if_exists=True(기본): 동일 파일 존재 시 재다운로드 없이 기존 경로 반환.
        overwrite=True: skip_if_exists 무시하고 항상 덮어씀.
        실패 시 RuntimeError.
        """
        file_seq = doc.file_seq if isinstance(doc, DocFile) else str(doc)
        hint = filename or (doc.filename if isinstance(doc, DocFile) else None)

        os.makedirs(out_dir, exist_ok=True)

        # skip 체크: 파일명을 미리 알 수 없으므로, hint가 있을 때만 사전 확인
        if skip_if_exists and not overwrite and hint:
            candidate = os.path.join(out_dir, _safe_filename(hint))
            if os.path.exists(candidate):
                return candidate

        try:
            resp = self.session.get(
                DOWNLOAD_URL, params={"FILE_SEQ": file_seq},
                headers={"Referer": self._last_referer},
                stream=True, timeout=max(self.timeout, 120),
            )
        except requests.exceptions.Timeout:
            raise RuntimeError(f"[{file_seq}] 연결 시간 초과")
        except requests.exceptions.ConnectionError:
            raise RuntimeError(f"[{file_seq}] 네트워크 연결 오류")

        if resp.status_code != 200:
            raise RuntimeError(f"[{file_seq}] HTTP {resp.status_code}")

        ct = resp.headers.get("Content-Type", "").lower()
        if "text/html" in ct:
            snip = resp.content[:200].decode("utf-8", errors="replace")
            if "로그인" in snip or "login" in snip.lower():
                raise RuntimeError(f"[{file_seq}] 로그인 필요(비공개)")
            raise RuntimeError(f"[{file_seq}] 접근 불가(비공개 파일)")

        fname = (_parse_cd_filename(resp.headers.get("Content-Disposition", ""))
                 or hint or f"eiass_{file_seq}.pdf")
        fname = _safe_filename(fname)
        path = os.path.join(out_dir, fname)
        if os.path.exists(path):
            if skip_if_exists and not overwrite:
                return path  # 이미 존재 — 재다운로드 없이 기존 파일 반환
            if not overwrite:
                base, ext = os.path.splitext(fname)
                c = 2
                while os.path.exists(os.path.join(out_dir, f"{base}({c}){ext}")):
                    c += 1
                path = os.path.join(out_dir, f"{base}({c}){ext}")

        total = 0
        with open(path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    total += len(chunk)
        if total < 512:
            os.remove(path)
            raise RuntimeError(f"[{file_seq}] 수신 데이터 불량({total}B) — 비공개 가능")
        return path

    # ── 편의: 사업코드 + 키워드 → 바로 다운로드 ─────────────────────────
    def download_chapter(self, biz_cd: str, keyword: str,
                         out_dir: str | None = None,
                         gubn: str = "auto") -> list[str]:
        """
        out_dir=None(기본): eia_cases/{사업코드}_{사업명}/ 자동 생성.
        WFS 캐시에서 사업명 자동 조회 — 캐시 없으면 {사업코드}/ 폴더 사용.
        """
        docs = self.resolve(biz_cd, gubn)
        if not docs:
            raise RuntimeError(f"{biz_cd}: 원문정보를 찾을 수 없음(비공개·코드오류·미공개)")
        if out_dir is None:
            biz_nm = _get_biz_nm_from_cache(biz_cd)
            folder = _safe_filename(f"{biz_cd}_{biz_nm}") if biz_nm else biz_cd
            out_dir = str(Path(BASE_EIA_CASES) / folder)
        hits = self.find(docs, keyword) if keyword else docs
        if not hits:
            raise RuntimeError(
                f"{biz_cd}: '{keyword}' 해당 장 없음. "
                f"가용 장: {', '.join(d.chapter_name for d in docs)}")
        saved = []
        for d in hits:
            saved.append(self.download(d, out_dir))
            time.sleep(0.3)
        return saved


# ── CLI ─────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="EIASS 사업코드 → 원문 파일목록·다운로드")
    ap.add_argument("biz_cd", help="사업코드(관리번호) 예: WJ20260098")
    ap.add_argument("-d", "--download", metavar="키워드",
                    help="해당 키워드(예: 동식물) 포함 장 다운로드")
    ap.add_argument("--all", action="store_true", help="전체 장 다운로드")
    ap.add_argument("-o", "--out", default=None,
                    help="저장 폴더 (기본: eia_cases/{사업코드}_{사업명}/)")
    ap.add_argument("-g", "--gubn", default="auto",
                    choices=["auto", "per", "eia", "after"], help="사업 유형")
    ap.add_argument("--json", action="store_true", help="파일목록을 JSON으로 출력")
    ap.add_argument("--overwrite", action="store_true",
                    help="이미 존재하는 파일 덮어쓰기 (기본: 존재 시 skip)")
    args = ap.parse_args()

    r = EIASSDocResolver()
    docs = r.resolve(args.biz_cd, args.gubn)

    if not docs:
        print(f"✗ {args.biz_cd}: 원문정보를 찾을 수 없습니다.")
        print("  (비공개 사업 / 코드 오류 / 아직 원문 미공개일 수 있음)")
        sys.exit(1)

    if args.json:
        print(json.dumps([d.as_dict() for d in docs], ensure_ascii=False, indent=2))
    else:
        print(f"\n■ {args.biz_cd}  원문 파일목록  ({len(docs)}건, 유형={docs[0].gubn})")
        print("─" * 64)
        for d in docs:
            print(f"  FILE_SEQ={d.file_seq:>8}  [{d.chapter_code or '----'}] {d.chapter_name}")
        print("─" * 64)

    targets: list[DocFile] = []
    if args.all:
        targets = docs
    elif args.download:
        targets = r.find(docs, args.download)
        if not targets:
            print(f"\n✗ '{args.download}' 해당 장 없음.")
            sys.exit(1)

    if targets:
        # 저장 폴더 결정: -o 미지정 시 eia_cases/{사업코드}_{사업명}/
        if args.out:
            out_dir = args.out
        else:
            biz_nm = _get_biz_nm_from_cache(args.biz_cd)
            folder = _safe_filename(f"{args.biz_cd}_{biz_nm}") if biz_nm else args.biz_cd
            out_dir = str(Path(BASE_EIA_CASES) / folder)

        print(f"\n다운로드 시작 → {out_dir}")
        ok = 0
        for d in targets:
            try:
                path = r.download(d, out_dir, overwrite=args.overwrite)
                size = os.path.getsize(path)
                sz = f"{size//1024//1024} MB" if size >= 1<<20 else f"{size//1024} KB"
                existed = " (이미 존재·skip)" if not args.overwrite and os.path.getsize(path) > 0 else ""
                print(f"  ✓ {os.path.basename(path)}  ({sz}){existed}")
                ok += 1
            except Exception as e:
                print(f"  ✗ {d.chapter_name}: {e}")
            time.sleep(0.3)
        print(f"\n완료: {ok}/{len(targets)}건")


if __name__ == "__main__":
    main()
