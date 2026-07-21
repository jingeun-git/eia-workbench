/* EIA Workbench 셸 (SYS-29 4단계)
 * 탭 라우팅(해시 동기화) · 테마 · 브리지 상태칩 · 설정(API 키·토큰) · 토스트
 */
import { bridge } from "./bridge.js";
import { keys } from "./keys.js";

/* 배포 버전 — 도구 모듈 import에 붙여 브라우저 모듈 캐시를 무효화한다.
   Pages는 즉시 갱신되는데 브라우저가 옛 .js를 계속 쓰는 바람에, 이미 고친
   버그가 화면에 계속 뜨는 일이 반복됐다(2026-07-20). 배포 시 이 값을 올린다. */
const V = "3.19.1";

/* ── 도구 레지스트리 ───────────────────────────────────────────────────
   init은 첫 활성화 시 1회 lazy 호출. needsBridge 도구는 미연결 시 잠금. */
const TOOLS = [
  { id: "parcel", label: "건축물대장", needsBridge: false,
    load: () => import(`../modules/parcel.js?v=${V}`) },
  { id: "md",     label: "md 변환",    needsBridge: false,
    load: () => import(`../modules/md.js?v=${V}`) },
  { id: "eiass",  label: "EIASS",      needsBridge: false,
    load: () => import(`../modules/eiass.js?v=${V}`) },
  { id: "hwppdf", label: "HWP→PDF",   needsBridge: true,
    load: () => import(`../modules/hwp.js?v=${V}`).then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pdf") })) },
  { id: "pagenum",label: "쪽번호",     needsBridge: true,
    load: () => import(`../modules/hwp.js?v=${V}`).then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pagenum") })) },
  // 차례·끼워넣기: 2026-07-20 사용자 지시로 기능 삭제
];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inited = new Set();

/* ── 테마 ───────────────────────────────────────────────────────────
   라이트가 기본이다(2026-07-20 사용자 확정). OS 설정을 자동 추종하지 않고,
   사용자가 토글로 고른 값만 기억한다. */
function applyTheme(mode) {              // "light" | "dark"
  document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
}
function initTheme() {
  applyTheme(localStorage.getItem("eiaw.theme") || "light");
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
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
    chip.className = "chip " + (s === "ok" ? "ok" : s === "checking" ? "warn" : "fail");
    chip.textContent =
      s === "ok"   ? `● 브리지 v${bridge.info?.bridge_version ?? "?"}` :
      s === "stub" ? "⚠ 진단 스텁 감지 — 클릭" :
      s === "off"  ? "○ 브리지 미연결" : "◌ 확인 중…";
    if (s === "stub")
      chip.title = "PoC 진단 스텁이 켜져 있습니다 — 그 창을 닫고 run_bridge.bat를 실행하세요";
    // 브리지가 여러 개 떠 있으면 최신을 골랐음을 알린다(구버전 창 방치 감지)
    if (s === "ok" && bridge.duplicates?.length) {
      chip.textContent += " ⚠";
      chip.title = `브리지가 ${bridge.duplicates.length + 1}개 실행 중 — 최신(v${bridge.info?.bridge_version})에 연결했습니다.\n`
        + `구버전: ${bridge.duplicates.join(", ")}\n혼선을 막으려면 구버전 창을 닫아주세요.`;
    }
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

/* ── 브리지 자동 페어링 ────────────────────────────────────────────
   브리지가 시작 시 브라우저를 #bt=토큰&bp=포트 해시로 연다.
   해시를 읽어 저장하고 즉시 지운다(주소창·히스토리·북마크 잔존 방지). */
function initPairing() {
  const h = location.hash.slice(1);
  if (!h.includes("bt=")) return;
  const params = new URLSearchParams(h);
  const token = params.get("bt");
  const port = params.get("bp");
  if (token) {
    bridge.token = token;
    if (port) localStorage.setItem("eiaw.bridge.port", port);
    history.replaceState(null, "", location.pathname + location.search);
    toast("브리지 토큰이 자동 등록됐습니다 — 곧 연결됩니다", "ok");
  }
}

/* ── 부트 ─────────────────────────────────────────────────────────── */
initTheme();
initPairing();   // bridge.start() 전에 토큰부터 확보
initTabs();
initBridgeChip();
initSettings();
initModals();
