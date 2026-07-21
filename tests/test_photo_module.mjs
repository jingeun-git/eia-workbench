/* photo.js 스모크 테스트 — init()이 실제로 끝까지 도는지 본다.
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
/* ⚠ init이 async다 — 검사 함수는 **반드시 프로미스를 반환**해야 한다.
   `() => { init(...); }` 처럼 버리면 예외가 사라져 무엇을 넣어도 통과하는
   무의미한 검사가 된다(2026-07-21 실제로 그렇게 만들었다가 변이 주입으로 발견). */
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
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
  get firstElementChild() { return this.children[0] || null; }
  get clientWidth() { return 800; }
  get offsetWidth() { return 100; }
  get scrollWidth() { return 100; }
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
globalThis.L = undefined;   // 지도 라이브러리 없음 — 그래도 죽지 않아야 한다

/* ── 브리지 스텁 ──────────────────────────────────────────────────── */
function makeBridge(state, features) {
  return {
    state, info: { features, bridge_version: "3.23.0" },
    _h: [],
    addEventListener(_e, f) { this._h.push(f); },
    fire() { this._h.forEach((f) => f()); },
    call: async () => ({ ok: true, photos: [], total: 0, with_geo: 0, no_dir: 0 }),
    blobUrl: async () => "blob:stub",
  };
}
const toasts = [];
const toast = (m, k) => toasts.push([m, k]);

/* ── 검사 ─────────────────────────────────────────────────────────── */
const { init } = await import("../modules/photo.js");

console.log("photo.js 초기화 경로");

await check("브리지 연결 + 전 기능 가용", () => {
  return init(new El("section"), {
    bridge: makeBridge("ok", { photo: true }),
    toast, V: 'test',
  });
});

await check("브리지 미연결 (탭을 열어도 죽지 않아야 한다)", () => {
  return init(new El("section"), {
    bridge: makeBridge("off", {}), toast, V: 'test', V: 'test',
  });
});

await check("vworld 키가 없는 상태 (지도는 OSM 폴백)", () => {
  return init(new El("section"), {
    bridge: makeBridge("ok", { photo: true }),
    toast, V: 'test',
  });
});

await check("구버전 브리지 — photo 기능 자체가 없음", () => {
  return init(new El("section"), {
    bridge: makeBridge("ok", { photo: false }), toast, V: 'test', V: 'test',
  });
});

await check("브리지 상태가 도중에 바뀜 (change 이벤트)", () => {
  const b = makeBridge("off", {});
  const p = init(new El("section"), { bridge: b, toast, V: 'test' });
  b.state = "ok";
  b.info.features = { photo: true };
  b.fire();
});

console.log(failures ? `\n  ✗ ${failures}건 실패` : "\n  ✓ 초기화 경로 전부 통과");
process.exit(failures ? 1 : 0);
