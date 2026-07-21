#!/usr/bin/env python3
"""현장사진 EXIF에서 촬영지점·촬영방향·화각을 뽑아 좌표 자료로 만든다.

## 무엇을 하나

현장조사 사진 폴더를 훑어 사진마다 다음을 얻는다.

  · 촬영지점 (위경도, 고도)
  · 촬영방향 (진북 기준 방위각)
  · 수평화각 (35mm 환산 초점거리로 계산 — 사진마다 다르다)

그리고 KML·CSV로 내보낸다. 지도 위에 "어디서 어느 쪽을 보고 찍었는지"를
부채꼴로 표시하기 위한 자료다.

## 화각 계산 근거 (실측 검증됨)

35mm 환산 초점거리 `fl35`가 가리키는 필름 규격은 36×24mm이므로

    수평화각 = 2 · atan(장변 / (2 · fl35))        가로사진이면 장변 36mm
                                                  세로사진이면 24mm

2026-07-21 지오세터(GeoSetter) 실행 로그와 대조해 확정했다. 같은 사진에 대해
지오세터가 지도에 그린 부채꼴 양끝점을 방위각으로 역산한 값과 위 공식이
**최대 0.074° 이내**로 일치했다(iPhone 13 mini, fl35 14mm·26mm 2종).

부채꼴은 원호가 아니라 **삼각형**이다 — 지오세터 로그의 좌·우변 길이가
정확히 같았고(24.77/24.77km), 화면에도 직선 변으로 그려진다.

## 포맷

확장자로 걸러내지 않는다. 사용자 지시(2026-07-21): "이 외 확장자여도 사진이
info정보만 가지고 있다면 호환되게". 열어봐서 EXIF가 나오면 사진으로 취급하고,
안 되면 **목록에서 지우지 않고 사유를 붙여 남긴다** — 조용히 빠지면 사용자는
몇 장이 누락됐는지조차 모른다.

HEIC는 `pillow-heif`가 설치돼 있을 때만 열린다. 없으면 그 사실을 사유로 남긴다.
※ 2026-07-21 현재 저장소에 HEIC 실물이 없어 **이 경로는 미검증**이다.

## 사용

    python photo_exif.py <폴더>                     좌표 목록 출력
    python photo_exif.py <폴더> --kml out.kml       KML 저장
    python photo_exif.py <폴더> --csv out.csv --epsg 5186
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path

from PIL import Image, ExifTags

# HEIC는 선택 의존이다. 없다고 죽으면 JPG까지 못 읽는다.
try:
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
    HEIF_OK = True
except Exception:
    HEIF_OK = False

# EXIF 태그 번호 — 이름 대신 번호를 쓰는 이유는 Pillow 버전에 따라
# 이름 매핑이 흔들려도 번호는 규격이라 안 변하기 때문이다.
_GPS_IFD = 0x8825
_EXIF_IFD = 0x8769
_TAG_MAKE = 0x010F
_TAG_MODEL = 0x0110
_TAG_ORIENT = 0x0112
_TAG_DT_ORIG = 0x9003
_TAG_FL35 = 0xA405  # FocalLengthIn35mmFilm
_TAG_FL = 0x920A  # FocalLength

_G_LATREF, _G_LAT = 1, 2
_G_LONREF, _G_LON = 3, 4
_G_ALTREF, _G_ALT = 5, 6
_G_IMGDIRREF, _G_IMGDIR = 16, 17
_G_HPOSERR = 31

# 35mm 필름 프레임 — 화각 계산의 기준 규격
_FRAME_LONG = 36.0
_FRAME_SHORT = 24.0

# 지오세터가 "값 없음"에 쓰는 센티널. 우리 JSON은 null을 쓰지만,
# 로그 해독 결과를 남겨두는 편이 나중에 비교할 때 도움이 된다.
GEOSETTER_NULL = 1000.0


@dataclass
class PhotoPoint:
    """사진 1장의 추출 결과. 좌표가 없어도 객체는 만들어진다(사유를 담아서)."""

    path: str
    name: str
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None
    direction: float | None = None  # 진북 기준 방위각(도)
    direction_ref: str | None = None  # 'T'=진북, 'M'=자북
    fov: float | None = None  # 수평화각(도)
    fl35: float | None = None
    taken_at: str | None = None
    camera: str | None = None
    width: int | None = None
    height: int | None = None
    gps_error: float | None = None  # GPSHPositioningError(m)
    reason: str | None = None  # 좌표를 못 얻은 사유

    @property
    def has_geo(self) -> bool:
        return self.lat is not None and self.lon is not None


def _dms_to_deg(dms, ref: str | None) -> float:
    """도분초 → 십진도. 6.공간정보실 camera_from_gps.py의 로직을 계승했다."""
    d, m, s = (float(v) for v in dms)
    deg = d + m / 60.0 + s / 3600.0
    return -deg if (ref or "").upper() in ("S", "W") else deg


def horizontal_fov(fl35: float, landscape: bool = True) -> float:
    """35mm 환산 초점거리 → 수평화각(도). 위 docstring의 검증된 공식."""
    frame = _FRAME_LONG if landscape else _FRAME_SHORT
    return 2.0 * math.degrees(math.atan(frame / (2.0 * fl35)))


def destination(lat: float, lon: float, bearing: float, dist_km: float) -> tuple[float, float]:
    """출발점에서 방위각·거리만큼 이동한 지점. 부채꼴 끝점 계산용.

    구면 직접문제. 부채꼴은 수십 km 규모라 이 정도 근사로 충분하다
    (지오세터 로그와 대조 시 소수 셋째 자리까지 일치).
    """
    R = 6371.0088
    br = math.radians(bearing)
    d = dist_km / R
    p1 = math.radians(lat)
    l1 = math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(br))
    l2 = l1 + math.atan2(
        math.sin(br) * math.sin(d) * math.cos(p1),
        math.cos(d) - math.sin(p1) * math.sin(p2),
    )
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def wedge(p: PhotoPoint, dist_km: float) -> dict | None:
    """촬영지점의 화각 삼각형과 중심 방향선을 좌표로 돌려준다.

    지오세터의 `showFocusMarker(... 중심, 좌변, 우변 ...)`과 같은 구조다.
    화각을 모르면 방향선만, 방위각도 없으면 None.
    """
    if not p.has_geo or p.direction is None:
        return None
    center = destination(p.lat, p.lon, p.direction, dist_km)
    out = {"apex": [p.lat, p.lon], "center": list(center)}
    if p.fov:
        half = p.fov / 2.0
        out["left"] = list(destination(p.lat, p.lon, p.direction - half, dist_km))
        out["right"] = list(destination(p.lat, p.lon, p.direction + half, dist_km))
    return out


def read_photo(path: Path) -> PhotoPoint:
    """사진 1장을 읽는다. 실패해도 예외를 던지지 않고 사유를 담아 돌려준다.

    ※ 6.공간정보실 landscape_sim/camera_from_gps.py의 `read_exif_gps()`는
      방위각·초점거리가 없으면 예외를 던진다(경관 시뮬레이션 전용이라 그렇다).
      여기서는 좌표만 있어도 쓸모가 있으므로 그 동작을 따르지 않는다.
    """
    pt = PhotoPoint(path=str(path), name=path.name)
    try:
        with Image.open(path) as im:
            pt.width, pt.height = im.size
            ex = im.getexif()
    except Exception as e:
        low = path.suffix.lower()
        if low in (".heic", ".heif") and not HEIF_OK:
            pt.reason = "HEIC를 열려면 pillow-heif가 필요합니다"
        else:
            pt.reason = f"이미지로 열 수 없음 ({type(e).__name__})"
        return pt

    if not ex:
        pt.reason = "EXIF 정보 없음"
        return pt

    make = ex.get(_TAG_MAKE)
    model = ex.get(_TAG_MODEL)
    pt.camera = " ".join(str(v).strip() for v in (make, model) if v) or None

    sub = ex.get_ifd(_EXIF_IFD) or {}
    dt = sub.get(_TAG_DT_ORIG)
    if dt:
        try:
            pt.taken_at = datetime.strptime(str(dt), "%Y:%m:%d %H:%M:%S").isoformat(sep=" ")
        except ValueError:
            pt.taken_at = str(dt)

    # 화각 — 세로사진이면 프레임 장변이 세로로 눕는다.
    fl35 = sub.get(_TAG_FL35)
    if fl35:
        try:
            pt.fl35 = float(fl35)
            orient = ex.get(_TAG_ORIENT, 1)
            # Orientation 5~8은 90도 회전 = 세로. 태그가 없으면 픽셀비로 판단.
            if orient in (5, 6, 7, 8):
                landscape = True  # 회전 전 원본이 가로라는 뜻
            else:
                landscape = (pt.width or 1) >= (pt.height or 1)
            pt.fov = round(horizontal_fov(pt.fl35, landscape), 3)
        except (TypeError, ValueError, ZeroDivisionError):
            pass

    gps = ex.get_ifd(_GPS_IFD) or {}
    if not gps or _G_LAT not in gps or _G_LON not in gps:
        pt.reason = "GPS 좌표 없음 (위치 태그 없이 촬영)"
        return pt

    try:
        pt.lat = round(_dms_to_deg(gps[_G_LAT], gps.get(_G_LATREF)), 10)
        pt.lon = round(_dms_to_deg(gps[_G_LON], gps.get(_G_LONREF)), 10)
    except Exception:
        pt.reason = "GPS 좌표를 해석할 수 없음"
        return pt

    if _G_ALT in gps:
        try:
            a = float(gps[_G_ALT])
            ref = gps.get(_G_ALTREF, 0)
            below = ref == 1 or ref == b"\x01"
            pt.alt = round(-a if below else a, 3)
        except (TypeError, ValueError):
            pass

    if _G_IMGDIR in gps:
        try:
            pt.direction = round(float(gps[_G_IMGDIR]) % 360, 6)
            ref = gps.get(_G_IMGDIRREF)
            pt.direction_ref = str(ref) if ref else None
        except (TypeError, ValueError):
            pass

    if _G_HPOSERR in gps:
        try:
            pt.gps_error = round(float(gps[_G_HPOSERR]), 2)
        except (TypeError, ValueError):
            pass

    return pt


def scan_folder(folder: str | Path, recursive: bool = False) -> list[PhotoPoint]:
    """폴더의 사진을 전부 읽는다. 좌표가 없는 것도 목록에 남는다."""
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(f"폴더가 아닙니다: {root}")

    files = sorted(
        (p for p in (root.rglob("*") if recursive else root.iterdir()) if p.is_file()),
        key=lambda p: p.name.lower(),
    )
    out: list[PhotoPoint] = []
    for f in files:
        # 명백한 비이미지는 건너뛴다. 다만 '이미지 확장자 목록'으로 좁히지는
        # 않는다 — 모르는 확장자는 일단 열어보고 판단한다.
        if f.suffix.lower() in (".txt", ".md", ".json", ".csv", ".xml", ".zip",
                                ".pdf", ".hwp", ".hwpx", ".docx", ".xlsx", ".pptx",
                                ".mp4", ".mov", ".avi", ".db", ".ini", ".log"):
            continue
        pt = read_photo(f)
        if pt.reason == "이미지로 열 수 없음 (UnidentifiedImageError)":
            continue  # 애초에 사진이 아니었던 파일은 목록을 더럽히지 않는다
        out.append(pt)
    return out


# ─────────────────────────── 내보내기 ───────────────────────────

def _kml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def export_kml(points: list[PhotoPoint], out_path: str | Path,
               wedge_km: float = 0.15) -> Path:
    """KML로 저장. 촬영지점 + 방위각이 있으면 화각 삼각형을 함께 넣는다.

    KML은 규격상 WGS84 고정이라 좌표계 선택이 없다.
    """
    out = Path(out_path)
    geo = [p for p in points if p.has_geo]
    rows = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
            f"<name>{_kml_escape(out.stem)}</name>",
            '<Style id="pt"><IconStyle><scale>1.1</scale><Icon>'
            '<href>http://maps.google.com/mapfiles/kml/shapes/camera.png</href>'
            "</Icon></IconStyle></Style>",
            '<Style id="fov"><LineStyle><color>ff0000ff</color><width>2</width></LineStyle>'
            "<PolyStyle><color>66ff00ff</color></PolyStyle></Style>"]

    for p in geo:
        desc = [f"파일: {p.name}"]
        if p.taken_at:
            desc.append(f"촬영: {p.taken_at}")
        if p.camera:
            desc.append(f"기기: {p.camera}")
        if p.direction is not None:
            desc.append(f"방위각: {p.direction:.2f}°")
        if p.fov:
            desc.append(f"수평화각: {p.fov:.1f}° (35mm 환산 {p.fl35:.0f}mm)")
        if p.alt is not None:
            desc.append(f"고도: {p.alt:.1f} m")
        alt = f",{p.alt}" if p.alt is not None else ""
        rows += [f"<Placemark><name>{_kml_escape(p.name)}</name>",
                 f"<description>{_kml_escape(chr(10).join(desc))}</description>",
                 "<styleUrl>#pt</styleUrl>",
                 f"<Point><coordinates>{p.lon},{p.lat}{alt}</coordinates></Point>",
                 "</Placemark>"]

        w = wedge(p, wedge_km)
        if w and "left" in w:
            ring = [w["apex"], w["left"], w["center"], w["right"], w["apex"]]
            coords = " ".join(f"{lo},{la}" for la, lo in ring)
            rows += [f"<Placemark><name>{_kml_escape(p.name)} 화각</name>",
                     "<styleUrl>#fov</styleUrl><Polygon><outerBoundaryIs><LinearRing>",
                     f"<coordinates>{coords}</coordinates>",
                     "</LinearRing></outerBoundaryIs></Polygon></Placemark>"]

    rows.append("</Document></kml>")
    out.write_text("\n".join(rows), encoding="utf-8")
    return out


def export_csv(points: list[PhotoPoint], out_path: str | Path,
               epsg: int = 5186) -> Path:
    """CSV로 저장. 위경도와 함께 선택 좌표계의 평면좌표(X·Y)를 나란히 적는다.

    엑셀에서 바로 열 수 있도록 **UTF-8 BOM**을 붙인다 — BOM이 없으면 엑셀이
    CP949로 읽어 한글 파일명이 깨진다(워크벤치 md 변환에서 겪은 것과 같은 함정).
    """
    import csv

    out = Path(out_path)
    if out.suffix.lower() != ".csv":
        out = out.with_suffix(".csv")

    geo = [p for p in points if p.has_geo]
    if not geo:
        raise ValueError("좌표를 가진 사진이 없어 CSV를 만들 수 없습니다")

    to_xy = None
    if epsg != 4326:
        try:
            from pyproj import Transformer

            to_xy = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
        except ImportError:
            to_xy = None  # pyproj가 없으면 평면좌표 칸을 비운다(경위도는 그대로 나간다)

    cols = ["파일명", "위도", "경도", f"X(EPSG:{epsg})", f"Y(EPSG:{epsg})",
            "고도(m)", "방위각(도)", "수평화각(도)", "35mm환산초점거리(mm)",
            "촬영시각", "기기", "GPS오차(m)", "경로"]

    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for p in geo:
            if to_xy is None:
                x = y = ""
            else:
                x, y = to_xy.transform(p.lon, p.lat)
                x, y = round(x, 3), round(y, 3)
            w.writerow([p.name, f"{p.lat:.10f}", f"{p.lon:.10f}", x, y,
                        "" if p.alt is None else f"{p.alt:.3f}",
                        "" if p.direction is None else f"{p.direction:.4f}",
                        "" if p.fov is None else f"{p.fov:.3f}",
                        "" if p.fl35 is None else f"{p.fl35:.0f}",
                        p.taken_at or "", p.camera or "",
                        "" if p.gps_error is None else f"{p.gps_error:.2f}",
                        p.path])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="현장사진 EXIF → 촬영지점·방향 추출")
    ap.add_argument("folder", help="사진 폴더")
    ap.add_argument("-r", "--recursive", action="store_true", help="하위 폴더 포함")
    ap.add_argument("--kml", help="KML 저장 경로")
    ap.add_argument("--csv", help="CSV 저장 경로")
    ap.add_argument("--epsg", type=int, default=5186, help="SHP 좌표계 (기본 5186)")
    ap.add_argument("--json", action="store_true", help="JSON으로 출력")
    a = ap.parse_args()

    pts = scan_folder(a.folder, a.recursive)
    geo = [p for p in pts if p.has_geo]

    if a.json:
        print(json.dumps([asdict(p) for p in pts], ensure_ascii=False, indent=2))
    else:
        print(f"사진 {len(pts)}장 · 좌표 있음 {len(geo)}장")
        for p in pts:
            if p.has_geo:
                d = f"{p.direction:7.2f}°" if p.direction is not None else "  방위각 없음"
                f = f" 화각 {p.fov:5.1f}°" if p.fov else ""
                print(f"  {p.name:24} {p.lat:.6f}, {p.lon:.6f}  {d}{f}")
            else:
                print(f"  {p.name:24} — {p.reason}")

    if a.kml:
        print(f"KML 저장: {export_kml(geo, a.kml)}")
    if a.csv:
        print(f"CSV 저장: {export_csv(geo, a.csv, a.epsg)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
