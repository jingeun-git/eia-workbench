/* geocode.js 검증 — 좌표계 정의와 좌표 파서 (SYS-36 ②③)
 *
 * ── 왜 이걸 반드시 검증하나 ──
 * proj4 정의가 틀리면 **예외가 나지 않는다**. 그냥 다른 위치의 좌표가 나온다.
 * 원점을 하나만 잘못 적어도 전국이 수백 km 어긋난 채 결과가 나오고, 화면에
 * 숫자가 그럴듯하게 채워지므로 눈으로는 못 잡는다.
 *
 * 그래서 **pyproj(PROJ 라이브러리)를 기준값으로 삼아 교차검증**한다.
 * 기준값은 tests/_crs_ref.json에 박아뒀고, 생성 방법은 그 파일 주석에 있다.
 * 두 독립 구현이 같은 답을 내면 정의가 맞다고 볼 수 있다.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); failures++; }
};

/* proj4는 vendor에 있는 것을 그대로 쓴다 — 배포되는 것과 같은 코드여야 한다 */
globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}), head: { appendChild() {} } };
const proj4src = readFileSync(join(HERE, "..", "vendor", "proj4.js"), "utf-8");
new Function("module", "exports", "window", proj4src)(
  { exports: {} }, {}, globalThis);
if (!globalThis.proj4) {
  const m = { exports: {} };
  new Function("module", "exports", proj4src)(m, m.exports);
  globalThis.proj4 = m.exports.default || m.exports;
}

const { toWgs84, fromWgs84, parseCoord, CRS_LIST } = await import("../shared/geocode.js");

const REF = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(join(HERE, "_crs_ref.json"), "utf-8")))
        .filter(([k]) => !k.startsWith("_")));   // _주석 등 메타 키 제외
const PTS = { "서울시청": [37.5665, 126.9780],
              "송호리": [34.560722, 126.479775],
              "울릉도": [37.4845, 130.9057] };

console.log("geocode.js — 좌표계 정의 (pyproj 교차검증)");

for (const [epsg, places] of Object.entries(REF)) {
  check(`EPSG:${epsg} — 경위도 → 평면좌표`, () => {
    for (const [name, want] of Object.entries(places)) {
      const [lat, lon] = PTS[name];
      const [x, y] = fromWgs84(lat, lon, +epsg);
      // 1m 이내면 같은 정의로 본다(부동소수 오차·PROJ 버전차 흡수)
      if (Math.abs(x - want[0]) > 1 || Math.abs(y - want[1]) > 1) {
        throw new Error(`${name}\n      기대(pyproj) ${want[0]}, ${want[1]}`
                      + `\n      실제(proj4)  ${x.toFixed(3)}, ${y.toFixed(3)}`);
      }
    }
  });
}

check("왕복 변환이 원점으로 돌아온다 (5186)", () => {
  for (const [name, [lat, lon]] of Object.entries(PTS)) {
    const [x, y] = fromWgs84(lat, lon, 5186);
    const [la2, lo2] = toWgs84(x, y, 5186);
    if (Math.abs(la2 - lat) > 1e-6 || Math.abs(lo2 - lon) > 1e-6)
      throw new Error(`${name} 왕복 오차: ${la2}, ${lo2}`);
  }
});

check("EPSG:4326은 변환 없이 그대로 통과한다", () => {
  const [lat, lon] = toWgs84(126.9780, 37.5665, 4326);
  if (lat !== 37.5665 || lon !== 126.9780) throw new Error(`${lat}, ${lon}`);
});

check("드롭다운 목록에 중복·누락이 없다", () => {
  const ids = CRS_LIST.map((c) => c.epsg);
  if (new Set(ids).size !== ids.length) throw new Error("중복 EPSG");
  for (const e of Object.keys(REF)) {
    if (!ids.includes(+e)) throw new Error(`목록에 EPSG:${e}가 없다`);
  }
});

console.log("\ngeocode.js — 좌표 문자열 파서");

const CASES = [
  ["37.5665", 37.5665],
  ["  126.978  ", 126.978],
  ["-33.5", -33.5],
  ["37.5665N", 37.5665],
  ["33.5S", -33.5],
  ["34°33'40.01\"N", 34.561114],
  ["126 28 12.77 E", 126.470214],
  ["34:33:40.01", 34.561114],
  ["", NaN],
  ["주소입니다", NaN],
];
for (const [input, want] of CASES) {
  check(`parseCoord(${JSON.stringify(input)})`, () => {
    const got = parseCoord(input);
    if (Number.isNaN(want)) {
      if (!Number.isNaN(got)) throw new Error(`NaN이어야 하는데 ${got}`);
      return;
    }
    if (Math.abs(got - want) > 1e-5) throw new Error(`기대 ${want}, 실제 ${got}`);
  });
}

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 전부 통과");
process.exit(failures ? 1 : 0);
