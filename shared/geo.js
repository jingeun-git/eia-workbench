






function eachCoord(coords, cb) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number") { cb(coords[0], coords[1]); return; }
  for (const c of coords) eachCoord(c, cb);
}


export function bboxOfGeometry(geom) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  if (geom?.coordinates) eachCoord(geom.coordinates, (x, y) => {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  });
  return [minx, miny, maxx, maxy];
}







export function promoteClosedLines(geom) {
  const closed = (ring) => {
    if (!ring || ring.length < 4) return false;
    const [x0, y0] = ring[0], [x1, y1] = ring[ring.length - 1];
    return Math.abs(x0 - x1) < 1e-9 && Math.abs(y0 - y1) < 1e-9;
  };
  if (geom?.type === "LineString" && closed(geom.coordinates))
    return { promoted: true, geometry: { type: "Polygon", coordinates: [geom.coordinates] } };
  if (geom?.type === "MultiLineString" && geom.coordinates.length &&
      geom.coordinates.every(closed))
    return { promoted: true,
             geometry: { type: "MultiPolygon", coordinates: geom.coordinates.map((r) => [r]) } };
  return { promoted: false, geometry: geom };
}


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



function eachRing(geom, cb) {
  if (!geom) return;
  if (geom.type === "Polygon") geom.coordinates.forEach(cb);
  else if (geom.type === "MultiPolygon")
    geom.coordinates.forEach((poly) => poly.forEach(cb));
}


function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}


function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) &&
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}


function pointInPolygon(x, y, poly) {
  if (!pointInRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h++)
    if (pointInRing(x, y, poly[h])) return false;
  return true;
}


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






export function bboxIntersectsGeometry(bbox, geom) {
  const [x0, y0, x1, y1] = bbox;

  if (!(x1 >= x0 && y1 >= y0) || (x0 === 0 && y0 === 0 && x1 === 0 && y1 === 0))
    return false;

  const [gx0, gy0, gx1, gy1] = bboxOfGeometry(geom);
  if (x1 < gx0 || gx1 < x0 || y1 < gy0 || gy1 < y0) return false;


  if (geom.type === "Point" || geom.type === "MultiPoint") {
    let hit = false;
    eachCoord(geom.coordinates, (px, py) => {
      if (x0 <= px && px <= x1 && y0 <= py && py <= y1) hit = true;
    });
    return hit;
  }
  if (geom.type === "LineString" || geom.type === "MultiLineString") {
    const lines = geom.type === "LineString" ? [geom.coordinates] : geom.coordinates;
    const rectEdges = [
      [x0, y0, x1, y0], [x1, y0, x1, y1],
      [x1, y1, x0, y1], [x0, y1, x0, y0],
    ];
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const [px, py] = line[i];
        if (x0 <= px && px <= x1 && y0 <= py && py <= y1) return true;
        if (i > 0) {
          const [qx, qy] = line[i - 1];
          for (const [ex0, ey0, ex1, ey1] of rectEdges)
            if (segIntersects(px, py, qx, qy, ex0, ey0, ex1, ey1)) return true;
        }
      }
    }
    return false;
  }

  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const rectEdges = [
    [x0, y0, x1, y0], [x1, y0, x1, y1],
    [x1, y1, x0, y1], [x0, y1, x0, y0],
  ];

  for (const poly of polygonsOf(geom)) {

    for (const [cx, cy] of corners)
      if (pointInPolygon(cx, cy, poly)) return true;



    for (const [px, py] of poly[0])
      if (x0 <= px && px <= x1 && y0 <= py && py <= y1) return true;

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
