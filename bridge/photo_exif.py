
"""."""










































from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path

from PIL import Image


try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_OK = True
except Exception:
    HEIF_OK = False



_GPS_IFD = 0x8825
_EXIF_IFD = 0x8769
_TAG_MAKE = 0x010F
_TAG_MODEL = 0x0110
_TAG_ORIENT = 0x0112
_TAG_DT_ORIG = 0x9003
_TAG_FL35 = 0xA405
_TAG_FL = 0x920A

_G_LATREF, _G_LAT = 1, 2
_G_LONREF, _G_LON = 3, 4
_G_ALTREF, _G_ALT = 5, 6
_G_IMGDIRREF, _G_IMGDIR = 16, 17
_G_HPOSERR = 31


_FRAME_LONG = 36.0
_FRAME_SHORT = 24.0



GEOSETTER_NULL = 1000.0


@dataclass
class PhotoPoint:
    """."""

    path: str
    name: str
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None
    direction: float | None = None
    direction_ref: str | None = None
    fov: float | None = None
    fl35: float | None = None
    taken_at: str | None = None
    camera: str | None = None
    width: int | None = None
    height: int | None = None
    gps_error: float | None = None
    reason: str | None = None

    @property
    def has_geo(self) -> bool:
        return self.lat is not None and self.lon is not None


def _dms_to_deg(dms, ref: str | None) -> float:
    """."""
    d, m, s = (float(v) for v in dms)
    deg = d + m / 60.0 + s / 3600.0
    return -deg if (ref or "").upper() in ("S", "W") else deg


def horizontal_fov(fl35: float, landscape: bool = True) -> float:
    """."""
    frame = _FRAME_LONG if landscape else _FRAME_SHORT
    return 2.0 * math.degrees(math.atan(frame / (2.0 * fl35)))


def destination(lat: float, lon: float, bearing: float, dist_km: float) -> tuple[float, float]:
    """."""




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
    """."""




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
    """."""





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


    fl35 = sub.get(_TAG_FL35)
    if fl35:
        try:
            pt.fl35 = float(fl35)
            orient = ex.get(_TAG_ORIENT, 1)

            if orient in (5, 6, 7, 8):
                landscape = True
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
    """."""
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(f"폴더가 아닙니다: {root}")

    files = sorted(
        (p for p in (root.rglob("*") if recursive else root.iterdir()) if p.is_file()),
        key=lambda p: p.name.lower(),
    )
    out: list[PhotoPoint] = []
    for f in files:


        if f.suffix.lower() in (".txt", ".md", ".json", ".csv", ".xml", ".zip",
                                ".pdf", ".hwp", ".hwpx", ".docx", ".xlsx", ".pptx",
                                ".mp4", ".mov", ".avi", ".db", ".ini", ".log"):
            continue
        pt = read_photo(f)
        if pt.reason == "이미지로 열 수 없음 (UnidentifiedImageError)":
            continue
        out.append(pt)
    return out




def _kml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def export_kml(points: list[PhotoPoint], out_path: str | Path,
               wedge_km: float = 0.15) -> Path:
    """."""



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
               epsg: int = 5186, on_warn=None) -> Path:
    """."""




    import csv

    out = Path(out_path)
    if out.suffix.lower() != ".csv":
        out = out.with_suffix(".csv")

    geo = [p for p in points if p.has_geo]
    if not geo:
        raise ValueError("좌표를 가진 사진이 없어 CSV를 만들 수 없습니다")

    to_xy = None
    area = None
    if epsg != 4326:
        try:
            from pyproj import CRS, Transformer

            to_xy = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)




            a = CRS.from_epsg(epsg).area_of_use
            if a:
                area = (a.west, a.south, a.east, a.north)
        except ImportError:
            to_xy = None

    cols = ["파일명", "위도", "경도", f"X(EPSG:{epsg})", f"Y(EPSG:{epsg})",
            "고도(m)", "방위각(도)", "수평화각(도)", "35mm환산초점거리(mm)",
            "촬영시각", "기기", "GPS오차(m)", "경로"]

    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        bad_range = 0
        for p in geo:
            if to_xy is None:
                x = y = ""
            elif area and not (area[0] <= p.lon <= area[2]
                               and area[1] <= p.lat <= area[3]):


                x = y = ""
                bad_range += 1
            else:
                x, y = to_xy.transform(p.lon, p.lat)
                if math.isfinite(x) and math.isfinite(y):
                    x, y = round(x, 3), round(y, 3)
                else:
                    x = y = ""
                    bad_range += 1
            w.writerow([p.name, f"{p.lat:.10f}", f"{p.lon:.10f}", x, y,
                        "" if p.alt is None else f"{p.alt:.3f}",
                        "" if p.direction is None else f"{p.direction:.4f}",
                        "" if p.fov is None else f"{p.fov:.3f}",
                        "" if p.fl35 is None else f"{p.fl35:.0f}",
                        p.taken_at or "", p.camera or "",
                        "" if p.gps_error is None else f"{p.gps_error:.2f}",
                        p.path])
    if bad_range and on_warn:
        rng = (f"(유효 경도 {area[0]}~{area[2]} · 위도 {area[1]}~{area[3]})"
               if area else "")
        on_warn(f"{bad_range}장은 EPSG:{epsg} 적용범위를 벗어나 평면좌표(X·Y) 칸을 "
                f"비웠습니다{rng} — 좌표계 선택을 확인하세요(경위도는 그대로 기록됨)")
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
