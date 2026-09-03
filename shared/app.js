


import { bridge } from "./bridge.js";
import { keys } from "./keys.js";




export const V = "3.66.1";






const MIN_BRIDGE = "3.31.2";


const cmpVer = (a, b) => {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < 3; i++) {
    const d = (+pa[i] || 0) - (+pb[i] || 0);
    if (d) return d;
  }
  return 0;
};








const GROUPS = [
  { id: "collect", label: "자료 수집·조사" },
  { id: "author",  label: "본문 작성" },
  { id: "finish",  label: "제출본 정리" },
];

const TOOLS = [
  { id: "eiass",  group: "collect", label: "EIASS 수집",  needsBridge: false,
    load: () => import(`../modules/eiass.js?v=${V}`) },
  { id: "md",     group: "collect", label: "문서 → MD",   needsBridge: false,
    load: () => import(`../modules/md.js?v=${V}`) },
  { id: "photo",  group: "collect", label: "사진 좌표",   needsBridge: true,
    load: () => import(`../modules/photo.js?v=${V}`) },

  { id: "geocode",group: "collect", label: "지오코딩",    needsBridge: false,
    load: () => import(`../modules/geocode.js?v=${V}`) },

  { id: "parcel", group: "author",  label: "건축물대장",  needsBridge: true,
    load: () => import(`../modules/parcel.js?v=${V}`) },
  { id: "pdf2xl", group: "author",  label: "PDF 표 → 엑셀", needsBridge: true,
    load: () => import(`../modules/pdf2excel.js?v=${V}`) },


  { id: "envdata", group: "author",  label: "환경질 분석",   needsBridge: false,
    load: () => import(`../modules/envdata.js?v=${V}`) },


  { id: "pdfmerge", group: "finish", label: "PDF 병합",   needsBridge: true,
    load: () => import(`../modules/pdfmerge.js?v=${V}`) },
  { id: "pagenum",group: "finish",  label: "쪽번호",      needsBridge: true,
    load: () => import(`../modules/hwp.js?v=${V}`).then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pagenum") })) },
  { id: "hwppdf", group: "finish",  label: "한글 → PDF",   needsBridge: true,
    load: () => import(`../modules/hwp.js?v=${V}`).then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pdf") })) },

];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inited = new Set();








function applyTheme(mode) {
  document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
}


function initVersion() {
  const v = $("#web-ver");
  if (v) v.textContent = `웹 v${V}`;
}

function initTheme() {
  applyTheme(localStorage.getItem("eiaw.theme") || "light");
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("eiaw.theme", next);
    applyTheme(next);
  });
}









function currentToolId() {
  const on = $$(".tab").find((b) => b.getAttribute("aria-selected") === "true");
  return on?.dataset.tool || null;
}

function askStopRunning() {
  return new Promise((resolve) => {
    const labels = [...bridge.activeJobs.values()]
      .map((j) => j.label).filter(Boolean);
    const what = $("#busy-what");
    if (what)
      what.textContent = labels.length ? labels.join(" · ") : "진행 중인 작업";
    const modal = $("#busy-modal");
    const go = $("#busy-go"), stay = $("#busy-stay");
    let settled = false;
    let obs = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      go.removeEventListener("click", onGo);
      stay.removeEventListener("click", onStay);
      obs?.disconnect();
      closeModals();
      resolve(v);
    };
    const onGo = () => done(true);
    const onStay = () => done(false);
    go.addEventListener("click", onGo);
    stay.addEventListener("click", onStay);





    obs = new MutationObserver(() => {
      if (!modal.classList.contains("active")) done(false);
    });
    obs.observe(modal, { attributes: true, attributeFilter: ["class"] });
    openModal("busy-modal");
  });
}





export async function stopAllRunning() {
  try {
    const res = await bridge.cancelAll();
    const killed = res.reduce((n, r) => n + (r.hwp_killed || 0), 0);


    const failed = res.filter((r) => r.ok === false);
    if (failed.length)


      toast(`작업을 멈추지 못했습니다 — ${failed[0].error}. `
            + "로컬 런처가 살아 있으면 백그라운드에서 계속될 수 있습니다", "fail");
    else if (res.length && res.every((r) => r.already_finished))
      toast("작업이 이미 끝났습니다 — 결과를 확인하세요", "ok");
    else
      toast(killed ? `작업을 중단했습니다 (한컴 ${killed}개 종료) — 완료된 파일은 남아 있습니다`
                   : "작업을 중단했습니다 — 완료된 파일은 남아 있습니다", "ok");
  } catch (e) {
    toast(`작업 중단에 실패했습니다 — ${String(e.message || e)}`, "fail");
  }
}




export function mountStopButton(el, { label = "중지" } = {}) {
  const b = document.createElement("button");
  b.className = "btn btn-secondary";
  b.type = "button";
  b.textContent = `■ ${label}`;
  const sync = () => {
    b.disabled = !bridge.busy;
    b.title = bridge.busy
      ? "진행 중인 작업을 멈춥니다 — 여기까지 만들어진 파일은 남습니다"
      : "진행 중인 작업이 없습니다";
  };
  b.addEventListener("click", async () => {
    if (!bridge.busy) return;
    b.disabled = true;
    await stopAllRunning();
    sync();
  });

  bridge.addEventListener("busy", sync);
  bridge.addEventListener("change", sync);
  sync();
  el.appendChild(b);
  return b;
}

async function activate(id, pushHash = true) {
  const tool = TOOLS.find((t) => t.id === id && !t.planned) || TOOLS[0];
  const from = currentToolId();
  if (bridge.busy && from && from !== tool.id) {
    if (!(await askStopRunning())) {


      if (from && location.hash !== `#${from}`)
        history.replaceState(null, "", `#${from}`);
      return;
    }
    await stopAllRunning();
  }
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


      await mod.init($(`#sec-${tool.id}`), { bridge, toast, V, mountStopButton });
    } catch (e) {


      const el = $(`#sec-${tool.id}`);
      if (el) el.innerHTML =
        `<div class="panel"><h2>${tool.label}</h2>`
        + `<div class="placeholder" style="white-space:pre-wrap;text-align:left">`
        + `이 도구를 불러오지 못했습니다.\n\n${String(e.message || e)}\n\n`
        + `· 새로고침(Ctrl+Shift+R)을 먼저 시도해 주세요.\n`
        + `· 사내망·보안 프로그램이 차단하는 경우가 있습니다.\n`
        + `· 계속되면 위 내용을 그대로 알려주세요.</div></div>`;
      toast(`${tool.label}을 불러오지 못했습니다 — 탭 안 내용을 확인하세요`, "fail");
      inited.delete(tool.id);
    }
  }
}
function initTabs() {
  const nav = $(".tabs");
  for (const g of GROUPS) {
    const wrap = document.createElement("div");
    wrap.className = "tab-group";
    const cap = document.createElement("span");
    cap.className = "tab-group-label";
    cap.textContent = g.label;
    wrap.appendChild(cap);

    for (const t of TOOLS.filter((x) => x.group === g.id)) {
      const b = document.createElement("button");
      b.className = "tab"; b.dataset.tool = t.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", "false");
      b.textContent = t.label;
      if (t.planned) {
        b.disabled = true;
        b.dataset.planned = "1";
        b.title = "구현 예정";
      } else if (t.needsBridge) {
        b.dataset.needsBridge = "1";
        b.title = "로컬 런처 연결 필요";
      }
      b.addEventListener("click", () => !b.disabled && activate(t.id));
      wrap.appendChild(b);
    }
    nav.appendChild(wrap);
  }
  addEventListener("hashchange", () =>
    activate(location.hash.slice(1) || TOOLS[0].id, false));

}


function initBridgeChip() {
  const chip = $("#bridge-chip");
  const render = () => {
    const s = bridge.state;
    chip.className = "chip " + (s === "ok" ? "ok" : s === "checking" ? "warn" : "fail");
    chip.style.cursor = s === "ok" ? "default" : "pointer";
    const bv = bridge.info?.bridge_version ?? "?";
    const stale = s === "ok" && cmpVer(bv, MIN_BRIDGE) < 0;
    chip.textContent =
      s === "ok"   ? `● 로컬 런처 v${bv}${stale ? " ⚠ 갱신 필요" : ""}` :
      s === "stub" ? "⚠ 진단 스텁 감지 — 클릭" :
      s === "off"  ? "○ 로컬 런처 미연결" : "◌ 확인 중…";
    if (s === "stub")
      chip.title = "PoC 진단 스텁이 켜져 있습니다 — 그 창을 닫고 로컬 런처를 실행하세요";


    else if (s === "ok") {
      chip.classList.toggle("warn", stale);
      chip.classList.toggle("ok", !stale);
      chip.style.cursor = "default";


      chip.title = stale ? "로컬 런처 갱신 필요" : "정상";
    }







    $$(".tab[data-needs-bridge]").forEach((b) => {
      if (b.dataset.planned) return;
      b.disabled = s !== "ok";
      b.title = s === "ok" ? "" : "로컬 런처 연결 필요 — 상태칩을 눌러 안내를 확인하세요";
    });
  };
  bridge.addEventListener("change", render);



  chip.addEventListener("click", () => {
    if (bridge.state !== "ok") openModal("bridge-modal");
  });
  render();
  bridge.start();
}


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

  $$("[data-reveal]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const inp = $(btn.dataset.reveal);
      inp.type = inp.type === "password" ? "text" : "password";
    }));
}


function openModal(id) { $(`#${id}`).classList.add("active"); }
function closeModals() { $$(".modal-backdrop").forEach((m) => m.classList.remove("active")); }
function initModals() {
  $$(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => { if (e.target === bd) closeModals(); });
  });
  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", closeModals));
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}


export function toast(msg, kind = "") {
  const box = $(".toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", "status");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}




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
    toast("로컬 런처 토큰이 자동 등록됐습니다 — 곧 연결됩니다", "ok");
  }
}






function initBridgeBanner() {
  const banner = $("#bridge-banner");
  const msgEl = $("#bridge-banner-msg");
  if (!banner || !msgEl) return;

  const render = () => {
    const s = bridge.state;
    const nl = bridge.info?.nodelock;
    const approved = s === "ok" && (!nl || nl.ok === true);

    if (approved) { banner.hidden = true; return; }
    banner.hidden = false;


    const needsAction = (s === "stub") || (s === "ok" && nl && nl.ok === false);
    banner.classList.toggle("is-warn", needsAction);
    if (s === "checking") {
      msgEl.textContent = "로컬 런처 연결을 확인하는 중입니다…";
    } else if (s === "stub") {
      msgEl.textContent = "진단 스텁 창이 열려 있습니다 — 그 창을 닫고 런처를 실행하세요.";
    } else if (s === "ok" && nl && nl.ok === false) {
      msgEl.textContent = "이 PC는 아직 승인되지 않았습니다 — 등록 요청 후 승인되면 로컬 기능이 열립니다.";
    } else {
      msgEl.textContent = "로컬 런처가 실행되지 않았습니다 — 한컴·PDF·사진 등 로컬 기능은 로컬 런처를 실행·승인한 뒤 사용할 수 있습니다. (브라우저 기능은 그대로 사용 가능)";
    }
  };

  bridge.addEventListener("change", render);
  render();
}


initVersion();
initTheme();
initPairing();
initTabs();
activate(location.hash.slice(1) || TOOLS[0].id, false);
initBridgeBanner();
initBridgeChip();
initSettings();
initModals();
