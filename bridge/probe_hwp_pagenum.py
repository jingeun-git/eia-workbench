#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SYS-31 1단계 — 한컴 COM 기능 검증 (읽기 전용 · 원본 수정 안 함)

쪽번호 제어 규칙을 구현하기 전에, 한컴 COM으로 **실제로 무엇이 되는지** 확인한다.
학습데이터 추측으로 설계하지 않기 위한 실기 검증이다(안 되는 것을 될 것처럼 만들지 않는다).

검증 항목
  A. 문서 열기·총쪽수·구역별 용지크기(A3 판정) 읽기
  B. 잔존 조판부호 열거 — 쪽번호(nwno)·감추기 계열이 몇 개, 어디에 있는지
     → 도구 생성분과 사용자 수작업분을 **구분할 수 있는지**가 핵심 쟁점
  C. 쪽번호 감추기(머리말·꼬리말·쪽번호) 제어 컨트롤의 존재·속성 접근 가능 여부
  D. 새 쪽번호(NewNumber) 액션 파라미터 확인

⚠ 원본을 수정하지 않는다. 열기만 하고 저장 없이 닫는다.

사용법 (Windows, 한컴오피스 설치 필요):
    python probe_hwp_pagenum.py "D:\\경로\\보고서폴더"     (.hwp·.hwpx 모두 검사)
    python probe_hwp_pagenum.py "D:\\경로\\파일.hwpx"

결과는 화면 출력 + 같은 폴더에 probe_result.txt 저장.
"""

import sys
import os
from pathlib import Path
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

OUT_LINES = []
_SINK = None          # 브리지에서 주입하는 로그 콜백


def log(msg=""):
    if _SINK:
        _SINK(str(msg))
    else:
        print(msg, flush=True)
    OUT_LINES.append(str(msg))


def open_doc(hwp, path: Path):
    """확장자에 맞는 형식 인자로 문서를 연다. (성공여부, 사용인자) 반환.

    ⚠ hwpx에 "HWP" 인자를 주면 한컴이 **예외 없이** 빈 문서 상태가 될 수 있다.
    (2026-07-20 실사고: 쓰기 검증이 67쪽 문서 대신 빈 문서에서 수행돼 결과가 무효화됐다.)
    그래서 여는 곳은 반드시 이 함수를 거친다."""
    ext = path.suffix.lower()
    candidates = ([("HWPX", "forceopen:true"), ("HWP", "forceopen:true"), (None, None)]
                  if ext == ".hwpx" else
                  [("HWP", "forceopen:true"), (None, None)])
    for fmt, arg in candidates:
        try:
            ok = hwp.Open(str(path)) if fmt is None else hwp.Open(str(path), fmt, arg)
            if ok is False:      # 한컴은 실패 시 예외 대신 False를 주기도 한다
                continue
            return True, ("자동판별" if fmt is None else f'"{fmt}"')
        except Exception:
            continue
    return False, None


def doc_pages(hwp) -> int:
    """마지막 쪽의 **쪽번호**를 반환한다(물리 쪽 수가 아니다).

    ⚠ KeyIndicator()[3]은 화면에 표시되는 쪽번호다. 새 쪽번호를 7로 지정하면
    8쪽짜리 문서가 14로 보고된다(2026-07-20 실측: 7쪽 원본 → BreakPage 8쪽 →
    NewNumber=7 적용 후 '14쪽'). 규칙 판정("장 끝이 짝수인가")에 필요한 값은
    쪽번호가 맞으므로 이 값을 쓰되, 물리 쪽 수와 혼동하지 않는다."""
    hwp.MovePos(3)
    return int(hwp.KeyIndicator()[3])


def phys_pages(hwp):
    """물리 쪽 수 — PageCount 속성이 있으면 사용(없으면 None)."""
    for attr in ("PageCount", "XHwpDocuments"):
        try:
            if attr == "PageCount":
                v = hwp.PageCount
                if v:
                    return int(v)
            else:
                v = hwp.XHwpDocuments.Item(0).XHwpDocumentInfo.PageCount
                if v:
                    return int(v)
        except Exception:
            continue
    return None


def probe_file(hwp, path: Path):
    log(f"\n{'─' * 66}")
    log(f"■ {path.name}   [{path.suffix.lower().lstrip('.')}]")
    log(f"{'─' * 66}")

    ok, opened_with = open_doc(hwp, path)
    if not ok:
        log("  ✗ 열기 실패(모든 형식 인자 시도)")
        return
    log(f"  열기 성공 — 형식 인자: {opened_with}")

    # ── A. 총쪽수 ────────────────────────────────────────────────────────
    try:
        hwp.MovePos(3)                    # 문서 끝
        ki = hwp.KeyIndicator()
        total_pages = int(ki[3])
        ph = phys_pages(hwp)
        log(f"  A. 끝 쪽번호: {total_pages}  / 물리 쪽수: {ph if ph is not None else '조회 불가'}")
    except Exception as e:
        total_pages = None
        log(f"  A. ✗ 총쪽수 읽기 실패: {e}")

    # ── A-2. 구역별 용지 크기 → A3 판정 (기존 hwpPageNum2.0 로직 재사용) ──
    try:
        sects = []
        ctrl = hwp.HeadCtrl
        while ctrl is not None:
            if ctrl.CtrlID == "secd":     # 구역 정의
                props = ctrl.Properties
                pagedef = props.Item("PageDef")
                w = round(pagedef.Item("PaperWidth") / 283.465, 1)
                h = round(pagedef.Item("PaperHeight") / 283.465, 1)
                kind = "A3" if (w > 210.0 and h > 297.0) else "A4"
                sects.append((kind, w, h))
            ctrl = ctrl.Next
        a3 = sum(1 for s in sects if s[0] == "A3")
        log(f"  A-2. 구역 {len(sects)}개 — A3 {a3}개 / A4 {len(sects) - a3}개")
        for i, (k, w, h) in enumerate(sects[:12], 1):
            log(f"        구역{i}: {k} ({w}×{h}mm)")

        # A3 "페이지 수" — 구역 수가 아니라 실제 쪽 수를 세려면 페이지를 순회해야 한다
        # (기존 hwpPageNum2.0.print_A3_page2 로직). 사용자 요구 "A3 장수"가 이 값이다.
        if a3 and total_pages:
            try:
                hwp.MovePos(2)
                pi = hwp.KeyIndicator()
                a3_pages, seen_pages = [], 0
                while seen_pages <= total_pages + 2:
                    seen_pages += 1
                    sec_idx = pi[2] - 1
                    if 0 <= sec_idx < len(sects) and sects[sec_idx][0] == "A3":
                        a3_pages.append(pi[3])
                    if pi[3] >= total_pages:
                        break
                    hwp.HAction.Run("MovePageDown")
                    nxt = hwp.KeyIndicator()
                    if nxt[3] == pi[3]:
                        break
                    pi = nxt
                log(f"  A-3. A3 페이지: {len(a3_pages)}쪽 {a3_pages[:20]}")
            except Exception as e:
                log(f"  A-3. ✗ A3 페이지 순회 실패: {e}")
    except Exception as e:
        log(f"  A-2. ✗ 구역 읽기 실패: {e}")

    # ── B. 잔존 조판부호 열거 (핵심 쟁점) ────────────────────────────────
    #    사용자 지적: 이전 실행·수작업의 쪽번호/감추기 조판부호가 남아 있다.
    #    여기서 확인할 것 — 종류별로 열거되는가, 생성 주체를 구분할 단서가 있는가.
    try:
        counts = {}
        details = []
        ctrl = hwp.HeadCtrl
        while ctrl is not None:
            cid = ctrl.CtrlID
            counts[cid] = counts.get(cid, 0) + 1
            if cid in ("nwno", "pghd", "head", "foot", "pgnp", "pgct"):
                try:
                    pos = ctrl.GetAnchorPos(0)
                    hwp.SetPos(pos.Item("List"), pos.Item("Para"), pos.Item("Pos"))
                    pi = hwp.KeyIndicator()
                    where = f"{pi[3]}쪽"
                except Exception:
                    where = "위치불명"
                # 속성 키를 열거해 "구분 단서"가 있는지 본다
                attrs = ""
                try:
                    st = ctrl.Properties
                    probe_keys = ("NumType", "NewNumber", "HideHeader", "HideFooter",
                                  "HidePageNum", "HideBorder", "HideFill", "HideMasterPage",
                                  "SideType", "ApplyTo", "ApplyClass")
                    got = [f"{k}={st.Item(k)}" for k in probe_keys if _safe_has(st, k)]
                    attrs = " | ".join(got)
                except Exception:
                    pass
                details.append(f"      - {cid} @ {where} {('[' + attrs + ']') if attrs else ''}")
            ctrl = ctrl.Next

        log(f"  B. 전체 컨트롤 종류: {len(counts)}종")
        for cid, n in sorted(counts.items(), key=lambda x: -x[1])[:20]:
            mark = "  ← 쪽번호/머리말 계열" if cid in ("nwno", "pghd", "head", "foot", "pgnp", "pgct") else ""
            log(f"        {cid}: {n}개{mark}")
        if details:
            log("     상세(쪽번호·머리말 계열):")
            for d in details[:25]:
                log(d)
        else:
            log("     (쪽번호·머리말 계열 컨트롤 없음)")
    except Exception as e:
        log(f"  B. ✗ 컨트롤 열거 실패: {e}")

    # ── C. 감추기(HideProperty) 접근 가능 여부 ──────────────────────────
    #    한컴의 '감추기'는 구역 속성(머리말/꼬리말/쪽번호 숨김)으로 들어간다.
    try:
        hwp.MovePos(2)
        act = hwp.CreateAction("PageHiding")
        st = act.CreateSet()
        act.GetDefault(st)
        keys = []
        for k in ("HideHeader", "HideFooter", "HidePageNum", "HideBorder",
                  "HideFill", "HideMasterPage"):
            if _safe_has(st, k):
                keys.append(f"{k}={st.Item(k)}")
        log(f"  C. PageHiding 액션 접근: ✓ 가능")
        log(f"     파라미터: {', '.join(keys) if keys else '(항목 확인 실패)'}")
    except Exception as e:
        log(f"  C. ✗ PageHiding 접근 실패: {e}")
        log("     → 감추기 자동 제어 불가 가능성. 대안 검토 필요")

    # ── D-2. 감추기 단서 — 기존 pghd·secd 속성을 넓은 키 목록으로 덤프 ──
    #    감추기가 별도 컨트롤(pghd)인지 구역(secd) 속성인지 판별하기 위한 조사.
    try:
        # 한글 감추기 대화상자 항목은 6개(머리말·꼬리말·바탕쪽·테두리·배경·쪽번호).
        # 5개는 Hide*로 찾았는데 **쪽번호만 이름을 못 찾았다** → 후보를 넓게 훑는다.
        WIDE = ("HideHeader", "HideFooter", "HideBorder", "HideFill", "HideMasterPage",
                # ── 쪽번호 감추기 후보 (이름 미확인, 2026-07-20) ──
                "HidePageNum", "HidePageNumber", "HidePageNo", "HidePgNum", "HidePgNo",
                "HidePageNumPos", "HidePageNumber2", "HideNumber", "HidePageNumbering",
                "PageNumHide", "PageNumberHide", "HidePagenum", "HidePageno",
                "ShowPageNum", "ShowPageNumber", "PageNumVisible", "VisiblePageNum",
                # ── 기타 구역 속성 ──
                "HideAll", "Hide", "ShowHeader", "ShowFooter", "HeadType", "FootType",
                "PageStartsOn", "StartNum", "SectionType", "TextDirection",
                "HideFirstHeader", "HideFirstFooter", "HideFirstPageNum",
                "HideFirstBorder", "HideFirstFill", "HideFirstMasterPage")
        found_any = False
        c = hwp.HeadCtrl
        while c is not None:
            if c.CtrlID in ("pghd", "secd"):
                try:
                    st = c.Properties
                    got = [f"{k}={st.Item(k)}" for k in WIDE if _safe_has(st, k)]
                    if got:
                        found_any = True
                        log(f"  D-2. {c.CtrlID} 속성: {' | '.join(got[:14])}")
                except Exception:
                    pass
            c = c.Next
        if not found_any:
            log("  D-2. pghd/secd에서 감추기 관련 속성 키를 찾지 못함")
    except Exception as e:
        log(f"  D-2. ✗ 속성 덤프 실패: {e}")

    # ── D. 새 쪽번호(NewNumber) 파라미터 ────────────────────────────────
    try:
        act = hwp.CreateAction("NewNumber")
        st = act.CreateSet()
        act.GetDefault(st)
        keys = []
        for k in ("NumType", "NewNumber"):
            if _safe_has(st, k):
                keys.append(f"{k}={st.Item(k)}")
        log(f"  D. NewNumber 액션: ✓ 가능 ({', '.join(keys) if keys else '항목 확인 실패'})")
    except Exception as e:
        log(f"  D. ✗ NewNumber 접근 실패: {e}")

    # ── 저장하지 않고 닫기 (원본 보호) ──────────────────────────────────
    try:
        hwp.XHwpDocuments.Item(0).Close(isDirty=False)
    except Exception:
        pass


def dump_paramsets(hwp):
    """HParameterSet에서 실제로 존재하는 파라미터셋·속성 이름을 **열거**한다.

    액션명과 파라미터셋 이름은 1:1이 아니다(FindDlg 액션 → HFindReplace 객체).
    추측 대신 COM 타입정보를 직접 읽어 감추기용 객체·필드를 확정한다."""
    log(f"\n{'=' * 66}")
    log("■ HParameterSet 실제 이름 열거")
    log(f"{'=' * 66}")

    def names_of(obj):
        out = set()
        try:
            out |= {n for n in dir(obj) if not n.startswith("_")}
        except Exception:
            pass
        for attr in ("_prop_map_get_", "_prop_map_put_"):
            try:
                out |= set(getattr(obj, attr).keys())
            except Exception:
                pass
        return sorted(out)

    try:
        ps = hwp.HParameterSet
    except Exception as e:
        log(f"  ✗ HParameterSet 접근 실패: {e}")
        return

    all_names = names_of(ps)
    log(f"  파라미터셋 총 {len(all_names)}종")
    cand = [n for n in all_names
            if any(k in n.lower() for k in ("hid", "page", "pg", "sec", "num"))]
    log(f"  감추기/쪽 관련 후보: {cand}")

    # 후보 각각의 속성에서 Hide 계열 찾기
    for name in cand[:12]:
        try:
            obj = getattr(ps, name)
        except Exception:
            continue
        fields = [f for f in names_of(obj) if "hide" in f.lower() or "num" in f.lower()]
        if fields:
            log(f"    {name}: {fields[:20]}")

    # PageHiding 액션의 파라미터셋을 GetDefault로 채운 뒤 값 읽기
    for name in ("HPageHiding", "HPageHide", "HSecDef", "HPageSetup", "HPageNumPos"):
        if name not in all_names:
            continue
        try:
            obj = getattr(ps, name)
            ret = hwp.HAction.GetDefault("PageHiding", obj.HSet)
            vals = []
            for f in names_of(obj):
                if "hide" not in f.lower():
                    continue
                try:
                    vals.append(f"{f}={getattr(obj, f)}")
                except Exception:
                    pass
            log(f"    [{name}] GetDefault('PageHiding')={ret} → {vals[:20] or '값 없음'}")
        except Exception as e:
            log(f"    [{name}] ✗ {type(e).__name__}: {str(e)[:70]}")


def hide_key_sweep(hwp, path: Path):
    """감추기 키 역추적 — 문서의 secd에서 **값이 설정된 키를 전부** 훑는다.

    사용법: 사용자가 한글에서 [쪽]→감추기→'쪽 번호'만 체크해 저장한 파일을 지정하면,
    1로 켜진 키가 곧 쪽번호 감추기의 정확한 속성명이다(무차별 대입보다 확실).
    """
    log(f"\n{'=' * 66}")
    log("■ 감추기 키 역추적")
    log(f"{'=' * 66}")
    ok, _ = open_doc(hwp, path)
    if not ok:
        log("  ✗ 열기 실패")
        return
    # ParameterSet에서 키를 직접 열거할 수 없으므로 후보를 넓게 시도한다
    CAND = [f"Hide{w}" for w in ("Header", "Footer", "Border", "Fill", "MasterPage",
                                 "PageNum", "PageNumber", "PageNo", "PgNum", "PgNo",
                                 "Number", "Numbering", "PageNumPos", "Pagenum",
                                 "FirstHeader", "FirstFooter", "FirstPageNum", "All")]
    CAND += ["PageNumHide", "PageNumberHide", "ShowPageNum", "ShowPageNumber",
             "PageNumVisible", "VisiblePageNum", "PageStartsOn", "StartNum"]
    idx = 0
    c = hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "secd":
            idx += 1
            try:
                st = c.Properties
                on, off = [], []
                for k in CAND:
                    try:
                        v = st.Item(k)
                    except Exception:
                        continue
                    if v is None:
                        continue
                    (on if v else off).append(f"{k}={v}")
                log(f"  구역{idx} — 켜짐(0아님): {on or '없음'}")
                log(f"           꺼짐(0)    : {off or '없음'}")
            except Exception as e:
                log(f"  구역{idx} ✗ {e}")
        c = c.Next
    try:
        hwp.XHwpDocuments.Item(0).Close(isDirty=False)
    except Exception:
        pass
    log("  → '켜짐'에 쪽번호 관련 키가 보이면 그것이 정답입니다.")


def write_test(hwp, src: Path):
    """쓰기 가능 여부 검증 — **원본이 아닌 사본**에서만 수행한다.
    규칙 구현에 필요한 3가지가 실제로 먹는지 확인: 공란 삽입·감추기·새 쪽번호."""
    import tempfile, shutil
    log(f"\n{'=' * 66}")
    log("■ 쓰기 검증 (사본에서 수행 — 원본 안전)")
    log(f"{'=' * 66}")

    tmpdir = Path(tempfile.gettempdir()) / "eiaw_probe"
    tmpdir.mkdir(exist_ok=True)
    dst = tmpdir / ("WRITETEST_" + src.name)
    try:
        shutil.copy2(src, dst)
    except Exception as e:
        log(f"  ✗ 사본 생성 실패: {e}")
        return
    log(f"  사본: {dst}")

    # 원본 쪽수를 먼저 확보해 사본과 대조한다 — 열기 실패를 성공으로 오독하지 않기 위한 게이트
    ok, _ = open_doc(hwp, src)
    if not ok:
        log("  ✗ 원본 열기 실패 — 쓰기 검증 중단")
        return
    origin_pages = doc_pages(hwp)
    hwp.XHwpDocuments.Item(0).Close(isDirty=False)

    ok, used = open_doc(hwp, dst)
    if not ok:
        log("  ✗ 사본 열기 실패 — 쓰기 검증 중단")
        return
    before = doc_pages(hwp)
    ph = phys_pages(hwp)
    log(f"  사본 열기 — 형식 인자: {used}, 끝 쪽번호: {before} (원본 {origin_pages}) "
        f"/ 물리 쪽수: {ph if ph is not None else '조회 불가'}")

    # ⚠ 무결성 게이트: 사본이 원본과 다른 쪽수면 제대로 안 열린 것이다.
    #   이 검사가 없어 빈 문서(1쪽)에서 실험하고 "성공"으로 보고한 사고가 있었다(2026-07-20).
    if before != origin_pages:
        log(f"  ✗ 사본 쪽수가 원본과 불일치({before}≠{origin_pages}) — 문서가 제대로 열리지 않았습니다.")
        log("     쓰기 검증을 중단합니다(무효한 결과를 성공으로 보고하지 않기 위함).")
        try: hwp.XHwpDocuments.Item(0).Close(isDirty=False)
        except Exception: pass
        return

    # (1) 공란 페이지 삽입 — 장 전환 시 짝수 맞춤에 필요
    try:
        hwp.MovePos(3)
        hwp.HAction.Run("BreakPage")
        hwp.MovePos(3)
        after = int(hwp.KeyIndicator()[3])
        log(f"  1) 공란 페이지 삽입(BreakPage): {'✓ 가능' if after > before else '✗ 쪽수 변화 없음'} "
            f"({before}→{after}쪽)")
    except Exception as e:
        log(f"  1) ✗ 공란 삽입 실패: {e}")

    # (2) 감추기 — 머리말·꼬리말·쪽번호 숨김
    #    ⚠ PageHiding은 Execute가 True를 반환해도 pghd 컨트롤이 생기지 않았다(2026-07-20 실측).
    #    반환값을 믿지 말고 **컨트롤 개수 변화로 판정**하고, 액션 이름 후보를 넓게 시도한다.
    def _count(cid):
        n, c = 0, hwp.HeadCtrl
        while c is not None:
            if c.CtrlID == cid:
                n += 1
            c = c.Next
        return n

    def _count(cid):
        n, c = 0, hwp.HeadCtrl
        while c is not None:
            if c.CtrlID == cid:
                n += 1
            c = c.Next
        return n

    # ⚠ 올바른 COM 패턴: hwp.HParameterSet.H{액션}.HSet + 파이썬 속성 직접 대입.
    #   기존 승인 코드(hwpContent1.1.py hwp_find_action)가 이 패턴을 쓰고 있었는데
    #   act.CreateSet()+SetItem 방식으로 잘못 호출해 파라미터가 전부 None이었다(2026-07-20).
    #   쪽번호 키는 secd 덤프에서 발견된 **HidePageNumPos**가 유력하다.
    HIDE_FIELDS = ["HideHeader", "HideFooter", "HidePageNumPos"]
    hide_ok = None
    try:
        before_pghd = _count("pghd")
        hwp.MovePos(3)
        pset = hwp.HParameterSet.HSecDef      # ← 액션명과 다름(실명 열거로 확정)
        hwp.HAction.GetDefault("PageHiding", pset.HSet)
        got, missed = [], []
        for f in HIDE_FIELDS:
            try:
                setattr(pset, f, 1)
                got.append(f)
            except Exception:
                missed.append(f)
        ret = hwp.HAction.Execute("PageHiding", pset.HSet)
        after_pghd = _count("pghd")
        log(f"  2) 감추기 [HSecDef 방식] 설정={got}"
            + (f" 실패={missed}" if missed else ""))
        log(f"     Execute={ret}  pghd {before_pghd}→{after_pghd} "
            f"{'✓ 컨트롤 생성됨' if after_pghd > before_pghd else '(개수 변화 없음)'}")
        if ret:
            hide_ok = "HParameterSet"
    except Exception as e:
        log(f"  2) 감추기 [HSecDef 방식] ✗ {type(e).__name__}: {str(e)[:120]}")

    # (2b) 감추기 재시도 — **구역(secd) 속성 경로**
    #      D-2에서 secd만 Hide*=0으로 실값을 갖고 pghd는 전부 None이었다
    #      → 감추기는 구역 속성이라는 강한 단서. 액션이 아니라 속성 쓰기로 시도한다.
    try:
        c, target_sec = hwp.HeadCtrl, None
        while c is not None:
            if c.CtrlID == "secd":
                target_sec = c
                break
            c = c.Next
        if target_sec is None:
            log("  2b) 구역(secd) 컨트롤을 찾지 못함")
        else:
            st = target_sec.Properties
            keys = [k for k in ("HideHeader", "HideFooter", "HideBorder",
                                "HideFill", "HideMasterPage", "HidePageNum")
                    if _safe_has(st, k) and st.Item(k) is not None]
            before = {k: st.Item(k) for k in keys}
            for k in keys:
                st.SetItem(k, 1)
            target_sec.Properties = st          # 속성 되돌려 넣기(핵심)
            # 재조회로 실제 반영 확인
            st2 = target_sec.Properties
            after = {k: st2.Item(k) for k in keys}
            changed = [k for k in keys if before[k] != after[k]]
            log(f"  2b) 구역 속성 쓰기: 대상키={keys}")
            log(f"      before={before}")
            log(f"      after ={after}")
            log(f"      → {'✓ ' + str(changed) + ' 반영됨' if changed else '✗ 값 변화 없음'}")
    except Exception as e:
        log(f"  2b) ✗ 구역 속성 쓰기 실패: {type(e).__name__}: {str(e)[:100]}")

    # (2c) 구역 나누기 — 특정 페이지만 감추려면 그 쪽을 별도 구역으로 떼야 한다
    try:
        c, before_sec = hwp.HeadCtrl, 0
        while c is not None:
            if c.CtrlID == "secd":
                before_sec += 1
            c = c.Next
        hwp.MovePos(3)
        hwp.HAction.Run("BreakSection")
        c, after_sec = hwp.HeadCtrl, 0
        while c is not None:
            if c.CtrlID == "secd":
                after_sec += 1
            c = c.Next
        log(f"  2c) 구역 나누기(BreakSection): secd {before_sec}→{after_sec} "
            f"{'✓ 가능' if after_sec > before_sec else '✗ 변화 없음'}")
    except Exception as e:
        log(f"  2c) ✗ 구역 나누기 실패: {e}")

    # (3) 새 쪽번호 — 홀수 강제에 필요
    try:
        hwp.MovePos(2)
        act = hwp.CreateAction("NewNumber")
        st = act.CreateSet()
        act.GetDefault(st)
        st.SetItem("NumType", hwp.AutoNumType("Page"))
        st.SetItem("NewNumber", 7)
        ok = act.Execute(st)
        log(f"  3) 새 쪽번호 지정(NewNumber=7): {'✓ Execute 성공' if ok else '✗ Execute 반환 False'}")
    except Exception as e:
        log(f"  3) ✗ 새 쪽번호 실패: {e}")

    # 저장 후 재열기로 실제 반영 확인
    try:
        hwp.Save()
        hwp.XHwpDocuments.Item(0).Close(isDirty=False)
        ok, _ = open_doc(hwp, dst)
        if not ok:
            log("  4) ✗ 저장본 재열기 실패")
            return
        ctrls = {}
        c = hwp.HeadCtrl
        while c is not None:
            ctrls[c.CtrlID] = ctrls.get(c.CtrlID, 0) + 1
            c = c.Next
        final = doc_pages(hwp)
        verdict = "✓ 반영됨" if final > origin_pages else "⚠ 쪽수 증가 없음"
        log(f"  4) 저장·재열기 검증({verdict}): 총 {final}쪽(원본 {origin_pages}), "
            f"nwno={ctrls.get('nwno', 0)}개 pghd={ctrls.get('pghd', 0)}개")
        log(f"     → 사본을 직접 열어 확인해보세요: {dst}")
        hwp.XHwpDocuments.Item(0).Close(isDirty=False)
    except Exception as e:
        log(f"  4) ✗ 저장·재검증 실패: {e}")


def _safe_has(pset, key) -> bool:
    try:
        pset.Item(key)
        return True
    except Exception:
        return False


def run_probe(target_path, sink=None, max_files: int = 5) -> str:
    """검증을 수행하고 전체 출력 텍스트를 반환한다.
    sink: 줄 단위 콜백(브리지 job_log). None이면 stdout 출력.
    예외는 호출자에게 전파한다 — 브리지가 job 오류로 표시하게."""
    global _SINK, OUT_LINES
    _SINK = sink
    OUT_LINES = []
    try:
        _run(Path(target_path), max_files)
    finally:
        _SINK = None
    return "\n".join(OUT_LINES)


def _run(target: Path, max_files: int = 5):
    EXTS = (".hwp", ".hwpx")
    if target.is_dir():
        files = sorted(p for p in target.iterdir()
                       if p.suffix.lower() in EXTS and not p.name.startswith("~"))
    elif target.suffix.lower() in EXTS:
        files = [target]
    else:
        raise RuntimeError("hwp/hwpx 파일 또는 폴더를 지정하세요.")

    if not files:
        raise RuntimeError("대상 .hwp / .hwpx 파일이 없습니다.")

    log("=" * 66)
    log("  SYS-31 한컴 COM 기능 검증 (읽기 전용 — 원본을 수정하지 않습니다)")
    log("=" * 66)
    log(f"  대상: {target}")
    log(f"  파일: {len(files)}개")
    log(f"  시각: {datetime.now():%Y-%m-%d %H:%M}")

    try:
        import win32com.client as win32
    except ImportError:
        raise RuntimeError("pywin32 미설치 — pip install pywin32")

    try:
        hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
    except Exception as e:
        raise RuntimeError(f"한컴 실행 실패: {e} — 한컴오피스 설치 필요")

    # 샘플링 — hwpx가 있으면 **반드시 포함**한다(포맷 지원 여부가 핵심 미지수).
    hwpx = [p for p in files if p.suffix.lower() == ".hwpx"]
    hwps = [p for p in files if p.suffix.lower() == ".hwp"]
    picked = (hwpx[:2] + hwps[:max(0, max_files - len(hwpx[:2]))])[:max_files]
    if hwpx:
        log(f"  (hwpx {len(hwpx)}개 발견 — 우선 검사)")
    else:
        log("  ⚠ 이 폴더에 hwpx가 없습니다 — hwpx 지원 여부는 미검증으로 남습니다")

    for p in picked:
        probe_file(hwp, p)

    # 감추기 키 역추적 — 파일명에 HIDE가 들어간 파일이 있으면 그것을 우선 대상으로
    marked = [p for p in files if "HIDE" in p.stem.upper()]
    if marked:
        log(f"\n  (감추기 표본 발견: {marked[0].name})")
        hide_key_sweep(hwp, marked[0])
    elif picked:
        hide_key_sweep(hwp, picked[0])
    dump_paramsets(hwp)

    # 쓰기 검증 — 감추기 조사가 목적이므로 **pghd가 실재하는 문서를 우선** 고른다
    if picked:
        def _has_pghd(p):
            try:
                ok, _ = open_doc(hwp, p)
                if not ok:
                    return False
                c, found = hwp.HeadCtrl, False
                while c is not None:
                    if c.CtrlID == "pghd":
                        found = True
                        break
                    c = c.Next
                hwp.XHwpDocuments.Item(0).Close(isDirty=False)
                return found
            except Exception:
                return False
        target = next((p for p in picked if _has_pghd(p)), picked[0])
        if target is not picked[0]:
            log(f"\n  (쓰기 검증 대상으로 pghd 보유 문서 선택: {target.name})")
        picked = [target] + [p for p in picked if p is not target]
        try:
            write_test(hwp, picked[0])
        except Exception as e:
            log(f"\n■ 쓰기 검증 ✗ 예외: {e}")
    if len(files) > len(picked):
        log(f"\n(파일 {len(files)}개 중 {len(picked)}개만 검증 — 구조 파악에 충분)")

    try:
        hwp.Quit()
    except Exception:
        pass

    out = (target if target.is_dir() else target.parent) / "probe_result.txt"
    try:
        out.write_text("\n".join(OUT_LINES), encoding="utf-8")
        log(f"\n결과 저장: {out}")
    except Exception as e:
        log(f"\n결과 저장 실패: {e}")

    log("\n이 출력 전체를 Claude에게 전달해주세요 — 규칙 구현 가능 범위를 판정합니다.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    try:
        run_probe(sys.argv[1])
    except Exception as e:
        print(f"\n✗ {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
