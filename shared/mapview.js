





















const VWORLD_WMTS = "https://api.vworld.kr/req/wmts/1.0.0";



const VWORLD_LAYERS = [
  { id: "base", label: "일반지도", layer: "Base", ext: "png" },
  { id: "sat", label: "위성영상", layer: "Satellite", ext: "jpeg" },
  { id: "hybrid", label: "위성+지명", layer: "Satellite", ext: "jpeg", overlay: "Hybrid" },
];



function vworldTile(L, key, layer, ext) {
  return L.tileLayer(`${VWORLD_WMTS}/${key}/${layer}/{z}/{y}/{x}.${ext}`, {
    maxZoom: 19,
    minZoom: 6,

    attribution: '<span style="opacity:.55">브이월드</span>',
  });
}








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


export function baseSwitcherHtml(prefix, bases) {
  if (bases.length < 2) return "";
  return `<div class="map-bases" role="group" aria-label="배경지도 선택">` +
    bases.map((b, i) =>
      `<button type="button" class="map-base-btn${i === 0 ? " on" : ""}" ` +
      `id="${prefix}-base-${b.id}" data-base="${b.id}">${b.label}</button>`).join("") +
    `</div>`;
}


export function bindBaseSwitcher(root, prefix, view) {
  root.querySelectorAll(`[id^="${prefix}-base-"]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      view.setBase(btn.dataset.base);
      root.querySelectorAll(`[id^="${prefix}-base-"]`)
          .forEach((b) => b.classList.toggle("on", b === btn));
    });
  });
}


export function destination(lat, lon, bearing, km) {
  const R = 6371.0088, rad = Math.PI / 180;
  const br = bearing * rad, d = km / R, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1),
                             Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, ((l2 / rad + 540) % 360) - 180];
}
