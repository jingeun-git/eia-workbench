#!/usr/bin/env python3
"""번들 exe가 저장소 실행본과 **같은 기능을 하는지** 검증한다.

## 왜 필요한가

자립화의 유일한 합격 기준은 "번들 전후로 기능이 같다"이다. 그런데 번들에서만
깨지는 것들이 있고, 전부 조용히 깨진다 — 예외가 아니라 **기능이 비활성으로
표시**되거나 **특정 형식만 실패**하는 식이다. 2026-07-21 실측으로 확인된 것:

  · EIASS 탐지가 파일 경로 존재를 봐서 번들에서 항상 False
  · lite 빌드가 pandas를 제외해 Excel 변환이 통째로 사라짐
  · 참조 도구들이 함수 안에서 늦게 import해 PyInstaller가 놓침

이런 것은 "빌드 성공"으로는 드러나지 않는다. 그래서 **exe를 실제로 띄워
/ping의 기능 목록을 저장소 실행본과 대조**한다.

## 사용

    python verify_bundle.py dist/EIAWorkbenchBridge.exe
    python verify_bundle.py dist/EIAWorkbenchBridge-full.exe --expect-ocr

종료코드 0이면 통과. 불일치가 있으면 무엇이 다른지 출력하고 1을 돌려준다.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORTS = [8765, 8766, 8767, 8768, 8769, 8770]


def _ping_any() -> dict | None:
    for port in PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=2) as r:
                d = json.loads(r.read())
                if d.get("features") is not None:
                    return d
        except Exception:
            continue
    return None


def _launch_and_ping(cmd: list[str], label: str, wait: int = 40) -> dict | None:
    print(f"  {label} 기동 중…")
    try:
        proc = subprocess.Popen(cmd, cwd=str(HERE),
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except OSError as e:
        # Windows 응용 프로그램 제어 정책(WDAC·AppLocker·스마트 앱 제어)이
        # 서명 없는 exe의 **실행 자체**를 막는다. 2026-07-21 실제로 겪었고,
        # 그때는 원시 트레이스백만 떠서 무엇이 문제인지 알 수 없었다.
        # 이건 빌드 결함이 아니라 **그 PC에서 exe를 못 돌린다**는 뜻이다.
        print(f"  ✗ {label}을 실행할 수 없습니다 — {e}")
        print()
        print("  ── Windows가 이 exe의 실행을 막았습니다 ──")
        print("     서명되지 않은 프로그램이라 보안 정책에 걸린 것입니다.")
        print("     빌드가 잘못된 것이 아니라, 이 PC에서 실행이 금지된 상태입니다.")
        print()
        print("     확인 순서:")
        print("       1) 설정 → 개인 정보 및 보안 → Windows 보안 →")
        print("          앱 및 브라우저 컨트롤 → '스마트 앱 제어'가 켜져 있는지")
        print("       2) 회사 PC라면 IT 정책(WDAC·AppLocker)일 수 있습니다")
        print("       3) 이벤트 뷰어 → 응용 프로그램 및 서비스 로그 →")
        print("          Microsoft → Windows → CodeIntegrity → Operational")
        print()
        print("     ※ 빌드 직후에만 막히는 경우가 많습니다 — Defender/SmartScreen이")
        print("       처음 보는 서명 없는 파일을 클라우드 평판 조회 동안 잡아둡니다.")
        print("       **몇 분 뒤 이 명령만 다시 돌려보세요**(재빌드 불필요):")
        print("           python verify_bundle.py dist\\EIAWorkbenchBridge.exe")
        print("       파일이 바뀌면 평판도 새로 매겨지므로 빌드할 때마다 반복될 수 있습니다.")
        print()
        print("     그래도 계속 막히면 정책 차단입니다. 받는 PC에서도 막힐 가능성이")
        print("     높으니 exe 대신 Python + run_bridge.bat 배포를 검토하세요.")
        return None
    try:
        for _ in range(wait):
            time.sleep(1)
            info = _ping_any()
            if info:
                return info
            if proc.poll() is not None:      # 죽었으면 더 기다릴 이유가 없다
                err = (proc.stderr.read() or b"").decode("utf-8", "replace")
                print(f"  ✗ {label}이 종료됐습니다:\n{err[-800:]}")
                return None
        print(f"  ✗ {label}이 {wait}초 안에 응답하지 않았습니다")
        return None
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        time.sleep(1)                        # 포트 해제 대기


def main() -> int:
    ap = argparse.ArgumentParser(description="번들 exe 기능 동일성 검증")
    ap.add_argument("exe", help="빌드된 브리지 exe 경로")
    ap.add_argument("--expect-ocr", action="store_true",
                    help="full 빌드 — OCR이 켜져 있어야 통과")
    a = ap.parse_args()

    exe = Path(a.exe)
    if not exe.exists():
        print(f"✗ 파일이 없습니다: {exe}")
        return 1

    print("=" * 62)
    print("  번들 기능 동일성 검증 — 저장소 실행본 vs exe")
    print("=" * 62)

    src = _launch_and_ping([sys.executable, str(HERE / "bridge_server.py"),
                            "--no-browser"], "저장소 실행본")
    if not src:
        return 1
    bun = _launch_and_ping([str(exe), "--no-browser"], "번들 exe")
    if not bun:
        # 기능이 **다른** 것과 기능을 **확인하지 못한** 것은 다르다.
        # 뭉뚱그리면 사용자가 원인을 엉뚱한 데서 찾는다(2026-07-21).
        print()
        print("  ✗ 검증하지 못했습니다 — exe를 띄울 수 없어 대조 자체가 불가능했습니다.")
        print("    (기능이 달라서가 아닙니다. 위 사유를 먼저 해결해야 합니다.)")
        return 2

    sf, bf = src["features"], bun["features"]
    keys = sorted(set(sf) | set(bf))
    print(f"\n  {'기능':12}{'저장소':>8}{'번들':>8}   판정")
    fail = 0
    for k in keys:
        s, b = sf.get(k), bf.get(k)
        # OCR은 lite 빌드에서 의도적으로 빠지는 **유일한** 기능이다.
        # 그 외 기능이 번들에서 꺼지면 자립화 실패로 본다.
        expected_off = (k == "ocr" and not a.expect_ocr)
        ok = (s == b) or (expected_off and s and not b)
        note = "" if s == b else ("lite 의도된 제외" if expected_off else "✗ 불일치")
        print(f"  {k:12}{str(s):>8}{str(b):>8}   {'✓' if ok else '✗'} {note}")
        fail += (not ok)

    # ── 선택 의존 대조 ────────────────────────────────────────────────
    # features만 보면 놓치는 것들이다. 빠져도 기능이 꺼지지 않고 **조용히
    # 틀린 결과**가 나온다(pyproj 없으면 CSV 평면좌표 칸이 빈다).
    sd, bd = src.get("deps") or {}, bun.get("deps") or {}
    if sd or bd:
        print(f"\n  {'선택 의존':14}{'저장소':>8}{'번들':>8}   판정")
        for k in sorted(set(sd) | set(bd)):
            s_, b_ = sd.get(k), bd.get(k)
            lost = bool(s_) and not b_
            fail += lost
            note = "✗ 번들에서 누락" if lost else ("저장소에도 없음" if not s_ else "")
            print(f"  {k:14}{str(s_):>8}{str(b_):>8}   {'✗' if lost else '✓'} {note}")
        missing_both = [k for k in sd if not sd[k]]
        if missing_both:
            print(f"\n  ※ 빌드 PC에 없어 번들에도 들어가지 않은 것: {', '.join(missing_both)}")
            print("     기능이 꺼지는 게 아니라 결과가 조용히 달라집니다:")
            if "pyproj" in missing_both:
                print("       · pyproj      — 사진 좌표 CSV의 평면좌표 X·Y 칸이 빕니다")
            if "pillow_heif" in missing_both:
                print("       · pillow_heif — HEIC 사진을 읽지 못합니다(JPG는 정상)")
            print("     필요하면: pip install pyproj pillow-heif  후 재빌드")

    if src.get("bridge_version") != bun.get("bridge_version"):
        print(f"\n  ✗ 버전 불일치 — 저장소 {src.get('bridge_version')} / "
              f"번들 {bun.get('bridge_version')} (오래된 소스로 빌드했을 수 있습니다)")
        fail += 1

    print("\n" + ("  ✓ 기능 동일 — 자립화 전후 차이 없음" if not fail
                  else f"  ✗ {fail}건 불일치 — 배포하면 안 됩니다"))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
