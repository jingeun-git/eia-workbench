/* 건축물대장 조회 모듈 (SYS-29 4단계)
 * 원본: 99.Tools/parcel_building_tool/parcel_engine.py (v1.1) — 로직 1:1 이식.
 * 원본과 다른 점 2가지(사유 명시):
 *  ① 필지 조회: req/wfs(GML·쿼드트리) → req/data(GeoJSON·페이징)
 *     — resources_index 실측 "req/wfs 오류 반환, req/data 사용" + CORS 없음.
 *       req/data는 JSONP(callback)를 지원해 브라우저에서 키만으로 동작(2026-07-20 실측).
 *  ② Excel: openpyxl → xlsx-js-style (서식 동일 재현: 헤더 1F4E79·줄무늬 EBF3FB)
 * 판정 의미는 동일: 필지 bbox × 사업지구 폴리곤 intersects (shared/geo.js, 15케이스 검증).
 */
import { bboxOfGeometry, boundsOfFeatures, bboxIntersectsGeometry, promoteClosedLines } from "../shared/geo.js";
import { keys } from "../shared/app.js";

const VWORLD_DATA = "https://api.vworld.kr/req/data";
const VWORLD_ADDR = "https://api.vworld.kr/req/address";
const BLDG_BASE   = "https://apis.data.go.kr/1613000/BldRgstHubService";
const PAGE_SIZE   = 1000;
const MAX_PAGES   = 30;      // 3만 필지 상한 — 초과 시 사용자에게 범위 축소 안내
// prj 미동봉 시 원본 엔진과 동일하게 EPSG:5186(TM중부) 가정
const EPSG5186 = "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── JSONP (vworld는 ACAO가 없어 fetch 불가 — callback 파라미터 실측 확인) ── */
let _jsonpSeq = 0;
function jsonp(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const cb = `__eiaw_cb${++_jsonpSeq}`;
    const s = document.createElement("script");
    const t = setTimeout(() => { cleanup(); reject(new Error("vworld 응답 시간 초과")); }, timeoutMs);
    function cleanup() { clearTimeout(t); delete window[cb]; s.remove(); }
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error("vworld 요청 실패 (네트워크)")); };
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
}

/* ── 필지 dict (엔진 _make_parcel 동일 — pnu 슬라이스) ─────────────── */
function makeParcel(pnu, addr, bbox) {
  pnu = (pnu || "").trim();
  if (pnu.length < 19) return null;
  return {
    pnu, addr,
    sigunguCd: pnu.slice(0, 5),
    bjdongCd:  pnu.slice(5, 10),
    bun:       pnu.slice(11, 15),
    ji:        pnu.slice(15, 19),
    bbox,
  };
}

/* ── vworld req/data — bbox 내 연속지적도 ──────────────────────────────
   ⚠ req/data BOX는 요청면적 10km² 상한이 있다(2026-07-20 실측 — 11.04km² 거부).
   상한 초과 bbox는 3km 격자 타일로 분할 조회 후 pnu로 중복 제거한다.
   (원본 엔진의 WFS 쿼드트리는 "1000건 상한" 대응이었고, 이쪽은 "면적 상한" 대응) */

function bboxKm([x0, y0, x1, y1]) {
  const midLat = ((y0 + y1) / 2) * Math.PI / 180;
  const kx = (x1 - x0) * 111.320 * Math.cos(midLat);
  const ky = (y1 - y0) * 110.574;
  return { kx, ky, area: kx * ky };
}

async function fetchTileInto(seen, bounds, vkey, log, checkCancel) {
  const geomFilter = `BOX(${bounds.join(",")})`;
  let page = 1, pageTotal = 1;
  do {
    checkCancel();
    const url = `${VWORLD_DATA}?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN` +
      `&key=${encodeURIComponent(vkey)}&format=json&crs=EPSG:4326` +
      `&geomFilter=${encodeURIComponent(geomFilter)}&size=${PAGE_SIZE}&page=${page}`;
    const j = await jsonp(url);
    const resp = j?.response || {};
    if (resp.status === "NOT_FOUND") return;   // 빈 타일(바다 등) — 정상
    if (resp.status !== "OK") {
      const err = resp?.error?.text || resp.status || "알 수 없는 오류";
      if (page === 1) throw new Error(`vworld 필지 조회 실패: ${err} — API 키·범위를 확인하세요`);
      return; // 뒤 페이지 이상은 수집분으로 진행
    }
    pageTotal = parseInt(resp.page?.total || "1", 10);
    for (const f of resp.result?.featureCollection?.features || []) {
      const p = makeParcel(f.properties?.pnu, f.properties?.addr, bboxOfGeometry(f.geometry));
      if (p) seen.set(p.pnu, p);
    }
    if (page >= MAX_PAGES) {
      log(`⚠ 타일당 ${MAX_PAGES * PAGE_SIZE}건 상한 도달 — 일부 필지가 누락될 수 있습니다`, "warn");
      return;
    }
    page++;
    await sleep(120);
  } while (page <= pageTotal);
}

async function fetchParcelsInBox(bounds, vkey, log, checkCancel) {
  const seen = new Map();
  const { kx, ky, area } = bboxKm(bounds);

  if (area <= 9) {   // 10km² 상한에 여유 1km²
    await fetchTileInto(seen, bounds, vkey, log, checkCancel);
    return [...seen.values()];
  }

  const nx = Math.ceil(kx / 3), ny = Math.ceil(ky / 3);   // 3km 격자 ≈ 9km²/타일
  const tiles = nx * ny;
  if (tiles > 120)
    throw new Error(`범위가 너무 넓습니다 (약 ${area.toFixed(1)}km², 타일 ${tiles}개) — 사업지구를 나눠 실행하세요`);
  log(`  범위 약 ${area.toFixed(1)}km² → ${nx}×${ny} 타일 분할 조회 (vworld 면적 10km² 제한)`);

  const dx = (bounds[2] - bounds[0]) / nx, dy = (bounds[3] - bounds[1]) / ny;
  let t = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      t++;
      checkCancel();
      const tile = [
        bounds[0] + dx * i, bounds[1] + dy * j,
        bounds[0] + dx * (i + 1), bounds[1] + dy * (j + 1),
      ];
      await fetchTileInto(seen, tile, vkey, log, checkCancel);
      log(`  타일 ${t}/${tiles} — 누적 ${seen.size}필지`);
      await sleep(120);
    }
  }
  return [...seen.values()];
}

/* ── 지오코딩 (엔진 _geocode_to_parcel 동일: parcel 우선, road 폴백) ── */
async function geocodeToParcel(addr, vkey, log) {
  for (const type of ["parcel", "road"]) {
    try {
      const url = `${VWORLD_ADDR}?service=address&request=getcoord&version=2.0` +
        `&crs=EPSG:4326&type=${type}&address=${encodeURIComponent(addr)}` +
        `&format=json&key=${encodeURIComponent(vkey)}`;
      const j = await jsonp(url);
      const resp = j?.response || {};
      if (resp.status !== "OK") continue;

      const pnu = (resp.refined?.structure?.level4LC || "").trim();
      if (type === "parcel" && pnu.length >= 19) {
        const p = makeParcel(pnu, addr, [0, 0, 0, 0]);
        if (p) return p;
      }
      // 도로명: pnu 미보장 → 좌표 소형 BOX 조회로 pnu 확보 (엔진 _point_to_parcel)
      const pt = resp.result?.point;
      const lon = parseFloat(pt?.x), lat = parseFloat(pt?.y);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        const eps = 0.00005; // 약 5m
        const cand = await fetchParcelsInBox([lon - eps, lat - eps, lon + eps, lat + eps],
                                             vkey, () => {}, () => {});
        for (const p of cand) {
          const [bx0, by0, bx1, by1] = p.bbox;
          if (bx0 <= lon && lon <= bx1 && by0 <= lat && lat <= by1)
            return { ...p, addr: addr || p.addr };
        }
        if (cand.length) return { ...cand[0], addr: addr || cand[0].addr };
      }
    } catch (e) {
      log(`  지오코딩 오류(${type}) '${addr}': ${e.message}`, "warn");
    }
  }
  return null;
}

/* ── 건축물대장 API (fetch — ACAO:* 실측 확인, XML 응답) ────────────── */
function findText(el, tag) { return el?.querySelector(tag)?.textContent ?? ""; }

async function fetchXml(url) {
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  return new DOMParser().parseFromString(text, "text/xml");
}

/* getBrTitleInfo — 총괄표제부(regstrKindCd=1) 우선, 없으면 합산 (엔진 동일) */
async function getTitleInfo(encKey, sgg, bjd, bun, ji) {
  try {
    const q = `serviceKey=${encKey}&sigunguCd=${sgg}&bjdongCd=${bjd}` +
      `&bun=${String(parseInt(bun, 10)).padStart(4, "0")}&ji=${String(parseInt(ji, 10)).padStart(4, "0")}` +
      `&numOfRows=50&pageNo=1`;
    const doc = await fetchXml(`${BLDG_BASE}/getBrTitleInfo?${q}`);
    const items = [...doc.querySelectorAll("item")];
    if (!items.length) return {};

    const recap = items.find((it) => findText(it, "regstrKindCd") === "1") || null;
    const head = recap || items[0];
    const purps = findText(head, "mainPurpsCdNm");
    const etc = findText(head, "etcPurps");
    const platPlc = findText(head, "platPlc");

    let totArea;
    if (recap) {
      totArea = parseFloat(findText(recap, "totDongTotArea") || findText(recap, "totArea") || 0) || 0;
    } else {
      totArea = items.reduce((s, it) => s + (parseFloat(findText(it, "totArea")) || 0), 0);
    }
    return {
      platPlc,
      mainPurps: etc || purps,     // etcPurps가 더 구체적(아파트 등) — 엔진 동일
      totArea: totArea > 0 ? totArea : null,
    };
  } catch { return {}; }
}

/* getBrWclfInfo — 오수처리방법 */
async function getWclfInfo(encKey, sgg, bjd, bun, ji) {
  try {
    const q = `serviceKey=${encKey}&sigunguCd=${sgg}&bjdongCd=${bjd}` +
      `&bun=${String(parseInt(bun, 10)).padStart(4, "0")}&ji=${String(parseInt(ji, 10)).padStart(4, "0")}` +
      `&numOfRows=5&pageNo=1`;
    const doc = await fetchXml(`${BLDG_BASE}/getBrWclfInfo?${q}`);
    const it = doc.querySelector("item");
    if (!it) return {};
    return {
      modeCdNm: findText(it, "modeCdNm").trim(),
      etcMode:  findText(it, "etcMode").trim(),
    };
  } catch { return {}; }
}

/* ── 필지 목록 → 건축물대장 결과 (엔진 _query_buildings 동일) ──────── */
async function queryBuildings(parcels, pkey, log, checkCancel, onProgress) {
  const encKey = encodeURIComponent(pkey);
  const results = [];
  const total = parcels.length;

  for (let i = 0; i < total; i++) {
    checkCancel();
    const parcel = parcels[i];

    if (parcel._failed) {
      results.push({ addr: parcel._input || "", mainPurps: "주소 조회 실패", totArea: null, sewage: "-" });
      onProgress(i + 1, total, parcel._input || "");
      continue;
    }

    const disp = parcel.addr || `${parcel.sigunguCd}-${parcel.bjdongCd} ${+parcel.bun}-${+parcel.ji}`;
    log(`  [${i + 1}/${total}] 건축물대장 조회: ${disp}`);
    onProgress(i + 1, total, disp);

    const title = await getTitleInfo(encKey, parcel.sigunguCd, parcel.bjdongCd, parcel.bun, parcel.ji);
    const wclf  = await getWclfInfo(encKey, parcel.sigunguCd, parcel.bjdongCd, parcel.bun, parcel.ji);

    const addr = title.platPlc || parcel.addr || `${+parcel.bun}-${+parcel.ji}`;
    let mode;
    if (wclf.modeCdNm) {
      mode = wclf.modeCdNm;
      if (wclf.etcMode && wclf.etcMode !== wclf.modeCdNm) mode += ` (${wclf.etcMode})`;
    } else if (title.mainPurps) {
      mode = "미기재 (공공하수도 연결 가능)";
    } else {
      mode = "-";
    }

    results.push({
      addr,
      mainPurps: title.mainPurps || "건물없음",
      totArea: title.totArea ?? null,
      sewage: mode,
    });
    await sleep(250);   // API rate limiting — 엔진 동일
  }
  log(`✅ 분석 완료: 총 ${results.length}개 필지`, "ok");
  return results;
}

/* ── SHP 읽기 + 좌표계 정규화 ──────────────────────────────────────────
   ⚠ shp.parseShp(buf, prj문자열)은 재투영을 하지 않는다(2026-07-20 실측 —
   prj를 줘도 미터 좌표 그대로). ZIP 경로(shp())만 내부 재투영한다.
   → 어느 경로든 읽은 뒤 bounds가 한국 위경도 범위가 아니면 proj4로 직접 변환.
   후보: SHP의 prj WKT → 5186(중부) → 5187(동부) → 5185(서부) → 5174(구 Bessel 중부)
   순으로 시도하고, 변환 결과가 한국 범위에 들어오는 첫 후보를 채택·로그 명시. */

const KOREA = ([x0, y0, x1, y1]) =>
  x0 >= 122 && x1 <= 134 && y0 >= 31 && y1 <= 41 && x1 >= x0 && y1 >= y0;

const CRS_CANDIDATES = [
  ["EPSG:5186 (TM중부)", EPSG5186],
  ["EPSG:5187 (TM동부)", "+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"],
  ["EPSG:5185 (TM서부)", "+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"],
  ["EPSG:5174 (구 Bessel 중부)", "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43"],
];

function txCoords(coords, fwd) {
  if (typeof coords[0] === "number") {
    const [X, Y] = fwd([coords[0], coords[1]]);
    coords[0] = X; coords[1] = Y;
    return;
  }
  for (const c of coords) txCoords(c, fwd);
}

function normalizeCrs(fc, prjText, log) {
  const feats = (fc.features || []).filter((f) => f.geometry);
  if (!feats.length) return fc;
  let b = boundsOfFeatures(feats);
  if (KOREA(b)) return fc;   // 이미 위경도

  const candidates = [...(prjText ? [["SHP 동봉 prj", prjText]] : []), ...CRS_CANDIDATES];
  for (const [label, def] of candidates) {
    try {
      const conv = proj4(def, "EPSG:4326");
      // bounds 모서리 2점으로 사전 판정 (전체 변환 전 가늠)
      const p0 = conv.forward([b[0], b[1]]), p1 = conv.forward([b[2], b[3]]);
      const test = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]),
                    Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
      if (!KOREA(test) || !test.every(Number.isFinite)) continue;
      for (const f of feats) txCoords(f.geometry.coordinates, conv.forward);
      log(`  좌표계 변환: ${label} → WGS84`);
      return fc;
    } catch (_) { /* 다음 후보 */ }
  }
  throw new Error("좌표계를 판별하지 못했습니다 — prj 파일을 함께 선택하거나 QGIS에서 EPSG:4326으로 변환 후 시도하세요");
}

async function readShpFiles(files, log) {
  const byExt = {};
  for (const f of files) {
    const ext = f.name.toLowerCase().split(".").pop();
    byExt[ext] = f;
  }

  let fc, prjText = null;
  if (byExt.zip) {
    log("  ZIP에서 SHP 세트 읽는 중…");
    let out = await shp(await byExt.zip.arrayBuffer());
    if (Array.isArray(out)) {   // 다중 레이어 zip → 피처 병합
      fc = { type: "FeatureCollection", features: out.flatMap((o) => o.features || []) };
    } else fc = out;
  } else {
    if (!byExt.shp) throw new Error(".shp 파일이 없습니다 — shp·dbf(·prj) 또는 zip을 선택하세요");
    if (byExt.prj) prjText = await byExt.prj.text();
    else log("  ※ prj 미제공 → 좌표 범위로 좌표계 자동 판별", "warn");
    const geoms = shp.parseShp(await byExt.shp.arrayBuffer());   // 원좌표 그대로
    let props = null;
    if (byExt.dbf) {
      const cpg = byExt.cpg ? await byExt.cpg.text() : undefined;
      props = shp.parseDbf(await byExt.dbf.arrayBuffer(), cpg);
    }
    fc = {
      type: "FeatureCollection",
      features: geoms.map((g, i) => ({ type: "Feature", geometry: g, properties: props ? props[i] : {} })),
    };
  }
  return normalizeCrs(fc, prjText, log);
}

/* ── Excel 입출력 ──────────────────────────────────────────────────── */
const HEADER_HINTS = ["주소", "지번", "소재지", "address", "addr", "번지", "필지"];

function readAddressesFromExcel(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" })
    .map((r) => String(r[0] ?? "").trim());
  if (rows.length && HEADER_HINTS.some((h) => rows[0].toLowerCase().includes(h)))
    rows.shift();
  return rows.filter(Boolean);
}

/* openpyxl 서식 재현: 헤더 남색(1F4E79)+흰 볼드, 줄무늬 EBF3FB, 얇은 테두리 */
function saveExcel(results) {
  const thin = { style: "thin", color: { rgb: "000000" } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  const hdrS = {
    fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } },
    font: { name: "맑은 고딕", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border,
  };
  const bodyS = (fill, left) => ({
    font: { name: "맑은 고딕", sz: 10 },
    alignment: { horizontal: left ? "left" : "center", vertical: "center", wrapText: true },
    border,
    ...(fill ? { fill: { patternType: "solid", fgColor: { rgb: "EBF3FB" } } } : {}),
  });

  const ws = {};
  const headers = ["지번주소", "주용도", "연면적(㎡)", "오수처리방법"];
  headers.forEach((h, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: h, t: "s", s: hdrS };
  });
  results.forEach((row, i) => {
    const r = i + 1;
    const zebra = (r + 1) % 2 === 0;   // openpyxl은 r_idx(2부터) 짝수 행 음영
    ws[XLSX.utils.encode_cell({ r, c: 0 })] = { v: row.addr, t: "s", s: bodyS(zebra, true) };
    ws[XLSX.utils.encode_cell({ r, c: 1 })] = { v: row.mainPurps, t: "s", s: bodyS(zebra) };
    ws[XLSX.utils.encode_cell({ r, c: 2 })] = row.totArea != null
      ? { v: row.totArea, t: "n", z: "#,##0.00", s: bodyS(zebra) }
      : { v: "-", t: "s", s: bodyS(zebra) };
    ws[XLSX.utils.encode_cell({ r, c: 3 })] = { v: row.sewage, t: "s", s: bodyS(zebra) };
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: results.length, c: 3 } });
  ws["!cols"] = [{ wch: 45 }, { wch: 20 }, { wch: 14 }, { wch: 28 }];
  ws["!rows"] = [{ hpx: 22 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "편입지적 건축물대장");
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  XLSX.writeFile(wb, `편입지적건축물대장_${ymd}.xlsx`);
}

/* ── UI ────────────────────────────────────────────────────────────── */
export function init(section, { toast }) {
  section.innerHTML = `
  <div class="panel">
    <h2>편입지적 건축물대장 조회</h2>
    <p class="desc">사업지구 SHP 또는 주소 목록으로 필지별 건축물대장(주용도·연면적·오수처리방법)을 조회해 Excel로 저장합니다.
      API 키 2종은 우상단 ⚙ 설정에 입력하세요.</p>

    <div class="field">
      <div class="segment" role="group" aria-label="입력 방식">
        <button type="button" data-mode="shp" aria-pressed="true">사업지구 SHP</button>
        <button type="button" data-mode="addr" aria-pressed="false">주소 목록</button>
      </div>
    </div>

    <div data-pane="shp">
      <div class="field">
        <label>사업지구 경계 파일 <span class="req">*</span></label>
        <label class="dropzone" id="pc-drop">
          <input type="file" id="pc-files" multiple accept=".shp,.dbf,.prj,.cpg,.shx,.zip">
          <span id="pc-drop-msg">shp·dbf·prj 파일을 함께 선택하거나 ZIP을 끌어다 놓으세요</span>
        </label>
        <p class="help">prj가 없으면 EPSG:5186(TM중부)으로 간주합니다. 파일은 브라우저 안에서만 처리되며 업로드되지 않습니다.</p>
      </div>
    </div>

    <div data-pane="addr" style="display:none">
      <div class="field">
        <label for="pc-addrs">주소 목록 <span class="req">*</span> (한 줄에 하나)</label>
        <textarea id="pc-addrs" placeholder="경기도 시흥시 ○○동 123-4&#10;서울특별시 성동구 성수동1가 13-219" spellcheck="false"></textarea>
        <p class="help">지번·도로명 모두 가능. Excel(A열)로 불러오려면 → <button type="button" class="btn btn-secondary" id="pc-xlsx-btn" style="height:28px;padding:0 10px;font-size:12px">Excel 불러오기</button>
        <input type="file" id="pc-xlsx" accept=".xlsx,.xls" style="display:none"></p>
      </div>
    </div>

    <div style="display:flex;gap:var(--space-2);align-items:center">
      <button class="btn btn-primary" id="pc-run">조회 실행</button>
      <button class="btn btn-secondary" id="pc-reset">초기화</button>
      <button class="btn btn-danger" id="pc-cancel" style="display:none">중단</button>
    </div>

    <div class="progress-wrap" id="pc-prog">
      <div class="progress-head">
        <span class="stage" id="pc-stage">준비 중…</span>
        <span class="count" id="pc-count"></span>
      </div>
      <div class="progress-track"><div class="progress-fill" id="pc-fill"></div></div>
    </div>

    <div class="log" id="pc-log" aria-live="polite"></div>

    <div class="result-table-wrap" id="pc-tblwrap">
      <table class="result-table" id="pc-tbl">
        <thead><tr><th>지번주소</th><th>주용도</th><th>연면적(㎡)</th><th>오수처리방법</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div style="margin-top:var(--space-4);display:none" id="pc-savebar">
      <button class="btn btn-primary" id="pc-save">Excel 저장</button>
    </div>
  </div>`;

  const $ = (s) => section.querySelector(s);
  let mode = "shp";
  let cancelled = false;
  let running = false;
  let results = null;

  /* 모드 전환 */
  section.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      section.querySelectorAll("[data-mode]").forEach((x) =>
        x.setAttribute("aria-pressed", String(x === b)));
      section.querySelectorAll("[data-pane]").forEach((p) =>
        p.style.display = p.dataset.pane === mode ? "" : "none");
    }));

  /* 드롭존 */
  const drop = $("#pc-drop"), filesInput = $("#pc-files");
  const showFiles = () => {
    const n = filesInput.files.length;
    $("#pc-drop-msg").textContent = n
      ? `선택됨: ${[...filesInput.files].map((f) => f.name).join(", ")}`
      : "shp·dbf·prj 파일을 함께 선택하거나 ZIP을 끌어다 놓으세요";
    drop.classList.toggle("hasfile", n > 0);
  };
  filesInput.addEventListener("change", showFiles);
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { filesInput.files = e.dataTransfer.files; showFiles(); });

  /* Excel 주소 불러오기 */
  $("#pc-xlsx-btn").addEventListener("click", () => $("#pc-xlsx").click());
  $("#pc-xlsx").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const addrs = readAddressesFromExcel(await f.arrayBuffer());
      $("#pc-addrs").value = addrs.join("\n");
      toast(`주소 ${addrs.length}건을 불러왔습니다`, "ok");
    } catch (err) { toast(`Excel 읽기 실패: ${err.message}`, "fail"); }
    e.target.value = "";
  });

  /* 로그·진행률 헬퍼 */
  const logEl = $("#pc-log");
  const log = (msg, kind = "") => {
    const line = document.createElement("div");
    if (kind) line.className = kind;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };
  const prog = (stage, cur, total) => {
    $("#pc-stage").textContent = stage;
    if (total) {
      $("#pc-count").textContent = `${cur}/${total}`;
      $("#pc-fill").classList.remove("indeterminate");
      $("#pc-fill").style.width = `${(cur / total) * 100}%`;
    } else {
      $("#pc-count").textContent = "";
      $("#pc-fill").classList.add("indeterminate");
    }
  };
  const checkCancel = () => { if (cancelled) throw new Error("사용자 취소"); };

  /* 초기화 — 입력·진행·로그·결과 전부 비움 (실행 중에는 중단부터) */
  $("#pc-reset").addEventListener("click", () => {
    if (running) { toast("실행 중입니다 — 먼저 [중단]을 눌러주세요", "warn"); return; }
    filesInput.value = ""; showFiles();
    $("#pc-addrs").value = "";
    results = null;
    logEl.textContent = ""; logEl.classList.remove("active");
    $("#pc-prog").classList.remove("active");
    $("#pc-fill").style.width = "0%";
    $("#pc-tbl tbody").innerHTML = "";
    $("#pc-tblwrap").classList.remove("active");
    $("#pc-savebar").style.display = "none";
  });

  /* 실행 */
  $("#pc-cancel").addEventListener("click", () => { cancelled = true; });
  $("#pc-run").addEventListener("click", async () => {
    if (running) return;
    if (!keys.vworld || !keys.pubdata) {
      toast("⚙ 설정에서 vworld·공공데이터포털 API 키를 먼저 입력하세요", "fail");
      return;
    }
    running = true; cancelled = false; results = null;
    const runBtn = $("#pc-run");
    runBtn.disabled = true;
    runBtn.innerHTML = `<span class="spinner"></span> 조회 중…`;
    $("#pc-cancel").style.display = "";
    $("#pc-prog").classList.add("active");
    logEl.classList.add("active");
    logEl.textContent = "";
    $("#pc-tblwrap").classList.remove("active");
    $("#pc-savebar").style.display = "none";

    try {
      let parcels;
      if (mode === "shp") {
        if (!filesInput.files.length) throw new Error("사업지구 파일을 먼저 선택하세요");
        prog("SHP 읽는 중…");
        log("사업지구 SHP 파일 읽는 중...");
        const fc = await readShpFiles(filesInput.files, log);
        const feats = (fc.features || []).filter((f) => f.geometry);
        if (!feats.length) throw new Error("SHP에서 지오메트리를 읽지 못했습니다");

        // geometry 타입 실물 확인 + 닫힌 선 → 면 승격 (핵심교훈 #10:
        // "부지" SHP가 실제 LineString인 실무 사례 — 승격 없이는 내부 필지 전체 누락)
        const types = new Set();
        let promoted = 0;
        for (const f of feats) {
          const r = promoteClosedLines(f.geometry);
          if (r.promoted) { f.geometry = r.geometry; promoted++; }
          types.add(f.geometry.type);
        }
        log(`  피처 수: ${feats.length} (${[...types].join(", ")})`);
        if (promoted)
          log(`  ※ 닫힌 경계선 ${promoted}건을 면(Polygon)으로 승격 — 내부 필지 포함 판정`, "warn");
        if ([...types].some((t) => t.includes("LineString")))
          log(`  ⚠ 열린 선형 지오메트리 — 선과 교차하는 필지만 추출됩니다`, "warn");

        const b = boundsOfFeatures(feats);
        if (!Number.isFinite(b[0]) || !Number.isFinite(b[2]))
          throw new Error("경계 좌표를 계산하지 못했습니다 — SHP 좌표계를 확인하세요");
        // 버퍼: 5% 또는 0.002도(약 180m) — 엔진 동일
        const bufx = Math.max((b[2] - b[0]) * 0.05, 0.002);
        const bufy = Math.max((b[3] - b[1]) * 0.05, 0.002);
        prog("연속지적도 조회 중…");
        log("vworld 연속지적도 조회 중...");
        const raw = await fetchParcelsInBox(
          [b[0] - bufx, b[1] - bufy, b[2] + bufx, b[3] + bufy],
          keys.vworld, log, checkCancel);
        if (!raw.length) throw new Error("vworld에서 필지 정보를 가져오지 못했습니다 — API 키·네트워크를 확인하세요");
        log(`  수신: ${raw.length}개 필지`);

        prog("편입 필지 선별 중…");
        log("편입 필지 선별 중...");
        parcels = raw.filter((p) =>
          feats.some((f) => bboxIntersectsGeometry(p.bbox, f.geometry)));
        log(`  편입 대상: ${parcels.length}개 필지`);
        if (!parcels.length) { toast("편입 필지가 없습니다", "warn"); return; }
      } else {
        const addrs = $("#pc-addrs").value.split("\n").map((a) => a.trim()).filter(Boolean);
        if (!addrs.length) throw new Error("주소를 한 줄에 하나씩 입력하세요");
        log(`입력 주소 ${addrs.length}건 — 지오코딩 시작...`);
        parcels = [];
        for (let i = 0; i < addrs.length; i++) {
          checkCancel();
          prog("지오코딩 중…", i + 1, addrs.length);
          const p = await geocodeToParcel(addrs[i], keys.vworld, log);
          parcels.push(p || { _input: addrs[i], _failed: true });
          await sleep(100);
        }
        const ok = parcels.filter((p) => !p._failed).length;
        log(`  지오코딩 완료: 성공 ${ok} / 실패 ${parcels.length - ok}`);
      }

      results = await queryBuildings(parcels, keys.pubdata, log, checkCancel,
        (cur, total, disp) => prog(`건축물대장: ${disp}`, cur, total));

      /* 결과 테이블 (전건 표시) */
      const tb = $("#pc-tbl tbody");
      tb.innerHTML = "";
      for (const r of results) {
        const tr = document.createElement("tr");
        const area = r.totArea != null
          ? r.totArea.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : "-";
        [[r.addr], [r.mainPurps], [area, "num"], [r.sewage]].forEach(([v, cls]) => {
          const td = document.createElement("td");
          if (cls) td.className = cls;
          td.textContent = v;
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      }
      $("#pc-tblwrap").classList.add("active");
      $("#pc-savebar").style.display = "";
      toast(`조회 완료 — ${results.length}건`, "ok");
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = "조회 실행";
      $("#pc-cancel").style.display = "none";
      $("#pc-fill").classList.remove("indeterminate");
    }
  });

  $("#pc-save").addEventListener("click", () => {
    if (!results?.length) return;
    try { saveExcel(results); }
    catch (e) { toast(`Excel 저장 실패: ${e.message}`, "fail"); }
  });
}
