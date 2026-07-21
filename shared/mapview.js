/* 지도 뷰 공통 모듈 — 사진 좌표·지오코딩 탭이 함께 쓴다 (SYS-36 ①)
 *
 * ── 배경지도를 vworld로 쓰는 이유 ──
 * 처음에는 OSM을 썼는데 사용자가 지도 위 출처 표기를 지워달라고 했다. 그런데
 * OSM 지도 데이터는 ODbL 라이선스라 출처 표시가 **사용 조건**이어서 그냥 지울
 * 수 없다. vworld(국토교통부)로 바꾸면 그 제약이 없어지고, 국내 지형·지번
 * 판독성도 OSM보다 낫다(사용자 승인 2026-07-21).
 *
 * ── vworld WMTS 실측 (2026-07-21) ──
 *   URL   : /req/wmts/1.0.0/{key}/{레이어}/{z}/{y}/{x}.{확장자}
 *           ⚠ **{z}/{y}/{x} 행·열 순서** — Leaflet 기본 {z}/{x}/{y}와 다르다
 *   레이어: Base(png) · Satellite(jpeg) · Hybrid(png, 지명 오버레이) · midnight(png)
 *           `gray`는 **존재하지 않는다** (3가지 표기 모두 ExceptionReport 반환)
 *   검증  : 타일이 빈 이미지가 아님을 크기 구배로 확인했다 —
 *           서울 22,445B > 송호리 6,747B > 동해 먼바다 177B
 *
 * ── 키가 없으면 ──
 * vworld 타일은 URL에 키가 들어가므로 키가 없는 사용자는 지도를 못 본다.
 * 그래서 키가 없으면 OSM으로 자동 폴백하고 **어느 배경을 쓰는지 화면에 밝힌다**.
 * OSM으로 떨어졌을 때는 ODbL 조건이므로 출처 표기를 그대로 둔다.
 */

const VWORLD_WMTS = "https://api.vworld.kr/req/wmts/1.0.0";

/* 레이어 구성 — EIA 실무에서 쓰는 것만 남겼다.
   midnight(야간)은 현장 판독에 쓸 일이 없어 뺐다. */
const VWORLD_LAYERS = [
  { id: "base", label: "일반지도", layer: "Base", ext: "png" },
  { id: "sat", label: "위성영상", layer: "Satellite", ext: "jpeg" },
  { id: "hybrid", label: "위성+지명", layer: "Satellite", ext: "jpeg", overlay: "Hybrid" },
];

/** vworld 타일 레이어 하나를 만든다.
 *  Leaflet의 {x}/{y}를 vworld의 행·열 순서에 맞춰 뒤집어 넣는다. */
function vworldTile(L, key, layer, ext) {
  return L.tileLayer(`${VWORLD_WMTS}/${key}/${layer}/{z}/{y}/{x}.${ext}`, {
    maxZoom: 19,
    minZoom: 6,
    // vworld는 표기 의무가 OSM처럼 강하지 않지만, 출처를 아주 작게 남긴다.
    attribution: '<span style="opacity:.55">브이월드</span>',
  });
}

/**
 * 지도를 만들고 배경 전환 컨트롤을 붙인다.
 *
 * @param {HTMLElement} el      지도를 그릴 요소
 * @param {string}      vworldKey  vworld 인증키 (없으면 OSM 폴백)
 * @returns {{map, usingVworld:boolean, setBase(id):void, bases:Array}}
 */
export function createMap(el, vworldKey) {
  const L = window.L;
  if (!L) throw new Error("지도 라이브러리(Leaflet)를 불러오지 못했습니다");

  const map = L.map(el, { zoomControl: true, attributionControl: true })
    .setView([36.5, 127.8], 7);

  const usingVworld = Boolean(vworldKey);
  let current = null;
  let currentOverlay = null;

  function setBase(id) {
    if (current) map.removeLayer(current);
    if (currentOverlay) { map.removeLayer(currentOverlay); currentOverlay = null; }

    if (!usingVworld) {
      // ODbL 조건이므로 이 경우에는 출처 표기를 유지한다.
      current = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      return;
    }

    const spec = VWORLD_LAYERS.find((v) => v.id === id) || VWORLD_LAYERS[0];
    current = vworldTile(L, vworldKey, spec.layer, spec.ext).addTo(map);
    if (spec.overlay) {
      currentOverlay = vworldTile(L, vworldKey, spec.overlay, "png").addTo(map);
    }
  }

  setBase("base");

  return {
    map,
    usingVworld,
    setBase,
    bases: usingVworld ? VWORLD_LAYERS : [{ id: "base", label: "OpenStreetMap" }],
  };
}

/** 배경 전환 버튼 묶음의 HTML. 탭마다 같은 모양을 쓰기 위해 여기서 만든다. */
export function baseSwitcherHtml(prefix, bases) {
  if (bases.length < 2) return "";
  return `<div class="map-bases" role="group" aria-label="배경지도 선택">` +
    bases.map((b, i) =>
      `<button type="button" class="map-base-btn${i === 0 ? " on" : ""}" ` +
      `id="${prefix}-base-${b.id}" data-base="${b.id}">${b.label}</button>`).join("") +
    `</div>`;
}

/** 배경 전환 버튼에 동작을 붙인다. */
export function bindBaseSwitcher(root, prefix, view) {
  root.querySelectorAll(`[id^="${prefix}-base-"]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      view.setBase(btn.dataset.base);
      root.querySelectorAll(`[id^="${prefix}-base-"]`)
          .forEach((b) => b.classList.toggle("on", b === btn));
    });
  });
}

/** 구면 직접문제 — 출발점에서 방위각·거리만큼 이동한 지점 */
export function destination(lat, lon, bearing, km) {
  const R = 6371.0088, rad = Math.PI / 180;
  const br = bearing * rad, d = km / R, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1),
                             Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, ((l2 / rad + 540) % 360) - 180];
}
