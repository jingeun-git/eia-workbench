#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HWP/HWPX 쪽번호 제어 엔진 (SYS-31)

기존 `배포용/hwpPageNum2.1/hwpPageNum2.0.py`를 대체한다. 기존 툴은
① 연속 재부여 ② 파일명 (시작-끝) 갱신 ③ A3 위치 .out 보고 까지만 했고,
제책 규칙(홀짝 정렬·A3 홀수·간지 감추기)은 사람이 로그를 보고 수동 처리했다.
또한 `import intro`가 저장소에 없어 .py 실행 자체가 불가능했다.

═══ 규칙 명세 (2026-07-20 사용자 확정) ═══
전제: 양면 인쇄. 각 장 첫 쪽은 항상 홀수(펼쳤을 때 오른쪽).
 R0  00장(표지·옆표지·목차)은 번호 부여 제외. 01장부터 1번 시작.
 R1  장 전환 시 앞 장은 짝수로 끝나고 다음 장은 홀수로 시작.
 R2  같은 장 내 소챕터(07장 0711~0753)는 R1 미적용 — 연속 번호.
 R3  A3는 홀수 쪽번호만. 한컴은 A3 1장을 1페이지로 계수하므로 NewNumber로 짝수를 건너뛴다.
 R3b A3 경계 정렬: ①앞이 짝수면 조치 없음 ②앞이 홀수면 홀수 강제 ③A3 연속은 9·11·13
     ④A3 뒤 A4 복귀도 홀수 강제 ⑤A3가 장 마지막이면 다음 장 홀수(R1과 동일).
     ※ 공백 면은 문서에 만들지 않는다 — 번호만 건너뛴다.
 R4  간지 모드(선택): 각 장 **첫 파일**의 앞 2면(간지+공백)을 감추기.

═══ 검증된 COM 사실 (2026-07-20 실측, 추측 아님) ═══
 · 열기 인자: .hwp="HWP" / .hwpx="HWPX"
 · BreakPage(공란 삽입)·NewNumber(쪽번호)·BreakSection(구역 분리) 모두 동작
 · 감추기 = **secd(구역) 속성** HideHeader/HideFooter/HideBorder/HideFill/HideMasterPage
   를 1로 쓰고 `ctrl.Properties = set`으로 되돌려 넣으면 반영된다.
   ⚠ PageHiding **액션**은 Execute=True를 반환해도 무동작 — 쓰지 않는다.
 · secd에 HidePageNum이 없다 → 쪽번호 숨김은 구역 분리 + 쪽번호 미부여로 우회.
 · KeyIndicator()[3]은 물리 쪽수가 아니라 **표시 쪽번호**다.
"""

import re
import shutil
from pathlib import Path

EXTS = (".hwp", ".hwpx")
# 파일명 앞 4자리 코드 — 앞 2자리가 장, 뒤 2자리가 절. 예: "0711 동식물상" → 장 07
_CODE_RE = re.compile(r"^\s*(\d{4})")
COVER_CHAPTER = "00"          # 표지·옆표지·목차 — 번호 부여 제외(R0)

# 감추기에 쓰는 구역 속성 키 (실측으로 존재 확인된 것만)
# 감추기 필드 — PageHiding 액션의 파라미터셋 **HSecDef**에서 실명 열거로 확정(2026-07-20).
# 전체 7종: HideHeader/HideFooter/HideBorder/HideFill/HideMasterPage/HidePageNumPos/HideEmptyLine
# 사용자 요구("머릿말·꼬릿말·쪽번호 모두 숨김")에 맞춰 기본 3종만 켠다 — 간지의
# 테두리·배경까지 지우면 디자인이 바뀔 수 있어 문서 원안을 존중한다.
HIDE_FIELDS = ("HideHeader", "HideFooter", "HidePageNumPos")


# ── 파일명 → 장/절 판별 ────────────────────────────────────────────────
def parse_code(name: str):
    """파일명에서 4자리 코드를 뽑아 (코드, 장) 반환. 없으면 (None, None)."""
    m = _CODE_RE.match(name)
    if not m:
        return None, None
    code = m.group(1)
    return code, code[:2]


def _div_mode(v) -> str:
    if v is True:  return "one"          # 구버전 웹이 보내는 bool
    if v is False or v is None: return "none"
    return v if v in ("none", "one", "two") else "none"


def build_plan(files, include_divider=False, start_num: int = 1, a3_back: str = "skip"):
    """include_divider: "none" | "one" | "two"  (하위호환으로 bool도 받는다)
         none — 간지 없음
         one  — 간지 1장만 (뒷면 공백 없음) → 뒷면 몫으로 번호를 하나 건너뛴다
         two  — 간지 2장 (뒷면 공백까지 물리 페이지로 존재) → 결번 불필요

       빈 쪽 유무를 문단 수로 추정하던 것을 사용자 선택으로 바꿨다(2026-07-20).
       한 보고서는 한 관행으로 작성되므로 추정보다 명시가 정확하다."""
    """파일 목록 → 처리 계획. 한컴 없이도 계산 가능한 부분(장 경계·제외 여부)만 만든다.

    files: [{"name":…, "path":…, "end_page":int|None, "phys_pages":int|None,
             "a3_pages":[int]}]  ← 스캔 결과
    반환:  각 파일에 chapter/is_chapter_head/skip/start 를 채운 리스트
    """
    plan = []
    prev_chapter = None
    for f in files:
        code, chapter = parse_code(f["name"])
        is_head = chapter is not None and chapter != prev_chapter
        skip = (chapter == COVER_CHAPTER) or chapter is None
        plan.append({
            **f,
            "code": code,
            "chapter": chapter,
            "is_chapter_head": bool(is_head and not skip),
            "skip": skip,
            "divider": bool(_div_mode(include_divider) != "none" and is_head and not skip),
            "divider_mode": _div_mode(include_divider),
            "a3_back": a3_back if a3_back in ("skip", "blank") else "skip",
        })
        if chapter is not None:
            prev_chapter = chapter
    return plan


def assign_numbers(plan, start_num: int = 1):
    """계획에 쪽번호를 배정한다 — **한컴 없이 순수 계산**(단위 테스트 가능).

    각 항목에 다음을 채운다:
      start/end : 표시 쪽번호 범위
      pages     : [(물리쪽순번, 표시번호, A3여부)]
      marks     : NewNumber를 걸어야 하는 [(물리쪽순번, 번호)] — 연속이 끊기는 지점만
      pad       : 장 끝 짝수 맞춤용 공란 삽입 수(0 또는 1)
    R1·R2·R3·R3b를 전부 여기서 결정하고, COM은 결정을 실행만 한다.
    """
    cur = start_num
    out = []
    for i, f in enumerate(plan):
        if f["skip"]:
            out.append({**f, "start": None, "end": None, "pages": [], "marks": [], "pad": 0})
            continue

        # R1: 장의 첫 파일은 홀수에서 시작
        if f["is_chapter_head"] and cur % 2 == 0:
            cur += 1

        total = f.get("phys_pages") or 0
        a3set = set(f.get("a3_pages") or [])

        # ── 공백면은 두 가지 방식으로 표현된다 (인쇄 결과는 동일) ──────────
        #   ⓐ 물리 빈 페이지를 넣는다        → 그 페이지가 번호를 가져간다
        #   ⓑ 페이지 없이 번호만 건너뛴다     → 결번이 생긴다
        # 작성자가 어느 쪽을 썼는지는 문서마다 다르므로 **가정하지 않고 스캔 결과로
        # 판별한다.** 규약을 가정했다가 시나리오 2·3을 못 맞춘 사례가 있다
        # (2026-07-20 사용자 지적).
        a3_back = f.get("a3_back", "skip")   # "skip"=결번 | "blank"=물리 공백 있음
        # 간지 뒷면: "간지 2장"이면 공백이 이미 물리 페이지로 있으므로 결번 불필요.
        # "간지 1장"이면 뒷면 몫으로 번호를 하나 건너뛴다.
        div_skip = 1 if (f.get("divider") and f.get("divider_mode") == "one") else 0
        pages, marks = [], []
        n = cur
        for phys in range(1, total + 1):
            if div_skip and phys == 2:
                n += 1                       # 간지 뒷면 몫으로 번호 하나를 비운다
            is_a3 = phys in a3set
            # R3b②: A3가 짝수 자리에 오면 홀수로 밀어낸다
            if is_a3 and n % 2 == 0:
                n += 1
            # 연속이 끊기는 지점에만 NewNumber를 건다(첫 쪽은 항상)
            if phys == 1 or (pages and n != pages[-1][1] + 1):
                marks.append((phys, n))
            pages.append((phys, n, is_a3))
            # R3: A3는 양면 인쇄에서 뒷면까지 차지하므로 번호를 2개 소비한다.
            # 단 작성자가 A3 뒤에 물리 빈 페이지를 이미 넣어뒀다면 그 페이지가
            # 번호를 가져가므로, 여기서 2를 소비하면 이중 계산이 된다.
            if is_a3:
                # A3 뒷면이 물리 공백으로 이미 있으면 그 쪽이 번호를 가져가므로 1,
                # 결번 방식이면 뒷면 몫까지 2를 소비한다
                n += 1 if a3_back == "blank" else 2
            else:
                n += 1

        end = (pages[-1][1] if pages else cur - 1)
        # A3로 끝나면 그 뒷면은 인쇄상 비는 면이다. 그렇다고 이 파일의 끝 번호를
        # 부풀리면 안 된다 — 31쪽으로 끝나는 문서를 32까지라고 표기하게 된다
        # (2026-07-20 사용자 지적). 넘겨줄 다음 시작 번호에서만 한 칸 건너뛴다.
        tail_a3 = bool(pages and pages[-1][2])

        # R1: 장이 홀수로 끝나도 **빈 페이지를 만들지 않는다** (2026-07-20 사용자 확정).
        #   앞장 끝이 홀수면 그 뒷면은 인쇄상 비는 면이고, 다음 장 간지가 그 다음
        #   홀수를 받으면 양면 인쇄 정합성이 맞는다. 물리 페이지를 넣을 이유가 없다.
        #   → 다음 장 시작에서 홀수로 올리는 것(아래 cur 보정)만으로 충분하다.
        #   ※ 공란 삽입은 문서 구조를 바꾸는 가장 위험한 동작이었고, 그 대가로 얻는
        #     것이 없었다. 감추기 문제도 여기서 파생됐다.
        pad = 0

        # 기존 감추기가 도구가 의도한 위치와 다르면 표시한다.
        # 도구가 감추는 곳: 간지 1·2면(장 첫 파일) + 장 끝 공란.
        # 그 밖의 감추기는 사람이 잘못 넣었을 가능성이 있으므로 사용자에게 알린다.
        expect = set()
        if f.get("divider"):
            # 간지 1장이면 2면은 **본문**이다. 여기를 감추면 본문이 감춰진다
            # (2026-07-20 사용자 지적 — 표에 1,2면으로 표기하던 것이 오류).
            expect |= {1, 2} if f.get("divider_mode") == "two" else {1}
        if pad:
            expect.add(total + 1)
        stray = [h for h in (f.get("hide_pages") or []) if h and h not in expect]

        out.append({**f, "start": (pages[0][1] if pages else cur),
                    "end": end, "pages": pages, "marks": marks, "pad": pad,
                    "expect_hide": sorted(expect), "stray_hide": stray,
                    "div_skip": div_skip})
        cur = end + 1 + (1 if tail_a3 else 0)
    return out


# ══════════════════════════════════════════════════════════════════════
#  COM 실행부 — 위에서 계산한 결정을 한글에 적용한다 (Windows + 한컴 필요)
# ══════════════════════════════════════════════════════════════════════

def _open(hwp, path: Path) -> bool:
    """확장자에 맞는 형식 인자로 연다(실측 확정). False 반환도 실패로 처리."""
    fmt = "HWPX" if path.suffix.lower() == ".hwpx" else "HWP"
    for f in (fmt, None):
        try:
            ok = hwp.Open(str(path)) if f is None else hwp.Open(str(path), f, "forceopen:true")
            if ok is not False:
                return True
        except Exception:
            continue
    return False


# KeyIndicator()의 C 원형은
#   BOOL KeyIndicator(seccnt, secno, prnpageno, colno, line, pos, over, ctrlname)
# 이고, win32com은 **반환값(BOOL)을 튜플 맨 앞에 붙여** 돌려준다. 따라서
#   [0]=BOOL  [1]=구역수  [2]=현재구역  [3]=인쇄 쪽번호  [4]=단  [5]=줄 …
# → 인쇄 쪽번호는 [3]. (한글 상태표시줄의 "7/6쪽"에서 앞의 7에 해당)
_KI_PRNPAGE = 3


def _end_page(hwp) -> int:
    hwp.MovePos(3)
    return int(hwp.KeyIndicator()[_KI_PRNPAGE])


def _page_map(hwp, total: int, log=lambda *_: None):
    """문서를 한 번만 훑어 **쪽마다 실제로 찍히는 인쇄 쪽번호와 문단 위치**를 읽는다.

    이 한 장의 지도로 문서가 어떤 방식으로 작성됐는지가 전부 드러난다:
      · 번호가 건너뛴 자리(결번) → 작성자가 '번호 제어'로 공백면을 표현한 것
      · 번호가 연속인데 물리 쪽이 있는 자리 → 실제 빈 페이지를 넣은 것
    두 방식은 인쇄 결과가 같으므로, 어느 쪽이든 이미 규칙을 만족하면 건드리지 않는다.

    반환: [{"phys":1, "num":1, "para":0, "blank":False}, …]
    ※ 쪽마다 처음부터 이동하면 O(n²)이라 211쪽짜리에서 멈춘다 — 순차 1회 통과.
    """
    out = []
    try:
        hwp.MovePos(2)
        for phys in range(1, (total or 0) + 1):
            num = para = None
            try:
                num = int(hwp.KeyIndicator()[_KI_PRNPAGE])
                para = int(hwp.GetPos()[1])
            except Exception as e:
                log(f"    ⚠ {phys}쪽 위치 읽기 실패: {type(e).__name__} {e}")
            out.append({"phys": phys, "num": num, "para": para})
            if phys < (total or 0):
                hwp.HAction.Run("MovePageDown")
    except Exception as e:
        log(f"    ⚠ 쪽 지도 작성 중단: {type(e).__name__} {e}")

    # ※ 문단 수로 빈 쪽을 추정하던 로직은 폐기했다(2026-07-20). 전면 표·전면 그림이
    #   한 문단으로 잡혀 부록에서 10곳이 오탐났다. 빈 쪽 유무는 추정하지 않고
    #   사용자가 간지·A3 옵션으로 명시한다.
    return out


def _hidden_pages(hwp, log=lambda *_: None):
    """감추기(pghd)가 걸린 물리 쪽 목록.

    사람이 손으로 넣은 감추기는 엉뚱한 쪽에 있을 수 있으므로(2026-07-20 사용자 지적)
    도구는 이를 신뢰하지 않고 **위치를 그대로 보여준다.** 판단은 사용자 몫이다.
    """
    pages, c = [], hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "pghd":
            try:
                hwp.SetPosBySet(c.GetAnchorPos(0))
                pages.append(int(hwp.KeyIndicator()[_KI_PRNPAGE]))
            except Exception as e:
                log(f"    ⚠ 감추기 위치 특정 실패: {type(e).__name__} {e}")
                pages.append(0)          # 존재만 보고
        c = c.Next
    return sorted(set(pages))


def _phys_pages(hwp):
    try:
        return int(hwp.PageCount) or None
    except Exception:
        return None


def _a3_pages(hwp, total: int):
    """A3 구역에 속한 물리 쪽 순번 목록. 구역 용지크기로 판정(실측 검증된 방식)."""
    sects = []
    c = hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "secd":
            try:
                pd = c.Properties.Item("PageDef")
                w = round(pd.Item("PaperWidth") / 283.465, 1)
                h = round(pd.Item("PaperHeight") / 283.465, 1)
                sects.append("A3" if (w > 210.0 and h > 297.0) else "A4")
            except Exception:
                sects.append("A4")
        c = c.Next
    if "A3" not in sects or not total:
        return []
    out, seen = [], 0
    hwp.MovePos(2)
    pi = hwp.KeyIndicator()
    while seen < total + 2:
        seen += 1
        idx = pi[2] - 1
        if 0 <= idx < len(sects) and sects[idx] == "A3":
            out.append(seen)
        hwp.HAction.Run("MovePageDown")
        nxt = hwp.KeyIndicator()
        if nxt[3] == pi[3]:
            break
        pi = nxt
    return out


def scan_folder(folder, log=lambda *_: None, progress=lambda *_: None):
    """폴더 스캔 — 파일별 쪽번호 범위·물리 쪽수·A3 위치를 읽는다(읽기 전용)."""
    import win32com.client as win32
    folder = Path(folder)
    files = sorted(p for p in folder.iterdir()
                   if p.suffix.lower() in EXTS and not p.name.startswith("~"))
    if not files:
        raise RuntimeError("대상 .hwp/.hwpx 파일이 없습니다")

    hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
    hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
    hwp.XHwpWindows.Item(0).Visible = False
    out = []
    try:
        for i, p in enumerate(files, 1):
            progress(i - 1, len(files), p.name)
            if not _open(hwp, p):
                log(f"  ✗ {p.name}: 열기 실패")
                out.append({"name": p.name, "path": str(p), "end_page": None,
                            "phys_pages": None, "a3_pages": [], "error": "열기 실패"})
                continue
            end = _end_page(hwp)
            phys = _phys_pages(hwp)
            a3 = _a3_pages(hwp, phys or 0)
            pmap = _page_map(hwp, phys or 0, log)
            hides_num = _hidden_pages(hwp, log)
            # _hidden_pages는 **인쇄 쪽번호**를 돌려주는데 expect_hide는 **물리 쪽**
            # 기준이다. 그대로 비교하면 각 파일의 간지(물리 1면)가 인쇄 33면 등으로
            # 잡혀 전부 오탐이 된다(2026-07-20 실사고). 물리 쪽으로 환산해 맞춘다.
            _n2p = {r["num"]: r["phys"] for r in pmap if r["num"] is not None}
            hides = sorted({_n2p.get(n, 0) for n in hides_num} - {0}) or \
                    ([0] if hides_num else [])
            nums = [r["num"] for r in pmap if r["num"] is not None]
            start = nums[0] if nums else None
            # 결번 = 번호는 소비했으나 물리 쪽이 없는 자리
            #   (작성자가 '빈 페이지 대신 번호 제어'로 공백면을 표현한 흔적)
            gaps = [pmap[i + 1]["num"] for i in range(len(pmap) - 1)
                    if pmap[i]["num"] is not None and pmap[i + 1]["num"] is not None
                    and pmap[i + 1]["num"] != pmap[i]["num"] + 1]
            pgct = _pgct_pages(hwp, log)
            pgct_phys = sorted({_n2p[n] for n in pgct if n in _n2p})
            log(f"  {p.name} — 현재 쪽번호 {start}~{end} / 물리 {phys}쪽"
                + (f" / A3 {len(a3)}쪽 {a3}" if a3 else "")
                + (f" / 결번 {len(gaps)}곳" if gaps else "")
                + (f" / 쪽번호제어 인쇄 {pgct}" if pgct else "")
                + (f" / 기존 감추기 물리 {hides}면(인쇄 {hides_num})" if hides_num else ""))
            out.append({"name": p.name, "path": str(p), "end_page": end,
                        "start_page": start, "hide_pages": hides,
                        "gap_count": len(gaps), "pgct_pages": pgct,
                        "pgct_phys": pgct_phys,
                        "phys_pages": phys, "a3_pages": a3})
            try:
                hwp.XHwpDocuments.Item(0).Close(isDirty=False)
            except Exception:
                pass
        progress(len(files), len(files), "완료")
    finally:
        try:
            hwp.Quit()
        except Exception:
            pass
    return out


# 쪽번호 관련 조판부호 — 매 실행 시 **삭제 후 재부여**한다(2026-07-20 사용자 지시:
# "혼선이 생기지 않게"). 반복 실행 시 누적·충돌을 원천 차단하기 위함이다.
#   nwno : 새 쪽번호(시작번호 지정) — NewNumber 액션으로 재부여 검증 완료 ✓
# ⚠ pgnp/pgct는 쪽번호 **표시 서식**(위치·모양)으로 추정되며, 지우면 되돌릴 방법이
#   검증되지 않았다. 잘못 지우면 쪽번호가 아예 사라지거나 서식이 바뀐다.
#   → **기본 삭제 대상에서 제외 확정**(2026-07-20 사용자: "nwno만 삭제").
#     반복 실행 시 혼선은 nwno 초기화만으로 해소되며, 표시 서식은 문서 자산이므로 보존한다.
#     extra_clear는 향후 검증이 끝나면 열 수 있도록 남겨둔 비활성 옵션이다.
PAGENUM_CTRLS = ("nwno", "pgct")      # 새 쪽번호 · 쪽 번호 제어 — 삭제 후 재부여
PAGENUM_CTRLS_RISKY = ("pgnp",)       # 쪽번호 표시 위치 — 서식이라 보존


def _clear_pagenum(hwp, extra_clear: bool = False):
    """쪽번호 관련 조판부호 제거. 반환: {컨트롤ID: 삭제수}

    ※ pghd(감추기)·head(머리말)는 쪽번호가 아니라 사용자 서식이므로 건드리지 않는다.
      간지 모드에서 감추기를 새로 부여할 때만 별도로 다룬다."""
    # nwno(새 쪽번호)·pgct(쪽 번호 제어)를 모두 지운다.
    # 이 도구는 여러 사람이 각자 쓴 장을 취합한 **직후**, 작성자가 수작업하기
    # 전에 쓰는 것이다. 작성자가 넣어둔 조판부호에 의존하면 그것을 쓰지 않는
    # 프로젝트에서 통째로 동작하지 않는다(2026-07-20 사용자 정정).
    targets = set(PAGENUM_CTRLS) | (set(PAGENUM_CTRLS_RISKY) if extra_clear else set())
    removed = {}
    c = hwp.HeadCtrl
    while c is not None:
        nxt = c.Next
        if c.CtrlID in targets:
            try:
                hwp.DeleteCtrl(c)
                removed[c.CtrlID] = removed.get(c.CtrlID, 0) + 1
            except Exception:
                pass
        c = nxt
    return removed


def _set_number(hwp, num: int):
    """새 쪽번호 부여. HParameterSet 속성 대입 방식 — CreateSet()+SetItem()은
    값이 반영되지 않는 사례가 확인됐다(2026-07-20)."""
    act = hwp.HAction
    pset = hwp.HParameterSet.HAutoNum
    act.GetDefault("NewNumber", pset.HSet)
    pset.NumType = hwp.AutoNumType("Page")
    pset.NewNumber = int(num)
    return bool(act.Execute("NewNumber", pset.HSet))


def _pgct_pages(hwp, log=lambda *_: None):
    """[쪽 번호 제어](pgct)가 걸린 인쇄 쪽번호 목록.

    이 조판부호는 '직후 홀수로 강제'라서, 본문 시작을 홀수로 만드는 일을
    이미 문서가 하고 있다는 뜻이다. 그 자리에 새 쪽번호를 또 넣으면 안 된다.
    """
    pages, c = [], hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "pgct":
            try:
                hwp.SetPosBySet(c.GetAnchorPos(0))
                pages.append(int(hwp.KeyIndicator()[_KI_PRNPAGE]))
            except Exception as e:
                log(f"    ⚠ 쪽번호제어 위치 특정 실패: {type(e).__name__} {e}")
        c = c.Next
    return sorted(set(pages))


def _goto_page(hwp, phys: int):
    """물리 쪽 순번으로 이동(1부터). MovePageDown 반복 — 실측된 방식."""
    hwp.MovePos(2)
    for _ in range(max(0, phys - 1)):
        hwp.HAction.Run("MovePageDown")


def _hide_section_first_page(ctrl):
    """구역(secd)의 **첫 쪽**을 감춘다. 반환: 적용된 필드 목록.

    ═══ 확정 근거 (2026-07-20, 쓰기 결과 XML 대조) ═══
    secd 속성을 1로 쓰면 hwpx XML의 secPr/visibility가 이렇게 바뀐다:
      HideHeader     → hideFirstHeader="1"
      HideFooter     → hideFirstFooter="1"
      HidePageNumPos → hideFirstPageNum="1"      ← 쪽번호 감추기
      HideMasterPage → hideFirstMasterPage="1"
      HideBorder/HideFill → border/fill="HIDE_FIRST"
    즉 이 경로는 **구역 첫 쪽 전용**이다. 임의 쪽 감추기는 pghd 컨트롤이 필요한데
    PageHiding 액션으로는 생성되지 않는다(Execute=True인데 무동작 — 실측 3회).
    → 간지는 '앞 2면'이므로 구역 분할 + 각 구역 첫 쪽 감추기로 해결한다.
    """
    try:
        st = ctrl.Properties
        applied = []
        for k in HIDE_FIELDS:
            try:
                if st.Item(k) is not None:
                    st.SetItem(k, 1)
                    applied.append(k)
            except Exception:
                pass
        ctrl.Properties = st
        return applied
    except Exception:
        return []


def _hide_divider_pages(hwp, log=lambda *_: None):
    """간지 1면(구역 첫 쪽)을 감춘다.

    ⚠ **BreakSection을 쓰지 않는다** — 2026-07-20 실사고: 2면을 감추려고 구역을
      나눴더니 머리말·꼬리말이 본문 전체에서 사라졌다. 한글에서 머리말·꼬리말은
      **구역 속성**이라, 새 구역에는 상속되지 않는다. 조판부호는 남아 있는데
      화면에 안 나오는 증상으로 나타난다.
      → 구역 구조는 절대 건드리지 않는다. 감출 수 있는 것은 '구역 첫 쪽'뿐이다.

    2면(간지 뒷공백)은 임의 쪽 감추기가 필요한데 COM으로는 pghd 컨트롤을 만들 수
    없다(실측 3회). 그래서 **자동 처리하지 않고 사용자에게 알린다.**
    """
    applied = []
    c = hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "secd":
            applied = _hide_section_first_page(c)
            break
        c = c.Next
    return (1 if applied else 0), applied


def _count_hidden(hwp):
    """문서에 이미 설정된 감추기(pghd) 개수 — 사용자가 직접 걸어둔 것을 존중하기 위해 센다."""
    n, c = 0, hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "pghd":
            n += 1
        c = c.Next
    return n


def apply_plan(plan, log=lambda *_: None, progress=lambda *_: None,
               dry_run=False, extra_clear=False):
    """계산된 계획을 문서에 적용한다. dry_run이면 문서를 열어 확인만 하고 저장하지 않는다."""
    import win32com.client as win32
    targets = [f for f in plan if not f["skip"]]
    if not targets:
        raise RuntimeError("번호를 부여할 대상이 없습니다(00장만 있거나 코드 없는 파일뿐)")

    hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
    hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
    hwp.XHwpWindows.Item(0).Visible = False
    ok = fail = 0
    try:
        for i, f in enumerate(targets, 1):
            p = Path(f["path"])
            progress(i - 1, len(targets), p.name)
            if not _open(hwp, p):
                log(f"  ✗ {p.name}: 열기 실패")
                fail += 1
                continue
            try:
                rm = _clear_pagenum(hwp, extra_clear=extra_clear)
                if rm:
                    log(f"  {p.name}: 기존 조판부호 제거 — "
                        + ", ".join(f"{k} {v}개" for k, v in rm.items()))

                # 스캔 시점과 실제 쪽수가 다르면 계획 전체가 어긋난다
                # (이미 적용된 폴더를 재스캔 없이 다시 돌리는 경우가 대표적 —
                #  공란이 이중 삽입되거나, 반대로 필요한 공란이 빠진다)
                _now = _phys_pages(hwp) or 0
                _planned = f.get("phys_pages") or 0
                if _now and _planned and _now != _planned:
                    log(f"    ⚠ 쪽수 불일치: 스캔 {_planned}쪽 → 현재 {_now}쪽. "
                        f"이미 적용된 파일일 수 있습니다 — 원본 사본으로 다시 스캔하세요")

                # 기존 조판부호는 위에서 전부 지웠으므로, 필요한 자리마다
                # **절대 번호**를 직접 부여한다. 작성자 관행에 의존하지 않는다.
                for phys, num in f["marks"]:
                    _goto_page(hwp, phys)
                    if not _set_number(hwp, num):
                        log(f"    ⚠ {phys}면 새 쪽번호({num}) 적용 실패")

                # ── 자체 검증: 쓴 대로 됐는지 문서에서 다시 읽어 대조한다 ──
                # 눈으로 확인해 알려주시기를 반복해서 기다리지 않기 위한 장치.
                want = {ph: nm for ph, nm, _ in f["pages"]}
                got = {r["phys"]: r["num"] for r in _page_map(hwp, f.get("phys_pages") or 0)}
                bad = [(ph, want[ph], got.get(ph)) for ph in sorted(want)
                       if got.get(ph) != want[ph]]
                log(f"  {p.name}: 쪽번호 {f['start']}~{f['end']}"
                    + f" · 새 쪽번호 {len(f['marks'])}곳"
                    + ("" if not bad else
                       f" · ✗ 불일치 {len(bad)}쪽 → " +
                       ", ".join(f"{ph}면 기대{w}/실제{g}" for ph, w, g in bad[:5])))

                if f.get("divider"):
                    existing = _count_hidden(hwp)
                    if existing:
                        # 사용자가 이미 걸어둔 감추기를 존중한다 — 덮어쓰지 않는다
                        log(f"    · 간지 감추기: 문서에 이미 설정됨({existing}개) — 건드리지 않음")
                        done, applied = 0, []
                    else:
                        done, applied = _hide_divider_pages(hwp, log)
                    if done:
                        log(f"    · 간지 1면 감추기: {', '.join(applied)}"
                            + (f" (문서에 기존 감추기 {existing}개 있음)" if existing else ""))
                    else:
                        log(f"    ⚠ 간지 1면 감추기 실패")
                    if not existing:
                        log(f"    ⚠ 간지 뒷면(2면)은 자동 감추기가 불가합니다 — "
                            f"한글에서 [쪽]→감추기로 직접 설정해주세요")

                if not dry_run:
                    hwp.Save()
                ok += 1
            except Exception as e:
                log(f"  ✗ {p.name}: {e}")
                fail += 1
            finally:
                try:
                    hwp.XHwpDocuments.Item(0).Close(isDirty=False)
                except Exception:
                    pass
        progress(len(targets), len(targets), "완료")
    finally:
        try:
            hwp.Quit()
        except Exception:
            pass
    log(f"─── {'미리보기' if dry_run else '적용'} 완료: 성공 {ok} / 실패 {fail}")
    return {"ok": ok, "fail": fail}
