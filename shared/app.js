/* EIA Workbench 셸 (SYS-29 4단계)
 * 탭 라우팅(해시 동기화) · 테마 · 브리지 상태칩 · 설정(API 키·토큰) · 토스트
 */
import { bridge } from "./bridge.js";
import { keys } from "./keys.js";

/* 배포 버전 — 도구 모듈 import에 붙여 브라우저 모듈 캐시를 무효화한다.
   Pages는 즉시 갱신되는데 브라우저가 옛 .js를 계속 쓰는 바람에, 이미 고친
   버그가 화면에 계속 뜨는 일이 반복됐다(2026-07-20). 배포 시 이 값을 올린다. */
export const V = "3.61.0";

/* 브리지가 마지막으로 **실제로 바뀐** 버전.
   웹과 브리지는 별개 프로그램이라 버전이 따로 논다. 웹은 자주 바뀌지만
   브리지는 PC에서 하는 일(한컴·파일 접근)이 늘어날 때만 바뀐다.
   여기 값을 웹 버전에 맞춰 올리면 안 된다 — 바뀐 것도 없는데 사용자에게
   매번 재시작을 시키게 된다. **브리지 코드를 고칠 때만** 올린다. */
const MIN_BRIDGE = "3.27.0";   // 작업 취소(/jobs/{id}/cancel) 지원 최소 버전 — 탭전환 안전장치가 이걸 부른다
const cmpVer = (a, b) => {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < 3; i++) {
    const d = (+pa[i] || 0) - (+pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/* ── 도구 레지스트리 ───────────────────────────────────────────────────
   init은 첫 활성화 시 1회 lazy 호출. needsBridge 도구는 미연결 시 잠금. */
/* 도구를 EIA 업무 흐름 순서로 묶는다 — 이름이 아니라 **언제 쓰는가**로 나눠야
   찾는 시간이 준다.
     자료 수집·조사  : 보고서에 넣을 근거 자료를 모으는 단계
     본문 작성       : 모은 자료를 보고서 형식으로 만드는 단계
     제출본 정리     : 다 쓴 뒤 제책·제출 형태로 다듬는 단계 */
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
  // 지오코딩은 vworld를 JSONP로 직접 부르므로 브리지가 필요 없다
  { id: "geocode",group: "collect", label: "지오코딩",    needsBridge: false,
    load: () => import(`../modules/geocode.js?v=${V}`) },

  { id: "parcel", group: "author",  label: "건축물대장",  needsBridge: true,
    load: () => import(`../modules/parcel.js?v=${V}`) },
  { id: "pdf2xl", group: "author",  label: "PDF 표 → 엑셀", needsBridge: true,
    load: () => import(`../modules/pdf2excel.js?v=${V}`) },
  // 환경질 분석은 브라우저만으로 완결(xlsx·붙여넣기·직접입력) — HWPX/PDF 자동파싱만
  // 브리지 연동 다음 단계(SYS-41 step 6)에서 추가로 열린다(md 탭과 동일한 하이브리드 패턴)
  { id: "envdata", group: "author",  label: "환경질 분석",   needsBridge: false,
    load: () => import(`../modules/envdata.js?v=${V}`) },

  { id: "pagenum",group: "finish",  label: "쪽번호",      needsBridge: true,
    load: () => import(`../modules/hwp.js?v=${V}`).then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pagenum") })) },
  { id: "hwppdf", group: "finish",  label: "HWPX → PDF",   needsBridge: true,
    load: () => import(`../modules/hwp.js?v=${V}`).then((m) => ({ init: (el, ctx) => m.init(el, ctx, "pdf") })) },
  // 차례·끼워넣기: 2026-07-20 사용자 지시로 기능 삭제
];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inited = new Set();

/* C안(SYS-67): 셸은 항상 열린다(소프트 모델). 브라우저 전용 탭은 브리지와 무관하게
   쓰고, 브리지 의존 기능은 서버측(브리지 403)이 최종 차단한다. 공개 GitHub Pages라
   웹 클라이언트 하드게이트는 실효가 없어 제거했다(구 T7 하드게이트 폐기). */

/* ── 테마 ───────────────────────────────────────────────────────────
   라이트가 기본이다(2026-07-20 사용자 확정). OS 설정을 자동 추종하지 않고,
   사용자가 토글로 고른 값만 기억한다. */
function applyTheme(mode) {              // "light" | "dark"
  document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
}
/* 화면 어디에도 웹 버전이 없어서 "브리지 v3.24.0"을 웹 버전으로 오해했다
   (2026-07-21 사용자 지적). 두 버전을 나란히 보이게 한다. */
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

/* ── 탭 ───────────────────────────────────────────────────────────── */
/* 작업 중 탭 전환 안전장치 (SYS-76 W3) ─────────────────────────────────
   한컴 작업은 사용자가 탭을 떠나도 계속 돌아 백그라운드 좀비로 남았다.
   그래서 **전환과 중단을 하나로 묶는다** — 옮기려면 반드시 멈춘다.
   대신 무엇이 남고 무엇이 안 남는지 먼저 알려 사용자가 선택하게 한다.

   왜 셸(여기)에서 하는가: 모듈마다 각자 막게 하면 한 곳만 빠져도 좀비가
   되살아난다. 탭 전환의 단일 관문인 `activate()`에서 한 번만 막는다. */
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
    let obs = null;          // 아래에서 만든다. done이 먼저 불려도 죽지 않게 미리 선언
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
    /* Escape·배경 클릭으로도 이 창이 닫힌다(공용 모달 규칙). 그 경로를 여기서
       잡지 않으면 창은 사라지는데 이 Promise가 영원히 안 풀려 **탭 전환이 조용히
       멈춘다** — 사용자에겐 "눌러도 아무 일이 없는" 상태가 된다(2026-07-24 발견).
       닫히는 방법을 하나하나 열거하는 대신 **닫혔다는 사실**을 관찰해 취소로 본다.
       그래야 나중에 닫는 경로가 늘어도 여기가 깨지지 않는다. */
    obs = new MutationObserver(() => {
      if (!modal.classList.contains("active")) done(false);
    });
    obs.observe(modal, { attributes: true, attributeFilter: ["class"] });
    openModal("busy-modal");
  });
}

async function activate(id, pushHash = true) {
  const tool = TOOLS.find((t) => t.id === id && !t.planned) || TOOLS[0];
  const from = currentToolId();
  if (bridge.busy && from && from !== tool.id) {
    if (!(await askStopRunning())) {
      /* 머무르기 — 해시로 들어온 전환(뒤로가기 등)이면 주소를 원래대로 돌린다.
         안 돌리면 주소는 새 탭인데 화면은 옛 탭인 상태가 되어 다음 전환이 꼬인다. */
      if (from && location.hash !== `#${from}`)
        history.replaceState(null, "", `#${from}`);
      return;
    }
    try {
      const res = await bridge.cancelAll();
      const killed = res.reduce((n, r) => n + (r.hwp_killed || 0), 0);
      /* 취소를 보내는 순간 작업이 끝나는 경합이 실제로 일어난다(2026-07-24 실측).
         그때 "중단했습니다"라고 말하면 거짓이다 — 브리지가 알려주는 대로 말한다. */
      const failed = res.filter((r) => r.ok === false);
      if (failed.length)
        /* 브리지가 도중에 죽으면 취소 요청 자체가 실패한다. 그때도 "중단했습니다"라고
           말하면 거짓이다 — 남은 작업이 정말 멈췄는지 알 수 없다고 알린다. */
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
      await mod.init($(`#sec-${tool.id}`), { bridge, toast, V });
    } catch (e) {
      /* 토스트는 몇 초 뒤 사라져 원인을 다시 볼 수 없다. 탭 안에 남겨
         사용자가 그대로 읽어 전달할 수 있게 한다(2026-07-21 타 PC 사고). */
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
  // 초기 탭 활성화는 부트에서 직접 한다 (SYS-67 C안, 하드게이트 없음)
}

/* ── 브리지 상태칩 ─────────────────────────────────────────────────── */
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
    // 버전이 둘이라 "안 맞는 것 아닌가" 하는 오해가 생긴다(2026-07-21 사용자 지적).
    // 숫자만 보여주지 말고 **맞는지 아닌지**를 말해준다.
    else if (s === "ok") {
      chip.classList.toggle("warn", stale);
      chip.classList.toggle("ok", !stale);
      chip.style.cursor = "default";
      // 툴팁은 **상태만** 말한다. 왜 버전이 다른지 같은 설명은 사용자가 알 필요가
      // 없다(2026-07-21 사용자 지시) — 필요한 사람은 사용법 문서를 본다.
      chip.title = stale ? "로컬 런처 갱신 필요" : "정상";
    }
    /* 브리지 중복 경고는 **띄우지 않는다**(2026-07-21 사용자 지시).
       예전에는 인스턴스가 쌓여 경고가 필요했지만 그 원인 두 가지를 고쳤다 —
       ⓐ브리지가 이미 떠 있으면 새로 뜨지 않고 물러난다(v3.25.0)
       ⓑ웹이 연결된 하나만 ping해서, 안 쓰는 것은 스스로 종료한다.
       남은 중복은 잠깐 스쳐 갈 뿐이고 웹은 항상 최신에 붙으므로 사용자가
       할 일이 없다. 기능이 실제로 안 맞으면 호출 시점에 오류로 드러난다. */
    // 브리지 필요 탭 잠금/해제 — 숨기지 않고 이유를 남긴다(empty-nav-state)
    $$(".tab[data-needs-bridge]").forEach((b) => {
      if (b.dataset.planned) return;         // 구현 예정 탭은 항상 잠김
      b.disabled = s !== "ok";
      b.title = s === "ok" ? "" : "로컬 런처 연결 필요 — 상태칩을 눌러 안내를 확인하세요";
    });
  };
  bridge.addEventListener("change", render);
  /* 상태칩은 **상태 표시가 본업**이다(2026-07-21 사용자 지시). 정상일 때는
     눌러도 아무 일이 없다 — 굳이 설명창을 띄울 이유가 없다.
     반대로 연결이 안 된 상태에서는 "어떻게 켜지?"를 알아야 하므로 그때만 연다. */
  chip.addEventListener("click", () => {
    if (bridge.state !== "ok") openModal("bridge-modal");
  });
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
    toast("로컬 런처 토큰이 자동 등록됐습니다 — 곧 연결됩니다", "ok");
  }
}

/* ── 브리지 소프트 배너 (SYS-67 C안, 구 T7 하드게이트 대체) ────────────────
   하드 오버레이를 없앴다. 셸·브라우저 전용 탭은 항상 열리고, 브리지 상태는 상단
   얇은 배너로만 안내한다. 브리지 의존 기능(한컴·PDF·사진·EIASS)의 실제 차단은
   브리지 서버측(미승인 시 403)이 담당한다 — 공개 웹의 클라이언트 게이트는 실효가
   없기 때문. 배너는 브리지가 승인·연결됐을 때만 사라진다. */
function initBridgeBanner() {
  const banner = $("#bridge-banner");
  const msgEl = $("#bridge-banner-msg");
  if (!banner || !msgEl) return;

  const render = () => {
    const s = bridge.state;
    const nl = bridge.info?.nodelock;      // C안 브리지가 /ping에 싣는다
    const approved = s === "ok" && (!nl || nl.ok === true);

    if (approved) { banner.hidden = true; return; }
    banner.hidden = false;
    if (s === "checking") {
      msgEl.textContent = "로컬 런처 연결을 확인하는 중입니다…";
    } else if (s === "stub") {
      msgEl.textContent = "진단 스텁 창이 열려 있습니다 — 그 창을 닫고 런처를 실행하세요.";
    } else if (s === "ok" && nl && nl.ok === false) {
      msgEl.textContent = "이 PC는 아직 승인되지 않았습니다 — 등록 요청 후 승인되면 로컬 기능이 열립니다.";
    } else {                                // off — 브리지 없음
      msgEl.textContent = "로컬 런처가 실행되지 않았습니다 — 한컴·PDF·사진 등 로컬 기능은 로컬 런처를 실행·승인한 뒤 사용할 수 있습니다. (브라우저 기능은 그대로 사용 가능)";
    }
  };

  bridge.addEventListener("change", render);
  render();                                 // 초기 표시(state=checking)
}

/* ── 부트 ─────────────────────────────────────────────────────────── */
initVersion();
initTheme();
initPairing();   // bridge.start() 전에 토큰부터 확보
initTabs();      // 탭 버튼 구성
activate(location.hash.slice(1) || TOOLS[0].id, false);  // C안: 첫 탭 즉시 활성(하드게이트 없음)
initBridgeBanner(); // bridge.start() 전에 change 리스너를 걸어 첫 신호를 놓치지 않는다
initBridgeChip();
initSettings();
initModals();
