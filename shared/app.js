/* EIA Workbench 셸 (SYS-29 4단계)
 * 탭 라우팅(해시 동기화) · 테마 · 브리지 상태칩 · 설정(API 키·토큰) · 토스트
 */
import { bridge } from "./bridge.js";

/* ── 도구 레지스트리 ───────────────────────────────────────────────────
   init은 첫 활성화 시 1회 lazy 호출. needsBridge 도구는 미연결 시 잠금. */
const TOOLS = [
  { id: "parcel", label: "건축물대장", needsBridge: false,
    load: () => import("../modules/parcel.js") },
  { id: "md",     label: "md 변환",    needsBridge: false,
    load: () => import("../modules/md.js") },
  { id: "eiass",  label: "EIASS",      needsBridge: false,
    load: () => import("../modules/eiass.js") },
  { id: "hwppdf", label: "HWP→PDF",   needsBridge: true,
    load: () => import("../modules/hwp.js").then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pdf") })) },
  { id: "toc",    label: "차례",       needsBridge: true,
    load: () => import("../modules/hwp.js").then((m) => ({ init: (el, ctx) => m.init(el, ctx, "toc") })) },
  { id: "pagenum",label: "쪽번호",     needsBridge: true,
    load: () => import("../modules/hwp.js").then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pagenum") })) },
  { id: "merge",  label: "끼워넣기",   needsBridge: true,
    load: () => import("../modules/hwp.js").then((m) => ({ init: (el, ctx) => m.init(el, ctx, "merge") })) },
];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inited = new Set();

/* ── 테마 ─────────────────────────────────────────────────────────── */
function applyTheme(mode) {              // mode: light | dark | null(시스템)
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}
function initTheme() {
  applyTheme(localStorage.getItem("eiaw.theme") || null);
  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    localStorage.setItem("eiaw.theme", next);
    applyTheme(next);
  });
}

/* ── 탭 ───────────────────────────────────────────────────────────── */
async function activate(id, pushHash = true) {
  const tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
  $$(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tool === tool.id)));
  $$(".tool-section").forEach((s) =>
    s.classList.toggle("active", s.id === `sec-${tool.id}`));
  if (pushHash && location.hash !== `#${tool.id}`)
    history.replaceState(null, "", `#${tool.id}`);

  if (tool.load && !inited.has(tool.id)) {
    inited.add(tool.id);
    try {
      const mod = await tool.load();
      mod.init($(`#sec-${tool.id}`), { bridge, toast });
    } catch (e) {
      toast(`${tool.label} 모듈 로드 실패: ${e.message}`, "fail");
      inited.delete(tool.id);
    }
  }
}
function initTabs() {
  const nav = $(".tabs");
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.className = "tab"; b.dataset.tool = t.id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", "false");
    b.textContent = t.label;
    if (t.needsBridge) {
      b.dataset.needsBridge = "1";
      b.title = "브리지 연결 필요";
    }
    b.addEventListener("click", () => !b.disabled && activate(t.id));
    nav.appendChild(b);
  }
  addEventListener("hashchange", () =>
    activate(location.hash.slice(1) || TOOLS[0].id, false));
  activate(location.hash.slice(1) || TOOLS[0].id, false);
}

/* ── 브리지 상태칩 ─────────────────────────────────────────────────── */
function initBridgeChip() {
  const chip = $("#bridge-chip");
  const render = () => {
    const s = bridge.state;
    chip.className = "chip " + (s === "ok" ? "ok" : s === "off" ? "fail" : "warn");
    chip.textContent = s === "ok"
      ? `● 브리지 v${bridge.info?.bridge_version ?? "?"}`
      : s === "off" ? "○ 브리지 미연결" : "◌ 확인 중…";
    // 브리지 필요 탭 잠금/해제 — 숨기지 않고 이유를 남긴다(empty-nav-state)
    $$(".tab[data-needs-bridge]").forEach((b) => {
      b.disabled = s !== "ok";
      b.title = s === "ok" ? "" : "브리지 연결 필요 — 상태칩을 눌러 안내를 확인하세요";
    });
  };
  bridge.addEventListener("change", render);
  chip.addEventListener("click", () => openModal("bridge-modal"));
  render();
  bridge.start();
}

/* ── 설정(API 키) ─────────────────────────────────────────────────── */
export const keys = {
  get vworld()  { return localStorage.getItem("eiaw.key.vworld") || ""; },
  get pubdata() { return localStorage.getItem("eiaw.key.pubdata") || ""; },
};
function initSettings() {
  $("#settings-btn").addEventListener("click", () => {
    $("#set-vworld").value = keys.vworld;
    $("#set-pubdata").value = keys.pubdata;
    $("#set-token").value = bridge.token;
    openModal("settings-modal");
  });
  $("#settings-save").addEventListener("click", () => {
    localStorage.setItem("eiaw.key.vworld", $("#set-vworld").value.trim());
    localStorage.setItem("eiaw.key.pubdata", $("#set-pubdata").value.trim());
    bridge.token = $("#set-token").value.trim();
    closeModals();
    toast("설정을 저장했습니다 (이 브라우저에만 보관됩니다)", "ok");
  });
  // 비밀번호 표시 토글
  $$("[data-reveal]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const inp = $(btn.dataset.reveal);
      inp.type = inp.type === "password" ? "text" : "password";
    }));
}

/* ── 모달 ─────────────────────────────────────────────────────────── */
function openModal(id) { $(`#${id}`).classList.add("active"); }
function closeModals() { $$(".modal-backdrop").forEach((m) => m.classList.remove("active")); }
function initModals() {
  $$(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => { if (e.target === bd) closeModals(); });
  });
  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", closeModals));
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}

/* ── 토스트 ───────────────────────────────────────────────────────── */
export function toast(msg, kind = "") {
  const box = $(".toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", "status");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ── 부트 ─────────────────────────────────────────────────────────── */
initTheme();
initTabs();
initBridgeChip();
initSettings();
initModals();
