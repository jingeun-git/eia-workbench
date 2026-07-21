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

# 참조 도구의 위치를 여기에 적지 않는다 — 폴더가 재편돼도 빌드가 깨지지 않아야 한다
# (SYS-33). 리졸버를 못 찾는 환경에서는 종전 경로로 폴백한다.
def _find(name: str, fallback: Path) -> Path:
    try:
        sys.path.insert(0, str(next(q for q in HERE.parents
                                    if (q / "CLAUDE_folder.md").exists())))
        from claude_paths import resolve
        return resolve(name)
    except Exception:
        return fallback


# 번들에 포함할 참조 도구 — bridge_server.py가 import로 쓰는 것들
BUNDLE_SRC = [
    _find("convert_core",       TOOLS / "convert_to_md" / "convert_core.py"),
    _find("eiass_doc_resolver", TOOLS / "EIASS" / "eiass_doc_resolver.py"),
    _find("hwp2pdf_core",       TOOLS / "hwp2pdf" / "hwp2pdf_core.py"),
    _find("pdf2excel_core",     TOOLS / "pdf2excel" / "pdf2excel_core.py"),
]
# 쪽번호는 브리지 자체 엔진(hwp_pagenum.py)이 처리한다 — bridge/ 안에 있어 자동 포함된다.
# 구 `배포용/hwpPageNum2.1.exe` 동봉 특례는 SYS-31 재구현 완료로 폐지(2026-07-21,
# 그 도구는 Trash로 이동됨). 여기에 남겨두면 빌드가 없는 파일을 찾다 실패한다.
OPTIONAL_SRC = []

# lite = OCR만 뺀 빌드다. **기능이 줄어드는 제외는 넣지 않는다.**
#   ⚠ pandas를 빼면 excel_to_markdown()이 죽는다 — Excel 변환이 통째로 사라진다
#     (2026-07-21 실측: convert_core가 pd.ExcelFile을 쓴다). 자립화 전후로
#     기능이 달라지면 안 되므로 제외 목록에서 제거했다.
#   torch/torchvision은 easyocr의 의존이라 함께 빠지고, 나머지는 convert_core가
#   쓰지 않음을 실측으로 확인한 것들이다.
LITE_EXCLUDES = [
    "torch", "torchvision", "easyocr",          # OCR 계열 — lite의 유일한 축소 지점
    "scipy", "sklearn", "matplotlib",           # convert_core 미사용(실측)
    "geopandas", "shapely",                     # 〃
]


# 참조 도구가 런타임에 늦게 import하는 모듈 — 소스에서 실측해 뽑았다.
#   convert_core        : 문서 파싱·이미지·인코딩
#   eiass_doc_resolver  : HTML 파싱
#   hwp2pdf_core·hwp_pagenum : 한컴 COM
#   photo_exif          : 좌표 변환(CSV의 평면좌표)·HEIC 읽기
#     ⚠ pyproj는 export_csv() **함수 안에서** import한다. 정적 분석이 이런
#       지연 import를 놓치므로, 여기에 적지 않으면 번들에서 평면좌표 칸만
#       조용히 비어 나간다(2026-07-21).
_RUNTIME_DEPS = [
    "chardet", "pdfplumber", "fitz", "docx", "openpyxl", "pandas", "numpy", "PIL",
    "bs4", "requests",
    "pyproj", "pillow_heif",
    "win32com", "win32com.client", "pythoncom", "pywintypes", "win32print",
    # 트레이 상주 — 콘솔 창 없이 백그라운드로 돌리기 위한 것.
    # 없으면 콘솔 모드로 폴백하므로 빌드가 깨지지는 않는다.
    "pystray", "pystray._win32",
]
# OCR(full 빌드에서만) — lite에서는 LITE_EXCLUDES가 걷어낸다
_OCR_DEPS = ["easyocr", "pytesseract", "torch", "torchvision"]


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

    try:
        import pystray  # noqa
    except ImportError:
        print("✗ pystray 미설치 — 트레이 상주가 빠져 종료할 방법이 없는 exe가 됩니다.")
        print("  설치: pip install pystray pillow")
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
        # 콘솔 창을 띄우지 않는다 — 트레이에 상주한다(2026-07-21).
        # 트레이를 못 만들면 코드가 콘솔 모드로 떨어지지만, --noconsole 빌드에서는
        # 그 출력이 보이지 않으므로 로그는 파일로도 남긴다(아래 _log_to_file).
        "--onefile", "--noconsole",
        "--name", name,
        "--paths", str(stage),
        "--distpath", str(HERE / "dist"),
        "--workpath", str(HERE / "_build_work"),
        "--specpath", str(HERE / "_build_work"),
        # 참조 도구를 모듈로 포함
        "--hidden-import", "convert_core",
        "--hidden-import", "eiass_doc_resolver",
        "--hidden-import", "hwp2pdf_core",
        # 쪽번호 엔진은 bridge/ 안에 있어 --paths로 잡히지만, PyInstaller가
        # 동적 import를 놓치지 않도록 명시한다
        "--hidden-import", "hwp_pagenum",
        "--hidden-import", "pdf2excel_core",
    ]
    # ⚠ 참조 도구들은 **함수 안에서 늦게 import**한다(기동 속도 때문). PyInstaller의
    #   정적 분석은 이런 호출을 못 잡아 번들에서 ModuleNotFoundError로 죽는다 —
    #   자립화 전후 기능이 같아야 하므로 실측한 목록을 전부 명시한다(2026-07-21).
    for mod in _RUNTIME_DEPS:
        cmd += ["--hidden-import", mod]
    if full:
        for mod in _OCR_DEPS:
            cmd += ["--hidden-import", mod]
    else:
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
    print()
    print("  ※ 콘솔 창 없이 **트레이에 상주**합니다 — 종료는 트레이 메뉴에서.")
    print("     pystray 미설치 환경에서 빌드하면 트레이가 빠져 조용히 떠 있게 되므로,")
    print("     빌드 전 `pip install pystray pillow`를 확인하세요.")
    print()
    print("  ▶ 배포 전 반드시 기능 동일성을 확인하세요 — 빌드 성공은 합격이 아닙니다:")
    print(f"      python verify_bundle.py dist/{name}.exe"
          + ("  --expect-ocr" if full else ""))
    print("    번들에서만 조용히 꺼지는 기능이 있어(경로 기반 탐지·지연 import·lite 제외),")
    print("    저장소 실행본과 /ping 기능 목록을 대조합니다.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="브리지 자립 exe 빌드")
    ap.add_argument("--full", action="store_true", help="OCR(EasyOCR/torch) 포함 빌드")
    build(ap.parse_args().full)
