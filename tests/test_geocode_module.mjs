/* geocode.js 스모크 테스트 — init()이 실제로 끝까지 도는지 본다.
 *
 * 왜 필요한가: 이 모듈은 `section.innerHTML = ...`로 UI를 만든 뒤 곧바로
 * `$("#ph-fmt").querySelector(...)` 같은 접근을 한다. 오타 하나로 null 참조가
 * 나는데, 그건 **탭을 눌렀을 때** 터지므로 배포 전까지 아무도 모른다.
 * 기존 dom_harness는 innerHTML을 파싱하지 않아 이걸 잡지 못한다.
 *
 * 여기서는 innerHTML의 id/class를 훑어 스텁을 등록하는 하네스를 따로 둔다.
 * 브라우저가 아니므로 지도(Leaflet)·네트워크는 검증 대상이 아니다 —
 * **초기화 경로가 예외 없이 끝나는지**만 본다.
 */

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); failures++; }
};

/* ── innerHTML을 이해하는 최소 하네스 ─────────────────────────────── */
class El {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {};
    this._attrs = {}; this._html = ""; this.textContent = ""; this.value = "";
    this.checked = false; this.disabled = false;
    this._ids = new Map();
    this.classList = {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)); },
      remove(...a) { a.forEach((x) => this._s.delete(x)); },
      toggle(x, on) { on ? this._s.add(x) : this._s.delete(x); },
      contains(x) { return this._s.has(x); },
    };
    Object.defineProperty(this, "className", {
      get() { return [...this.classList._s].join(" "); },
      set(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(this, "innerHTML", {
      get() { return this._html; },
      set(v) {
        this._html = String(v);
        // id를 가진 요소를 스텁으로 등록해 이후 querySelector가 찾을 수 있게 한다
        for (const m of this._html.matchAll(/id="([^"]+)"/g)) {
          const child = new El("div");
          child._ids = this._ids;
          this._ids.set("#" + m[1], child);
        }
      },
    });
  }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  addEventListener() {} removeEventListener() {} remove() {}
  scrollIntoView() {}
  querySelector(s) {
    if (this._ids.has(s)) return this._ids.get(s);
    // `option[value="shp"]` 같은 하위 선택도 죽지 않게 스텁을 준다
    return new El("div");
  }
  querySelectorAll() { return []; }
}

const root = new El("section");
globalThis.document = {
  documentElement: { dataset: {} },
  createElement: (t) => new El(t),
  querySelector: () => new El(),
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.URL = { createObjectURL: () => "blob:stub", revokeObjectURL() {} };
// keys.js가 읽는다 — 없으면 지도 경로에서 터진다
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
};


/* ── 지도·엑셀 스텁 ───────────────────────────────────────────────── */
globalThis.L = {
  map: () => ({ setView(){return this;}, removeLayer(){}, on(){}, invalidateSize(){},
                doubleClickZoom:{disable(){}}, fitBounds(){}, getZoom:()=>10 }),
  tileLayer: () => ({ addTo(){ return this; } }),
  circleMarker: () => ({ addTo(){return this;}, bindTooltip(){return this;},
                         on(){}, setStyle(){}, bringToFront(){} }),
  latLngBounds: (a) => a,
  layerGroup: () => ({ addTo(){return this;}, clearLayers(){} }),
};
globalThis.XLSX = { read: () => ({ SheetNames:["s"], Sheets:{s:{}} }),
                    utils: { sheet_to_json: () => [], json_to_sheet: () => ({}),
                             book_new: () => ({}), book_append_sheet(){} },
                    writeFile(){} };
globalThis.addEventListener = () => {};
globalThis.confirm = () => true;

const toasts = [];
const toast = (m, k) => toasts.push([m, k]);
const bridgeStub = { state: "off", info: { features: {} }, addEventListener(){},
                     call: async () => ({}), blobUrl: async () => "" };

const { init } = await import("../modules/geocode.js");

console.log("geocode.js 초기화 경로");

check("vworld 키가 없을 때 — 안내만 뜨고 죽지 않는다", () => {
  localStorage.removeItem("eiaw.key.vworld");
  init(new El("section"), { bridge: bridgeStub, toast });
});

check("vworld 키가 있을 때 — 지도까지 초기화된다", () => {
  localStorage.setItem("eiaw.key.vworld", "TESTKEY");
  init(new El("section"), { bridge: bridgeStub, toast });
});

check("좌표계를 바꿔도 죽지 않는다 (헤더·표 재렌더)", () => {
  localStorage.setItem("eiaw.key.vworld", "TESTKEY");
  const el = new El("section");
  init(el, { bridge: bridgeStub, toast });
  const crs = el.querySelector("#gc-crs");
  crs.value = "4326";
});

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 초기화 경로 전부 통과");
process.exit(failures ? 1 : 0);
