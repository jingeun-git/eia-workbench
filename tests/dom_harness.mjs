/* 최소 DOM 스텁 — 진입점(app.js)을 실제로 실행해 UI 회귀를 잡는다.
   브라우저 없이 "탭이 몇 개 생기는가" 같은 것을 확인하기 위한 것으로,
   2026-07-21 탭 중복 사고(진입점 이중 실행)를 재현·검증한 도구다. */
class El {
  constructor(tag){ this.tagName=tag; this.children=[]; this.dataset={}; this.style={};
    this.classList={_s:new Set(), add(...a){a.forEach(x=>this._s.add(x))}, remove(){}, toggle(){}, contains(x){return this._s.has(x)}};
    this._attrs={}; this.textContent=""; }
  appendChild(c){ this.children.push(c); c.parentNode=this; return c; }
  setAttribute(k,v){ this._attrs[k]=v; } getAttribute(k){ return this._attrs[k]; }
  addEventListener(){} removeEventListener(){} remove(){}
  querySelector(s){ return doc.querySelector(s); }
  querySelectorAll(s){ return doc.querySelectorAll(s); }
}
const nav = new El("nav"); nav.classList.add("tabs");
const TOOL_IDS = ["parcel","md","eiass","hwppdf","pagenum"];
const reg = { ".tabs": nav, ".toasts": new El("div") };
for (const t of TOOL_IDS) reg["#sec-"+t] = new El("section");
for (const id of ["theme-toggle","bridge-chip","settings-btn","settings-save",
                  "set-vworld","set-pubdata","set-token"]) reg["#"+id] = new El("div");
const doc = {
  documentElement:{dataset:{}},
  querySelector(s){ return reg[s] ?? null; },
  querySelectorAll(s){
    if (s===".tab"||s===".tab[data-needs-bridge]") return nav.children.filter(c=>c.classList.contains("tab"));
    if (s===".tool-section") return TOOL_IDS.map(t=>reg["#sec-"+t]);
    return [];
  },
  createElement(t){ return new El(t); },
  addEventListener(){},
};
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.location = { hash:"", pathname:"/", search:"" };
globalThis.history = { replaceState(){} };
globalThis.addEventListener = ()=>{};
globalThis.setInterval = ()=>0;
globalThis.fetch = async()=>({ ok:false, status:0, json:async()=>({}) });
const store={};
globalThis.localStorage={ getItem:k=>store[k]??null, setItem:(k,v)=>{store[k]=String(v)} };
globalThis.CustomEvent = class { constructor(t,o){ this.type=t; Object.assign(this,o) } };
globalThis.EventTarget = class { addEventListener(){} dispatchEvent(){} };
globalThis.AbortController = class { constructor(){ this.signal={} } abort(){} };
export { nav };
