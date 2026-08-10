

"""."""




























import re
from pathlib import Path

EXTS = (".hwp", ".hwpx")







_CODE_RE = re.compile(r"(?<!\d)([01]\d{3})(?!\d)")
COVER_CHAPTER = "00"








HIDE_SPEC = "Header|Footer|MasterPage|Border|Fill|PageNumPos"


class Cancelled(Exception):
    """."""







def parse_code(name: str):
    """."""
    m = _CODE_RE.search(name)
    if not m:
        return None, None
    code = m.group(1)
    return code, code[:2]


def _div_mode(v) -> str:
    if v is True:  return "one"
    if v is False or v is None: return "none"
    return v if v in ("none", "one", "two") else "none"


def build_plan(files, include_divider=False, start_num: int = 1, a3_back: str = "skip",
               do_hide: bool = True, overrides: dict | None = None):
    """."""






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



            "do_hide": True,







            "override": (overrides or {}).get(f["name"]) or f.get("override") or {},
        })
        if chapter is not None:
            prev_chapter = chapter
    return plan


def assign_numbers(plan, start_num: int = 1, restart_per_chapter: bool = False):
    """."""













    cur = start_num
    first_body_seen = False
    out = []
    for f in plan:
        if f["skip"]:
            out.append({**f, "start": None, "end": None, "pages": [], "marks": [], "pad": 0})
            continue

        if f["is_chapter_head"]:
            ov_continue = bool((f.get("override") or {}).get("continue_chapter"))
            if restart_per_chapter and not ov_continue:



                cur = start_num
            elif not first_body_seen and (f.get("divider_mode") or "none") == "none":




                cur += 2
            first_body_seen = True


        if f["is_chapter_head"] and cur % 2 == 0:
            cur += 1

        _ov_start = (f.get("override") or {}).get("start")
        if isinstance(_ov_start, int) and _ov_start > 0:
            cur = _ov_start

        total = f.get("phys_pages") or 0
        a3set = set(f.get("a3_pages") or [])







        a3_back = f.get("a3_back", "skip")


        ov = f.get("override") or {}
        mode = ov.get("divider_mode") or f.get("divider_mode")
        div_skip = 1 if (f.get("divider") and mode == "one") else 0
        pages = []
        n = cur
        blank_backs = []
        force_odd = []
        phys = 1
        while phys <= total:
            if div_skip and phys == 2:
                n += 1
                force_odd.append(phys)

            if phys in a3set:

                if n % 2 == 0:
                    n += 1
                    if phys not in force_odd:
                        force_odd.append(phys)
                pages.append((phys, n, True))

                if a3_back == "blank" and (phys + 1) in a3set:



                    n += 1
                    pages.append((phys + 1, n, False))
                    blank_backs.append(phys + 1)
                    n += 1
                    phys += 2
                    continue
                n += 2
                phys += 1
                continue

            pages.append((phys, n, False))
            n += 1
            phys += 1








        a3_bad = []
        if a3_back == "blank":
            _blank = set(blank_backs)
            for ph in sorted(a3set):
                if ph in _blank:
                    continue
                nxt = ph + 1
                if nxt <= total and nxt not in _blank:
                    a3_bad.append(ph)




        marks = [(1, pages[0][1])] if pages else []

        end = (pages[-1][1] if pages else cur - 1)



        tail_a3 = bool(pages and pages[-1][2])







        pad = 0




        expect = set()
        if f.get("divider"):


            expect |= {1, 2} if f.get("divider_mode") == "two" else {1}
        if pad:
            expect.add(total + 1)
        stray = [h for h in (f.get("hide_pages") or []) if h and h not in expect]


        targets = []
        if f.get("divider"):
            targets.append(1)
            if f.get("divider_mode") == "two":
                targets.append(2)
        targets += blank_backs
        targets = sorted(set(targets))




        if targets:
            visible = [p for p in pages if p[0] not in targets]
            marks = [(visible[0][0], visible[0][1])] if visible else []
            force_odd = [p for p in force_odd if p not in targets]





        _marked = {p for p, _ in marks}
        force_odd = [p for p in force_odd if p not in _marked]





        mismatch = None





        actual_gap = f.get("gap_count")
        if total and isinstance(actual_gap, int):
            expect_gap = 0
            if a3_back == "skip":


                a3_inside = [p for p, _, is_a3 in pages if is_a3 and p != total]
                expect_gap += len(a3_inside)
            if actual_gap != expect_gap:
                if actual_gap < expect_gap:
                    hint = ("이 파일은 A3 뒷면을 빈 페이지(물리 공백)로 둔 것으로 "
                            "보입니다 — 'A3 뒷면'을 '공백'으로 선택하세요")
                else:
                    hint = ("이 파일은 A3 뒷면을 결번(빈 페이지 없이 번호만 건너뜀)으로 "
                            "둔 것으로 보입니다 — 'A3 뒷면'을 '결번'으로 선택하세요")
                mismatch = (f"현재 설정과 파일의 A3 처리 방식이 다릅니다"
                            f"(본문 결번 {actual_gap}곳). {hint}. "
                            f"그대로 진행하면 쪽번호가 밀릴 수 있습니다")

        out.append({**f, "start": (pages[0][1] if pages else cur),
                    "end": end, "pages": pages, "marks": marks, "pad": pad,
                    "expect_hide": sorted(expect), "stray_hide": stray,
                    "hide_targets": targets, "force_odd": force_odd,
                    "div_skip": div_skip, "a3_bad": a3_bad, "mismatch": mismatch})
        cur = end + 1 + (1 if tail_a3 else 0)
    return out






def _open(hwp, path: Path) -> bool:
    """."""
    fmt = "HWPX" if path.suffix.lower() == ".hwpx" else "HWP"
    for f in (fmt, None):
        try:
            ok = hwp.Open(str(path)) if f is None else hwp.Open(str(path), f, "forceopen:true")
            if ok is not False:
                return True
        except Exception:
            continue
    return False







_KI_PRNPAGE = 3


def _end_page(hwp) -> int:
    hwp.MovePos(3)
    return int(hwp.KeyIndicator()[_KI_PRNPAGE])


def _page_map(hwp, total: int, log=lambda *_: None):
    """."""









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




    return out


def _hidden_pages(hwp, log=lambda *_: None):
    """."""




    pages, c = [], hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "pghd":
            try:
                hwp.SetPosBySet(c.GetAnchorPos(0))
                pages.append(int(hwp.KeyIndicator()[_KI_PRNPAGE]))
            except Exception as e:
                log(f"    ⚠ 감추기 위치 특정 실패: {type(e).__name__} {e}")
                pages.append(0)
        c = c.Next
    return sorted(set(pages))


def _phys_pages(hwp):
    try:
        return int(hwp.PageCount) or None
    except Exception:
        return None


def _a3_pages(hwp, total: int):
    """."""
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


def _hwp_process_helpers():
    """."""





    import sys
    try:
        sys.path.insert(0, str(next(p for p in Path(__file__).resolve().parents
                                    if (p / "CLAUDE_folder.md").exists())))
        from claude_paths import resolve as _resolve
        sys.path.insert(0, str(_resolve("hwp2pdf_core").parent))
        from hwp2pdf_core import hwp_pids, kill_pids
        return hwp_pids, kill_pids
    except Exception:
        return (lambda: set()), (lambda pids: None)


def scan_folder(folder, log=lambda *_: None, progress=lambda *_: None,
                should_cancel=None):
    """."""




    import win32com.client as win32
    _cancelled = lambda: bool(should_cancel and should_cancel())
    folder = Path(folder)
    files = sorted(p for p in folder.iterdir()
                   if p.suffix.lower() in EXTS and not p.name.startswith("~"))
    if not files:
        raise RuntimeError("대상 .hwp/.hwpx 파일이 없습니다")



    _hwp_pids, _kill_pids = _hwp_process_helpers()
    _pids_before = _hwp_pids()


    hwp = None
    out = []
    try:
        hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
        for i, p in enumerate(files, 1):



            if _cancelled():
                raise Cancelled(f"스캔 취소 — {i - 1}/{len(files)}개까지 읽고 중단")
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



            _n2p = {r["num"]: r["phys"] for r in pmap if r["num"] is not None}
            hides = sorted({_n2p.get(n, 0) for n in hides_num} - {0}) or \
                    ([0] if hides_num else [])
            nums = [r["num"] for r in pmap if r["num"] is not None]




            _hide_set = {h for h in hides if h}





            _lead = 0
            while _lead < len(pmap) and pmap[_lead]["phys"] in _hide_set:
                _lead += 1
            body = [r for r in pmap[_lead:] if r["num"] is not None]
            start = body[0]["num"] if body else (nums[0] if nums else None)


            gaps = [body[i + 1]["num"] for i in range(len(body) - 1)
                    if body[i + 1]["num"] - body[i]["num"] > 1]
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
        if hwp is not None:
            try:
                hwp.Quit()
            except Exception:
                pass




        _kill_pids(_hwp_pids() - _pids_before)
    return out










PAGENUM_CTRLS = ("nwno", "pgct")
PAGENUM_CTRLS_RISKY = ("pgnp",)


def _clear_pagenum(hwp, extra_clear: bool = False):
    """."""







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
    """."""

    act = hwp.HAction
    pset = hwp.HParameterSet.HAutoNum
    act.GetDefault("NewNumber", pset.HSet)
    pset.NumType = hwp.AutoNumType("Page")
    pset.NewNumber = int(num)
    return bool(act.Execute("NewNumber", pset.HSet))


def _pgct_pages(hwp, log=lambda *_: None):
    """."""




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
    """."""
    hwp.MovePos(2)
    for _ in range(max(0, phys - 1)):
        hwp.HAction.Run("MovePageDown")


def _hide_section_first_page(ctrl):
    """."""












    try:
        st = ctrl.Properties
        applied = []
        for k in ("HideHeader", "HideFooter", "HidePageNumPos"):
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
    """."""










    applied = []
    c = hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "secd":
            applied = _hide_section_first_page(c)
            break
        c = c.Next
    return (1 if applied else 0), applied


def _hide_page(hwp, phys: int):
    """."""













    _goto_page(hwp, phys)
    act = hwp.HAction
    pset = hwp.HParameterSet.HPageHiding
    act.GetDefault("PageHiding", pset.HSet)
    pset.Fields = hwp.Hiding(HIDE_SPEC)
    return bool(act.Execute("PageHiding", pset.HSet))


def _count_pgct(hwp):
    n, c = 0, hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "pgct":
            n += 1
        c = c.Next
    return n







_PGCT_CANDIDATES = ("PageOdd", "Odd", "AlwaysOdd", "OddPage", "PageAlwaysOdd")
_pgct_type = None


def _set_pgct(hwp, phys: int, log=lambda *_: None):
    """."""




    global _pgct_type
    for name in ((_pgct_type,) if _pgct_type else _PGCT_CANDIDATES):
        try:
            _goto_page(hwp, phys)
            before = _count_pgct(hwp)
            act = hwp.HAction
            pset = hwp.HParameterSet.HAutoNum
            act.GetDefault("NewNumber", pset.HSet)
            pset.NumType = hwp.AutoNumType(name)
            act.Execute("NewNumber", pset.HSet)
            if _count_pgct(hwp) > before:
                if _pgct_type != name:
                    _pgct_type = name
                    log(f'    · 쪽번호제어 상수 확인: AutoNumType("{name}")')
                return True
        except Exception:
            continue
    return False


def _count_hidden(hwp):
    """."""
    n, c = 0, hwp.HeadCtrl
    while c is not None:
        if c.CtrlID == "pghd":
            n += 1
        c = c.Next
    return n


def apply_plan(plan, log=lambda *_: None, progress=lambda *_: None,
               dry_run=False, extra_clear=False, do_hide=True, should_cancel=None):
    """."""











    import win32com.client as win32
    _cancelled = lambda: bool(should_cancel and should_cancel())
    targets = [f for f in plan if not f["skip"]]
    if not targets:
        raise RuntimeError("번호를 부여할 대상이 없습니다(00장만 있거나 코드 없는 파일뿐)")




    _hwp_pids, _kill_pids = _hwp_process_helpers()
    _pids_before = _hwp_pids()

    hwp = None
    ok = fail = 0
    cancelled = False
    try:
        hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
        for i, f in enumerate(targets, 1):
            if _cancelled():
                cancelled = True
                break
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




                _now = _phys_pages(hwp) or 0
                _planned = f.get("phys_pages") or 0
                if _now and _planned and _now != _planned:
                    log(f"    ⚠ 쪽수 불일치: 스캔 {_planned}쪽 → 현재 {_now}쪽. "
                        f"이미 적용된 파일일 수 있습니다 — 원본 사본으로 다시 스캔하세요")



                for phys, num in f["marks"]:
                    _goto_page(hwp, phys)
                    if not _set_number(hwp, num):
                        log(f"    ⚠ {phys}면 새 쪽번호({num}) 적용 실패")



                want = {ph: nm for ph, nm, _ in f["pages"]}
                got = {r["phys"]: r["num"] for r in _page_map(hwp, f.get("phys_pages") or 0)}
                bad = [(ph, want[ph], got.get(ph)) for ph in sorted(want)
                       if got.get(ph) != want[ph]]
                log(f"  {p.name}: 쪽번호 {f['start']}~{f['end']}"
                    + f" · 새 쪽번호 {len(f['marks'])}곳"
                    + ("" if not bad else
                       f" · ✗ 불일치 {len(bad)}쪽 → " +
                       ", ".join(f"{ph}면 기대{w}/실제{g}" for ph, w, g in bad[:5])))


                if f.get("force_odd"):
                    ok_p = [ph for ph in f["force_odd"] if _set_pgct(hwp, ph, log)]
                    miss = [ph for ph in f["force_odd"] if ph not in ok_p]


                    for ph in miss:
                        num = next((nm for p2, nm, _ in f["pages"] if p2 == ph), None)
                        if num is not None:
                            _goto_page(hwp, ph)
                            _set_number(hwp, num)
                    log(f"    · 홀수 강제 {len(f['force_odd'])}쪽"
                        + (f" · 쪽번호제어 {ok_p}" if ok_p else "")
                        + (f" · 새쪽번호 대체 {miss}" if miss else ""))

                if f.get("hide_targets"):
                    before = _count_hidden(hwp)
                    ok_pages, fail_pages = [], []
                    for ph in f["hide_targets"]:
                        n0 = _count_hidden(hwp)
                        _hide_page(hwp, ph)

                        (ok_pages if _count_hidden(hwp) > n0 else fail_pages).append(ph)
                    log(f"    · 감추기 {len(ok_pages)}/{len(f['hide_targets'])}쪽"
                        + (f" 적용 {ok_pages}" if ok_pages else "")
                        + (f" · ✗ 실패 {fail_pages}" if fail_pages else "")
                        + (f" (기존 {before}개)" if before else ""))

                if not dry_run:
                    hwp.Save()
                ok += 1
            except Exception as e:


                if _cancelled():
                    cancelled = True
                    break
                log(f"  ✗ {p.name}: {e}")
                fail += 1
            finally:
                try:
                    hwp.XHwpDocuments.Item(0).Close(isDirty=False)
                except Exception:
                    pass
        if not cancelled:
            progress(len(targets), len(targets), "완료")
    finally:
        if hwp is not None:
            try:
                hwp.Quit()
            except Exception:
                pass




        _kill_pids(_hwp_pids() - _pids_before)
    if cancelled:
        log(f"─── 사용자 취소 — 여기까지 {'미리보기' if dry_run else '적용'}됨: "
            f"성공 {ok} / 실패 {fail} (남은 {len(targets) - ok - fail}건은 원본 그대로)")
        return {"ok": ok, "fail": fail, "cancelled": True,
                "remaining": len(targets) - ok - fail}
    log(f"─── {'미리보기' if dry_run else '적용'} 완료: 성공 {ok} / 실패 {fail}")
    return {"ok": ok, "fail": fail}











def _cli(argv=None):
    import argparse



    ap = argparse.ArgumentParser(description="HWP 폴더 쪽번호 일괄 부여")
    ap.add_argument("mode", choices=["scan", "apply"])
    ap.add_argument("folder")
    ap.add_argument("--start", type=int, default=1, help="시작 쪽번호")
    ap.add_argument("--divider", choices=["none", "one", "two"], default="none",
                    help="장별 간지: 없음 / 1장(뒷면 공백 없음) / 2장(뒷면 공백 포함)")
    ap.add_argument("--a3-back", choices=["skip", "blank"], default="skip",
                    help="A3 뒷면: 결번 / 물리 공백 페이지 있음")
    ap.add_argument("--hide", action="store_true", help="간지·여백면 감추기")
    ap.add_argument("--apply", action="store_true",
                    help="실제로 원본을 수정한다(없으면 미리보기)")
    a = ap.parse_args(argv)

    log = lambda m: print(m, flush=True)
    files = scan_folder(a.folder, log=log)
    plan = assign_numbers(
        build_plan(files, include_divider=a.divider, a3_back=a.a3_back,
                   do_hide=a.hide),
        start_num=a.start,
    )

    print(f"\n{'파일':44}{'물리':>5}{'현재':>10}{'적용후':>10}  처리")
    for f in plan:
        if f.get("skip"):
            print(f"{f['name'][:42]:44}{f.get('phys_pages') or 0:>5}{'—':>10}{'번호 제외':>10}")
            continue
        cur = (f"{f.get('start_page')}~{f.get('end_page')}"
               if f.get("start_page") else "—")
        note = []
        if f.get("hide_targets") and a.hide: note.append(f"감추기 {f['hide_targets']}")
        if f.get("force_odd"): note.append(f"홀수강제 {f['force_odd']}")
        print(f"{f['name'][:42]:44}{f['phys_pages']:>5}{cur:>10}"
              f"{f['start']}~{f['end']:>4}  {' · '.join(note)}")

    if a.mode == "scan":
        print("\n(스캔만 수행 — 문서를 수정하지 않았습니다)")
        return 0
    if not a.apply:
        print("\n⚠ 미리보기입니다. 실제 적용하려면 --apply 를 붙이세요. "
              "원본을 직접 수정하므로 사본으로 먼저 시험하세요.")
        return 0
    r = apply_plan(plan, log=log, do_hide=a.hide)
    return 0 if r["fail"] == 0 else 1


if __name__ == "__main__":
    import sys as _sys
    _sys.exit(_cli())
