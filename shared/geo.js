/* 기하 유틸 — parcel 모듈 전용 (SYS-29 4단계)
 * 원본 parcel_engine.py의 shapely `box(bbox).intersects(project_poly)` 판정을
 * 의존성 없이 재현한다. bbox 사각형 vs GeoJSON (Multi)Polygon 교차 판정.
 * turf(604KB)를 이 판정 하나 때문에 싣지 않기 위한 수제 구현 — node로 단위검증 필수.
 */

/** GeoJSON geometry의 [minx,miny,maxx,maxy] */
export function bboxOfGeometry(geom) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  eachRing(geom, (ring) => {
    for (const [x, y] of ring) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
  });
  return [minx, miny, maxx, maxy];
}

/** FeatureCollection 전체 bounds */
export function boundsOfFeatures(features) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const [x0, y0, x1, y1] = bboxOfGeometry(g);
    if (x0 < b[0]) b[0] = x0;
    if (y0 < b[1]) b[1] = y0;
    if (x1 > b[2]) b[2] = x1;
    if (y1 > b[3]) b[3] = y1;
  }
  return b;
}

/* (Multi)Polygon의 모든 링 순회. polygons[0]=외곽, [1..]=구멍 구조는
   polygonsOf()로 별도 취급한다. */
function eachRing(geom, cb) {
  if (!geom) return;
  if (geom.type === "Polygon") geom.coordinates.forEach(cb);
  else if (geom.type === "MultiPolygon")
    geom.coordinates.forEach((poly) => poly.forEach(cb));
}

/** (Multi)Polygon → 폴리곤 배열 [[outer, hole...], ...] */
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}

/** 점-링 내부 판정 (ray casting, 경계선상은 내부로 간주하지 않아도 무방) */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) &&
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 점이 폴리곤(구멍 포함) 내부인가 */
function pointInPolygon(x, y, poly) {
  if (!pointInRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h++)
    if (pointInRing(x, y, poly[h])) return false;
  return true;
}

/** 선분 교차 (properly or touching) */
function segIntersects(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
  return false;
}
function cross(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
function onSeg(ax, ay, bx, by, px, py) {
  return Math.min(ax, bx) <= px && px <= Math.max(ax, bx) &&
         Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

/**
 * bbox 사각형이 GeoJSON (Multi)Polygon과 교차하는가.
 * shapely box(...).intersects(poly)와 동일 의미(접촉 포함).
 */
export function bboxIntersectsGeometry(bbox, geom) {
  const [x0, y0, x1, y1] = bbox;
  // 퇴화 bbox(지오코딩 placeholder (0,0,0,0))는 교차 아님
  if (!(x1 >= x0 && y1 >= y0) || (x0 === 0 && y0 === 0 && x1 === 0 && y1 === 0))
    return false;

  const [gx0, gy0, gx1, gy1] = bboxOfGeometry(geom);
  if (x1 < gx0 || gx1 < x0 || y1 < gy0 || gy1 < y0) return false; // 빠른 배제

  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const rectEdges = [
    [x0, y0, x1, y0], [x1, y0, x1, y1],
    [x1, y1, x0, y1], [x0, y1, x0, y0],
  ];

  for (const poly of polygonsOf(geom)) {
    // ① bbox 꼭짓점이 폴리곤 내부
    for (const [cx, cy] of corners)
      if (pointInPolygon(cx, cy, poly)) return true;
    // ② 외곽 링 꼭짓점이 bbox 내부 — 꼭짓점은 폴리곤 경계의 일부이므로
    //    (shapely intersects는 경계 접촉 포함) 그 자체로 교차 성립.
    //    bbox가 구멍 안에 통째로 든 경우 외곽 꼭짓점은 bbox에 못 들어오므로 오탐 없음.
    for (const [px, py] of poly[0])
      if (x0 <= px && px <= x1 && y0 <= py && py <= y1) return true;
    // ③ 변 교차 (외곽+구멍 링 전부)
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [px, py] = ring[i], [qx, qy] = ring[j];
        for (const [ex0, ey0, ex1, ey1] of rectEdges)
          if (segIntersects(px, py, qx, qy, ex0, ey0, ex1, ey1)) return true;
      }
    }
  }
  return false;
}
