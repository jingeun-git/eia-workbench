




















const BASE = "https://api.vworld.kr/req/address";

let _seq = 0;


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






export async function toCoord(key, address, { prefer = "auto" } = {}) {
  const addr = String(address || "").trim();
  if (!addr) return { ok: false, reason: "주소가 비어 있습니다" };


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

    return { ok: false, reason: r?.status === "NOT_FOUND"
      ? "주소가 없는 지점입니다 (바다·미등록 구역)" : (r?.status || "조회 실패") };
  }
  const pick = (t) => r.result.find((x) => x.type === t)?.text || "";
  return { ok: true, jibun: pick("parcel"), road: pick("road") };
}




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


export function toWgs84(x, y, epsg) {
  epsg = Number(epsg);
  if (epsg === 4326) return [Number(y), Number(x)];
  ensureDefs();
  if (!window.proj4) throw new Error("좌표 변환 라이브러리(proj4)를 불러오지 못했습니다");
  const [lon, lat] = window.proj4(`EPSG:${epsg}`, "EPSG:4326", [Number(x), Number(y)]);
  return [lat, lon];
}


export function fromWgs84(lat, lon, epsg) {
  epsg = Number(epsg);
  if (epsg === 4326) return [Number(lon), Number(lat)];
  ensureDefs();
  if (!window.proj4) throw new Error("좌표 변환 라이브러리(proj4)를 불러오지 못했습니다");
  return window.proj4("EPSG:4326", `EPSG:${epsg}`, [Number(lon), Number(lat)]);
}


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
