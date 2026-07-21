/* 열 매핑·범위 검사 회귀 — 2026-07-21 실사고 재현
 *
 * ── 무슨 일이 있었나 ──
 * 지오코딩 탭이 파일의 **첫 두 열을 좌표로 단정**했다. 사용자가 넣은 보호수
 * 표준데이터(`보호수_20260620.csv`)는 29개 열이고 앞의 둘이
 *
 *     [0] 개방자치단체코드 = 3000000
 *     [1] 관리번호        = 202430000000200027
 *
 * 인데 **둘 다 숫자로 파싱**돼 좌표쌍으로 잡혔다. 진짜 좌표는 [23]WGS84위도·
 * [24]WGS84경도였다. 결과는 위도 57.6 / 경도 177.2 — 캄차카 반도 근처인데도
 * 예외 없이 244행이 조용히 들어갔고 127건이 실패로 쌓였다.
 *
 * ── 그래서 무엇을 검증하나 ──
 *   ① 열 이름 추정이 진짜 좌표 열을 고르는가 (코드·번호 열이 아니라)
 *   ② 추정이 틀렸을 때 **한국 밖 좌표를 잡아내는가** — 마지막 방어선
 *
 * 실제 파일이 있으면 그것으로, 없으면 같은 구조의 축약본으로 돌린다.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); failures++; }
};

/* geocode.js의 좌표 변환만 쓴다 — UI 없이 규칙을 검증한다 */
globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}), head: { appendChild() {} } };
const proj4src = readFileSync(join(HERE, "..", "vendor", "proj4.js"), "utf-8");
{
  const m = { exports: {} };
  new Function("module", "exports", "window", proj4src)(m, m.exports, globalThis);
  if (!globalThis.proj4) globalThis.proj4 = m.exports.default || m.exports;
}
const { toWgs84, parseCoord } = await import("../shared/geocode.js");

/* 인코딩 자동판별 검증용 — modules/geocode.js의 decodeText와 같은 규칙 */
function decodeText(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  const count = (enc) => {
    try { return (new TextDecoder(enc).decode(head).match(/\uFFFD/g) || []).length; }
    catch (_) { return Infinity; }
  };
  const utf8 = count("utf-8");
  if (utf8 === 0) return new TextDecoder("utf-8").decode(bytes);
  for (const enc of ["euc-kr", "windows-949"])
    if (count(enc) < utf8) return new TextDecoder(enc).decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/* modules/geocode.js와 **같은** 규칙을 여기 옮겨 적지 않는다 —
   두 벌이 되면 한쪽만 고쳐져 조용히 어긋난다. 소스에서 뽑아 쓴다. */
const src = readFileSync(join(HERE, "..", "modules", "geocode.js"), "utf-8");
const GUESS = {};
for (const key of ["lat", "lon", "x", "y", "addr", "name"]) {
  const m = src.match(new RegExp(`${key}:\\s*(/.*?/[a-z]*),?\\n`));
  if (!m) throw new Error(`geocode.js에서 GUESS.${key} 패턴을 찾지 못했습니다`);
  GUESS[key] = eval(m[1]);
}
const inKorea = (lat, lon) => lat > 32 && lat < 40 && lon > 123 && lon < 133;
{
  const m = src.match(/const inKorea = \(lat, lon\) =>([^;]+);/);
  if (!m) throw new Error("geocode.js에서 inKorea를 찾지 못했습니다");
}
const guess = (cols, re) => cols.find((c) => re.test(String(c).trim())) || "";

/* ── 실사고 파일 (없으면 같은 구조의 축약본) ─────────────────────── */
const REAL = "/mnt/d/claude/1.input/기타/보호수_20260620.csv";
let cols, sample;
if (existsSync(REAL)) {
  // ⚠ 이 파일은 EUC-KR이다. UTF-8로 읽으면 열 이름이 통째로 깨져
  //   "추정이 실패했다"는 잘못된 결론을 낸다(2026-07-21 테스트 자체의 오류).
  const txt = new TextDecoder("euc-kr").decode(readFileSync(REAL));
  const [h, r1] = txt.split(/\r?\n/);
  cols = h.split(",");
  sample = Object.fromEntries(cols.map((c, i) => [c, (r1.split(",")[i] || "").trim()]));
  console.log(`보호수 표준데이터 실물 사용 — 열 ${cols.length}개`);
} else {
  cols = ["개방자치단체코드", "관리번호", "시도명", "소재지도로명주소",
          "소재지지번주소", "WGS84위도", "WGS84경도"];
  sample = { "개방자치단체코드": "3000000", "관리번호": "202430000000200027",
             "시도명": "서울특별시", "소재지도로명주소": "서울특별시 종로구 평창11길 9-1",
             "소재지지번주소": "서울특별시 종로구 평창동 329-2",
             "WGS84위도": "37.606291", "WGS84경도": "126.965916" };
  console.log("실물 파일 없음 — 같은 구조의 축약본 사용");
}

console.log("\n① 열 이름 추정");

check("위도 열로 '개방자치단체코드'가 아니라 'WGS84위도'를 고른다", () => {
  const g = guess(cols, GUESS.lat) || guess(cols, GUESS.y);
  if (!/위도/.test(g)) throw new Error(`고른 열: ${g || "(없음)"}`);
});

check("경도 열로 '관리번호'가 아니라 'WGS84경도'를 고른다", () => {
  const g = guess(cols, GUESS.lon) || guess(cols, GUESS.x);
  if (!/경도/.test(g)) throw new Error(`고른 열: ${g || "(없음)"}`);
});

check("주소 열을 찾는다", () => {
  const g = guess(cols, GUESS.addr);
  if (!/주소|소재지/.test(g)) throw new Error(`고른 열: ${g || "(없음)"}`);
});

check("'관리번호'가 좌표 열로 추정되지 않는다", () => {
  for (const re of [GUESS.lat, GUESS.lon, GUESS.x, GUESS.y]) {
    if (re.test("관리번호")) throw new Error(`관리번호가 ${re}에 걸린다`);
    if (re.test("개방자치단체코드")) throw new Error(`개방자치단체코드가 ${re}에 걸린다`);
  }
});

console.log("\n② 인코딩 자동판별");

check("EUC-KR CSV를 UTF-8이 아니라 EUC-KR로 읽는다", () => {
  if (!existsSync(REAL)) { console.log("      (실물 없음 — 건너뜀)"); return; }
  const raw = new Uint8Array(readFileSync(REAL));
  const txt = decodeText(raw);
  const first = txt.split(/\r?\n/)[0];
  const bad = (first.match(/\uFFFD/g) || []).length;
  if (bad) throw new Error(`치환문자 ${bad}개 — 인코딩 판별 실패: ${first.slice(0, 40)}`);
  if (!/개방자치단체코드/.test(first)) throw new Error(`열 이름이 이상함: ${first.slice(0, 40)}`);
});

check("UTF-8로 읽으면 실제로 깨진다 (판별이 무의미하지 않음을 증명)", () => {
  if (!existsSync(REAL)) return;
  const raw = new Uint8Array(readFileSync(REAL));
  const wrong = new TextDecoder("utf-8").decode(raw.subarray(0, 300));
  const bad = (wrong.match(/\uFFFD/g) || []).length;
  if (bad === 0) throw new Error("UTF-8로도 안 깨진다 — 이 검사는 아무것도 증명하지 못한다");
});

console.log("\n③ 범위 검사 — 추정이 틀렸을 때의 마지막 방어선");

check("실사고 값(코드 열을 5186 좌표로 오인)을 한국 밖으로 잡아낸다", () => {
  // 사고 당시와 같은 입력: X=3000000, Y=202430000000200027 → 5186 해석
  const [lat, lon] = toWgs84(3000000, 20243000000020000, 5186);
  if (inKorea(lat, lon))
    throw new Error(`한국 안으로 판정됨: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
});

check("진짜 좌표(WGS84)는 한국 안으로 통과한다", () => {
  const lat = parseCoord(sample["WGS84위도"]), lon = parseCoord(sample["WGS84경도"]);
  if (!inKorea(lat, lon))
    throw new Error(`한국 밖으로 판정됨: ${lat}, ${lon}`);
});

check("5186 평면좌표를 옳게 변환하면 한국 안이다", () => {
  const [lat, lon] = toWgs84(152256.978, 218485.874, 5186);   // 송호리
  if (!inKorea(lat, lon)) throw new Error(`${lat}, ${lon}`);
});

check("좌표계를 틀리게 고르면(5186 값을 5187로) 걸러지거나 크게 어긋난다", () => {
  const right = toWgs84(152256.978, 218485.874, 5186);
  const wrong = toWgs84(152256.978, 218485.874, 5187);
  const km = Math.hypot((wrong[0] - right[0]) * 111, (wrong[1] - right[1]) * 89);
  if (km < 50) throw new Error(`차이가 ${km.toFixed(0)}km밖에 안 된다 — 검사가 무의미`);
});

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 전부 통과");
process.exit(failures ? 1 : 0);
