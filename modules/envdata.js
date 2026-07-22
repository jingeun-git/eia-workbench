/* 환경질 측정 데이터 분석·그래프화 (SYS-41~42)
 * 설계: tasks/specs/2026-07-22-환경질측정데이터분석도구-design.md
 *       tasks/specs/2026-07-22-환경질측정데이터분석도구-마스터플랜.md
 *
 * 분야는 두 갈래 판정방식으로 갈린다(마스터플랜 §1):
 *  - "item"   대기질 등 — 항목별 평균시간 기준과 비교(임계값 1개)
 *  - "region" 소음·진동 — 측정지점마다 지역구분을 고르면 그 지역의 낮/밤 기준과 비교
 * 입력 4단계 폴백: HWP/PDF 자동파싱(브리지, 이번 초안에서는 미구현) → xlsx/csv 업로드
 *   → 붙여넣기 → 그리드 직접입력. 기준DB는 law_client.py로 원문 직접 검증한 값만 담는다.
 */

const FIELDS = [
  { code: "air", label: "대기질", file: "air.json" },
  { code: "noise", label: "소음", file: "noise.json" },
  { code: "vibration", label: "진동", file: "vibration.json" },
  { code: "soil", label: "토양오염도", file: "soil.json" },
  { code: "river_life", label: "하천수질", file: "river_life.json" },
  { code: "lake_life", label: "호소수질", file: "lake_life.json" },
  { code: "groundwater", label: "지하수질", file: "groundwater.json" },
];

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
// chartjs-plugin-datalabels(수치표시)는 annotation 플러그인과 달리 자동등록되지 않는다 — 1회만 등록
if (typeof window !== "undefined" && window.Chart && window.ChartDataLabels) {
  window.Chart.register(window.ChartDataLabels);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtNum(n) { return n == null ? "—" : String(n); }
// range·number 두 입력을 양방향으로 동기화한다 — 표 글자크기에만 있던 "수치 직접입력"을
// 그래프 조절바(가로·세로·막대굵기)에도 동일하게 적용하기 위한 공용 헬퍼.
function bindRangeNumber(rangeEl, numberEl, onChange) {
  const min = Number(rangeEl.min), max = Number(rangeEl.max);
  const clamp = (v) => Math.min(max, Math.max(min, v));
  rangeEl.addEventListener("input", () => {
    numberEl.value = rangeEl.value;
    onChange(Number(rangeEl.value));
  });
  // "input"이 아니라 "change"(blur·엔터 시점)로 커밋한다 — 타이핑 중간에 clamp해서
  // 되쓰면 "75" 입력 중 "7"에서 70으로 튕겨 입력을 방해한다.
  numberEl.addEventListener("change", () => {
    const v = clamp(parseInt(numberEl.value, 10) || min);
    numberEl.value = String(v);
    rangeEl.value = String(v);
    onChange(v);
  });
}
function parseNum(text) {
  let t = String(text ?? "").trim();
  if (t === "") return null;
  // 로케일 입력(숫자패드 등)에서 쉼표가 소수점으로 들어오는 경우 방어
  // — 뒤에 1~2자리만 있으면 소수점, 3자리(천단위)면 구분자로 본다
  if (/,\d{1,2}$/.test(t) && !/,\d{3}\b/.test(t)) t = t.replace(",", ".");
  t = t.replace(/,/g, "");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
// 화면 표시는 SO₂처럼 위/아래첨자를 쓰지만, 매칭(aliases·기간·지역)은 항상 일반 텍스트
// 기준이다 — 그런데 측정업체 원본 파일 헤더가 이미 SO₂·PM₁₀처럼 첨자 유니코드로 와 있으면
// 이 매칭이 실패할 수 있다(사용자 지적, 2026-07-22). 매칭 직전에 첨자를 일반 숫자/기호로
// 되돌려 두 표기 다 인식되게 한다 — 표시(label)는 그대로 두고 매칭에만 영향.
const SUBSUP_TO_ASCII = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "₊": "+", "₋": "-",
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-",
};
function normalizeSubSup(s) {
  return String(s || "").replace(/[₀-₉₊₋⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, (c) => SUBSUP_TO_ASCII[c] || c);
}
function norm(s) { return normalizeSubSup(String(s || "")).toLowerCase().replace(/[\s()（）·./\-]/g, ""); }

async function loadStandardsFor(file, V) {
  const url = new URL(`../shared/env_standards/${file}?v=${V || ""}`, import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`기준DB 로드 실패 (HTTP ${r.status})`);
  return r.json();
}

function findItemByAlias(standards, text) {
  const n = norm(text);
  if (!n) return null;
  for (const item of standards.items) {
    for (const alias of item.aliases) {
      const an = norm(alias);
      if (an && (n.includes(an) || an.includes(n))) return item;
    }
  }
  return null;
}
function findPeriodByAlias(standards, text) {
  const n = norm(text);
  if (!n) return null;
  return standards.periods.find((p) => { const pn = norm(p.label); return pn.includes(n) || n.includes(pn.slice(0, 1)); })
      || standards.periods.find((p) => norm(p.code) === n);
}
// "나" 한 글자만으로 매칭하면 다른 지역의 설명문 속 "나"에도 걸릴 위험이 있어
// 코드 정확일치를 먼저 보고, 라벨은 괄호 앞 핵심명(2글자 이상)만 비교한다.
// 하천/호소 등급명처럼 짧은 등급이 긴 등급의 부분문자열인 경우(좋음 ⊂ 매우좋음/약간좋음)
// 배열 순서상 먼저 나온 region의 substring-포함 매치가 나중에 나온 정확일치 region을
// 가로채는 사고가 있었다(2026-07-22 실측 — "좋음"이 "매우좋음"에 먼저 걸려 Ib 대신 Ia로
// 오판정) → exact-core 매치를 전부 먼저 훑고, 그래도 없을 때만 substring 폴백한다.
function findRegionByAlias(standards, text) {
  const n = norm(text);
  if (!n) return null;
  let hit = (standards.regions || []).find((r) => norm(r.code) === n);
  if (hit) return hit;
  if (n.length < 2) return null;
  const cores = (standards.regions || []).map((r) => ({ r, core: norm(String(r.label || "").split(/[(（]/)[0]) }));
  const exact = cores.find((c) => c.core === n);
  if (exact) return exact.r;
  const fuzzy = cores.find((c) => c.core && (c.core.includes(n) || n.includes(c.core)));
  return fuzzy ? fuzzy.r : null;
}
// 등록문서(측정업체 xlsx)에는 항목이 아닌 관리열이 섞여 있다 — 이를 항목으로 오인해
// 무의미한 사용자 항목을 만들지 않도록 사전 차단한다.
// "no."는 순번열 탐지용으로 넣으면 NO2·CO 같은 화학식 항목명과 겹쳐 오탐하므로 빼고
// 한글 키워드(순번·연번)만으로 순번열을 잡는다.
const ADMIN_HEADER_KEYWORDS = ["기준", "판정", "초과", "적합", "비고", "순번", "연번", "결과",
  "시료명", "조사일", "측정일", "채취일", "일시"];
function isAdminHeader(text) {
  const n = norm(text);
  return ADMIN_HEADER_KEYWORDS.some((kw) => n.includes(norm(kw)));
}
function aoaTranspose(aoa) {
  const ncols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  const out = [];
  for (let c = 0; c < ncols; c++) out.push(aoa.map((r) => (r[c] ?? "")));
  return out;
}
// 첫 N행(또는 전치 후 첫 N열)에서 matchFn에 걸리는 셀이 가장 많은 행을 헤더로 추정 —
// 실무 보고서는 회사명·사업명 등 안내문이 표 위에 몇 줄 더 있는 경우가 흔하다.
function scanBestHeaderRow(aoa, matchFn, limit) {
  const n = Math.min(aoa.length, limit || 15);
  let best = { idx: -1, score: 0 };
  for (let r = 0; r < n; r++) {
    let score = 0;
    for (const cell of (aoa[r] || [])) { if (matchFn(cell)) score++; }
    if (score > best.score) best = { idx: r, score };
  }
  return best;
}

/* ── 다중분석 프로젝트 저장(브라우저 localStorage, 분야별) ──────────────────
 * 단일분석은 저장하지 않는다(사용자 확정, 2026-07-22) — 다중분석만 대상.
 * 프로젝트 = { id, field, name, sites:[{code,label,region}], itemCodes:[...], rounds:[{id,label,values}] }
 */
function projectsStorageKey(fieldCode) { return `eiaw.envdata.projects.${fieldCode}`; }
function loadProjects(fieldCode) {
  try {
    const raw = localStorage.getItem(projectsStorageKey(fieldCode));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveProjects(fieldCode, projects) {
  try { localStorage.setItem(projectsStorageKey(fieldCode), JSON.stringify(projects)); }
  catch (e) { console.error("프로젝트 저장 실패", e); }
}

export async function init(section, { toast, bridge, V }) {
  section.innerHTML = `<div class="panel"><h2>환경질 측정 데이터 분석</h2>
    <div class="placeholder">기준DB를 불러오는 중…</div></div>`;

  let fieldIdx = 0;
  let standards;
  try {
    standards = await loadStandardsFor(FIELDS[fieldIdx].file, V);
  } catch (e) {
    section.innerHTML = `<div class="panel"><h2>환경질 측정 데이터 분석</h2>
      <div class="placeholder">기준DB를 불러오지 못했습니다.<br>${escapeHtml(e.message)}</div></div>`;
    toast("환경질 분석: 기준DB 로드 실패", "fail");
    return;
  }

  /* Chart.js·annotation 플러그인은 index.html에서 plain <script> 태그로 미리 로드된다
     (leaflet.js·xlsx.min.js와 동일한 vendor 패턴) — 모듈 스크립트는 그 뒤에 실행되므로
     탭이 열리는 시점엔 항상 window.Chart가 준비돼 있다. */
  if (!window.Chart) {
    section.innerHTML = `<div class="panel"><h2>환경질 측정 데이터 분석</h2>
      <div class="placeholder">차트 라이브러리를 불러오지 못했습니다 — 새로고침 후 다시 시도해주세요.</div></div>`;
    toast("환경질 분석: Chart.js 로드 실패", "fail");
    return;
  }
  const Chart = window.Chart;

  /* ── 상태 (모듈 전역이 아니라 init 클로저 — 탭은 1회만 init되므로 충분) ── */
  let rowSeq = 0, colSeq = 0;
  const isRegionMode = () => standards.type === "region";
  // columnsFixed:false(토양) — 컬럼이 대기질처럼 항목 추가/삭제 가능. 소음·진동·등급형
  // 수질(하천·호소)은 컬럼이 고정(day/night 또는 pH·BOD… 등 정해진 항목 세트)이라 true.
  const columnsFixed = () => isRegionMode() && standards.columnsFixed !== false;

  function makeColumnFromItem(item) {
    const def = item.standards.find((s) => s.default) || item.standards[0];
    return { id: `c${++colSeq}`, code: item.code, label: item.label, unit: def?.unit || "",
             averaging: def?.averaging || null, custom: false, overrideValue: null, unitScale: 1 };
  }
  function makeColumnFromRegionItem(item) {
    // 토양처럼 "지역구분(행)×항목(열)" 매트릭스인 경우 — 항목 자체가 지역별 값(values)을 가짐.
    // dualStandard가 있는 분야(토양 우려/대책기준)는 2차 기준값 맵도 함께 옮겨야 한다 —
    // 안 옮기면 secondaryStandard()가 항상 null을 반환해 1단계 판정만 걸린다(실제 발견한 버그).
    const col = { id: `c${++colSeq}`, code: item.code, label: item.label, unit: item.unit || standards.unit || "",
                  custom: false, values: item.values };
    if (standards.dualStandard) col[standards.dualStandard.action] = item[standards.dualStandard.action];
    return col;
  }
  function makeCustomColumn(label) {
    return { id: `c${++colSeq}`, code: null, label: label || `열${columns.length + 1}`,
             unit: "", averaging: null, custom: true, overrideValue: null, unitScale: 1 };
  }
  function makePeriodColumn(period) {
    return { id: `c${++colSeq}`, code: period.code, label: period.label, fixed: true };
  }
  // standardKey — 조사지점(행/site)이 어떤 관련기준(환경기준=main 또는 additionalStandards의
  // key)으로 판정받을지. noiseSource는 소음의 "생활소음" 기준을 고를 때만 쓰는 소음원 축.
  // 지점의 속성이라 region과 동일하게 지점 단위로만 붙는다(항목·회차 단위 아님, 2026-07-22 사용자 확정).
  function defaultRowFields() { return { standardKey: "main", noiseSource: null }; }
  function initColumnsAndRows() {
    rowSeq = 0; colSeq = 0;
    if (isRegionMode()) {
      columns = columnsFixed() ? standards.periods.map(makePeriodColumn) : standards.items.map(makeColumnFromRegionItem);
      rows = [1, 2, 3].map(() => ({ id: `r${++rowSeq}`, label: "", region: standards.regions[0]?.code || null, ...defaultRowFields(), values: {} }));
    } else {
      columns = standards.items.map(makeColumnFromItem);
      rows = [1, 2, 3].map(() => ({ id: `r${++rowSeq}`, label: "", values: {} }));
    }
  }
  let columns = [], rows = [];
  initColumnsAndRows();

  let charts = {}; // colId -> Chart 인스턴스
  let chartDebounce = null;
  let bulkApplyCharts = false; // 체크 시 첫 번째로 렌더된 카드의 chartOpts를 나머지 전체에 전파
  let cornerWidth = null; // 측정지점 열 너비(드래그로 조절, px 문자열)
  let regionColWidth = null;
  let transposed = false; // 행/열 전환 — true면 행=조사항목, 열=조사지점
  let selAnchor = null, selecting = false, selectionRect = null; // 셀 드래그 다중선택

  /* ── 다중분석(시계열 누적) 상태 — SYS-49 ──────────────────────────────
   * single: 지금까지의 단일분석(컬럼/행 직접 편집). multi: 프로젝트 큐브(회차×지점×항목)를
   * 슬라이스(지점 고정 또는 항목 고정)해서 같은 표/그래프 엔진으로 보여준다. */
  let analysisMode = "single"; // "single" | "multi"
  let projects = loadProjects(FIELDS[fieldIdx].code);
  let activeProject = null;
  let sliceAxis = null; // "site" | "item"
  let sliceKey = null;  // site.code 또는 item.code
  let multiViewMode = null; // null(슬라이스 선택 전) | "slice" | "newRound"
  let roundSeq = 0;
  let savedSingle = null; // 다중분석 전환 시 단일분석 columns/rows를 잠시 보관
  let currentEditRoundId = null; // multiViewMode==="newRound"일 때 지금 채우고 있는 회차 id
  let refTabIndex = 0; // 분야별 기준값 패널 — 근거법령이 여럿일 때 탭 인덱스(분야 전환 시 0으로 리셋)
  let soilStandardMode = "concern"; // 토양 전용 — "concern"(우려기준) | "action"(대책기준), 표 전체 단위 토글
  const defaultChartColor = cssVar("--accent", "#2f6fed");
  /* 그래프 옵션은 전역이 아니라 컬럼(항목)마다 따로 갖는다 — "그래프별 개별 설정"
     요청 반영. 처음 렌더될 때 col.chartOpts가 없으면 기본값으로 채운다. */
  function chartOptsOf(col) {
    if (!col.chartOpts) {
      col.chartOpts = {
        type: "bar", color: defaultChartColor, height: 260, width: 320, barThickness: null,
        showTitle: true, showLegend: false, showLabels: false,
        yManual: false, yMin: null, yMax: null, yStep: null,
      };
    }
    return col.chartOpts;
  }
  // 일괄적용 체크 시 사용 — 나머지 컬럼의 chartOpts를 sourceCol 것으로 덮어쓴다(사본이라 서로 간섭 없음)
  function applyBulkChartOpts(sourceCol) {
    const src = chartOptsOf(sourceCol);
    for (const c of columns) {
      if (c === sourceCol) continue;
      c.chartOpts = { ...src };
    }
  }

  /* ── 판정 로직 ─────────────────────────────────────────────────────── */
  /* ppm 항목만 ppb 표시로 전환 가능(질량농도 항목은 ppb 개념이 없다) — item 모드 전용 */
  function isPpmItem(col) {
    if (isRegionMode() || col.custom || !col.code) return false;
    const item = standards.items.find((i) => i.code === col.code);
    return item?.standards?.[0]?.unit === "ppm";
  }
  function dbStandard(col) {
    if (col.custom || !col.code || !standards.items) return null;
    const item = standards.items.find((i) => i.code === col.code);
    if (!item) return null;
    const raw = item.standards.find((s) => s.averaging === col.averaging)
        || item.standards.find((s) => s.default) || item.standards[0];
    if (!raw) return null;
    const scale = col.unitScale || 1;
    return scale === 1000 ? { ...raw, value: raw.value * 1000, unit: "ppb" } : raw;
  }
  /* 판정 방향 — 대부분 "이하"(max)지만 등급형 수질은 항목마다 다르다:
     DO(용존산소)는 "이상"(min), pH는 범위(range: [최소,최대]). */
  function isExceed(std, value) {
    if (!std || value == null) return false;
    const dir = std.direction || "max";
    if (dir === "range") { const [mn, mx] = std.value; return value < mn || value > mx; }
    if (dir === "min") return value < std.value;
    return value > std.value;
  }
  function fmtStd(std) {
    if (!std) return "";
    if (std.direction === "range") return `${std.value[0]}~${std.value[1]}${std.unit}`;
    return `${std.value}${std.unit}${std.direction === "min" ? " 이상" : " 이하"}`;
  }
  // 지역구분은 보통 행(지점/회차)의 속성이지만, 다중분석의 "항목 슬라이스"(열=지점)에서는
  // 지역이 열마다 달라진다 — 그때는 컬럼에 fixedRegion을 미리 못박아두고 우선 사용한다.
  // 단일분석 컬럼은 fixedRegion이 없으므로 항상 row.region으로 폴백(기존 동작 무변경).
  function regionOf(col, row) { return col.fixedRegion || row?.region; }
  // standardKey/noiseSource도 region과 동일한 패턴 — 항목슬라이스 컬럼은 fixed*로 못박고,
  // 그 외(단일분석·지점슬라이스·새회차)는 row(=지점)의 속성을 그대로 쓴다.
  function standardKeyOf(col, row) { return col.fixedStandardKey || row?.standardKey || "main"; }
  function noiseSourceOf(col, row) { return col.fixedNoiseSource ?? row?.noiseSource ?? null; }
  // 관련기준(standardKey) 선택지 — 메인 기준(환경기준류) + additionalStandards 각 항목.
  function standardOptions() {
    return [{ key: "main", label: standards.mainTitle || "환경기준" },
      ...(standards.additionalStandards || []).map((e) => ({ key: e.key, label: e.shortTitle || e.title }))];
  }
  // 선택된 관련기준에 맞는 지역구분 선택지 — main이면 standards.regions(가~라 등),
  // additionalStandard면 그 항목의 regionLegend(가/나), 없으면(축사) 빈 배열(선택창 비활성화).
  function regionOptionsFor(skey) {
    skey = skey || "main"; // row.standardKey가 없는(구버전 데이터·다른 분야) 행은 main으로 취급
    if (skey === "main") return standards.regions.map((r) => ({ code: r.code, label: r.label }));
    const extra = standards.additionalStandards?.find((e) => e.key === skey);
    if (!extra?.regionLegend) return [];
    return Object.entries(extra.regionLegend).map(([code, label]) => ({ code, label: `${code}. ${label}` }));
  }
  // 생활소음을 골랐을 때만 필요한 소음원 선택지 — JSON rows에서 (소음원,세부) 조합을 그대로 추출.
  function noiseSourceOptionsFor(skey) {
    if (skey !== "living") return [];
    const extra = standards.additionalStandards?.find((e) => e.key === "living");
    if (!extra) return [];
    const seen = new Set(), opts = [];
    for (const r of extra.rows) {
      const key = `${r[1]}::${r[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({ key, label: r[2] !== "—" ? `${r[1]}-${r[2]}` : r[1] });
    }
    return opts;
  }
  // 소음·진동에서 "관련기준"으로 환경기준이 아닌 도로·철도·생활소음·축사를 고른 지점의
  // 값 조회 — additionalStandards[].rows를 지역(+생활소음이면 소음원)으로 매칭한다.
  // rows shape: 도로/철도=[지역,주간,야간], 생활소음=[지역,소음원,세부,아침저녁,주간,야간],
  // 축사=[구분,값,단위,비고](지역 없음, 소음/진동 필드별로 해당 구분명만 조회).
  function altStandardValue(skey, col, row) {
    const extra = standards.additionalStandards?.find((e) => e.key === skey);
    if (!extra) return null;
    const isDay = col.code === "day";
    if (skey === "livestock") {
      const label = standards.field === "소음" ? "가축피해 소음" : "가축피해 진동";
      const hit = extra.rows.find((r) => r[0] === label);
      if (!hit) return null;
      return { value: hit[1], unit: hit[2], averaging: extra.shortTitle || extra.title, source: "db", direction: "max" };
    }
    const rcode = regionOf(col, row);
    if (!rcode) return null;
    if (skey === "living") {
      const src = noiseSourceOf(col, row);
      if (!src) return null;
      const [srcMain, srcSub] = src.split("::");
      const hit = extra.rows.find((r) => r[0] === rcode && r[1] === srcMain && r[2] === srcSub);
      if (!hit) return null;
      // [지역,소음원,세부,아침저녁,주간,야간] — 아침저녁(3)은 표 열 구조(낮/밤 2칸)와 안 맞아
      // 구현 범위 밖(사용자 지시, 2026-07-22) — 주간(4)→낮, 야간(5)→밤에 매핑.
      const val = isDay ? hit[4] : hit[5];
      return { value: val, unit: standards.unit || "dB(A)", averaging: `${rcode}지역·${srcMain}${srcSub !== "—" ? "-" + srcSub : ""}`, source: "db", direction: "max" };
    }
    // road / rail: [지역,주간,야간]
    const hit = extra.rows.find((r) => r[0] === rcode);
    if (!hit) return null;
    const val = isDay ? hit[1] : hit[2];
    return { value: val, unit: standards.unit || "", averaging: `${rcode}지역(${extra.shortTitle})`, source: "db", direction: "max" };
  }
  function effectiveStandard(col, row) {
    if (isRegionMode()) {
      if (columnsFixed()) {
        const skey = standardKeyOf(col, row);
        if (skey !== "main") return altStandardValue(skey, col, row);
        const region = standards.regions.find((r) => r.code === regionOf(col, row));
        if (!region) return null;
        const period = standards.periods.find((p) => p.code === col.code);
        const raw = region[col.code];
        if (raw == null) return null;
        const isRange = Array.isArray(raw);
        return { value: raw, unit: period?.unit || standards.unit || "", averaging: region.label,
                 source: "db", direction: isRange ? "range" : (period?.direction || "max") };
      }
      // 토양형 — 항목(컬럼) 자신이 지역구분별 값을 갖는다. 우려/대책 두 기준을 한 셀에
      // 늘 함께 보여주던 방식을 폐지하고, 표 상단 토글(soilStandardMode)로 하나만 판정한다
      // (사용자 지시, 2026-07-22 — "선택형으로 전환, 우려 또는 대책 하나만 보기").
      const region = standards.regions.find((r) => r.code === regionOf(col, row));
      if (!region) return null;
      const dual = standards.dualStandard;
      const useAction = dual && soilStandardMode === "action";
      const map = useAction ? col[dual.action] : col.values;
      const val = map?.[regionOf(col, row)];
      const label = dual ? (useAction ? dual.actionLabel : dual.concernLabel) : null;
      return val != null
        ? { value: val, unit: col.unit || standards.unit || "", averaging: label ? `${region.label} · ${label}` : region.label, source: "db", direction: "max" }
        : null;
    }
    const db = dbStandard(col);
    if (col.overrideValue != null)
      return { value: col.overrideValue, unit: db?.unit || (col.unitScale === 1000 ? "ppb" : col.unit) || "",
                averaging: db?.averaging || "사용자지정", source: "custom", direction: db?.direction || "max" };
    if (db) return { ...db, source: "db", direction: db.direction || "max" };
    return null;
  }
  function tooltipFor(col, row) {
    const std = effectiveStandard(col, row);
    if (!std) return "";
    return `기준 ${fmtStd(std)}`;
  }
  /* 판정 등급: -2=기준미등록 -1=값없음 0=정상 1=초과 2=대책기준 초과(토양, 표준선택=대책일 때만) */
  function judgeLevel(col, row, value) {
    if (value == null) return -1;
    const std = effectiveStandard(col, row);
    if (!std) return -2;
    if (!isExceed(std, value)) return 0;
    return (isRegionMode() && !columnsFixed() && standards.dualStandard && soilStandardMode === "action") ? 2 : 1;
  }
  function judge(col, row, value) {
    const lvl = judgeLevel(col, row, value);
    if (lvl === -1) return "";
    if (lvl === -2) return "ed-nostd";
    return lvl === 2 ? "ed-exceed2" : lvl === 1 ? "ed-exceed" : "ed-ok";
  }
  /* ── 마크업 ────────────────────────────────────────────────────────── */
  section.innerHTML = `
  <p class="ed-toppage-note">이 화면은 다중분석 프로젝트에 한해 사용자가 편집한 마지막 상태를 이 브라우저(로컬 PC)에 자동 저장합니다 — 단일분석은 저장되지 않습니다.</p>
  <div class="panel">
    <div class="ed-field-banner" id="ed-field-banner" role="tablist" aria-label="분야 선택"></div>
    <div class="ed-mode-banner" id="ed-mode-banner" role="tablist" aria-label="분석 모드"></div>
    <div class="ed-project-banner" id="ed-project-banner" role="tablist" aria-label="프로젝트" style="display:none"></div>
    <div class="ed-slice-banner" id="ed-slice-banner" style="display:none"></div>
    <div class="ed-newround-bar" id="ed-newround-bar" style="display:none">
      <label>회차명 <input type="text" id="ed-round-label" placeholder="예: 3차(2026-03-10)"></label>
      <button class="btn btn-primary" id="ed-round-done">완료</button>
      <button class="btn btn-secondary" id="ed-round-delete">이 회차 삭제</button>
    </div>
    <div class="panel ed-newproject-form" id="ed-newproject-form" style="display:none">
      <h4 style="margin:0 0 var(--space-2)">새 프로젝트</h4>
      <div class="field"><label>프로젝트명</label><input type="text" id="ed-np-name" placeholder="예: OO사업 2026 대기질 조사"></div>
      <div class="field"><label>조사지점(쉼표로 구분)</label><input type="text" id="ed-np-sites" placeholder="A-1, A-2, A-3, A-4"></div>
      <div class="field" id="ed-np-items-field"><label>조사항목</label><div id="ed-np-items"></div></div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button class="btn btn-primary" id="ed-np-create">프로젝트 생성</button>
        <button class="btn btn-secondary" id="ed-np-cancel">취소</button>
      </div>
    </div>

    <div class="ed-head-flex">
      <div class="ed-head-left">
        <h2 id="ed-title">환경질 측정 데이터 분석</h2>
        <p class="desc" id="ed-desc"></p>

        <div class="field">
          <label>등록문서 업로드 (xlsx·csv·hwp·pdf)</label>
          <label class="dropzone" id="ed-drop">
            <input type="file" id="ed-file" accept=".xlsx,.xls,.csv,.hwp,.pdf">
            <span id="ed-drop-msg">파일을 선택하거나 끌어다 놓으세요 — 첫 행은 항목명, 첫 열은 측정지점으로 인식합니다</span>
          </label>
          <p class="help">xlsx·csv는 바로 인식됩니다. 표의 셀을 클릭한 뒤 Ctrl+V로 엑셀 내용을 직접 붙여넣을 수도 있습니다.</p>
        </div>

        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-bottom:0">
          <select id="ed-add-item" class="ed-add-select"><option value="">+ 항목 추가…</option></select>
          <button class="btn btn-secondary" id="ed-add-row">+ 지점 추가</button>
          <button class="btn btn-secondary" id="ed-reset">표 초기화</button>
        </div>
        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-2)">
          <!-- 행/열전환은 단일·다중분석 공통 "표 보기" 기능이라 위 편집버튼 행(다중분석에서
               숨겨짐)이 아니라 여기(항상 노출) 소속으로 옮겼다 — 다중분석엔 이 버튼 자체가
               없어서 못 쓰던 것을 해소(사용자 지적, 2026-07-22). -->
          <button class="btn btn-secondary" id="ed-transpose" title="행에 조사항목, 열에 조사지점 등으로 표를 뒤집습니다">⇄ 행/열 전환</button>
          <button class="btn btn-secondary" id="ed-export-xlsx" title="표 데이터를 엑셀로 내보냅니다(그래프는 엑셀에서 직접 삽입해주세요)">엑셀로 내보내기</button>
        </div>
      </div>

      <div class="ed-head-right">
        <div class="ed-ref-headrow">
          <h4 id="ed-ref-heading">분야별 기준값</h4>
          <div class="ed-ref-tabs" id="ed-ref-tabs" style="display:none"></div>
        </div>
        <div id="ed-ref-wrap"></div>
      </div>
    </div>
  </div>

  <div class="ed-main panel">
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:var(--space-2)">
      <h3 style="margin:0">표</h3>
      <div style="display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap">
        <div class="ed-item-slice-info" id="ed-item-slice-info" style="display:none"></div>
        <div class="ed-soil-mode" id="ed-soil-mode" style="display:none"></div>
        <label class="ed-chk-label">글자크기
          <input type="range" id="ed-font-size" min="70" max="150" value="100" style="width:110px">
          <input type="number" id="ed-font-size-num" min="70" max="150" value="100" class="ed-slider-num">%
        </label>
      </div>
    </div>
    <div class="ed-scroll" id="ed-scroll">
      <table class="ed-table" id="ed-table">
        <thead><tr id="ed-thead-row"></tr></thead>
        <tbody id="ed-tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="ed-summary panel" id="ed-summary" style="display:none"></div>

  <div class="panel">
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:var(--space-2);margin-bottom:var(--space-2)">
      <h3 style="margin:0">그래프</h3>
      <label class="ed-chk-label"><input type="checkbox" id="ed-chart-bulk"> 전체 그래프에 첫 번째 그래프 설정 일괄적용</label>
    </div>
    <p class="ed-chart-note" style="margin-bottom:var(--space-3)">각 그래프 카드 위쪽 도구에서 타입·색상·크기·막대폭·수치표시·Y축을 그래프별로 따로 설정할 수 있습니다(일괄적용 체크 시 첫 번째 그래프 설정을 전체에 적용).</p>
    <div class="ed-charts" id="ed-charts"></div>
  </div>`;

  const $ = (s) => section.querySelector(s);

  /* 분야 선택 — 드롭다운 대신 클릭형 배너(칩) 사용(사용자 지시, 2026-07-22) */
  function renderFieldBanner() {
    $("#ed-field-banner").innerHTML = FIELDS.map((f, i) =>
      `<button type="button" class="ed-field-btn" data-idx="${i}" aria-pressed="${i === fieldIdx}">${escapeHtml(f.label)}</button>`
    ).join("");
  }
  function updateFieldBannerActive() {
    $("#ed-field-banner").querySelectorAll(".ed-field-btn").forEach((b) => {
      b.setAttribute("aria-pressed", String(parseInt(b.dataset.idx, 10) === fieldIdx));
    });
  }

  /* 분야별 기준값 참고표 — 상단 안내패널 오른쪽 빈 공간에 배치(사용자 지시, 2026-07-22).
     item/region+고정컬럼/region+가변컬럼 3가지 판정모드에 맞춰 표 형태가 갈린다.
     소음·진동처럼 근거법령이 다른 기준이 여러 개면(additionalStandards) 전부 쌓아
     보여주는 대신 탭(패널)으로 나눈다 — 세로로 다 늘어놓으면 스크롤이 지나치게
     길어진다는 실사용 지적(2026-07-22)으로 재설계. */
  function buildReferencePanels() {
    let theadHtml, bodyRows;
    if (!isRegionMode()) {
      theadHtml = `<tr><th>항목</th><th class="num">평균시간</th><th class="num">기준</th><th class="num">단위</th></tr>`;
      bodyRows = standards.items.map((it) => {
        const std = it.standards.find((s) => s.default) || it.standards[0];
        return `<tr><th>${escapeHtml(it.label)}</th><td class="num">${escapeHtml(std?.averaging || "—")}</td>`
          + `<td class="num">${fmtNum(std?.value)}</td><td class="num">${escapeHtml(std?.unit || "")}</td></tr>`;
      });
    } else if (columnsFixed()) {
      // 항목(period) 자체 unit이 없으면(소음·진동처럼 낮/밤이 같은 단위 공유) 분야 공통 unit으로 대체
      const periodUnit = (p) => (p.unit != null ? p.unit : (standards.unit || ""));
      theadHtml = `<tr><th>${escapeHtml(standards.regionLabel || "지역구분")}</th>`
        + standards.periods.map((p) => `<th class="num">${escapeHtml(p.label)}${periodUnit(p) ? ` (${escapeHtml(periodUnit(p))})` : ""}</th>`).join("") + `</tr>`;
      bodyRows = standards.regions.map((r) => {
        const cells = standards.periods.map((p) => {
          const v = r[p.code];
          return `<td class="num">${Array.isArray(v) ? `${v[0]}~${v[1]}` : fmtNum(v)}</td>`;
        }).join("");
        return `<tr><th>${escapeHtml(r.label)}</th>${cells}</tr>`;
      });
    } else {
      const dual = standards.dualStandard;
      theadHtml = `<tr><th>항목</th>` + standards.regions.map((r) => `<th class="num">${escapeHtml(r.code)}</th>`).join("") + `</tr>`;
      bodyRows = standards.items.map((it) => {
        const unit = it.unit || standards.unit || "";
        const cells = standards.regions.map((r) => {
          const v = it.values?.[r.code];
          const v2 = dual ? it[dual.action]?.[r.code] : null;
          return `<td class="num">${fmtNum(v)}${v2 != null ? `/${fmtNum(v2)}` : ""}</td>`;
        }).join("");
        return `<tr><th>${escapeHtml(it.label)}${unit ? ` (${escapeHtml(unit)})` : ""}</th>${cells}</tr>`;
      });
    }
    // 우려/대책기준 표기 안내는 별도 <p>가 아니라 notes 목록에 합류시켜 다른 비고들과
    // 동일하게 불릿이 붙게 한다(2026-07-22 지적 — 혼자만 불릿 없이 떠 있던 사각지대).
    const mergedNotes = [...(standards.notes || [])];
    if (standards.dualStandard) {
      mergedNotes.push(`숫자 표기는 ${standards.dualStandard.concernLabel}/${standards.dualStandard.actionLabel} 순서입니다.`);
    }
    // 원문 비고·보정조항·경고는 법적 판단에 직결되는 단서라 생략하지 않는다(사용자 지시,
    // 2026-07-22) — 지금까지 JSON에 있어도 화면에 안 뜨던 사각지대였다(notes 미출력 확인됨).
    const legal = `<p class="ed-ref-source">* 출처 : ${escapeHtml(standards.legal_basis || "—")}${standards.enacted ? ` / ${escapeHtml(standards.enacted)}` : ""}</p>`;
    const mainHtml = `<div class="ed-ref-scroll"><table class="cap-table ed-ref-table">`
      + `<thead>${theadHtml}</thead><tbody>${bodyRows.join("")}</tbody></table></div>`
      + notesListHtml(mergedNotes) + correctionsListHtml(standards.corrections) + flagsListHtml(standards.criticalFlags)
      + currencyWarningHtml(standards.currencyWarning) + legal;
    const panels = [{ title: standards.mainTitle || "환경기준", html: mainHtml }];
    for (const extra of (standards.additionalStandards || [])) {
      panels.push({ title: extra.shortTitle || extra.title, html: renderExtraStandardTable(extra) });
    }
    return panels;
  }

  // 탭(패널) 방식으로 바뀌면서 "분야별 기준값" 제목도 고정문구가 아니라 상황에 맞게 바뀐다 —
  // 기준이 하나면 그 기준 이름을, 여러 개면 "관련 기준"+탭버튼을 보여준다(사용자 지시, 2026-07-22).
  function renderReferencePanel() {
    const panels = buildReferencePanels();
    if (refTabIndex >= panels.length) refTabIndex = 0;
    const heading = $("#ed-ref-heading");
    const tabsEl = $("#ed-ref-tabs");
    if (panels.length > 1) {
      heading.textContent = "관련 기준";
      tabsEl.style.display = "";
      tabsEl.innerHTML = panels.map((p, i) =>
        `<button type="button" class="ed-ref-tab" data-i="${i}" aria-pressed="${i === refTabIndex}">${escapeHtml(p.title)}</button>`
      ).join("");
    } else {
      heading.textContent = panels[0].title;
      tabsEl.style.display = "none";
      tabsEl.innerHTML = "";
    }
    const intro = (panels.length > 1 && standards.additionalStandardsIntro)
      ? `<p class="ed-ref-intro">${escapeHtml(standards.additionalStandardsIntro)}</p>` : "";
    $("#ed-ref-wrap").innerHTML = intro + panels[refTabIndex].html;
  }

  // notes·corrections·criticalFlags·currencyWarning은 법적 판단에 직결되는 단서라 절대
  // 생략하지 않고 전부 렌더링한다(사용자 지시, 2026-07-22) — 메인표·추가표 양쪽에서 재사용.
  function notesListHtml(notes) {
    return (notes || []).length ? `<ul class="ed-ref-notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : "";
  }
  function correctionsListHtml(corr) {
    return (corr || []).length ? `<div class="ed-ref-corrections"><b>보정</b><ul>${corr.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>` : "";
  }
  function flagsListHtml(flags) {
    return (flags || []).length ? `<div class="ed-ref-warning">${flags.map((f) => `<p>⚠ ${escapeHtml(f)}</p>`).join("")}</div>` : "";
  }
  function currencyWarningHtml(w) {
    return w ? `<div class="ed-ref-currency-warning">⚠ ${escapeHtml(w)}</div>` : "";
  }

  // 근거법령이 다른 기준(예: 소음의 교통관리기준·생활소음규제기준·환경분쟁조정 피해인정기준)은
  // 메인 표에 억지로 합치지 않고 각각 별도 표로 보여준다(사용자 지시, 2026-07-22).
  function renderExtraStandardTable(extra) {
    const cellText = (v) => (v == null ? "—" : escapeHtml(String(v)));
    const head = `<tr>${extra.columns.map((c) => `<th class="num">${escapeHtml(c)}</th>`).join("")}</tr>`;
    const body = extra.rows.map((r) => `<tr>${r.map((cell, i) => (i === 0 ? `<th>${cellText(cell)}</th>` : `<td class="num">${cellText(cell)}</td>`)).join("")}</tr>`).join("");
    const legend = extra.regionLegend
      ? `<p class="ed-ref-note">${Object.entries(extra.regionLegend).map(([k, v]) => `${escapeHtml(k)} = ${escapeHtml(v)}`).join(" · ")}</p>` : "";
    const badge = extra.sourceBadge ? `<span class="ed-ref-badge">${escapeHtml(extra.sourceBadge)}</span>` : "";
    const source = `<p class="ed-ref-source">* 출처 : ${escapeHtml(extra.legal_basis || "—")}${extra.enacted ? ` / ${escapeHtml(extra.enacted)}` : ""}</p>`;
    const nestedTable = extra.extraTable ? `
      <p class="ed-ref-subtitle" style="margin-top:var(--space-2)">${escapeHtml(extra.extraTable.title)}</p>
      <div class="ed-ref-scroll"><table class="cap-table ed-ref-table">
        <thead><tr>${extra.extraTable.columns.map((c) => `<th class="num">${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${extra.extraTable.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th>${cellText(c)}</th>` : `<td class="num">${cellText(c)}</td>`)).join("")}</tr>`).join("")}</tbody>
      </table></div>
      ${extra.extraTable.note ? `<p class="ed-ref-note">${escapeHtml(extra.extraTable.note)}</p>` : ""}` : "";
    return `<div class="ed-ref-extra">
      <p class="ed-ref-subtitle">${escapeHtml(extra.title)}${badge}</p>
      <div class="ed-ref-scroll"><table class="cap-table ed-ref-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      ${legend}${notesListHtml(extra.notes)}${correctionsListHtml(extra.corrections)}${flagsListHtml(extra.criticalFlags)}${currencyWarningHtml(extra.currencyWarning)}${source}${nestedTable}
    </div>`;
  }

  function updateHeaderText() {
    const f = FIELDS[fieldIdx];
    updateFieldBannerActive();
    $("#ed-title").textContent = `환경질 측정 데이터 분석 — ${f.label} (${analysisMode === "multi" ? "다중분석" : "단일분석"})`;
    $("#ed-desc").textContent = isRegionMode()
      ? `측정 결과를 표에 입력하면 ${standards.legal_basis} 기준 초과 여부를 지점별 지역구분에 따라 자동 판별하고 그래프를 그립니다. xlsx·csv 업로드, 붙여넣기, 표 직접 입력을 모두 지원합니다.`
      : `측정 결과를 표에 입력하면 ${standards.legal_basis} 초과 여부를 자동 판별하고 항목별 그래프를 그립니다. xlsx·csv 업로드, 엑셀에서 복사한 내용 붙여넣기, 표 직접 입력을 모두 지원합니다. HWP·PDF 등록문서 자동인식은 브리지 연동 다음 업데이트에서 지원됩니다.`;
    // 다중분석 중엔 컬럼이 프로젝트(sites/itemCodes)에서 파생되므로 구조편집(항목·지점 추가,
    // 표초기화)은 의미가 없다 — 숨긴다. 엑셀 내보내기는 별도 div라 영향받지 않는다.
    $("#ed-add-item").parentElement.style.display = (columnsFixed() || analysisMode === "multi") ? "none" : "";

    renderReferencePanel();
  }

  /* ── 항목 추가 셀렉트 채우기 (item 모드 전용) ─────────────────────── */
  function refreshAddSelect() {
    if (columnsFixed()) return;
    const sel = $("#ed-add-item");
    const used = new Set(columns.filter((c) => !c.custom).map((c) => c.code));
    sel.innerHTML = `<option value="">+ 항목 추가…</option>`
      + standards.items.filter((i) => !used.has(i.code))
          .map((i) => `<option value="${i.code}">${escapeHtml(i.label)}</option>`).join("")
      + `<option value="__custom">직접 입력(사용자 정의 항목)</option>`;
  }

  /* ── 다중분석(시계열 누적) — SYS-49 ───────────────────────────────────
   * 프로젝트 = (회차×지점×항목) 큐브. 같은 표/그래프/판정 엔진을 "슬라이스"로 재사용한다:
   * 지점 고정(행=회차, 열=항목) 또는 항목 고정(행=회차, 열=지점, 열마다 지역이 다를 수 있어
   * col.fixedRegion으로 해결 — regionOf() 참조). */
  function renderModeBanner() {
    $("#ed-mode-banner").innerHTML = ["single", "multi"].map((m) =>
      `<button type="button" class="ed-mode-btn" data-mode="${m}" aria-pressed="${analysisMode === m}">${m === "single" ? "단일분석" : "다중분석"}</button>`
    ).join("");
  }

  function renderProjectBanner() {
    const el = $("#ed-project-banner");
    if (analysisMode !== "multi") { el.style.display = "none"; return; }
    el.style.display = "";
    el.innerHTML = projects.map((p) =>
      `<button type="button" class="ed-project-btn" data-id="${escapeHtml(p.id)}" aria-pressed="${activeProject?.id === p.id}">${escapeHtml(p.name)}<span class="ed-project-btn-del" data-del="${escapeHtml(p.id)}" title="프로젝트 삭제">×</span></button>`
    ).join("") + `<button type="button" class="ed-project-btn ed-project-btn-add" id="ed-project-add">+ 새 프로젝트</button>`;
  }

  function renderSliceBanner() {
    const el = $("#ed-slice-banner");
    if (analysisMode !== "multi" || !activeProject) { el.style.display = "none"; return; }
    el.style.display = "";
    const siteBtns = activeProject.sites.map((s) =>
      `<span class="ed-slice-btn-wrap"><button type="button" class="ed-slice-btn" data-axis="site" data-key="${escapeHtml(s.code)}" aria-pressed="${sliceAxis === "site" && sliceKey === s.code}">${escapeHtml(s.label)}</button><span class="ed-slice-del" data-del-site="${escapeHtml(s.code)}" title="지점 삭제">×</span></span>`
    ).join("");
    const showItemAxis = !columnsFixed(); // columnsFixed 분야는 항목이 이미 고정컬럼이라 별도 항목축이 없다
    const itemBtns = showItemAxis ? activeProject.itemCodes.map((code) => {
      const item = standards.items.find((i) => i.code === code);
      return `<span class="ed-slice-btn-wrap"><button type="button" class="ed-slice-btn" data-axis="item" data-key="${escapeHtml(code)}" aria-pressed="${sliceAxis === "item" && sliceKey === code}">${escapeHtml(item?.label || code)}</button><span class="ed-slice-del" data-del-item="${escapeHtml(code)}" title="항목 삭제">×</span></span>`;
    }).join("") : "";
    el.innerHTML = `
      <div class="ed-slice-group"><span class="ed-slice-group-label">조사지점</span>${siteBtns}<button type="button" class="ed-slice-btn ed-slice-btn-add" id="ed-site-add">+ 지점</button></div>
      ${showItemAxis ? `<div class="ed-slice-group"><span class="ed-slice-group-label">조사항목</span>${itemBtns}<button type="button" class="ed-slice-btn ed-slice-btn-add" id="ed-item-add">+ 항목</button></div>` : ""}
      <button type="button" class="btn btn-secondary" id="ed-round-add">+ 회차 추가</button>`;
  }

  // 지점·항목 추가/삭제 후 "지금 보고 있는 표"를 다시 그린다 — renderSliceBanner()는
  // 위쪽 칩 목록만 갱신하고 아래 상세 표(newRound 입력폼 또는 슬라이스 뷰)는 건드리지
  // 않아서, 편집 중에 지점·항목을 추가해도 표에 새 행/열이 안 나타나던 버그였다
  // (2026-07-22 사용자 실사용 지적 — "회차 추가해도 상세 표에 동기화가 안 된다").
  function refreshCurrentView() {
    if (analysisMode !== "multi" || !activeProject) return;
    if (multiViewMode === "newRound") { buildNewRoundColumnsAndRows(); renderGrid(); scheduleCharts(); }
    else if (multiViewMode === "slice") { buildSliceColumnsAndRows(); renderGrid(); scheduleCharts(); }
  }
  // 프로젝트 생성 후에도 지점·항목을 추가/삭제할 수 있어야 한다(사용자 확정, 2026-07-22).
  // 삭제는 sites/itemCodes 목록에서만 빼고 기존 회차의 값 자체는 그대로 둔다(비파괴적).
  function addSiteToProject() {
    const label = prompt("추가할 조사지점 이름을 입력하세요");
    if (!label || !label.trim()) return;
    activeProject.sites.push({ code: `s${Date.now()}`, label: label.trim(), region: standards.regions?.[0]?.code || null, ...defaultRowFields() });
    saveProjects(FIELDS[fieldIdx].code, projects);
    renderSliceBanner();
    refreshCurrentView();
    toast(`"${label.trim()}" 지점이 추가되었습니다`, "ok");
  }
  function removeSiteFromProject(code) {
    activeProject.sites = activeProject.sites.filter((s) => s.code !== code);
    saveProjects(FIELDS[fieldIdx].code, projects);
    if (sliceAxis === "site" && sliceKey === code) { sliceAxis = null; sliceKey = null; multiViewMode = null; columns = []; rows = []; renderGrid(); renderCharts(); }
    else refreshCurrentView();
    renderSliceBanner();
  }
  function addItemToProject() {
    const used = new Set(activeProject.itemCodes);
    const avail = standards.items.filter((i) => !used.has(i.code));
    if (!avail.length) { toast("추가할 수 있는 항목이 더 없습니다", "warn"); return; }
    const label = prompt(`추가할 항목 이름을 입력하세요 — 선택 가능: ${avail.map((i) => i.label).join(", ")}`);
    if (!label) return;
    const item = avail.find((i) => i.label === label.trim() || i.code === label.trim());
    if (!item) { toast("일치하는 항목을 찾지 못했습니다", "warn"); return; }
    activeProject.itemCodes.push(item.code);
    saveProjects(FIELDS[fieldIdx].code, projects);
    renderSliceBanner();
    refreshCurrentView();
    toast(`"${item.label}" 항목이 추가되었습니다`, "ok");
  }
  function removeItemFromProject(code) {
    activeProject.itemCodes = activeProject.itemCodes.filter((c) => c !== code);
    saveProjects(FIELDS[fieldIdx].code, projects);
    if (sliceAxis === "item" && sliceKey === code) { sliceAxis = null; sliceKey = null; multiViewMode = null; columns = []; rows = []; renderGrid(); renderCharts(); }
    else refreshCurrentView();
    renderSliceBanner();
  }

  // 항목슬라이스는 모든 컬럼(지점)이 같은 항목을 공유하므로, 평균시간·기준·단위를 표 상단에
  // 1회만 보여준다(컬럼마다 반복 표시하던 버그의 대체 UI). item 모드에서만 편집 가능하게 —
  // region+가변컬럼(토양)은 지점마다 지역이 달라 공유 기준이 없어 표시하지 않는다.
  function updateItemSliceInfo() {
    const el = $("#ed-item-slice-info");
    if (analysisMode !== "multi" || sliceAxis !== "item" || isRegionMode() || !columns.length) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    const item = standards.items.find((i) => i.code === sliceKey);
    const std = effectiveStandard(columns[0], null);
    const avgOptions = item.standards.length > 1
      ? item.standards.map((s) => `<option value="${escapeHtml(s.averaging)}" ${s.averaging === columns[0].averaging ? "selected" : ""}>${escapeHtml(s.averaging)}</option>`).join("")
      : "";
    el.innerHTML = `<b>${escapeHtml(item.label)}</b>
      ${avgOptions ? `<select class="ed-item-slice-avg">${avgOptions}</select>` : (columns[0].averaging ? `<span>${escapeHtml(columns[0].averaging)}</span>` : "")}
      <span>기준 <input type="number" class="ed-item-slice-std-input" step="any" value="${std ? std.value : ""}" placeholder="미등록"> ${std ? escapeHtml(std.unit) : ""}</span>`;
    el.querySelector(".ed-item-slice-avg")?.addEventListener("change", (e) => {
      for (const col of columns) col.averaging = e.target.value;
      renderGrid(); scheduleCharts();
    });
    el.querySelector(".ed-item-slice-std-input")?.addEventListener("change", (e) => {
      const v = e.target.value === "" ? null : Number(e.target.value);
      for (const col of columns) col.overrideValue = v;
      renderGrid(); scheduleCharts();
    });
  }

  // 토양 우려/대책기준 전환 — 지점별이 아니라 표 전체 단위 토글이다(사용자 확정, 2026-07-22).
  // 지역구분(1/2/3지역)은 우려·대책 양쪽에 법령상 완전히 동일해 지점 속성은 그대로 두고
  // "그 지역에 어느 기준값 세트를 적용할지"만 바꾸는 것이라 표 전체 토글이 맞는 단위다.
  function renderSoilModeToggle() {
    const el = $("#ed-soil-mode");
    if (!standards.dualStandard) { el.style.display = "none"; return; }
    el.style.display = "";
    const dual = standards.dualStandard;
    el.innerHTML = `
      <button type="button" class="ed-soil-mode-btn" data-mode="concern" aria-pressed="${soilStandardMode === "concern"}">${escapeHtml(dual.concernLabel)}</button>
      <button type="button" class="ed-soil-mode-btn" data-mode="action" aria-pressed="${soilStandardMode === "action"}">${escapeHtml(dual.actionLabel)}</button>`;
    el.querySelectorAll(".ed-soil-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        soilStandardMode = btn.dataset.mode;
        renderGrid(); scheduleCharts();
      });
    });
  }

  // 표와 그래프 사이 "분석 요약" — 표에 값이 입력되면 항목/지점별 최소~최대, 등급범위(있는
  // 분야만), 기준초과 지점·항목을 자동 표출한다(사용자 지시, 2026-07-22). 집계축이 셋으로
  // 갈린다: 단일분석·다중분석-지점슬라이스는 "항목별"(같은 shape — 열=항목,행=지점 또는
  // 행=회차), 다중분석-항목슬라이스는 "지점별 세부 + 지점 무시 전체 통합"(사용자 확인:
  // 지점을 나눠보는 것과 합쳐보는 것 둘 다 필요). "등급이 있다면"은 문자 그대로 등급
  // 개념(순서형 목표등급)이 있는 분야만 — regionLabel이 "목표등급"인 하천·호소만 해당,
  // 소음·진동·토양의 "지역구분"은 순서형 등급이 아니라 용도/범주 구분이라 대상에서 뺐다.
  // "선택한 조사회차 기간"은 별도 회차 범위선택 UI를 새로 만들지 않고, 지금 슬라이스에
  // 보이는 전체 회차 그대로를 대상으로 한다(사용자 확인, 2026-07-22).
  function renderSummary() {
    const el = $("#ed-summary");
    if (analysisMode === "multi" && !multiViewMode) { el.style.display = "none"; return; }
    if (!columns.length || !rows.length) { el.style.display = "none"; return; }

    const cells = [];
    for (const col of columns) for (const row of rows) {
      const raw = row.values[col.id];
      const v = typeof raw === "number" ? raw : parseNum(raw);
      if (v != null && !Number.isNaN(v)) cells.push({ col, row, value: v });
    }
    if (!cells.length) { el.style.display = "none"; return; }

    const hasGrade = standards.regionLabel === "목표등급";
    const fmtRange = (vals) => {
      if (!vals.length) return "—";
      const mn = Math.min(...vals), mx = Math.max(...vals);
      return mn === mx ? fmtNum(mn) : `${fmtNum(mn)}~${fmtNum(mx)}`;
    };
    const gradeRangeOf = (pairs) => {
      if (!hasGrade) return null;
      const idxes = pairs.map(({ col, row }) => standards.regions.findIndex((r) => r.code === regionOf(col, row))).filter((i) => i >= 0);
      if (!idxes.length) return null;
      const mn = Math.min(...idxes), mx = Math.max(...idxes);
      return mn === mx ? standards.regions[mn].label : `${standards.regions[mn].label}~${standards.regions[mx].label}`;
    };
    // includeCol=false — 컬럼(항목 또는 지점)이 이미 그 줄의 <b>로 한 번 나와 있는
    // 문맥(항목별/지점별 세부 줄)에서는 초과 목록에 컬럼명을 반복하지 않는다(2026-07-22
    // 실사용 확인 — "X-1 낮, X-2 낮, X-3 낮"처럼 항목명이 지점마다 중복 표시되던 것 정리).
    // 컬럼이 여러 종류 섞이는 문맥(항목슬라이스의 "전체" 통합 줄)에서만 컬럼명도 함께 남긴다.
    const exceedList = (pairs, includeCol = true) => pairs
      .filter(({ col, row, value }) => isExceed(effectiveStandard(col, row), value))
      .map(({ col, row }) => (includeCol ? `${row.label || ""} ${col.label || ""}`.trim() : (row.label || "").trim()))
      .filter(Boolean);
    const unitOf = (col) => col.unit || dbStandard(col)?.unit || standards.unit || "";

    // "새 회차 추가"(newRound) 입력폼은 항상 행=지점·열=항목 모양이라(어느 슬라이스를
    // 보다 진입했든 무관), sliceAxis가 이전 슬라이스에서 "item"으로 남아있어도 항목슬라이스
    // 로 오분류하면 안 된다 — multiViewMode==="slice"일 때만 실제 슬라이스 모양을 따른다
    // (2026-07-22 실측 버그: newRound에서 항목명이 "지점"칸에 잘못 표시됨).
    const isSingle = analysisMode === "single";
    const isNewRoundShape = analysisMode === "multi" && multiViewMode === "newRound";
    const isSiteSlice = analysisMode === "multi" && multiViewMode === "slice" && sliceAxis === "site";
    const isItemSlice = analysisMode === "multi" && multiViewMode === "slice" && sliceAxis === "item";
    let html = "";

    // 한 표 안에 지점마다 다른 관련기준(소음·진동의 환경기준/도로/축사 등)이 섞여 있으면,
    // 전체를 한 범위로 뭉치는 게 아니라 기준별로 나눠 요약해야 한다 — 서로 다른 문턱값으로
    // 판정되는 값을 하나의 최소~최대에 섞으면 오도한다(사용자 지적, 2026-07-22).
    const stdLabelOf = (skey) => standardOptions().find((o) => o.key === skey)?.label || skey;
    if (isSingle || isSiteSlice || isNewRoundShape) {
      const lines = columns.map((col) => {
        const pairs = cells.filter((c) => c.col === col);
        if (!pairs.length) return null;
        const unit = unitOf(col);
        const groups = new Map();
        for (const p of pairs) {
          const skey = standardKeyOf(col, p.row);
          if (!groups.has(skey)) groups.set(skey, []);
          groups.get(skey).push(p);
        }
        if (groups.size <= 1) {
          const range = fmtRange(pairs.map((p) => p.value));
          const exceeds = exceedList(pairs, false);
          const exceedTxt = exceeds.length ? ` <span class="ed-summary-exceed">⚠ 초과: ${exceeds.map(escapeHtml).join(", ")}</span>` : "";
          return `<li><b>${escapeHtml(col.label)}</b> ${escapeHtml(range)}${escapeHtml(unit)}${exceedTxt}</li>`;
        }
        const subLines = [...groups.entries()].map(([skey, gp]) => {
          const range = fmtRange(gp.map((p) => p.value));
          const exceeds = exceedList(gp, false);
          const exceedTxt = exceeds.length ? ` <span class="ed-summary-exceed">⚠ 초과: ${exceeds.map(escapeHtml).join(", ")}</span>` : "";
          return `<li>${escapeHtml(stdLabelOf(skey))}: ${escapeHtml(range)}${escapeHtml(unit)}${exceedTxt}</li>`;
        });
        return `<li><b>${escapeHtml(col.label)}</b><ul class="ed-summary-substd">${subLines.join("")}</ul></li>`;
      }).filter(Boolean);
      const grade = gradeRangeOf(cells.map(({ col, row }) => ({ col, row })));
      html = `<h3 style="margin:0 0 var(--space-2)">분석 요약</h3>`
        + (grade ? `<p class="ed-summary-grade">목표등급 범위: <b>${escapeHtml(grade)}</b></p>` : "")
        + `<ul class="ed-summary-list">${lines.join("")}</ul>`;
    } else if (isItemSlice) {
      const overallRange = fmtRange(cells.map((c) => c.value));
      const overallUnit = unitOf(columns[0]);
      const overallGrade = gradeRangeOf(cells.map(({ col, row }) => ({ col, row })));
      const allExceeds = exceedList(cells);
      const perSite = columns.map((col) => {
        const pairs = cells.filter((c) => c.col === col);
        if (!pairs.length) return null;
        const range = fmtRange(pairs.map((p) => p.value));
        const exceeds = exceedList(pairs, false);
        const exceedTxt = exceeds.length ? ` <span class="ed-summary-exceed">⚠ 초과: ${exceeds.map(escapeHtml).join(", ")}</span>` : "";
        return `<li><b>${escapeHtml(col.label)}</b> ${escapeHtml(range)}${escapeHtml(overallUnit)}${exceedTxt}</li>`;
      }).filter(Boolean);
      html = `<h3 style="margin:0 0 var(--space-2)">분석 요약</h3>`
        + `<p class="ed-summary-overall">전체(지점 무시): <b>${escapeHtml(overallRange)}${escapeHtml(overallUnit)}</b>`
        + (overallGrade ? ` · 목표등급 범위 <b>${escapeHtml(overallGrade)}</b>` : "")
        + (allExceeds.length ? ` <span class="ed-summary-exceed">⚠ 초과: ${allExceeds.map(escapeHtml).join(", ")}</span>` : "")
        + `</p><p class="ed-summary-sub">지점별</p><ul class="ed-summary-list">${perSite.join("")}</ul>`;
    }

    el.innerHTML = html;
    el.style.display = html ? "" : "none";
  }

  function buildSliceColumnsAndRows() {
    const proj = activeProject;
    if (sliceAxis === "site") {
      const site = proj.sites.find((s) => s.code === sliceKey);
      columns = columnsFixed()
        ? standards.periods.map(makePeriodColumn)
        : proj.itemCodes.map((code) => {
            const item = standards.items.find((i) => i.code === code);
            return isRegionMode() ? makeColumnFromRegionItem(item) : makeColumnFromItem(item);
          });
      rows = proj.rounds.map((r) => ({
        id: r.id, label: r.label, region: site?.region || null,
        standardKey: site?.standardKey || "main", noiseSource: site?.noiseSource || null,
        values: Object.fromEntries(columns.map((c) => [c.id, r.values[site?.code]?.[c.code] ?? null])),
      }));
    } else {
      const item = standards.items.find((i) => i.code === sliceKey);
      columns = proj.sites.map((site) => {
        const base = isRegionMode() ? makeColumnFromRegionItem(item) : makeColumnFromItem(item);
        base.label = site.label;
        base.siteCode = site.code;
        base.fixedRegion = site.region;
        base.fixedStandardKey = site.standardKey || "main";
        base.fixedNoiseSource = site.noiseSource || null;
        return base;
      });
      rows = proj.rounds.map((r) => ({
        id: r.id, label: r.label, region: null,
        values: Object.fromEntries(columns.map((c) => [c.id, r.values[c.siteCode]?.[item.code] ?? null])),
      }));
    }
  }

  function buildNewRoundColumnsAndRows() {
    const proj = activeProject;
    columns = columnsFixed()
      ? standards.periods.map(makePeriodColumn)
      : proj.itemCodes.map((code) => {
          const item = standards.items.find((i) => i.code === code);
          return isRegionMode() ? makeColumnFromRegionItem(item) : makeColumnFromItem(item);
        });
    rows = proj.sites.map((site) => ({
      id: site.code, label: site.label, region: site.region,
      standardKey: site.standardKey || "main", noiseSource: site.noiseSource || null,
      values: {},
    }));
  }

  // 슬라이스 뷰(과거 회차) 셀을 고치면 프로젝트 큐브에도 즉시 되쓴다 — 읽기전용이면
  // "분석 도구"로서 쓸모가 떨어진다(오탈자 정정 등 실무 수요).
  function persistSliceEdits() {
    if (analysisMode !== "multi" || !activeProject) return;
    if (multiViewMode === "newRound") {
      // 새 회차 입력폼(지점×항목)도 슬라이스와 똑같이 매 입력마다 즉시 저장한다 — 별도
      // "저장" 버튼을 두면 안 누르고 나갈 때 데이터가 사라진다(실사용 지적으로 단일 흐름화).
      const round = activeProject.rounds.find((r) => r.id === currentEditRoundId);
      if (!round) return;
      for (const row of rows) { // row = 지점(row.id = site.code)
        const site = activeProject.sites.find((s) => s.code === row.id);
        if (site && row.region != null) site.region = row.region;
        if (site && row.standardKey != null) site.standardKey = row.standardKey;
        if (site) site.noiseSource = row.noiseSource ?? null;
        round.values[row.id] = round.values[row.id] || {};
        for (const col of columns) round.values[row.id][col.code] = row.values[col.id] ?? null;
      }
      saveProjects(FIELDS[fieldIdx].code, projects);
      return;
    }
    if (multiViewMode !== "slice") return;
    // 지점 슬라이스는 모든 행(회차)이 같은 지점이라 지역구분도 그 지점 전체의 속성이다 —
    // 슬라이스뷰에서 지역을 바꾸면 지점 자체에 반영한다(회차 추가 폼과 동일한 문제).
    if (sliceAxis === "site") {
      const site = activeProject.sites.find((s) => s.code === sliceKey);
      const changed = rows.find((r) => r.region != null && r.region !== site?.region);
      if (site && changed) site.region = changed.region;
      const stdChanged = rows.find((r) => r.standardKey != null && r.standardKey !== site?.standardKey);
      if (site && stdChanged) site.standardKey = stdChanged.standardKey;
      const srcChanged = rows.find((r) => r.noiseSource !== undefined && r.noiseSource !== site?.noiseSource);
      if (site && srcChanged) site.noiseSource = srcChanged.noiseSource;
    }
    for (const row of rows) {
      const round = activeProject.rounds.find((r) => r.id === row.id);
      if (!round) continue;
      for (const col of columns) {
        const val = row.values[col.id];
        if (sliceAxis === "site") {
          round.values[sliceKey] = round.values[sliceKey] || {};
          round.values[sliceKey][col.code] = val;
        } else {
          round.values[col.siteCode] = round.values[col.siteCode] || {};
          round.values[col.siteCode][sliceKey] = val;
        }
      }
    }
    saveProjects(FIELDS[fieldIdx].code, projects);
  }

  function switchAnalysisMode(mode) {
    if (mode === analysisMode) return;
    if (mode === "multi") {
      savedSingle = { columns, rows };
      analysisMode = "multi";
    } else {
      analysisMode = "single";
      if (savedSingle) { columns = savedSingle.columns; rows = savedSingle.rows; }
      else initColumnsAndRows();
    }
    activeProject = null; sliceAxis = null; sliceKey = null; multiViewMode = null;
    if (mode === "multi") { columns = []; rows = []; }
    // 단일분석에서 뒤집어 보던 상태가 다중분석으로(혹은 반대로) 그대로 넘어와 기본값이
    // 아닌 채로 시작하던 버그(사용자 지적, 2026-07-22) — 모드 전환 시 항상 기본값(false)으로.
    transposed = false;
    currentEditRoundId = null;
    $("#ed-newround-bar").style.display = "none";
    renderModeBanner(); renderProjectBanner(); renderSliceBanner(); updateHeaderText(); refreshAddSelect();
    renderGrid(); renderCharts();
  }

  function selectProject(id) {
    activeProject = projects.find((p) => p.id === id) || null;
    sliceAxis = null; sliceKey = null; multiViewMode = null;
    currentEditRoundId = null;
    columns = []; rows = [];
    $("#ed-newround-bar").style.display = "none";
    renderProjectBanner(); renderSliceBanner();
    renderGrid(); renderCharts();
  }

  function deleteProject(id) {
    projects = projects.filter((p) => p.id !== id);
    saveProjects(FIELDS[fieldIdx].code, projects);
    if (activeProject?.id === id) {
      activeProject = null; sliceAxis = null; sliceKey = null; multiViewMode = null;
      columns = []; rows = [];
      currentEditRoundId = null;
    }
    renderProjectBanner(); renderSliceBanner(); renderGrid(); renderCharts();
  }

  function selectSlice(axis, key) {
    sliceAxis = axis; sliceKey = key; multiViewMode = "slice";
    currentEditRoundId = null;
    buildSliceColumnsAndRows();
    renderSliceBanner();
    $("#ed-newround-bar").style.display = "none";
    renderGrid(); renderCharts();
  }

  // "+ 회차 추가"를 누르면 즉시 회차를 만들어 큐브에 넣고 그 회차의 (지점×항목) 입력폼을
  // 연다 — 이전엔 입력 후 "회차 저장"을 따로 눌러야 했는데, 안 누르고 다른 화면으로 가면
  // 데이터가 통째로 사라지는 버그로 이어졌다(실사용 지적). 이제 매 셀 입력이 슬라이스뷰와
  // 동일하게 즉시 저장되므로 "저장" 버튼 자체가 없다 — "완료"는 그냥 슬라이스 화면으로 복귀.
  function startNewRound() {
    const label = `${activeProject.rounds.length + 1}차`;
    const round = { id: `r${Date.now()}`, label, values: {} };
    activeProject.rounds.push(round);
    saveProjects(FIELDS[fieldIdx].code, projects);
    currentEditRoundId = round.id;
    multiViewMode = "newRound";
    buildNewRoundColumnsAndRows();
    renderGrid(); renderCharts();
    $("#ed-newround-bar").style.display = "";
    $("#ed-round-label").value = label;
    toast(`"${label}" 회차를 추가했습니다 — 표에 입력하면 바로 저장됩니다`, "ok");
  }

  function renameCurrentRound() {
    if (!currentEditRoundId) return;
    const round = activeProject.rounds.find((r) => r.id === currentEditRoundId);
    const label = $("#ed-round-label").value.trim();
    if (!round || !label) return;
    round.label = label;
    saveProjects(FIELDS[fieldIdx].code, projects);
  }

  function finishNewRound() {
    currentEditRoundId = null;
    multiViewMode = sliceAxis ? "slice" : null;
    if (multiViewMode === "slice") buildSliceColumnsAndRows();
    else { columns = []; rows = []; }
    $("#ed-newround-bar").style.display = "none";
    renderGrid(); renderCharts();
  }

  function deleteCurrentRound() {
    if (!currentEditRoundId) return;
    activeProject.rounds = activeProject.rounds.filter((r) => r.id !== currentEditRoundId);
    saveProjects(FIELDS[fieldIdx].code, projects);
    toast("회차를 삭제했습니다", "ok");
    finishNewRound();
  }

  function openNewProjectForm() {
    $("#ed-newproject-form").style.display = "";
    $("#ed-np-name").value = "";
    $("#ed-np-sites").value = "";
    const itemsField = $("#ed-np-items-field");
    if (columnsFixed()) {
      itemsField.style.display = "none";
    } else {
      itemsField.style.display = "";
      $("#ed-np-items").innerHTML = standards.items.map((it) =>
        `<label><input type="checkbox" value="${escapeHtml(it.code)}" checked> ${escapeHtml(it.label)}</label>`
      ).join("");
    }
  }
  function closeNewProjectForm() { $("#ed-newproject-form").style.display = "none"; }

  function createProjectFromForm() {
    const name = $("#ed-np-name").value.trim();
    const siteNames = $("#ed-np-sites").value.trim().split(",").map((s) => s.trim()).filter(Boolean);
    if (!name) { toast("프로젝트명을 입력해주세요", "warn"); return; }
    if (!siteNames.length) { toast("조사지점을 1개 이상 입력해주세요", "warn"); return; }
    const defaultRegion = standards.regions?.[0]?.code || null;
    const sites = siteNames.map((label, i) => ({ code: `s${Date.now()}_${i}`, label, region: defaultRegion, ...defaultRowFields() }));
    let itemCodes = [];
    if (!columnsFixed()) {
      itemCodes = [...$("#ed-np-items").querySelectorAll("input:checked")].map((el) => el.value);
      if (!itemCodes.length) { toast("조사항목을 1개 이상 선택해주세요", "warn"); return; }
    }
    const proj = { id: `p${Date.now()}`, field: FIELDS[fieldIdx].code, name, sites, itemCodes, rounds: [] };
    projects.push(proj);
    saveProjects(FIELDS[fieldIdx].code, projects);
    closeNewProjectForm();
    renderProjectBanner();
    selectProject(proj.id);
    toast(`"${name}" 프로젝트를 만들었습니다`, "ok");
  }

  function exportTableToExcel() {
    if (!window.XLSX) { toast("엑셀 라이브러리를 불러오지 못했습니다", "fail"); return; }
    const aoa = [["측정지점/회차", ...columns.map((c) => c.label)]];
    for (const row of rows) aoa.push([row.label || "", ...columns.map((c) => row.values[c.id] ?? "")]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "측정데이터");
    XLSX.writeFile(wb, `${standards.field}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast("엑셀로 내보냈습니다 — 차트는 엑셀에서 표를 선택한 뒤 삽입 메뉴로 추가해주세요", "ok");
  }

  /* ── 그리드 렌더 ───────────────────────────────────────────────────── */
  function attachColDrag(th, col) {
    th.draggable = true;
    th.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/ed-col", col.id));
    th.addEventListener("dragover", (e) => e.preventDefault());
    th.addEventListener("drop", (e) => {
      e.preventDefault();
      const srcId = e.dataTransfer.getData("text/ed-col");
      if (!srcId || srcId === col.id) return;
      const from = columns.findIndex((c) => c.id === srcId);
      const to = columns.findIndex((c) => c.id === col.id);
      const [moved] = columns.splice(from, 1);
      columns.splice(to, 0, moved);
      renderGrid(); scheduleCharts();
    });
  }
  function attachRowDrag(handle, row) {
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/ed-row", row.id));
    handle.addEventListener("dragover", (e) => e.preventDefault());
    handle.addEventListener("drop", (e) => {
      e.preventDefault();
      const srcId = e.dataTransfer.getData("text/ed-row");
      if (!srcId || srcId === row.id) return;
      const from = rows.findIndex((r) => r.id === srcId);
      const to = rows.findIndex((r) => r.id === row.id);
      const [moved] = rows.splice(from, 1);
      rows.splice(to, 0, moved);
      renderGrid(); scheduleCharts();
    });
  }

  /* 열 너비 조절 손잡이 — geocode 탭(gc-resizer)과 동일한 상호작용을 재사용.
     draggable=false로 둬서 옆의 컬럼 드래그(순서변경)가 오작동하지 않게 한다. */
  function addResizer(th, onResize) {
    const h = document.createElement("span");
    h.className = "ed-resizer";
    h.title = "끌어서 너비 조절";
    h.draggable = false;
    th.appendChild(h);
    let x0 = 0, w0 = 0;
    const move = (ev) => { th.style.width = `${Math.max(40, w0 + (ev.clientX - x0))}px`; };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("ed-resizing");
      onResize(th.style.width);
    };
    h.addEventListener("mousedown", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      x0 = ev.clientX; w0 = th.offsetWidth;
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      document.body.classList.add("ed-resizing");
    });
  }

  // 관련기준(select) + 생활소음일 때만 나오는 소음원(select) — 한 셀 안에 같이 둔다.
  // 컬럼 수를 그때그때 바꾸면(사용자에 따라 소음원 열이 생기고 없어지고) 헤더 칸수가
  // 안 맞는 사고가 재발하므로(2026-07-22 comment 참조), 열 자체는 고정하고 셀 내부만 바뀐다.
  function buildStandardCell(row, onChange) {
    const td = document.createElement("td");
    td.className = "ed-standard-cell";
    const stdSel = document.createElement("select");
    stdSel.className = "ed-standard-select";
    stdSel.innerHTML = standardOptions().map((o) =>
      `<option value="${o.key}" ${o.key === row.standardKey ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    td.appendChild(stdSel);
    const srcOpts = noiseSourceOptionsFor(row.standardKey);
    const srcSel = document.createElement("select");
    srcSel.className = "ed-noisesource-select";
    srcSel.style.display = srcOpts.length ? "" : "none";
    srcSel.innerHTML = srcOpts.map((o) =>
      `<option value="${o.key}" ${o.key === row.noiseSource ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    td.appendChild(srcSel);
    stdSel.addEventListener("change", () => {
      row.standardKey = stdSel.value;
      const regOpts = regionOptionsFor(row.standardKey);
      row.region = regOpts[0]?.code ?? null;
      const newSrcOpts = noiseSourceOptionsFor(row.standardKey);
      row.noiseSource = newSrcOpts[0]?.key ?? null;
      onChange();
    });
    srcSel.addEventListener("change", () => { row.noiseSource = srcSel.value; onChange(); });
    return td;
  }
  // 지역구분 select — 관련기준에 따라 옵션 목록이 바뀌거나(도로/철도/생활소음=가·나)
  // 아예 없어져(축사) 비활성화된다. main이면 기존 standards.regions 그대로.
  function buildRegionCell(row, onChange) {
    const td = document.createElement("td");
    td.className = "ed-region-cell";
    const opts = regionOptionsFor(row.standardKey);
    const sel = document.createElement("select");
    sel.className = "ed-region-select";
    if (!opts.length) {
      sel.disabled = true;
      sel.innerHTML = `<option>지역구분 없음</option>`;
    } else {
      sel.innerHTML = opts.map((o) =>
        `<option value="${o.code}" ${o.code === row.region ? "selected" : ""} title="${escapeHtml(o.label)}">${escapeHtml(o.label)}</option>`).join("");
      sel.addEventListener("change", () => { row.region = sel.value; onChange(); });
    }
    td.appendChild(sel);
    return td;
  }

  function renderGrid() {
    updateItemSliceInfo();
    renderSoilModeToggle();
    // transposed는 분야·모드 전환 시 코드에서 직접 리셋되기도 해서(전환 이력이 새
    // 분야/모드로 새어나가던 버그, 2026-07-22), 버튼의 눌림 표시도 매 렌더마다 변수값에
    // 맞춰 동기화한다 — 클릭 핸들러에서만 갱신하면 프로그램적 리셋이 화면에 반영 안 된다.
    $("#ed-transpose")?.setAttribute("aria-pressed", String(transposed));
    renderSummary();
    // 다중분석에서 아직 프로젝트/슬라이스를 고르지 않았으면 표를 그릴 데이터 모양이 없다 —
    // 빈 표 대신 무엇을 눌러야 하는지 안내한다.
    if (analysisMode === "multi" && !multiViewMode) {
      $("#ed-thead-row").innerHTML = "";
      $("#ed-tbody").innerHTML = "";
      const scroll = $("#ed-scroll");
      scroll.querySelectorAll(".ed-multi-placeholder").forEach((el) => el.remove());
      const ph = document.createElement("div");
      ph.className = "placeholder ed-multi-placeholder";
      ph.textContent = activeProject
        ? "위에서 조사지점 또는 조사항목을 선택하거나 '+ 회차 추가'로 새 조사결과를 등록하세요"
        : "다중분석 배너에서 프로젝트를 선택하거나 '+ 새 프로젝트'로 시작하세요";
      scroll.appendChild(ph);
      return;
    }
    $("#ed-scroll").querySelectorAll(".ed-multi-placeholder").forEach((el) => el.remove());
    if (transposed) { renderGridTransposed(); return; }
    const thead = $("#ed-thead-row");
    thead.innerHTML = "";
    // tbody 각 행은 [드래그핸들, 측정지점명, (지역구분,) 항목…, 삭제] 순 — 헤더도 칸 수를
    // 정확히 맞춰야 컬럼이 한 칸씩 밀리지 않는다(2026-07-22 실사용 중 발견한 근본 원인).
    const dragTh = document.createElement("th");
    dragTh.style.width = "22px";
    thead.appendChild(dragTh);
    const corner = document.createElement("th");
    corner.textContent = "측정지점";
    corner.style.width = cornerWidth || "110px";
    addResizer(corner, (w) => { cornerWidth = w; });
    thead.appendChild(corner);

    // 관련기준(standardKey) 열 — 소음·진동처럼 additionalStandards(도로·철도·생활소음·축사)가
    // 있는 분야만. 토양은 표 전체 토글(ed-soil-mode)로 처리하므로 이 열이 필요 없다.
    if (isRegionMode() && columnsFixed() && standards.additionalStandards?.length) {
      const stdTh = document.createElement("th");
      stdTh.textContent = "관련기준";
      stdTh.style.width = "120px";
      thead.appendChild(stdTh);
    }
    if (isRegionMode()) {
      const regionTh = document.createElement("th");
      regionTh.textContent = standards.regionLabel || "지역구분";
      regionTh.style.width = regionColWidth || "210px";
      addResizer(regionTh, (w) => { regionColWidth = w; });
      thead.appendChild(regionTh);
    }

    for (const col of columns) {
      const th = document.createElement("th");
      th.dataset.col = col.id;
      th.style.width = col.width || "128px";

      if (col.siteCode != null) {
        // 다중분석 항목슬라이스 — 컬럼은 지점일 뿐 항목(기준·평균시간·단위)은 전부 공통이라
        // 컬럼마다 반복 표시하지 않는다. 공통 정보는 표 상단에 1회만(updateItemSliceInfo()) —
        // 지점 헤더에 기준값·단위가 나오는 건 버그라는 실사용 지적으로 수정(2026-07-22).
        th.title = "";
        th.innerHTML = `<div class="ed-col-label">${escapeHtml(col.label)}</div>`;
        addResizer(th, (w) => { col.width = w; });
        thead.appendChild(th);
        continue;
      }
      if (isRegionMode() && columnsFixed()) {
        // 소음·진동·등급형 수질 — 컬럼이 고정(시간대/항목 세트)이라 삭제·평균시간 선택 없음
        th.title = "";
        th.innerHTML = `<div class="ed-col-label">${escapeHtml(col.label)}${standards.unit ? ` <span class="ed-unit">(${escapeHtml(standards.unit)})</span>` : ""}</div>`;
        addResizer(th, (w) => { col.width = w; });
        thead.appendChild(th);
        continue;
      }
      if (isRegionMode() && !columnsFixed()) {
        // 토양형 — 대기질처럼 항목 추가·삭제·드래그는 되지만 지역구분별로 기준이 갈려
        // 컬럼 하나에 고정된 "기준" 입력은 의미가 없다(행마다 다른 값을 봐야 한다).
        th.title = "드래그해서 항목 순서 변경";
        th.innerHTML = `
          <div class="ed-col-grip">⋮⋮</div>
          <div class="ed-col-label">${escapeHtml(col.label)}${col.unit ? ` <span class="ed-unit">(${escapeHtml(col.unit)})</span>` : ""}</div>
          <button type="button" class="ed-col-del" title="항목 삭제">×</button>`;
        attachColDrag(th, col);
        addResizer(th, (w) => { col.width = w; });
        th.querySelector(".ed-col-del").addEventListener("click", () => {
          columns = columns.filter((c) => c.id !== col.id);
          rows.forEach((r) => delete r.values[col.id]);
          refreshAddSelect(); renderGrid(); scheduleCharts();
        });
        thead.appendChild(th);
        continue;
      }

      th.title = "드래그해서 항목 순서 변경";
      // table-layout:fixed(리사이즈에 필요)는 min-width를 무시하고 컨테이너 폭에
      // 맞춰 칸을 균등 압축한다 — 폭을 명시하지 않으면 항목이 좁은 표 폭에 짓눌려
      // 글자가 여러 줄로 접히고 헤더가 수백 px까지 늘어난다(2026-07-22 실측).
      const std = effectiveStandard(col, null);
      const dispUnit = col.unitScale === 1000 ? "ppb" : col.unit;
      const avgOptions = (!col.custom && standards.items.find((i) => i.code === col.code)?.standards.length > 1)
        ? standards.items.find((i) => i.code === col.code).standards.map((s) =>
            `<option value="${s.averaging}" ${s.averaging === col.averaging ? "selected" : ""}>${s.averaging}</option>`).join("")
        : "";
      const unitToggle = isPpmItem(col)
        ? `<select class="ed-unitscale-select">
             <option value="1" ${col.unitScale !== 1000 ? "selected" : ""}>ppm</option>
             <option value="1000" ${col.unitScale === 1000 ? "selected" : ""}>ppb</option>
           </select>`
        : "";
      th.innerHTML = `
        <div class="ed-col-grip">⋮⋮</div>
        <div class="ed-col-label">${escapeHtml(col.label)}${dispUnit ? ` <span class="ed-unit">(${escapeHtml(dispUnit)})</span>` : ""}</div>
        <div class="ed-col-sub">
          ${avgOptions ? `<select class="ed-avg-select">${avgOptions}</select>` : ""}
          ${unitToggle}
        </div>
        <div class="ed-col-std">
          기준<input type="number" class="ed-std-input" step="any"
            value="${std ? std.value : ""}" placeholder="미등록">
          ${std ? `<span class="ed-std-unit">${escapeHtml(std.unit)}</span>` : ""}
          ${col.overrideValue != null ? `<button type="button" class="ed-std-reset" title="기준DB 기본값으로">↺</button>` : ""}
        </div>
        <button type="button" class="ed-col-del" title="항목 삭제">×</button>`;
      attachColDrag(th, col);
      addResizer(th, (w) => { col.width = w; });

      const avgSel = th.querySelector(".ed-avg-select");
      if (avgSel) avgSel.addEventListener("change", () => { col.averaging = avgSel.value; renderGrid(); scheduleCharts(); });

      const unitSel = th.querySelector(".ed-unitscale-select");
      if (unitSel) unitSel.addEventListener("change", () => {
        const newScale = parseInt(unitSel.value, 10);
        const factor = newScale / (col.unitScale || 1);
        if (factor !== 1) {
          for (const row of rows) {
            const v = row.values[col.id];
            if (v != null) row.values[col.id] = v * factor;
          }
          if (col.overrideValue != null) col.overrideValue *= factor;
        }
        col.unitScale = newScale;
        renderGrid(); scheduleCharts();
      });

      const stdInput = th.querySelector(".ed-std-input");
      stdInput.addEventListener("change", () => {
        const v = parseNum(stdInput.value);
        const db = dbStandard(col);
        col.overrideValue = (v != null && v !== db?.value) ? v : null;
        renderGrid(); scheduleCharts();
      });
      const resetBtn = th.querySelector(".ed-std-reset");
      if (resetBtn) resetBtn.addEventListener("click", () => { col.overrideValue = null; renderGrid(); scheduleCharts(); });

      th.querySelector(".ed-col-del").addEventListener("click", () => {
        columns = columns.filter((c) => c.id !== col.id);
        rows.forEach((r) => delete r.values[col.id]);
        refreshAddSelect(); renderGrid(); scheduleCharts();
      });
      thead.appendChild(th);
    }
    const delTh = document.createElement("th");
    delTh.style.width = "34px";
    thead.appendChild(delTh);

    const tbody = $("#ed-tbody");
    tbody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.row = row.id;

      const handleTd = document.createElement("td");
      handleTd.className = "ed-row-drag";
      handleTd.textContent = "⋮⋮";
      handleTd.title = "드래그해서 지점 순서 변경";
      attachRowDrag(handleTd, row);
      tr.appendChild(handleTd);

      const labelTd = document.createElement("td");
      labelTd.className = "ed-row-label";
      labelTd.contentEditable = "true";
      labelTd.dataset.row = row.id;
      labelTd.dataset.col = "-1";
      labelTd.textContent = row.label;
      tr.appendChild(labelTd);

      if (isRegionMode() && columnsFixed() && standards.additionalStandards?.length) {
        tr.appendChild(buildStandardCell(row, () => { renderGrid(); scheduleCharts(); }));
      }
      if (isRegionMode()) {
        tr.appendChild(buildRegionCell(row, () => { renderGrid(); scheduleCharts(); }));
      }

      for (const col of columns) {
        const td = document.createElement("td");
        const val = row.values[col.id];
        td.className = `ed-cell ${judge(col, row, val)}`;
        const tip = tooltipFor(col, row);
        if (tip) td.title = tip;
        td.contentEditable = "true";
        td.dataset.row = row.id;
        td.dataset.col = col.id;
        td.textContent = val == null ? "" : String(val);
        tr.appendChild(td);
      }

      const delTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.className = "ed-row-del"; delBtn.title = "지점 삭제";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", () => {
        rows = rows.filter((r) => r.id !== row.id);
        renderGrid(); scheduleCharts();
      });
      delTd.appendChild(delBtn);
      tr.appendChild(delTd);

      tbody.appendChild(tr);
    }
    attachCellEvents();
  }

  /* 행/열 전환 — 행=조사항목(columns), 열=조사지점(rows). 데이터 모델(columns/rows,
     values는 항상 site.values[col.id])은 그대로 두고 DOM 배치만 뒤집는다 — 표를
     새로 만들지 않고 그대로 보여주는 방식만 바꾸는 것이라 판정·차트 로직은 무변경.
     너비 드래그 조절은 이 모드에서는 생략한다(행 높이 조절은 실익이 적어 단순화). */
  function renderGridTransposed() {
    const thead = $("#ed-thead-row");
    thead.innerHTML = "";
    const dragTh = document.createElement("th");
    dragTh.style.width = "22px";
    thead.appendChild(dragTh);
    const corner = document.createElement("th");
    corner.textContent = "조사항목";
    corner.style.width = cornerWidth || "140px";
    thead.appendChild(corner);

    for (const row of rows) {
      const th = document.createElement("th");
      th.dataset.row = row.id;
      th.style.width = "128px";
      th.title = "드래그해서 지점 순서 변경";
      const showStandardSel = isRegionMode() && columnsFixed() && standards.additionalStandards?.length;
      const standardOptionsHtml = showStandardSel
        ? `<select class="ed-standard-select">${standardOptions().map((o) =>
            `<option value="${o.key}" ${o.key === row.standardKey ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>
           <select class="ed-noisesource-select" style="display:${noiseSourceOptionsFor(row.standardKey).length ? "" : "none"}">${noiseSourceOptionsFor(row.standardKey).map((o) =>
            `<option value="${o.key}" ${o.key === row.noiseSource ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>`
        : "";
      const regionOpts = isRegionMode() ? regionOptionsFor(row.standardKey) : [];
      const regionOptions = isRegionMode()
        ? (regionOpts.length
            ? `<select class="ed-region-select">${regionOpts.map((o) =>
                `<option value="${o.code}" ${o.code === row.region ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>`
            : `<select class="ed-region-select" disabled><option>지역구분 없음</option></select>`)
        : "";
      th.innerHTML = `
        <div class="ed-col-grip">⋮⋮</div>
        <div class="ed-site-label" contenteditable="true">${escapeHtml(row.label)}</div>
        ${standardOptionsHtml}
        ${regionOptions}
        <button type="button" class="ed-col-del" title="지점 삭제">×</button>`;
      th.draggable = true;
      th.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/ed-row", row.id));
      th.addEventListener("dragover", (e) => e.preventDefault());
      th.addEventListener("drop", (e) => {
        e.preventDefault();
        const srcId = e.dataTransfer.getData("text/ed-row");
        if (!srcId || srcId === row.id) return;
        const from = rows.findIndex((r) => r.id === srcId);
        const to = rows.findIndex((r) => r.id === row.id);
        const [moved] = rows.splice(from, 1);
        rows.splice(to, 0, moved);
        renderGrid(); scheduleCharts();
      });
      th.querySelector(".ed-site-label").addEventListener("input", (e) => { row.label = e.target.textContent.trim(); });
      const standardSel = th.querySelector(".ed-standard-select");
      if (standardSel) standardSel.addEventListener("change", () => {
        row.standardKey = standardSel.value;
        row.region = regionOptionsFor(row.standardKey)[0]?.code ?? null;
        row.noiseSource = noiseSourceOptionsFor(row.standardKey)[0]?.key ?? null;
        renderGrid(); scheduleCharts();
      });
      const noiseSrcSel = th.querySelector(".ed-noisesource-select");
      if (noiseSrcSel) noiseSrcSel.addEventListener("change", () => { row.noiseSource = noiseSrcSel.value; renderGrid(); scheduleCharts(); });
      const regionSel = th.querySelector(".ed-region-select");
      if (regionSel && !regionSel.disabled) regionSel.addEventListener("change", () => { row.region = regionSel.value; renderGrid(); scheduleCharts(); });
      th.querySelector(".ed-col-del").addEventListener("click", () => {
        rows = rows.filter((r) => r.id !== row.id);
        renderGrid(); scheduleCharts();
      });
      thead.appendChild(th);
    }
    const delTh = document.createElement("th");
    delTh.style.width = "34px";
    thead.appendChild(delTh);

    const tbody = $("#ed-tbody");
    tbody.innerHTML = "";
    for (const col of columns) {
      const tr = document.createElement("tr");
      tr.dataset.col = col.id;

      const handleTd = document.createElement("td");
      handleTd.className = "ed-row-drag";
      handleTd.textContent = "⋮⋮";
      handleTd.title = "드래그해서 항목 순서 변경";
      handleTd.draggable = true;
      handleTd.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/ed-col", col.id));
      handleTd.addEventListener("dragover", (e) => e.preventDefault());
      handleTd.addEventListener("drop", (e) => {
        e.preventDefault();
        const srcId = e.dataTransfer.getData("text/ed-col");
        if (!srcId || srcId === col.id) return;
        const from = columns.findIndex((c) => c.id === srcId);
        const to = columns.findIndex((c) => c.id === col.id);
        const [moved] = columns.splice(from, 1);
        columns.splice(to, 0, moved);
        renderGrid(); scheduleCharts();
      });
      tr.appendChild(handleTd);

      const labelTd = document.createElement("td");
      labelTd.className = "ed-row-label";
      buildGroupCellContent(labelTd, col);
      tr.appendChild(labelTd);

      for (const row of rows) {
        const td = document.createElement("td");
        const val = row.values[col.id];
        td.className = `ed-cell ${judge(col, row, val)}`;
        const tip = tooltipFor(col, row);
        if (tip) td.title = tip;
        td.contentEditable = "true";
        td.dataset.row = row.id;
        td.dataset.col = col.id;
        td.textContent = val == null ? "" : String(val);
        tr.appendChild(td);
      }

      if (!columnsFixed()) {
        const delTd = document.createElement("td");
        const delBtn = document.createElement("button");
        delBtn.type = "button"; delBtn.className = "ed-row-del"; delBtn.title = "항목 삭제";
        delBtn.textContent = "×";
        delBtn.addEventListener("click", () => {
          columns = columns.filter((c) => c.id !== col.id);
          rows.forEach((r) => delete r.values[col.id]);
          refreshAddSelect(); renderGrid(); scheduleCharts();
        });
        delTd.appendChild(delBtn);
        tr.appendChild(delTd);
      } else {
        tr.appendChild(document.createElement("td"));
      }

      tbody.appendChild(tr);
    }
    attachCellEvents();
  }

  /* item/region 항목의 라벨+컨트롤(평균시간·ppm/ppb·기준입력·삭제)을 만든다.
     정상모드 th(컬럼헤더)와 전환모드 td(행헤더)에서 똑같이 재사용 — 리사이즈만
     정상모드 th 쪽에서 별도로 addResizer()를 붙인다(전환모드는 리사이즈 생략). */
  function buildGroupCellContent(el, col) {
    if (isRegionMode() && columnsFixed()) {
      el.innerHTML = `<div class="ed-col-label">${escapeHtml(col.label)}${standards.unit ? ` <span class="ed-unit">(${escapeHtml(standards.unit)})</span>` : ""}</div>`;
      return;
    }
    if (isRegionMode() && !columnsFixed()) {
      el.innerHTML = `
        <div class="ed-col-grip">⋮⋮</div>
        <div class="ed-col-label">${escapeHtml(col.label)}${col.unit ? ` <span class="ed-unit">(${escapeHtml(col.unit)})</span>` : ""}</div>
        <button type="button" class="ed-col-del" title="항목 삭제">×</button>`;
      attachColDrag(el, col);
      el.querySelector(".ed-col-del").addEventListener("click", () => {
        columns = columns.filter((c) => c.id !== col.id);
        rows.forEach((r) => delete r.values[col.id]);
        refreshAddSelect(); renderGrid(); scheduleCharts();
      });
      return;
    }
    // item 모드
    const std = effectiveStandard(col, null);
    const dispUnit = col.unitScale === 1000 ? "ppb" : col.unit;
    const avgOptions = (!col.custom && standards.items.find((i) => i.code === col.code)?.standards.length > 1)
      ? standards.items.find((i) => i.code === col.code).standards.map((s) =>
          `<option value="${s.averaging}" ${s.averaging === col.averaging ? "selected" : ""}>${s.averaging}</option>`).join("")
      : "";
    const unitToggle = isPpmItem(col)
      ? `<select class="ed-unitscale-select">
           <option value="1" ${col.unitScale !== 1000 ? "selected" : ""}>ppm</option>
           <option value="1000" ${col.unitScale === 1000 ? "selected" : ""}>ppb</option>
         </select>`
      : "";
    el.innerHTML = `
      <div class="ed-col-grip">⋮⋮</div>
      <div class="ed-col-label">${escapeHtml(col.label)}${dispUnit ? ` <span class="ed-unit">(${escapeHtml(dispUnit)})</span>` : ""}</div>
      <div class="ed-col-sub">
        ${avgOptions ? `<select class="ed-avg-select">${avgOptions}</select>` : ""}
        ${unitToggle}
      </div>
      <div class="ed-col-std">
        기준<input type="number" class="ed-std-input" step="any" value="${std ? std.value : ""}" placeholder="미등록">
        ${std ? `<span class="ed-std-unit">${escapeHtml(std.unit)}</span>` : ""}
        ${col.overrideValue != null ? `<button type="button" class="ed-std-reset" title="기준DB 기본값으로">↺</button>` : ""}
      </div>
      <button type="button" class="ed-col-del" title="항목 삭제">×</button>`;
    attachColDrag(el, col);
    const avgSel = el.querySelector(".ed-avg-select");
    if (avgSel) avgSel.addEventListener("change", () => { col.averaging = avgSel.value; renderGrid(); scheduleCharts(); });
    const unitSel = el.querySelector(".ed-unitscale-select");
    if (unitSel) unitSel.addEventListener("change", () => {
      const newScale = parseInt(unitSel.value, 10);
      const factor = newScale / (col.unitScale || 1);
      if (factor !== 1) {
        for (const row of rows) { const v = row.values[col.id]; if (v != null) row.values[col.id] = v * factor; }
        if (col.overrideValue != null) col.overrideValue *= factor;
      }
      col.unitScale = newScale;
      renderGrid(); scheduleCharts();
    });
    const stdInput = el.querySelector(".ed-std-input");
    stdInput.addEventListener("change", () => {
      const v = parseNum(stdInput.value);
      const db = dbStandard(col);
      col.overrideValue = (v != null && v !== db?.value) ? v : null;
      renderGrid(); scheduleCharts();
    });
    const resetBtn = el.querySelector(".ed-std-reset");
    if (resetBtn) resetBtn.addEventListener("click", () => { col.overrideValue = null; renderGrid(); scheduleCharts(); });
    el.querySelector(".ed-col-del").addEventListener("click", () => {
      columns = columns.filter((c) => c.id !== col.id);
      rows.forEach((r) => delete r.values[col.id]);
      refreshAddSelect(); renderGrid(); scheduleCharts();
    });
  }

  /* 셀 값 편집 — 구조 변경이 아니므로 전체 재렌더 없이 값·판정 클래스만 갱신 */
  function attachCellEvents() {
    section.querySelectorAll("[data-row]").forEach((cell) => {
      cell.addEventListener("input", () => {
        const rowId = cell.dataset.row, colId = cell.dataset.col;
        const row = rows.find((r) => r.id === rowId);
        if (!row) return;
        if (colId === "-1") {
          row.label = cell.textContent.trim();
        } else {
          const col = columns.find((c) => c.id === colId);
          const v = parseNum(cell.textContent);
          row.values[colId] = v;
          if (col) cell.className = `ed-cell ${judge(col, row, v)}`;
        }
        scheduleCharts();
      });
    });
    // addEventListener는 같은 함수 참조면 브라우저가 중복 등록을 걸러내므로
    // renderGrid마다 다시 불러도 안전하다(#ed-table은 재렌더에도 유지되는 안정된 요소).
    const table = section.querySelector("#ed-table");
    table.addEventListener("paste", onPaste);
    table.addEventListener("mousedown", onCellMouseDown);
    table.addEventListener("mouseover", onCellMouseOver);
  }

  /* ── 셀 다중선택(드래그) — 클릭+드래그로 사각 범위를 고르고 Delete로 비우거나
     Ctrl+C로 TSV째 복사한다. contenteditable 셀이라 브라우저 기본 텍스트선택과
     충돌하므로, 앵커 셀과 다른 셀로 넘어가는 순간부터 우리 하이라이트로 대신한다. */
  function cellPos(cellEl) {
    const rowId = cellEl.dataset.row, colId = cellEl.dataset.col;
    if (rowId == null || colId === "-1") return null;
    const ri = rows.findIndex((r) => r.id === rowId);
    const ci = columns.findIndex((c) => c.id === colId);
    if (ri < 0 || ci < 0) return null;
    return { ri, ci };
  }
  function clearSelectionHighlight() {
    section.querySelectorAll(".ed-selected").forEach((el) => el.classList.remove("ed-selected"));
  }
  function applySelection(a, b) {
    const r0 = Math.min(a.ri, b.ri), r1 = Math.max(a.ri, b.ri);
    const c0 = Math.min(a.ci, b.ci), c1 = Math.max(a.ci, b.ci);
    clearSelectionHighlight();
    section.querySelectorAll(".ed-cell[data-row][data-col]").forEach((el) => {
      const p = cellPos(el);
      if (p && p.ri >= r0 && p.ri <= r1 && p.ci >= c0 && p.ci <= c1) el.classList.add("ed-selected");
    });
    selectionRect = { r0, r1, c0, c1 };
  }
  function onCellMouseDown(e) {
    const cell = e.target.closest(".ed-cell");
    if (!cell) { selAnchor = null; selectionRect = null; clearSelectionHighlight(); return; }
    const pos = cellPos(cell);
    if (!pos) return;
    selAnchor = pos; selecting = true;
    applySelection(pos, pos);
  }
  function onCellMouseOver(e) {
    if (!selecting || !selAnchor) return;
    const cell = e.target.closest(".ed-cell");
    if (!cell) return;
    const pos = cellPos(cell);
    if (!pos) return;
    applySelection(selAnchor, pos);
  }

  /* ── 붙여넣기 ──────────────────────────────────────────────────────── */
  function ensureCustomColumn(label) {
    const col = makeCustomColumn(label);
    columns.push(col);
    return col;
  }
  function ensureRowAt(idx) {
    while (rows.length <= idx)
      rows.push({ id: `r${++rowSeq}`, label: "", region: standards.regions?.[0]?.code || null, ...defaultRowFields(), values: {} });
    return rows[idx];
  }
  /* 붙여넣은 텍스트 격자를 뒤집는다 — 전환모드에서는 화면에 보이는 대로(줄=항목,
     칸=지점) 복사했을 값을 데이터모델 기준(줄=지점,칸=항목)으로 맞추기 위함.
     이렇게 해두면 아래 배치 로직은 방향과 무관하게 그대로 재사용된다. */
  function transposeGrid(g) {
    const nCols = Math.max(0, ...g.map((r) => r.length));
    const out = [];
    for (let c = 0; c < nCols; c++) { const line = []; for (let r = 0; r < g.length; r++) line.push(g[r][c] ?? ""); out.push(line); }
    return out;
  }
  /* 엑셀·워드·HWP 등에서 표를 복사하면 브라우저 클립보드에 text/html(<table>)이
     함께 담기는 경우가 많다 — text/plain은 앱마다 탭 구분이 깨지거나(줄바꿈만
     주고 셀 구분자가 없는 경우 실사용에서 확인됨) 신뢰할 수 없어 html을 우선
     신뢰한다. */
  function parseHtmlTable(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const table = doc.querySelector("table");
      if (!table) return null;
      const grid = [...table.querySelectorAll("tr")]
        .map((tr) => [...tr.querySelectorAll("td,th")].map((td) => td.textContent.replace(/ /g, " ").trim()))
        .filter((line) => line.some((c) => c !== ""));
      return grid.length ? grid : null;
    } catch (_) { return null; }
  }
  function onPaste(e) {
    const target = e.target.closest("[data-row]");
    if (!target) return;
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    let grid = parseHtmlTable(cd.getData("text/html"));
    let fromHtml = !!grid;
    if (!grid) {
      const text = cd.getData("text/plain");
      grid = text.replace(/\r/g, "").split("\n").filter((l) => l.length).map((l) => l.split("\t"));
    }
    if (!grid.length) return;

    const startRowIdx = rows.findIndex((r) => r.id === target.dataset.row);
    const startColIdx = columns.findIndex((c) => c.id === target.dataset.col);
    const baseColIdx = target.dataset.col === "-1" ? -1 : startColIdx;
    const fixedCols = columnsFixed();

    // html도 아니고 tab도 하나도 없는 평문(일부 문서뷰어·PDF 복사가 이렇게 준다) —
    // 표를 복사한 게 맞다면 남은 열 수의 배수일 가능성이 높아 그 폭으로 재배열한다.
    // (실사용 확인: HWP 표 3×3을 복사했더니 tab 없이 9줄로만 붙여진 사례)
    if (!fromHtml && grid.every((l) => l.length === 1) && grid.length > 1) {
      const remainingCols = Math.max(1, columns.length - Math.max(baseColIdx, 0));
      if (remainingCols > 1 && grid.length % remainingCols === 0 && grid.length > remainingCols) {
        const flat = grid.map((l) => l[0]);
        const reshaped = [];
        for (let i = 0; i < flat.length; i += remainingCols) reshaped.push(flat.slice(i, i + remainingCols));
        grid = reshaped;
        toast(`탭 구분이 없는 텍스트를 ${remainingCols}열 기준으로 재배열했습니다 — 결과를 확인해주세요`, "warn");
      }
    }
    if (transposed) grid = transposeGrid(grid);

    grid.forEach((line, ri) => {
      const row = ensureRowAt(startRowIdx + ri);
      line.forEach((cellText, ci) => {
        const colIdx = baseColIdx + ci;
        const text2 = String(cellText).trim();
        if (colIdx === -1) { row.label = text2; return; }
        if (fixedCols) {
          if (colIdx < 0 || colIdx >= columns.length) return; // 열이 고정(예: 낮/밤)이라 초과분은 무시
        } else {
          while (columns.length <= colIdx) ensureCustomColumn(`열${columns.length + 1}`);
        }
        row.values[columns[colIdx].id] = parseNum(text2);
      });
    });
    refreshAddSelect(); renderGrid(); scheduleCharts();
    toast(`붙여넣기 완료 — ${grid.length}행 반영`, "ok");
  }

  /* ── xlsx/csv 업로드 ──────────────────────────────────────────────────
   * 실제 측정업체 등록문서는 "1행=헤더, 1열=지점명"이라는 이상적 형태를 잘 지키지 않는다
   * (사업명 안내문이 표 위에 몇 줄 더 있거나, 항목이 행 방향으로 뒤집혀 있거나, 순번·판정
   * 같은 관리열이 섞여 있는 경우가 흔하다). 아래는 그런 변형을 스캔으로 흡수한다:
   *  ① 헤더행 자동탐지(전처리 안내문 스킵) ② 방향 자동판별(뒤집힌 표 자동전환)
   *  ③ 지점명 열 자동탐지(꼭 1열이 아닐 수 있음) ④ region 모드면 지역구분 열도 자동인식
   *  ⑤ 순번·판정 등 관리열은 항목으로 오인하지 않고 제외 ⑥ 무엇을 어떻게 읽었는지 토스트로 투명하게 보고
   */
  function applyAoaToGrid(aoa) {
    if (!aoa.length) { toast("빈 파일입니다", "fail"); return; }
    const regionMode = isRegionMode();
    const fixedCols = columnsFixed();
    const matchFn = fixedCols
      ? (cell) => !!findPeriodByAlias(standards, cell)
      : (cell) => !!findItemByAlias(standards, cell);

    // ① + ② 헤더행·방향 판별 — 원본과 전치본 중 매칭 점수가 더 높은 쪽을 채택
    const rowScan = scanBestHeaderRow(aoa, matchFn);
    const colScan = scanBestHeaderRow(aoaTranspose(aoa), matchFn);
    const flipped = colScan.score > rowScan.score;
    const work = flipped ? aoaTranspose(aoa) : aoa;
    const headerScan = flipped ? colScan : rowScan;
    const headerRowIdx = headerScan.idx >= 0 ? headerScan.idx : 0;
    const header = work[headerRowIdx] || [];
    const dataRows = work.slice(headerRowIdx + 1);

    // ③ 지점명 열 판별 — 데이터 구간에서 "숫자로 안 읽히는 셀"이 가장 많은 열
    const scanCols = Math.min(header.length, 6);
    let labelCol = 0, labelScore = -1;
    for (let c = 0; c < scanCols; c++) {
      let filled = 0, textish = 0;
      for (const line of dataRows) {
        const v = line[c];
        if (v == null || String(v).trim() === "") continue;
        filled++;
        if (parseNum(v) == null) textish++;
      }
      const score = filled > 0 ? textish / filled : -1;
      if (score > labelScore) { labelScore = score; labelCol = c; }
    }

    // ④ 지역구분 열 판별(region 모드에서만) — 헤더에 "지역/등급/구분"이 있고 실제 값이 지역DB와 매칭될 때만
    let regionCol = -1;
    if (regionMode) {
      for (let c = 0; c < header.length; c++) {
        if (c === labelCol) continue;
        if (!/지역|등급|구분/.test(String(header[c] || ""))) continue;
        const sample = dataRows.find((line) => line[c] != null && String(line[c]).trim() !== "");
        if (sample && findRegionByAlias(standards, sample[c])) { regionCol = c; break; }
      }
    }

    // ⑤ 컬럼 매핑 — 관리열 제외, 항목/기간 별칭 매칭, 못 찾으면 사용자 항목으로 보존(투명 보고용 기록)
    const newColumns = fixedCols ? standards.periods.map(makePeriodColumn) : [];
    const colIndexMap = [];
    const unmatchedHeaders = [], skippedAdmin = [];
    if (!fixedCols) {
      for (let c = 0; c < header.length; c++) {
        if (c === labelCol || c === regionCol) continue;
        const h = String(header[c] || "").trim();
        if (!h) continue;
        if (isAdminHeader(h)) { skippedAdmin.push(h); continue; }
        const item = findItemByAlias(standards, h);
        newColumns.push(item ? (regionMode ? makeColumnFromRegionItem(item) : makeColumnFromItem(item)) : makeCustomColumn(h));
        if (!item) unmatchedHeaders.push(h);
        colIndexMap.push(c);
      }
    } else {
      // 관리열(비고·판정 등)은 폴백 후보에서도 제외 — 안 그러면 못 찾은 항목이 관리열 값을
      // 잘못 주워가는 경우가 생긴다(예: TOC를 못 찾으면 다음 후보인 "비고"열을 대신 읽어버림).
      const restIdxs = header.map((_, idx) => idx).filter((idx) => idx !== labelCol && idx !== regionCol && !isAdminHeader(header[idx]));
      newColumns.forEach((col, ci) => {
        const hi = header.findIndex((h, idx) => idx !== labelCol && idx !== regionCol && findPeriodByAlias(standards, h)?.code === col.code);
        colIndexMap.push(hi >= 0 ? hi : restIdxs[ci]);
      });
    }

    // 행 생성
    const newRows = [];
    let regionAssigned = 0;
    for (const line of dataRows) {
      const label = String(line[labelCol] ?? "").trim();
      if (!label) continue;
      const values = {};
      newColumns.forEach((col, ci) => { values[col.id] = parseNum(line[colIndexMap[ci]]); });
      let region = standards.regions?.[0]?.code || null;
      if (regionCol >= 0) {
        const hit = findRegionByAlias(standards, line[regionCol]);
        if (hit) { region = hit.code; regionAssigned++; }
      }
      newRows.push({ id: `r${++rowSeq}`, label, region, values });
    }
    if (!newRows.length) {
      toast("표 형식을 인식하지 못했습니다 — 헤더행·지점명열을 찾지 못했습니다. 직접 입력하거나 붙여넣기를 이용해주세요", "warn");
      return;
    }
    columns = newColumns; rows = newRows;
    refreshAddSelect(); renderGrid(); scheduleCharts();

    const parts = [`${newRows.length}개 지점 × ${newColumns.length}개 항목을 불러왔습니다`];
    if (headerRowIdx > 0) parts.push(`${headerRowIdx + 1}행을 헤더로 인식(상단 안내문 ${headerRowIdx}행 제외)`);
    if (flipped) parts.push("행/열이 뒤집힌 표를 자동으로 맞춤");
    if (regionMode) parts.push(regionAssigned > 0 ? `지역구분 ${regionAssigned}건 자동인식` : "지역구분은 직접 선택해주세요");
    if (unmatchedHeaders.length) parts.push(`미인식 ${unmatchedHeaders.length}개는 사용자 항목으로 추가(${unmatchedHeaders.slice(0, 3).join("·")}${unmatchedHeaders.length > 3 ? " 등" : ""})`);
    if (skippedAdmin.length) parts.push(`관리열 ${skippedAdmin.length}개 제외(${skippedAdmin.slice(0, 3).join("·")}${skippedAdmin.length > 3 ? " 등" : ""})`);
    toast(parts.join(" · "), unmatchedHeaders.length || skippedAdmin.length ? "warn" : "ok");
  }

  async function handleFile(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    try {
      if (["xlsx", "xls", "csv"].includes(ext)) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        applyAoaToGrid(aoa);
      } else if (["hwp", "pdf"].includes(ext)) {
        toast("HWP·PDF 등록문서 자동인식은 브리지 연동 다음 업데이트에서 지원됩니다 — "
          + "지금은 xlsx로 변환하거나 표에 직접 입력·붙여넣기 해주세요", "warn");
      } else {
        toast("지원하지 않는 파일 형식입니다 (xlsx·csv·hwp·pdf)", "fail");
      }
    } catch (e) {
      toast(`파일 읽기 실패: ${e.message}`, "fail");
    }
  }

  /* ── 차트 ──────────────────────────────────────────────────────────── */
  function scheduleCharts() {
    clearTimeout(chartDebounce);
    chartDebounce = setTimeout(() => { renderCharts(); renderSummary(); persistSliceEdits(); }, 350);
  }
  // 차트마다 옵션이 다르므로(col.chartOpts) 설정 값을 반영한 Chart.js config를 매번 새로 만든다
  function buildChartConfig(col, { forExport } = {}) {
    const opts = chartOptsOf(col);
    const regionMode = isRegionMode();
    // PNG 내보내기는 화면 테마(다크 포함)와 무관하게 항상 라이트 고정색을 쓴다(사용자 지시,
    // 2026-07-22) — 보고서 삽입용이라 다크 톤이 인쇄·문서에서 흐릿하게 보이면 안 된다.
    // tokens.css 라이트 테마의 --fail/--warn 실값을 그대로 하드코딩(전역 테마 토글 없이 안전하게).
    const failColor = forExport ? "#DC2626" : cssVar("--fail", "#d64545");
    const warnColor = forExport ? "#D97706" : cssVar("--warn", "#c98a1c");
    const actionColor = "#9b1c1c"; // 대책기준(2차) 초과 — 우려기준 초과(failColor)보다 한 단계 진한 색(테마 무관 고정값)
    const data = rows.map((r) => (r.values[col.id] == null ? null : Number(r.values[col.id])));
    const colors = data.map((v, i) => {
      const lvl = judgeLevel(col, regionMode ? rows[i] : null, v);
      return lvl === 2 ? actionColor : lvl === 1 ? failColor : opts.color;
    });
    const singleStd = !regionMode ? effectiveStandard(col, null) : null;
    const annotations = (singleStd && singleStd.direction !== "range") ? {
      stdLine: {
        type: "line", yMin: singleStd.value, yMax: singleStd.value,
        borderColor: warnColor, borderWidth: 2, borderDash: [6, 4],
        label: { display: true, content: `기준 ${fmtStd(singleStd)}(${singleStd.averaging}${singleStd.source === "custom" ? "·사용자지정" : ""})`,
                  position: "end", backgroundColor: warnColor, color: "#fff", font: { size: 10 } },
      },
    } : {};
    return {
      type: opts.type,
      data: {
        labels: rows.map((r) => r.label || "(이름없음)"),
        datasets: [{
          label: col.label, data, backgroundColor: colors, borderColor: colors,
          tension: opts.type === "line" ? 0.25 : 0, fill: false,
          barThickness: opts.barThickness || undefined,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: opts.showLegend },
          title: { display: opts.showTitle, text: col.label, font: { size: 13 } },
          annotation: { annotations },
          datalabels: window.ChartDataLabels ? {
            display: opts.showLabels, anchor: "end", align: "top", font: { size: 10 },
            formatter: (v) => (v == null ? "" : v),
          } : undefined,
          tooltip: regionMode ? {
            callbacks: {
              afterLabel: (ctx) => tooltipFor(col, rows[ctx.dataIndex]) || "기준 미등록",
            },
          } : undefined,
        },
        scales: {
          y: {
            beginAtZero: !opts.yManual,
            ...(opts.yManual && opts.yMin != null ? { min: opts.yMin } : {}),
            ...(opts.yManual && opts.yMax != null ? { max: opts.yMax } : {}),
            ...(opts.yManual && opts.yStep != null ? { ticks: { stepSize: opts.yStep } } : {}),
            title: { display: !!(singleStd || regionMode), text: singleStd?.unit || standards.unit || "" },
          },
        },
      },
    };
  }

  function rebuildChart(col, canvas) {
    if (charts[col.id]) { charts[col.id].destroy(); delete charts[col.id]; }
    charts[col.id] = new Chart(canvas.getContext("2d"), buildChartConfig(col));
  }

  // 96dpi 기준 CSS px를 그대로 저장하면 인쇄용으로 흐리다 — Chart.js의 devicePixelRatio로
  // 내부 렌더 버퍼만 확대해(화면 표시 크기는 그대로) 300dpi 이상을 만든다(사용자 지시, 2026-07-22).
  // EMF(메타파일)는 브라우저 표준 API로 직접 생성할 수 없어(서버·네이티브 변환기 필요) 미지원 —
  // 대신 고해상도 PNG로 같은 목적(인쇄·보고서 삽입 시 흐려지지 않음)을 満족한다.
  const EXPORT_DPI_SCALE = 3.2; // 96dpi * 3.2 ≈ 307dpi
  function exportChartPNG(col, filename) {
    const opts = chartOptsOf(col);
    // responsive:true+maintainAspectRatio:false인 Chart.js는 canvas 자체 width/height 속성이
    // 아니라 "부모 컨테이너의 렌더 크기"를 기준으로 리사이즈한다 — canvas를 곧바로 body에
    // 붙이면 부모(body)가 페이지 전체 크기라 차트가 페이지만큼 거대하게 부풀어버린다
    // (자체발견 버그, 2026-07-22). 반드시 opts.width/height로 명시적 크기를 가진
    // wrapper부터 만들고 그 안에 canvas를 둔다 — 화면에 실제 보이는 카드의
    // .ed-chart-canvas-wrap과 동일한 구조.
    const wrap = document.createElement("div");
    wrap.style.position = "fixed"; wrap.style.left = "-99999px"; wrap.style.top = "0";
    wrap.style.width = `${opts.width}px`; wrap.style.height = `${opts.height}px`;
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    const config = buildChartConfig(col, { forExport: true });
    config.options.devicePixelRatio = EXPORT_DPI_SCALE;
    config.options.animation = false;
    const whiteBg = {
      id: "ed-export-bg",
      beforeDraw(chart) {
        const { ctx, width, height } = chart;
        ctx.save();
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      },
    };
    const tempChart = new Chart(canvas.getContext("2d"), { ...config, plugins: [whiteBg] });
    const url = canvas.toDataURL("image/png");
    tempChart.destroy();
    wrap.remove();
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  }

  // col.id -> {card, canvas} — 일괄적용 중 팔로워를 갱신할 때 전체를 다시 그리지 않고
  // 이 카드만 표적 갱신하기 위한 캐시(2026-07-22, 드래그 중 깜빡임·재시도 버그 수정).
  let chartCardRefs = {};

  // 리더의 chartOpts를 나머지 전체 컬럼에 복사하고, 이미 카드가 그려진 팔로워는
  // DOM을 통째로 다시 만들지 않고(전체 innerHTML 리셋 없이) 컨트롤 값과 차트만 갱신한다.
  // renderCharts() 전체를 다시 부르면 드래그 중인 슬라이더 자신까지 파괴돼 조작이 끊긴다
  // (사용자가 지적한 "일괄적용 안 됨"·"드래그 시 깜빡임" 버그의 실제 원인).
  function syncFollowers(sourceCol) {
    const src = chartOptsOf(sourceCol);
    for (const c of columns) {
      if (c === sourceCol) continue;
      c.chartOpts = { ...src };
      const ref = chartCardRefs[c.id];
      if (!ref) continue; // 데이터가 없어 카드 자체가 없는 컬럼
      const { card, canvas } = ref;
      card.style.width = `${src.width}px`;
      const wrap = card.querySelector(".ed-chart-canvas-wrap");
      if (wrap) wrap.style.height = `${src.height}px`;
      card.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.type === src.type)));
      const set = (sel, prop, val) => { const el = card.querySelector(sel); if (el) el[prop] = val; };
      set(".ed-c-color", "value", src.color);
      set(".ed-c-width", "value", src.width); set(".ed-c-width-num", "value", src.width);
      set(".ed-c-height", "value", src.height); set(".ed-c-height-num", "value", src.height);
      set(".ed-c-thick", "value", src.barThickness || 0); set(".ed-c-thick-num", "value", src.barThickness || 0);
      set(".ed-c-title", "checked", src.showTitle);
      set(".ed-c-legend", "checked", src.showLegend);
      set(".ed-c-labels", "checked", src.showLabels);
      set(".ed-c-ymanual", "checked", src.yManual);
      set(".ed-c-ymin", "value", src.yMin ?? "");
      set(".ed-c-ymax", "value", src.yMax ?? "");
      set(".ed-c-ystep", "value", src.yStep ?? "");
      rebuildChart(c, canvas);
    }
  }

  function renderCharts() {
    const container = $("#ed-charts");
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};
    chartCardRefs = {};
    container.innerHTML = "";

    const regionMode = isRegionMode();
    let any = false;
    let cardIdx = 0; // "1번째 그래프" = 실제로 카드가 그려지는 첫 컬럼(데이터 없는 컬럼은 카드가 없다)
    for (const col of columns) {
      const data = rows.map((r) => (r.values[col.id] == null ? null : Number(r.values[col.id])));
      if (!data.some((v) => v != null)) continue;
      any = true;
      const isLeader = cardIdx === 0;
      const isFollower = bulkApplyCharts && !isLeader;
      const opts = chartOptsOf(col);

      const card = document.createElement("div");
      card.className = "panel ed-chart-card";
      card.style.width = `${opts.width}px`;
      const dis = isFollower ? "disabled" : "";
      const thickDis = (isFollower || opts.type === "line") ? "disabled" : "";
      card.innerHTML = `
        <div class="ed-chart-head"><h4>${escapeHtml(col.label)}${isFollower ? ' <span class="ed-chart-note" style="display:inline">(일괄적용 중)</span>' : ""}</h4>
          <button type="button" class="btn btn-secondary ed-chart-png">PNG 저장</button></div>
        <div class="ed-chart-ctlrow${isFollower ? " is-bulk-follower" : ""}">
          <div class="segment" role="group" aria-label="그래프 타입">
            <button type="button" data-type="bar" aria-pressed="${opts.type === "bar"}" ${dis}>막대</button>
            <button type="button" data-type="line" aria-pressed="${opts.type === "line"}" ${dis}>선</button>
          </div>
          <label class="ed-chk-label">색상 <input type="color" class="ed-c-color" value="${opts.color.startsWith("#") ? opts.color : "#2f6fed"}" ${dis}></label>
          <label class="ed-chk-label">가로
            <input type="range" class="ed-c-width" min="240" max="900" step="10" value="${opts.width}" ${dis}>
            <input type="number" class="ed-c-width-num ed-slider-num" min="240" max="900" value="${opts.width}" ${dis}>
          </label>
          <label class="ed-chk-label">세로
            <input type="range" class="ed-c-height" min="160" max="640" step="10" value="${opts.height}" ${dis}>
            <input type="number" class="ed-c-height-num ed-slider-num" min="160" max="640" value="${opts.height}" ${dis}>
          </label>
          <label class="ed-chk-label">막대굵기
            <input type="range" class="ed-c-thick ed-yaxis-input" min="0" max="60" step="2" value="${opts.barThickness || 0}" title="선 그래프에는 적용되지 않습니다" ${thickDis}>
            <input type="number" class="ed-c-thick-num ed-slider-num ed-yaxis-input" min="0" max="60" value="${opts.barThickness || 0}" ${thickDis}>
          </label>
        </div>
        <div class="ed-chart-ctlrow${isFollower ? " is-bulk-follower" : ""}">
          <label class="ed-chk-label"><input type="checkbox" class="ed-c-title" ${opts.showTitle ? "checked" : ""} ${dis}> 제목</label>
          <label class="ed-chk-label"><input type="checkbox" class="ed-c-legend" ${opts.showLegend ? "checked" : ""} ${dis}> 범례</label>
          <label class="ed-chk-label"><input type="checkbox" class="ed-c-labels" ${opts.showLabels ? "checked" : ""} ${dis}> 수치표시</label>
          <label class="ed-chk-label"><input type="checkbox" class="ed-c-ymanual" ${opts.yManual ? "checked" : ""} ${dis}> Y축 직접설정</label>
          <input type="number" class="ed-c-ymin ed-yaxis-input" placeholder="최소" value="${opts.yMin ?? ""}" ${opts.yManual ? "" : "disabled"} ${dis}>
          <input type="number" class="ed-c-ymax ed-yaxis-input" placeholder="최대" value="${opts.yMax ?? ""}" ${opts.yManual ? "" : "disabled"} ${dis}>
          <input type="number" class="ed-c-ystep ed-yaxis-input" placeholder="간격" value="${opts.yStep ?? ""}" ${opts.yManual ? "" : "disabled"} ${dis}>
        </div>
        ${regionMode ? `<p class="ed-chart-note">지점마다 지역구분이 달라 기준선이 하나로 고정되지 않습니다 — 막대 위에 마우스를 올리면 그 지점의 기준을 볼 수 있습니다.</p>` : ""}
        <div class="ed-chart-canvas-wrap" style="height:${opts.height}px"><canvas></canvas></div>`;
      container.appendChild(card);

      const canvas = card.querySelector("canvas");
      chartCardRefs[col.id] = { card, canvas };
      rebuildChart(col, canvas);

      card.querySelector(".ed-chart-png").addEventListener("click", () => {
        exportChartPNG(col, `${standards.field}_${col.code || col.label}_${new Date().toISOString().slice(0, 10)}.png`);
      });

      // 일괄적용 중인 팔로워 카드는 조작을 막아뒀으니(disabled+pointer-events:none) 아래
      // 리스너들은 리더 카드에서만 실질적으로 동작한다. 리더가 바뀌면 자기 자신은 가볍게
      // 갱신(destroy+recreate는 canvas 위 Chart 인스턴스만, DOM은 그대로)하고, 일괄적용
      // 중이면 나머지도 syncFollowers()로 가볍게 뒤따라 갱신한다 — renderCharts() 전체를
      // 다시 부르지 않아 드래그 중에도 끊기지 않는다.
      const thickInputs = () => [card.querySelector(".ed-c-thick"), card.querySelector(".ed-c-thick-num")];
      card.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
        opts.type = b.dataset.type;
        card.querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        thickInputs().forEach((el) => { el.disabled = opts.type === "line"; }); // 선 그래프엔 막대굵기 무의미
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      }));
      card.querySelector(".ed-c-color").addEventListener("input", (e) => {
        opts.color = e.target.value;
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      bindRangeNumber(card.querySelector(".ed-c-width"), card.querySelector(".ed-c-width-num"), (v) => {
        opts.width = v;
        card.style.width = `${v}px`;
        charts[col.id]?.resize();
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      bindRangeNumber(card.querySelector(".ed-c-height"), card.querySelector(".ed-c-height-num"), (v) => {
        opts.height = v;
        card.querySelector(".ed-chart-canvas-wrap").style.height = `${v}px`;
        charts[col.id]?.resize();
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      bindRangeNumber(card.querySelector(".ed-c-thick"), card.querySelector(".ed-c-thick-num"), (v) => {
        opts.barThickness = v || null;
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      card.querySelector(".ed-c-title").addEventListener("change", (e) => {
        opts.showTitle = e.target.checked;
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      card.querySelector(".ed-c-legend").addEventListener("change", (e) => {
        opts.showLegend = e.target.checked;
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      card.querySelector(".ed-c-labels").addEventListener("change", (e) => {
        opts.showLabels = e.target.checked;
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      const yMinI = card.querySelector(".ed-c-ymin"), yMaxI = card.querySelector(".ed-c-ymax"), yStepI = card.querySelector(".ed-c-ystep");
      card.querySelector(".ed-c-ymanual").addEventListener("change", (e) => {
        opts.yManual = e.target.checked;
        [yMinI, yMaxI, yStepI].forEach((el) => { el.disabled = !opts.yManual; });
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      yMinI.addEventListener("change", (e) => {
        opts.yMin = e.target.value === "" ? null : Number(e.target.value);
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      yMaxI.addEventListener("change", (e) => {
        opts.yMax = e.target.value === "" ? null : Number(e.target.value);
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      yStepI.addEventListener("change", (e) => {
        opts.yStep = e.target.value === "" ? null : Number(e.target.value);
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });

      cardIdx++;
    }
    if (!any) container.innerHTML = `<div class="placeholder">표에 측정값을 입력하면 그래프가 나타납니다</div>`;
  }

  /* ── 분야 전환 ─────────────────────────────────────────────────────── */
  async function switchField(idx) {
    if (idx === fieldIdx) return;
    let next;
    try {
      next = await loadStandardsFor(FIELDS[idx].file, V);
    } catch (e) {
      toast(`${FIELDS[idx].label} 기준DB 로드 실패: ${e.message}`, "fail");
      return;
    }
    fieldIdx = idx;
    standards = next;
    refTabIndex = 0;
    soilStandardMode = "concern";
    transposed = false; // 분야가 바뀌면 이전 분야의 행/열전환 상태를 물려받지 않는다
    initColumnsAndRows();
    // 분야가 바뀌면 프로젝트도 분야별 저장소를 다시 읽고, 다중분석 선택 상태는 초기화한다
    // (다른 분야의 프로젝트를 보여주는 건 의미가 없다).
    analysisMode = "single";
    projects = loadProjects(FIELDS[fieldIdx].code);
    activeProject = null; sliceAxis = null; sliceKey = null; multiViewMode = null;
    savedSingle = null;
    $("#ed-newround-bar").style.display = "none";
    closeNewProjectForm();
    renderModeBanner();
    renderProjectBanner();
    renderSliceBanner();
    updateHeaderText();
    refreshAddSelect();
    renderGrid();
    renderCharts();
  }

  /* ── 툴바 이벤트 ───────────────────────────────────────────────────── */
  renderFieldBanner();
  renderModeBanner();
  renderProjectBanner();
  renderSliceBanner();
  updateHeaderText();
  refreshAddSelect();
  $("#ed-field-banner").addEventListener("click", (e) => {
    const btn = e.target.closest(".ed-field-btn");
    if (btn) switchField(parseInt(btn.dataset.idx, 10));
  });
  $("#ed-mode-banner").addEventListener("click", (e) => {
    const btn = e.target.closest(".ed-mode-btn");
    if (btn) switchAnalysisMode(btn.dataset.mode);
  });
  $("#ed-project-banner").addEventListener("click", (e) => {
    if (e.target.closest("#ed-project-add")) { openNewProjectForm(); return; }
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); deleteProject(del.dataset.del); return; }
    const btn = e.target.closest(".ed-project-btn[data-id]");
    if (btn) selectProject(btn.dataset.id);
  });
  $("#ed-slice-banner").addEventListener("click", (e) => {
    if (e.target.closest("#ed-round-add")) { startNewRound(); return; }
    if (e.target.closest("#ed-site-add")) { addSiteToProject(); return; }
    if (e.target.closest("#ed-item-add")) { addItemToProject(); return; }
    const delSite = e.target.closest("[data-del-site]");
    if (delSite) { e.stopPropagation(); removeSiteFromProject(delSite.dataset.delSite); return; }
    const delItem = e.target.closest("[data-del-item]");
    if (delItem) { e.stopPropagation(); removeItemFromProject(delItem.dataset.delItem); return; }
    const btn = e.target.closest(".ed-slice-btn[data-axis]");
    if (btn) selectSlice(btn.dataset.axis, btn.dataset.key);
  });
  $("#ed-np-create").addEventListener("click", createProjectFromForm);
  $("#ed-np-cancel").addEventListener("click", closeNewProjectForm);
  $("#ed-round-label").addEventListener("change", renameCurrentRound);
  $("#ed-round-done").addEventListener("click", finishNewRound);
  $("#ed-round-delete").addEventListener("click", deleteCurrentRound);
  $("#ed-ref-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".ed-ref-tab");
    if (!btn) return;
    refTabIndex = parseInt(btn.dataset.i, 10);
    renderReferencePanel();
  });
  $("#ed-export-xlsx").addEventListener("click", exportTableToExcel);
  $("#ed-add-item").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    if (v === "__custom") {
      const name = prompt("새 항목 이름을 입력하세요 (예: 총부유먼지)");
      if (name && name.trim()) ensureCustomColumn(name.trim());
    } else {
      const item = standards.items.find((i) => i.code === v);
      columns.push(isRegionMode() ? makeColumnFromRegionItem(item) : makeColumnFromItem(item));
    }
    e.target.value = "";
    refreshAddSelect(); renderGrid(); scheduleCharts();
  });
  $("#ed-add-row").addEventListener("click", () => {
    rows.push({ id: `r${++rowSeq}`, label: "", region: standards.regions?.[0]?.code || null, ...defaultRowFields(), values: {} });
    renderGrid();
  });
  $("#ed-reset").addEventListener("click", () => {
    initColumnsAndRows();
    refreshAddSelect(); renderGrid(); scheduleCharts();
  });
  $("#ed-transpose").addEventListener("click", () => {
    transposed = !transposed;
    $("#ed-transpose").setAttribute("aria-pressed", String(transposed));
    renderGrid();
  });
  $("#ed-chart-bulk").addEventListener("change", (e) => {
    bulkApplyCharts = e.target.checked;
    if (bulkApplyCharts) {
      const leader = columns.find((c) => rows.some((r) => r.values[c.id] != null));
      if (leader) applyBulkChartOpts(leader);
    }
    renderCharts();
  });

  /* 다중선택 전역 리스너 — mouseup은 표 밖에서 놓아도 잡아야 하고, Delete·Ctrl+C도
     포커스가 어디에 있든(선택된 셀 자체가 포커스가 아닐 수 있음) 반응해야 한다. */
  document.addEventListener("mouseup", () => { selecting = false; });
  document.addEventListener("keydown", (e) => {
    if (!selectionRect || !section.classList.contains("active")) return;
    const span = (selectionRect.r1 > selectionRect.r0) || (selectionRect.c1 > selectionRect.c0);
    if (!span) return; // 셀 1개만 선택된 상태면 일반 contenteditable 편집을 방해하지 않는다
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!section.contains(document.activeElement) && document.activeElement !== document.body) return;
    e.preventDefault();
    for (let ri = selectionRect.r0; ri <= selectionRect.r1; ri++) {
      for (let ci = selectionRect.c0; ci <= selectionRect.c1; ci++) {
        const row = rows[ri], col = columns[ci];
        if (row && col) delete row.values[col.id];
      }
    }
    renderGrid(); scheduleCharts();
  });
  document.addEventListener("copy", (e) => {
    if (!selectionRect || !section.classList.contains("active")) return;
    const span = (selectionRect.r1 > selectionRect.r0) || (selectionRect.c1 > selectionRect.c0);
    if (!span) return; // 셀 1개면 브라우저 기본 복사(텍스트 일부 등)를 그대로 둔다
    const lines = [];
    for (let ri = selectionRect.r0; ri <= selectionRect.r1; ri++) {
      const line = [];
      for (let ci = selectionRect.c0; ci <= selectionRect.c1; ci++) {
        const row = rows[ri], col = columns[ci];
        const v = row && col ? row.values[col.id] : null;
        line.push(v == null ? "" : String(v));
      }
      lines.push(line.join("\t"));
    }
    e.clipboardData.setData("text/plain", lines.join("\n"));
    e.preventDefault();
    toast(`선택한 ${selectionRect.r1 - selectionRect.r0 + 1}×${selectionRect.c1 - selectionRect.c0 + 1} 셀을 복사했습니다`, "ok");
  });

  const drop = $("#ed-drop"), fileInput = $("#ed-file");
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) {
      $("#ed-drop-msg").textContent = `선택됨: ${fileInput.files[0].name}`;
      handleFile(fileInput.files[0]);
    }
  });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  // zoom은 폭 계산까지 통째로 스케일해줘서 표(가변 폭 다단 헤더)에 가장 안전하다.
  // 최신 Firefox(126+)도 지원 — 미지원 구형 브라우저에서는 그냥 100%로 보인다.
  bindRangeNumber($("#ed-font-size"), $("#ed-font-size-num"), (pct) => {
    $("#ed-scroll").style.zoom = `${pct}%`;
  });

  renderGrid();
  renderCharts();
}
