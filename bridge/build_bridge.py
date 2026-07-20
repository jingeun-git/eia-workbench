#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
브리지 자립 exe 빌드 (SYS-32 6단계) — **Windows에서 실행**

목적: URL만 공유받은 PC에서도 브리지 기능을 쓸 수 있게 한다.
현재 bridge_server.py는 D:\\Claude\\99.Tools\\ 트리를 참조하므로 그 트리가 없는 PC에서는
실행되지 않는다. PyInstaller로 참조 도구를 **번들**해 자립시킨다.

설계 원칙과의 관계:
  개발 시에는 계속 "참조"(복제 금지 — 원본 개선이 자동 반영)하고,
  배포 시에만 "번들"한다. 대신 **원본 도구를 고치면 재빌드가 필요**하다.

2종 빌드 (사용자 확정):
  lite : OCR 제외 — 일상 배포용 (torch 미포함)
  full : OCR 포함 — EasyOCR/torch 동봉 (1GB+)

사용법 (Windows, Python 3.10+):
    pip install pyinstaller
    python build_bridge.py           # lite (기본)
    python build_bridge.py --full    # full
결과: dist/EIAWorkbenchBridge[-full].exe
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent.parent            # 99.Tools/

# 번들에 포함할 참조 도구 — bridge_server.py가 import/subprocess로 쓰는 것들
BUNDLE_SRC = [
    TOOLS / "convert_to_md" / "convert_core.py",
    TOOLS / "EIASS" / "eiass_doc_resolver.py",
    TOOLS / "hwp2pdf" / "hwp2pdf_core.py",
]
# 쪽번호: .py는 `import intro`를 하는데 intro.py가 저장소에 없어 실행 불가(2026-07-20 실측).
# 자립형 exe를 데이터로 동봉한다. SYS-31 재구현이 끝나면 이 특례는 사라진다.
PAGE_EXE = TOOLS / "배포용" / "hwpPageNum2.1" / "hwpPageNum2.1.exe"
OPTIONAL_SRC = []

LITE_EXCLUDES = [
    "torch", "torchvision", "easyocr", "scipy", "sklearn",
    "matplotlib", "pandas", "geopandas", "shapely",
]


def check_env():
    if sys.platform != "win32":
        print("✗ Windows에서 실행해야 합니다 (한컴 COM·pywin32 번들 필요).")
        print("  WSL에서는 빌드할 수 없습니다.")
        sys.exit(1)
    try:
        import PyInstaller  # noqa
    except ImportError:
        print("✗ PyInstaller 미설치 — 설치: pip install pyinstaller")
        sys.exit(1)

    missing = [p for p in BUNDLE_SRC if not p.exists()]
    if missing:
        print("✗ 참조 도구를 찾지 못했습니다 — 경로를 확인하세요:")
        for m in missing:
            print(f"   {m}")
        sys.exit(1)


def stage_sources() -> Path:
    """번들 대상 .py를 임시 폴더에 모은다(원본은 건드리지 않는다)."""
    stage = HERE / "_build_stage"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    for p in BUNDLE_SRC + [q for q in OPTIONAL_SRC if q.exists()]:
        shutil.copy2(p, stage / p.name)
        print(f"  + {p.name}")
    return stage


def build(full: bool):
    check_env()
    print("=" * 62)
    print(f"  EIA Workbench 브리지 빌드 — {'full (OCR 포함)' if full else 'lite (OCR 제외)'}")
    print("=" * 62)
    print("  참조 도구 스테이징:")
    stage = stage_sources()

    name = "EIAWorkbenchBridge" + ("-full" if full else "")
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile", "--console",
        "--name", name,
        "--paths", str(stage),
        "--distpath", str(HERE / "dist"),
        "--workpath", str(HERE / "_build_work"),
        "--specpath", str(HERE / "_build_work"),
        # 참조 도구를 모듈로 포함
        "--hidden-import", "convert_core",
        "--hidden-import", "eiass_doc_resolver",
        "--hidden-import", "hwp2pdf_core",
    ]
    if PAGE_EXE.exists():
        cmd += ["--add-data", f"{PAGE_EXE};."]     # 쪽번호 자립 exe 동봉
    else:
        print("  ⚠ hwpPageNum2.1.exe 없음 — 쪽번호 기능은 비활성으로 빌드됩니다")
    if not full:
        for m in LITE_EXCLUDES:
            cmd += ["--exclude-module", m]
    cmd.append(str(HERE / "bridge_server.py"))

    print("\n  PyInstaller 실행…")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print("\n✗ 빌드 실패 — 위 오류를 확인하세요.")
        sys.exit(r.returncode)

    out = HERE / "dist" / f"{name}.exe"
    size = out.stat().st_size / 1024 / 1024 if out.exists() else 0
    print("\n" + "=" * 62)
    print(f"  ✓ 빌드 완료: {out}  ({size:.0f} MB)")
    print("=" * 62)
    print("  배포 방법:")
    print("   1) GitHub 저장소 → Releases → Draft a new release")
    print("   2) 위 exe를 자산(asset)으로 업로드")
    print("      ⚠ 저장소에 exe를 커밋하지 마세요(.gitignore로 차단돼 있습니다)")
    print("   3) 웹 UI 브리지 안내 모달의 다운로드 링크를 해당 Release URL로 갱신")
    print()
    print("  ※ 원본 도구(convert_core 등)를 수정하면 재빌드해야 반영됩니다.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="브리지 자립 exe 빌드")
    ap.add_argument("--full", action="store_true", help="OCR(EasyOCR/torch) 포함 빌드")
    build(ap.parse_args().full)
