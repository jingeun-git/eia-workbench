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
    proc = subprocess.Popen(cmd, cwd=str(HERE),
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
        return 1

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

    if src.get("bridge_version") != bun.get("bridge_version"):
        print(f"\n  ✗ 버전 불일치 — 저장소 {src.get('bridge_version')} / "
              f"번들 {bun.get('bridge_version')} (오래된 소스로 빌드했을 수 있습니다)")
        fail += 1

    print("\n" + ("  ✓ 기능 동일 — 자립화 전후 차이 없음" if not fail
                  else f"  ✗ {fail}건 불일치 — 배포하면 안 됩니다"))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
