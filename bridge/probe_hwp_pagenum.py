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

    try:
        hwp.Open(str(dst), "HWP", "forceopen:true")
    except Exception as e:
        log(f"  ✗ 사본 열기 실패: {e}")
        return

    hwp.MovePos(3)
    before = int(hwp.KeyIndicator()[3])
    log(f"  변경 전 총쪽수: {before}쪽")

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
    try:
        hwp.MovePos(3)
        act = hwp.CreateAction("PageHiding")
        st = act.CreateSet()
        act.GetDefault(st)
        applied = []
        for k in ("HideHeader", "HideFooter", "HidePageNum"):
            if _safe_has(st, k):
                st.SetItem(k, 1)
                applied.append(k)
        ok = act.Execute(st)
        log(f"  2) 감추기(PageHiding {','.join(applied) or '항목없음'}): "
            f"{'✓ Execute 성공' if ok else '✗ Execute 반환 False'}")
    except Exception as e:
        log(f"  2) ✗ 감추기 실패: {e}")

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
        hwp.Open(str(dst), "HWP", "forceopen:true")
        ctrls = {}
        c = hwp.HeadCtrl
        while c is not None:
            ctrls[c.CtrlID] = ctrls.get(c.CtrlID, 0) + 1
            c = c.Next
        hwp.MovePos(3)
        final = int(hwp.KeyIndicator()[3])
        log(f"  4) 저장·재열기 검증: 총 {final}쪽, "
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

    # 쓰기 검증 — 사본에서, 첫 파일 하나로만
    if picked:
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
