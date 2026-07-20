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
        pages, marks = [], []
        n = cur
        for phys in range(1, total + 1):
            is_a3 = phys in a3set
            # R3b②: A3가 짝수 자리에 오면 홀수로 밀어낸다
            if is_a3 and n % 2 == 0:
                n += 1
            # 연속이 끊기는 지점에만 NewNumber를 건다(첫 쪽은 항상)
            if phys == 1 or (pages and n != pages[-1][1] + 1):
                marks.append((phys, n))
            pages.append((phys, n, is_a3))
            n += 2 if is_a3 else 1      # R3: A3는 번호 2 소비

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

        out.append({**f, "start": (pages[0][1] if pages else cur),
                    "end": end, "pages": pages, "marks": marks, "pad": pad})
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


def _end_page(hwp) -> int:
    hwp.MovePos(3)
    return int(hwp.KeyIndicator()[3])


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
            log(f"  {p.name} — 끝번호 {end} / 물리 {phys}쪽" + (f" / A3 {len(a3)}쪽 {a3}" if a3 else ""))
            out.append({"name": p.name, "path": str(p), "end_page": end,
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


def _hide_current_page(hwp):
    """현재 커서 위치에 감추기를 적용한다(머리말·꼬리말·테두리·배경·바탕쪽·쪽번호).

    ⚠ 파라미터셋 이름이 액션명과 다르다: PageHiding 액션 → **HSecDef** 객체.
      (FindDlg 액션 → HFindReplace 와 같은 어긋남. HPageHiding은 필드가 없는 빈 객체라
       setattr이 전부 실패한다 — 2026-07-20 실명 열거로 확정)
    반환: (성공여부, 적용된 필드 목록)"""
    try:
        pset = hwp.HParameterSet.HSecDef
        hwp.HAction.GetDefault("PageHiding", pset.HSet)
        applied = []
        for f in HIDE_FIELDS:
            try:
                setattr(pset, f, 1)
                applied.append(f)
            except Exception:
                pass
        ok = hwp.HAction.Execute("PageHiding", pset.HSet)
        return bool(ok), applied
    except Exception:
        return False, []


def _hide_divider_pages(hwp, pages: int = 2):
    """간지 구간(앞 N면)에 감추기를 적용한다. 각 쪽으로 이동해 개별 적용한다."""
    done = []
    for phys in range(1, pages + 1):
        _goto_page(hwp, phys)
        ok, applied = _hide_current_page(hwp)
        if ok:
            done.append(phys)
    return done, (applied if done else [])


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

                for phys, num in f["marks"]:
                    _goto_page(hwp, phys)
                    _set_number(hwp, num)
                log(f"  {p.name}: 쪽번호 {f['start']}~{f['end']}"
                    + (f" (NewNumber {len(f['marks'])}곳)" if len(f["marks"]) > 1 else ""))

                if f.get("pad"):
                    hwp.MovePos(3)
                    hwp.HAction.Run("BreakPage")
                    log(f"    · 장 끝 짝수 맞춤 — 공란 1쪽 삽입")

                if f.get("divider"):
                    done, applied = _hide_divider_pages(hwp, 2)
                    if done:
                        log(f"    · 간지 감추기: {len(done)}면({done}) — {', '.join(applied)}")
                    else:
                        log(f"    ⚠ 간지 감추기 실패 — 한글에서 직접 처리해주세요")

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
