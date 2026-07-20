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


def log(msg=""):
    print(msg, flush=True)
    OUT_LINES.append(str(msg))


def probe_file(hwp, path: Path):
    log(f"\n{'─' * 66}")
    log(f"■ {path.name}   [{path.suffix.lower().lstrip('.')}]")
    log(f"{'─' * 66}")

    # 열기 — hwpx는 형식 인자가 다를 수 있어 후보를 순차 시도하고 성공한 것을 기록한다
    # (학습데이터 추측 금지 — 어떤 인자가 통하는지 실측으로 남긴다)
    ext = path.suffix.lower()
    candidates = ([("HWPX", "forceopen:true"), ("HWP", "forceopen:true"), (None, None)]
                  if ext == ".hwpx" else
                  [("HWP", "forceopen:true"), (None, None)])
    opened_with = None
    for fmt, arg in candidates:
        try:
            if fmt is None:
                hwp.Open(str(path))          # 형식 자동판별
                opened_with = "자동판별"
            else:
                hwp.Open(str(path), fmt, arg)
                opened_with = f'"{fmt}"'
            break
        except Exception as e:
            last = e
    if opened_with is None:
        log(f"  ✗ 열기 실패(모든 형식 인자 시도): {last}")
        return
    log(f"  열기 성공 — 형식 인자: {opened_with}")

    # ── A. 총쪽수 ────────────────────────────────────────────────────────
    try:
        hwp.MovePos(3)                    # 문서 끝
        ki = hwp.KeyIndicator()
        total_pages = int(ki[3])
        log(f"  A. 총쪽수: {total_pages}쪽")
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
                    attrs = " | ".join(str(st.Item(k)) for k in ("NumType", "NewNumber")
                                       if _safe_has(st, k))
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


def _safe_has(pset, key) -> bool:
    try:
        pset.Item(key)
        return True
    except Exception:
        return False


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    target = Path(sys.argv[1])
    EXTS = (".hwp", ".hwpx")
    if target.is_dir():
        files = sorted(p for p in target.iterdir()
                       if p.suffix.lower() in EXTS and not p.name.startswith("~"))
    elif target.suffix.lower() in EXTS:
        files = [target]
    else:
        print("hwp/hwpx 파일 또는 폴더를 지정하세요.")
        sys.exit(1)

    if not files:
        print("대상 .hwp / .hwpx 파일이 없습니다.")
        sys.exit(1)

    log("=" * 66)
    log("  SYS-31 한컴 COM 기능 검증 (읽기 전용 — 원본을 수정하지 않습니다)")
    log("=" * 66)
    log(f"  대상: {target}")
    log(f"  파일: {len(files)}개")
    log(f"  시각: {datetime.now():%Y-%m-%d %H:%M}")

    try:
        import win32com.client as win32
    except ImportError:
        log("\n✗ pywin32 미설치 — 설치: pip install pywin32")
        sys.exit(1)

    try:
        hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
    except Exception as e:
        log(f"\n✗ 한컴 실행 실패: {e}")
        log("  한컴오피스가 설치돼 있어야 합니다.")
        sys.exit(1)

    # 파일이 많으면 앞 5개만 — 검증 목적이라 전수는 불필요
    for p in files[:5]:
        probe_file(hwp, p)
    if len(files) > 5:
        log(f"\n(파일 {len(files)}개 중 앞 5개만 검증 — 구조 파악에 충분)")

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


if __name__ == "__main__":
    main()
