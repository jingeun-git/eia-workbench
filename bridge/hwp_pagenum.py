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


def build_plan(files, include_divider: bool = False, start_num: int = 1):
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
            "divider": bool(include_divider and is_head and not skip),
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
        blanks = set(f.get("blank_pages") or [])

        # 간지 뒷면: 이미 물리 빈 페이지(2면)가 있으면 결번을 넣지 않는다
        div_skip = 1 if (f.get("divider") and 2 not in blanks) else 0
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
                n += 1 if (phys + 1) in blanks else 2
            else:
                n += 1

        end = (pages[-1][1] if pages else cur - 1)
        # A3로 끝나면 그 뒷면(짝수)까지 차지한 것으로 본다 — 다음은 홀수에서 시작
        if pages and pages[-1][2]:
            end += 1

        # R1: 장의 마지막 파일이면 짝수로 끝나야 한다
        nxt = plan[i + 1] if i + 1 < len(plan) else None
        is_tail = (nxt is None) or nxt.get("is_chapter_head") or nxt.get("skip")
        pad = 0
        if is_tail and end % 2 == 1:
            pad = 1
            end += 1

        # 기존 감추기가 도구가 의도한 위치와 다르면 표시한다.
        # 도구가 감추는 곳: 간지 1·2면(장 첫 파일) + 장 끝 공란.
        # 그 밖의 감추기는 사람이 잘못 넣었을 가능성이 있으므로 사용자에게 알린다.
        expect = set()
        if f.get("divider"):
            expect |= {1, 2}
        if pad:
            expect.add(total + 1)
        stray = [h for h in (f.get("hide_pages") or []) if h and h not in expect]

        out.append({**f, "start": (pages[0][1] if pages else cur),
                    "end": end, "pages": pages, "marks": marks, "pad": pad,
                    "expect_hide": sorted(expect), "stray_hide": stray,
                    "div_skip": div_skip})
        cur = end + 1
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

    # 빈 쪽 추정: 문단이 1개 이하로만 걸친 쪽 (간지 뒷면·A3 사이 공백 판정용)
    for i, r in enumerate(out):
        nxt = out[i + 1]["para"] if i + 1 < len(out) else None
        r["blank"] = (r["para"] is not None and nxt is not None
                      and nxt - r["para"] <= 1)
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
            hides = _hidden_pages(hwp, log)
            nums = [r["num"] for r in pmap if r["num"] is not None]
            start = nums[0] if nums else None
            # 결번 = 번호는 소비했으나 물리 쪽이 없는 자리
            #   (작성자가 '빈 페이지 대신 번호 제어'로 공백면을 표현한 흔적)
            gaps = [pmap[i + 1]["num"] for i in range(len(pmap) - 1)
                    if pmap[i]["num"] is not None and pmap[i + 1]["num"] is not None
                    and pmap[i + 1]["num"] != pmap[i]["num"] + 1]
            blanks = [r["phys"] for r in pmap if r.get("blank")]
            log(f"  {p.name} — 현재 쪽번호 {start}~{end} / 물리 {phys}쪽"
                + (f" / A3 {len(a3)}쪽 {a3}" if a3 else "")
                + (f" / 결번 {len(gaps)}곳" if gaps else "")
                + (f" / 빈쪽 추정 {blanks}" if blanks else "")
                + (f" / 기존 감추기 {hides}" if hides else ""))
            out.append({"name": p.name, "path": str(p), "end_page": end,
                        "start_page": start, "hide_pages": hides,
                        "gap_count": len(gaps), "blank_pages": blanks,
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
PAGENUM_CTRLS = ("nwno",)
PAGENUM_CTRLS_RISKY = ("pgnp", "pgct")


def _clear_pagenum(hwp, extra_clear: bool = False):
    """쪽번호 관련 조판부호 제거. 반환: {컨트롤ID: 삭제수}

    ※ pghd(감추기)·head(머리말)는 쪽번호가 아니라 사용자 서식이므로 건드리지 않는다.
      간지 모드에서 감추기를 새로 부여할 때만 별도로 다룬다."""
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
    act = hwp.CreateAction("NewNumber")
    st = act.CreateSet()
    act.GetDefault(st)
    st.SetItem("NumType", hwp.AutoNumType("Page"))
    st.SetItem("NewNumber", int(num))
    return bool(act.Execute(st))


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


def _hide_last_section_first_page(hwp):
    """마지막 구역의 첫 쪽을 감춘다 — 장 끝 공란 전용.

    ⚠ 문서 **끝**에서 BreakSection 하는 것은 안전하다. 본문은 기존 구역에 그대로
      남고 새 구역에는 공란만 들어가므로, 2026-07-20의 머리말 소실(본문이 새 구역으로
      넘어가 머리말을 잃은 사고)이 발생하지 않는다. 오히려 새 구역이 머리말을
      상속하지 않는 성질이 여기서는 목적에 부합한다(공란에 머리말이 찍히면 안 됨).
    """
    last, c = None, hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "secd":
            last = c
        c = c.Next
    return _hide_section_first_page(last) if last is not None else []


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

                for phys, num in f["marks"]:
                    _goto_page(hwp, phys)
                    _set_number(hwp, num)
                log(f"  {p.name}: 쪽번호 {f['start']}~{f['end']}"
                    + (f" (NewNumber {len(f['marks'])}곳)" if len(f["marks"]) > 1 else ""))

                if f.get("pad"):
                    before = (_phys_pages(hwp) or 0)
                    hwp.MovePos(3)
                    # BreakPage가 아니라 BreakSection — 공란을 '구역 첫 쪽'으로 만들어야
                    # 감추기를 걸 수 있다(구역 중간 쪽은 COM으로 감출 수 없음)
                    hwp.HAction.Run("BreakSection")
                    after = (_phys_pages(hwp) or 0)
                    hidden = _hide_last_section_first_page(hwp)
                    log(f"    · 장 끝 짝수 맞춤 — 공란 1쪽 삽입"
                        + (f" ({before}→{after}쪽)" if after else "")
                        + (f" · 감추기 {', '.join(hidden)}" if hidden
                           else " · ⚠ 감추기 실패 — 한글에서 직접 확인 필요"))

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
