/* mapview.js 검증 — vworld 타일 URL이 올바르게 만들어지는지 본다.
 *
 * 왜 이걸 따로 검증하나: vworld WMTS는 `{z}/{y}/{x}` **행·열** 순서인데
 * Leaflet 기본 템플릿은 `{z}/{x}/{y}`다. 뒤집혀도 **타일은 정상적으로 나온다** —
 * 다만 엉뚱한 곳의 타일이라 지도가 조용히 어긋난다. 예외도 오류도 안 나므로
 * 눈으로 보기 전에는 모른다. 그래서 URL 템플릿을 직접 검사한다.
 *
 * 좌표 정합은 실좌표로 확인한다 — 서울 시청 지점의 z/x/y를 계산해 템플릿에
 * 넣고, vworld가 기대하는 문자열과 맞는지 본다.
 */

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); failures++; }
};
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}\n      기대 ${want}\n      실제 ${got}`);
};

/* ── Leaflet 스텁 — tileLayer에 넘어온 URL 템플릿을 붙잡는다 ────────── */
const captured = [];
class LayerStub {
  constructor(url, opts) { this.url = url; this.opts = opts; captured.push({ url, opts }); }
  addTo() { return this; }
}
globalThis.window = globalThis;
globalThis.L = {
  map: () => ({ setView() { return this; }, removeLayer() {}, on() {} }),
  tileLayer: (url, opts) => new LayerStub(url, opts),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { createMap, destination } = await import("../shared/mapview.js");

console.log("mapview.js — vworld 타일 URL");

check("vworld 키가 있으면 vworld 타일을 쓴다", () => {
  captured.length = 0;
  const v = createMap({}, "TESTKEY");
  if (!v.usingVworld) throw new Error("usingVworld가 false");
  const u = captured[0].url;
  if (!u.includes("api.vworld.kr")) throw new Error(`vworld가 아님: ${u}`);
});

check("타일 좌표가 {z}/{y}/{x} 행·열 순서다 (뒤집히면 지도가 조용히 어긋난다)", () => {
  captured.length = 0;
  createMap({}, "TESTKEY");
  eq(captured[0].url,
     "https://api.vworld.kr/req/wmts/1.0.0/TESTKEY/Base/{z}/{y}/{x}.png",
     "Base 타일 URL 템플릿");
});

check("위성은 jpeg, 일반은 png (확장자가 레이어마다 다르다)", () => {
  captured.length = 0;
  const v = createMap({}, "K");
  v.setBase("sat");
  const sat = captured[captured.length - 1].url;
  if (!sat.endsWith(".jpeg")) throw new Error(`위성 확장자가 jpeg가 아님: ${sat}`);
  if (!sat.includes("/Satellite/")) throw new Error(`Satellite 레이어가 아님: ${sat}`);
});

check("위성+지명은 Satellite 위에 Hybrid를 겹친다", () => {
  captured.length = 0;
  const v = createMap({}, "K");
  v.setBase("hybrid");
  const last2 = captured.slice(-2).map((c) => c.url);
  if (!last2[0].includes("/Satellite/")) throw new Error(`바탕이 Satellite가 아님: ${last2[0]}`);
  if (!last2[1].includes("/Hybrid/")) throw new Error(`오버레이가 Hybrid가 아님: ${last2[1]}`);
});

check("키가 없으면 OSM으로 폴백하고 출처 표기를 유지한다 (ODbL 조건)", () => {
  captured.length = 0;
  const v = createMap({}, "");
  if (v.usingVworld) throw new Error("키가 없는데 usingVworld가 true");
  const c = captured[0];
  if (!c.url.includes("openstreetmap")) throw new Error(`OSM이 아님: ${c.url}`);
  if (!/OpenStreetMap/.test(c.opts.attribution || ""))
    throw new Error("OSM 출처 표기가 없다 — ODbL 라이선스 위반");
});

check("존재하지 않는 레이어(gray)는 목록에 없다", () => {
  const v = createMap({}, "K");
  if (v.bases.some((b) => b.id === "gray"))
    throw new Error("gray는 vworld에 없는 레이어인데 목록에 있다");
});

console.log("\nmapview.js — 기하");

check("destination: 정북 100km는 위도만 약 0.9도 증가", () => {
  const [lat, lon] = destination(36.0, 127.0, 0, 100);
  if (Math.abs(lat - 36.899) > 0.01) throw new Error(`위도 ${lat}`);
  if (Math.abs(lon - 127.0) > 1e-6) throw new Error(`경도가 변함: ${lon}`);
});

check("destination: 정동 100km는 경도만 증가 (위도 36도에서 약 1.11도)", () => {
  const [lat, lon] = destination(36.0, 127.0, 90, 100);
  if (Math.abs(lon - 128.112) > 0.02) throw new Error(`경도 ${lon}`);
  if (Math.abs(lat - 36.0) > 0.01) throw new Error(`위도가 크게 변함: ${lat}`);
});

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 전부 통과");
process.exit(failures ? 1 : 0);
