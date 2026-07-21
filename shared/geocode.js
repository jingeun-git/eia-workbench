/* vworld 지오코딩 래퍼 — 주소↔좌표 양방향 (SYS-36 ②)
 *
 * ── 왜 JSONP인가 ──
 * vworld는 Access-Control-Allow-Origin을 주지 않아 fetch가 통째로 막힌다.
 * 대신 `callback` 파라미터를 지원한다(2026-07-21 정·역방향 모두 실측 확인).
 * 덕분에 **브리지 없이 브라우저에서 바로** 쓸 수 있다 — 건축물대장 탭이
 * 이미 같은 방식을 쓴다(parcel.js).
 *
 * ── 실측으로 확인한 함정 2가지 ──
 *
 * ① 정방향은 type을 잘못 고르면 오류가 아니라 NOT_FOUND로 조용히 넘어간다.
 *      "서울특별시 중구 세종대로 110"  → ROAD 성공,  PARCEL NOT_FOUND
 *      "전라남도 해남군 황산면 옥동리 100" → ROAD 실패,  PARCEL 성공
 *    도로명·지번이 섞인 파일을 한쪽 기준으로만 돌리면 **절반이 빈칸**이 된다.
 *    그래서 한쪽이 실패하면 다른 쪽으로 자동 재시도한다.
 *
 * ② 역방향은 반드시 type=BOTH.
 *    사업지는 대개 산간·농지라 도로명주소가 없다. 실측에서 송호리 지점은
 *    BOTH가 "해남군 황산면 원호리 1056-8"을 주는데 ROAD 단독은 NOT_FOUND였다.
 */

const BASE = "https://api.vworld.kr/req/address";

let _seq = 0;

/** JSONP 호출. vworld 전용이므로 URL을 여기서만 만든다. */
function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cb = `__eiaw_geo${++_seq}`;
    const s = document.createElement("script");
    const t = setTimeout(() => { cleanup(); reject(new Error("vworld 응답 시간 초과")); },
                         timeoutMs);
    function cleanup() { clearTimeout(t); delete window[cb]; s.remove(); }
    window[cb] = (d) => { cleanup(); resolve(d); };
    s.onerror = () => { cleanup(); reject(new Error("vworld 요청 실패 (네트워크)")); };
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
}

function url(key, params) {
  const q = new URLSearchParams({
    service: "address", format: "json", crs: "epsg:4326", key, ...params,
  });
  return `${BASE}?${q}`;
}

/**
 * 주소 → 좌표. ROAD·PARCEL을 자동으로 오간다.
 * @returns {{ok:true, lat, lon, matched:'도로명'|'지번', refined:string}
 *          |{ok:false, reason:string}}
 */
export async function toCoord(key, address, { prefer = "auto" } = {}) {
  const addr = String(address || "").trim();
  if (!addr) return { ok: false, reason: "주소가 비어 있습니다" };

  // 도로명 표기가 보이면 ROAD를 먼저 — 헛호출을 한 번 줄인다.
  const looksRoad = /(로|길)\s*\d/.test(addr);
  const order = prefer === "road" ? ["ROAD"]
              : prefer === "parcel" ? ["PARCEL"]
              : looksRoad ? ["ROAD", "PARCEL"] : ["PARCEL", "ROAD"];

  let last = "조회 결과 없음";
  for (const type of order) {
    let d;
    try {
      d = await jsonp(url(key, { request: "getcoord", type, address: addr }));
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    const r = d?.response;
    if (r?.status === "OK" && r.result?.point) {
      return {
        ok: true,
        lat: parseFloat(r.result.point.y),
        lon: parseFloat(r.result.point.x),
        matched: type === "ROAD" ? "도로명" : "지번",
        refined: r.refined?.text || addr,
      };
    }
    last = r?.status === "NOT_FOUND" ? "일치하는 주소 없음"
         : r?.error?.text || r?.status || "조회 실패";
  }
  return { ok: false, reason: last };
}

/**
 * 좌표 → 주소. type=BOTH로 지번·도로명을 함께 받는다.
 * @returns {{ok:true, jibun:string, road:string}|{ok:false, reason:string}}
 */
export async function toAddress(key, lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) {
    return { ok: false, reason: "좌표가 올바르지 않습니다" };
  }
  let d;
  try {
    d = await jsonp(url(key, { request: "getAddress", type: "BOTH",
                              point: `${lon},${lat}` }));
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const r = d?.response;
  if (r?.status !== "OK" || !Array.isArray(r.result) || !r.result.length) {
    // 바다·비주소 지점은 정상적으로 NOT_FOUND가 난다 — 오류가 아니다.
    return { ok: false, reason: r?.status === "NOT_FOUND"
      ? "주소가 없는 지점입니다 (바다·미등록 구역)" : (r?.status || "조회 실패") };
  }
  const pick = (t) => r.result.find((x) => x.type === t)?.text || "";
  return { ok: true, jibun: pick("parcel"), road: pick("road") };
}

/** 한국에서 쓰이는 좌표계 — 드롭다운 목록(사용자 지시: 자동 추정하지 않는다).
 *  값만 보고 5186·5185·5187을 구분할 수 없고, 잘못 고르면 전국이 수백 km
 *  어긋난 채 결과가 나오기 때문에 반드시 사용자가 고른다. */
export const CRS_LIST = [
  { epsg: 4326, label: "EPSG:4326  WGS84 경위도", geographic: true },
  { epsg: 5186, label: "EPSG:5186  중부원점 (GRS80)" },
  { epsg: 5185, label: "EPSG:5185  서부원점 (GRS80)" },
  { epsg: 5187, label: "EPSG:5187  동부원점 (GRS80)" },
  { epsg: 5188, label: "EPSG:5188  동해원점 (GRS80)" },
  { epsg: 5179, label: "EPSG:5179  UTM-K (국토지리정보원)" },
  { epsg: 5174, label: "EPSG:5174  중부원점 (구 베셀)" },
  { epsg: 3857, label: "EPSG:3857  웹 메르카토르" },
];

/* proj4 정의 — vendor/proj4.js는 EPSG 코드를 기본 내장하지 않으므로
   쓰는 것만 등록한다. 정의가 틀리면 조용히 엉뚱한 좌표가 나오므로
   국토지리정보원 고시값을 그대로 적었다. */
const PROJ4_DEFS = {
  5186: "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs",
  5185: "+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs",
  5187: "+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs",
  5188: "+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs",
  5179: "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
  5174: "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43",
  3857: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs",
  4326: "+proj=longlat +datum=WGS84 +no_defs",
};

let _registered = false;
function ensureDefs() {
  if (_registered || !window.proj4) return;
  for (const [epsg, def] of Object.entries(PROJ4_DEFS)) {
    window.proj4.defs(`EPSG:${epsg}`, def);
  }
  _registered = true;
}

/** 임의 좌표계 → WGS84 경위도. 반환 [lat, lon] */
export function toWgs84(x, y, epsg) {
  epsg = Number(epsg);
  if (epsg === 4326) return [Number(y), Number(x)];   // 입력이 이미 경위도
  ensureDefs();
  if (!window.proj4) throw new Error("좌표 변환 라이브러리(proj4)를 불러오지 못했습니다");
  const [lon, lat] = window.proj4(`EPSG:${epsg}`, "EPSG:4326", [Number(x), Number(y)]);
  return [lat, lon];
}

/** WGS84 경위도 → 임의 좌표계. 반환 [x, y] */
export function fromWgs84(lat, lon, epsg) {
  epsg = Number(epsg);
  if (epsg === 4326) return [Number(lon), Number(lat)];
  ensureDefs();
  if (!window.proj4) throw new Error("좌표 변환 라이브러리(proj4)를 불러오지 못했습니다");
  return window.proj4("EPSG:4326", `EPSG:${epsg}`, [Number(lon), Number(lat)]);
}

/** 도분초·십진도가 섞인 문자열을 숫자로. "34°33'40.01\"N" 같은 표기도 받는다. */
export function parseCoord(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").trim();
  if (!s) return NaN;
  const dms = s.match(/^(-?\d+(?:\.\d+)?)\s*[°d:\s]\s*(\d+(?:\.\d+)?)\s*['m:\s]\s*(\d+(?:\.\d+)?)\s*["s]?\s*([NSEW])?$/i);
  if (dms) {
    const val = Math.abs(+dms[1]) + +dms[2] / 60 + +dms[3] / 3600;
    const neg = /^[SW]$/i.test(dms[4] || "") || +dms[1] < 0;
    return neg ? -val : val;
  }
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i);
  if (!m) return NaN;
  const val = Math.abs(+m[1]);
  return (/^[SW]$/i.test(m[2] || "") || +m[1] < 0) ? -val : val;
}
