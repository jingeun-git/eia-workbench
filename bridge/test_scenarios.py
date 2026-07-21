#!/usr/bin/env python3
"""쪽번호 6개 시나리오 규칙 감사.

간지(없음·1장·2장) × A3 뒷면(결번·물리공백) = 6가지가 실무 시나리오 전부다.
감추기는 옵션이 아니라 상시 적용이므로 시나리오를 늘리지 않는다.

## 절대 조건 (2026-07-21 사용자 확정)

  R1  각 장은 홀수에서 시작한다. 앞 장이 홀수로 끝나면 그 뒷면 1면은 결번
  R2  동일 장 내 여러 파일은 연속 — 홀짝 강제 없음
  R3  간지 1장이면 뒷면 1면 결번, 본문은 홀수 시작
  R4  A3 내용면은 홀수에서 시작한다
  R5  **결번과 감추기는 다른 개념이다** — 결번은 물리 페이지가 없어 감출 대상이
      아니고, 감추기는 물리로 존재하는 면(간지·여백면)에만 건다
"""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("hp", Path(__file__).parent / "hwp_pagenum.py")
hp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hp)

# 장1(6쪽) · 장2 첫파일(10쪽, A3 포함) · 장2 둘째파일(4쪽) · 장3(3쪽)
#
# ⚠ A3 뒷면은 **같은 용지의 뒷면**이라 A4가 올 수 없다(2026-07-21 사용자 정정).
#   그래서 문서 자체가 모드에 따라 다르다 — 한 벌로 두 모드를 시험할 수 없다:
#     결번 방식  → A3는 5면 하나 (뒷면은 페이지가 아예 없음)
#     물리공백   → A3가 5·6면 두 장 (6면이 같은 규격의 여백면)
def fixture(a3_back):
    a3 = [5, 6] if a3_back == "blank" else [5]
    return [
        {"name": "0100 가.hwp", "phys_pages": 6,  "a3_pages": []},
        {"name": "0200 나.hwp", "phys_pages": 10, "a3_pages": a3},
        {"name": "0210 다.hwp", "phys_pages": 4,  "a3_pages": []},
        {"name": "0300 라.hwp", "phys_pages": 3,  "a3_pages": []},
    ]
SCENARIOS = [(d, a) for d in ("none", "one", "two") for a in ("skip", "blank")]
LBL = {"none": "간지 없음", "one": "간지 1장", "two": "간지 2장",
       "skip": "A3 결번", "blank": "A3 물리공백"}


def audit(plan, divider, a3_back):
    """규칙 위반을 문자열 목록으로 반환. 빈 목록이면 통과."""
    bad = []
    rows = [f for f in plan if not f.get("skip")]
    prev_end = None
    for f in rows:
        nums = [n for _, n, _ in f["pages"]]
        if not nums:
            continue

        if f["is_chapter_head"]:
            if nums[0] % 2 == 0:                                   # R1
                bad.append(f"R1 {f['name']}: 장 시작 {nums[0]}이 짝수")
            if prev_end is not None and prev_end % 2 == 1 and nums[0] != prev_end + 2:
                bad.append(f"R1 {f['name']}: 앞 장이 {prev_end}(홀수)로 끝났는데 "
                           f"{nums[0]}에서 시작(결번 1면이 아님)")
        elif prev_end is not None and nums[0] != prev_end + 1:      # R2
            bad.append(f"R2 {f['name']}: 같은 장 안인데 {prev_end}→{nums[0]}로 끊김")

        if divider == "one" and f["is_chapter_head"] and len(nums) > 1:
            if nums[1] != nums[0] + 2:                              # R3
                bad.append(f"R3 {f['name']}: 간지 {nums[0]} 다음 본문이 {nums[1]}"
                           f"(결번 1면이면 {nums[0] + 2})")

        blanks = set(f.get("hide_targets") or [])
        for phys, num, is_a3 in f["pages"]:
            if is_a3 and num % 2 == 0:                              # R4
                bad.append(f"R4 {f['name']}: A3 {phys}면이 짝수 {num}")

        # R5 — 감추기는 물리로 존재하는 면에만
        expect = set()
        if f.get("divider"):
            expect.add(1)
            if f.get("divider_mode") == "two":
                expect.add(2)
        if a3_back == "blank":
            # 여백면은 A3 내용면 바로 뒤의 **같은 규격** 쪽이다
            a3set = set(f.get("a3_pages") or [])
            for ph in sorted(a3set):
                if ph - 1 in a3set:
                    continue                 # 이미 앞 쪽의 여백면으로 잡힌 것
                if ph + 1 in a3set:
                    expect.add(ph + 1)
        if blanks != expect:
            bad.append(f"R5 {f['name']}: 감추기 {sorted(blanks)} ≠ 기대 {sorted(expect)}")

        prev_end = nums[-1]
    return bad


def main() -> int:
    fail = 0
    for i, (dv, a3) in enumerate(SCENARIOS, 1):
        plan = hp.assign_numbers(hp.build_plan(fixture(a3), include_divider=dv, a3_back=a3))
        bad = audit(plan, dv, a3)
        print(f"[{i}] {LBL[dv]} · {LBL[a3]}  " + ("✓ 통과" if not bad else f"✗ {len(bad)}건"))
        for f in plan:
            if f.get("skip"):
                continue
            nums = [n for _, n, _ in f["pages"]]
            head = "●" if f["is_chapter_head"] else " "
            print(f"     {head} {f['name'][:7]:9} {f['start']:>3}~{f['end']:<3} "
                  f"감추기{f['hide_targets']}  쪽={nums}")
        for b in bad:
            print(f"     ✗ {b}")
        fail += len(bad)
        print()
    print("=" * 66)
    print("  전 시나리오 통과" if not fail else f"  위반 {fail}건 — 수정 필요")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
