










import { loadShared } from "../shared/loader.js";

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

if (typeof window !== "undefined" && window.Chart && window.ChartDataLabels) {
  window.Chart.register(window.ChartDataLabels);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtNum(n) { return n == null ? "—" : String(n); }




function packLabel(label) {
  const s = String(label ?? "");
  const m = s.match(/^([\s\S]*?)(\([^()]*\))\s*$/);
  if (!m) return escapeHtml(s);
  return `${escapeHtml(m[1])}<span class="ed-nowrap">${escapeHtml(m[2])}</span>`;
}


function bindRangeNumber(rangeEl, numberEl, onChange) {
  const min = Number(rangeEl.min), max = Number(rangeEl.max);
  const clamp = (v) => Math.min(max, Math.max(min, v));
  rangeEl.addEventListener("input", () => {
    numberEl.value = rangeEl.value;
    onChange(Number(rangeEl.value));
  });


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


  if (/,\d{1,2}$/.test(t) && !/,\d{3}\b/.test(t)) t = t.replace(",", ".");
  t = t.replace(/,/g, "");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}




const SUBSUP_TO_ASCII = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "₊": "+", "₋": "-",
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-",
};
function normalizeSubSup(s) {
  return String(s || "").replace(/[₀-₉₊₋⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, (c) => SUBSUP_TO_ASCII[c] || c);
}




let romanToAsciiFn = (s) => s;
function norm(s) {
  return romanToAsciiFn(normalizeSubSup(String(s || ""))).toLowerCase().replace(/[\s()（）·./\-]/g, "");
}

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
  const periods = standards.periods || [];





  const core = (p) => norm(String(p.label || "").split(/[(（]/)[0]);


  const byAlias = periods.find((p) => (p.aliases || []).some((al) => norm(al) === n));
  return periods.find((p) => norm(p.code) === n)
      || periods.find((p) => norm(p.label) === n || core(p) === n)
      || byAlias
      || periods.find((p) => { const pn = norm(p.label); return pn.includes(n) || n.includes(pn); });
}






function findRegionByAlias(standards, text) {
  const n = norm(text);
  if (!n) return null;
  const regions = standards.regions || [];
  let hit = regions.find((r) => norm(r.code) === n);
  if (hit) return hit;
  if (n.length < 2) return null;


  const paren = String(text).match(/[(（]\s*([^)）]+)\s*[)）]/);
  if (paren) {
    const byCode = regions.find((r) => norm(r.code) === norm(paren[1]));
    if (byCode) return byCode;
  }
  const cores = regions.map((r) => ({ r, core: norm(String(r.label || "").split(/[(（]/)[0]) }));
  const head = norm(String(text).split(/[(（]/)[0]);
  const exact = cores.find((c) => c.core === n || (head && c.core === head));
  if (exact) return exact.r;



  const cands = cores.filter((c) => c.core && (c.core.includes(n) || n.includes(c.core)));
  cands.sort((a, b) => b.core.length - a.core.length);
  return cands.length ? cands[0].r : null;
}




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


  const { readWorkbook } = await loadShared("textenc.js", V);


  const GRADE = await loadShared("env_grade.js", V);
  const { isExceed, hasGradeScale: hasGradeScaleOf, achievedGrade: achievedGradeOf,
          gradeCellText, GRADE_NONE_TEXT } = GRADE;
  romanToAsciiFn = GRADE.romanToAscii;
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




  if (!window.Chart) {
    section.innerHTML = `<div class="panel"><h2>환경질 측정 데이터 분석</h2>
      <div class="placeholder">차트 라이브러리를 불러오지 못했습니다 — 새로고침 후 다시 시도해주세요.</div></div>`;
    toast("환경질 분석: Chart.js 로드 실패", "fail");
    return;
  }
  const Chart = window.Chart;


  let rowSeq = 0, colSeq = 0;
  const isRegionMode = () => standards.type === "region";


  const columnsFixed = () => isRegionMode() && standards.columnsFixed !== false;



  const canAddItems = () => !columnsFixed() || hasGradeScale();

  function makeColumnFromItem(item) {
    const def = item.standards.find((s) => s.default) || item.standards[0];
    return { id: `c${++colSeq}`, code: item.code, label: item.label, unit: def?.unit || "",
             averaging: def?.averaging || null, custom: false, overrideValue: null, unitScale: 1 };
  }
  function makeColumnFromRegionItem(item) {



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

  let charts = {};
  let chartDebounce = null;
  let bulkApplyCharts = false;
  let cornerWidth = null;
  let regionColWidth = null;
  let transposed = false;
  let selAnchor = null, selecting = false, selectionRect = null;




  let analysisMode = "single";
  let projects = loadProjects(FIELDS[fieldIdx].code);
  let activeProject = null;
  let sliceAxis = null;
  let sliceKey = null;
  let multiViewMode = null;
  let roundSeq = 0;
  let savedSingle = null;
  let currentEditRoundId = null;
  let refTabIndex = 0;
  let soilStandardMode = "concern";




  let showGrades = true;
  const defaultChartColor = cssVar("--accent", "#2f6fed");


  function chartOptsOf(col) {
    if (!col.chartOpts) {
      col.chartOpts = {
        type: "bar", color: defaultChartColor, height: 260, width: 320, barThickness: null,
        showTitle: true, showLegend: false, showLabels: false,
        yManual: false, yMin: null, yMax: null, yStep: null,
        pattern: "none",
        mono: false,
      };
    }
    return col.chartOpts;
  }

  function applyBulkChartOpts(sourceCol) {
    const src = chartOptsOf(sourceCol);
    for (const c of columns) {
      if (c === sourceCol) continue;
      c.chartOpts = { ...src };
    }
  }



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
  function fmtStd(std) {
    if (!std) return "";
    if (std.direction === "range") return `${std.value[0]}~${std.value[1]}${std.unit}`;
    return `${std.value}${std.unit}${std.direction === "min" ? " 이상" : " 이하"}`;
  }



  function regionOf(col, row) { return col.fixedRegion || row?.region; }


  function standardKeyOf(col, row) { return col.fixedStandardKey || row?.standardKey || "main"; }
  function noiseSourceOf(col, row) { return col.fixedNoiseSource ?? row?.noiseSource ?? null; }

  function standardOptions() {
    return [{ key: "main", label: standards.mainTitle || "환경기준" },
      ...(standards.additionalStandards || []).map((e) => ({ key: e.key, label: e.shortTitle || e.title }))];
  }


  function regionOptionsFor(skey) {
    skey = skey || "main";
    if (skey === "main") return standards.regions.map((r) => ({ code: r.code, label: r.label }));
    const extra = standards.additionalStandards?.find((e) => e.key === skey);
    if (!extra?.regionLegend) return [];
    return Object.entries(extra.regionLegend).map(([code, label]) => ({ code, label: `${code}. ${label}` }));
  }

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


      const val = isDay ? hit[4] : hit[5];
      return { value: val, unit: standards.unit || "dB(A)", averaging: `${rcode}지역·${srcMain}${srcSub !== "—" ? "-" + srcSub : ""}`, source: "db", direction: "max" };
    }

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


  function tooltipFor(col, row, value) {
    const std = effectiveStandard(col, row);
    const g = achievedGrade(col, typeof value === "number" ? value : parseNum(value));
    const gradeTxt = g ? `달성등급 ${g.label}` : "";
    if (!std) return gradeTxt;
    return gradeTxt ? `기준 ${fmtStd(std)} · ${gradeTxt}` : `기준 ${fmtStd(std)}`;
  }

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







  function hasGradeScale() { return hasGradeScaleOf(standards); }
  function achievedGrade(col, value) {
    if (col.custom) return null;
    return achievedGradeOf(standards, col.code, value);
  }


  function gradeBadgeFor(col, value) {
    if (!showGrades || !hasGradeScale() || value == null || Number.isNaN(value)) return "";
    if (col.custom || !col.code) return GRADE_NONE_TEXT;
    return gradeCellText(standards, col.code, value) || GRADE_NONE_TEXT;
  }
  function setGradeBadge(td, col, value) {
    const txt = gradeBadgeFor(col, value);
    if (txt) td.dataset.grade = txt; else delete td.dataset.grade;
  }

  function gradeSpan(grades) {
    const gs = grades.filter(Boolean);
    if (!gs.length) return null;
    let lo = gs[0], hi = gs[0];
    for (const g of gs) { if (g.rank < lo.rank) lo = g; if (g.rank > hi.rank) hi = g; }
    return lo.label === hi.label ? lo.label : `${lo.label}~${hi.label}`;
  }



  function worstGradeOf(cellsOfRow) {
    const gs = cellsOfRow.map((c) => achievedGrade(c.col, c.value)).filter(Boolean);
    if (!gs.length) return null;
    return gs.reduce((a, b) => (b.rank > a.rank ? b : a));
  }















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
          <label>측정 데이터 불러오기</label>
          <label class="dropzone" id="ed-drop">
            <input type="file" id="ed-file" accept=".xlsx,.xls,.csv,.hwpx,.pdf">
            <b class="dz-formats">지원 파일 — 엑셀 · CSV</b>
            <span class="dz-hint" id="ed-drop-hint">끌어다 놓으면 첫 행은 항목명, 첫 열은 측정지점으로 읽습니다. 표의 셀을 클릭한 뒤 Ctrl+V로 엑셀 내용을 직접 붙여넣을 수도 있습니다.</span>
          </label>
          <details class="md-more ed-input-help">
            <summary>파일 업로드와 붙여넣기는 어떻게 다른가요?</summary>
            <p class="help"><b>파일 업로드</b>는 표 전체를 올린 파일의 내용으로 교체합니다.</p>
            <p class="help"><b>붙여넣기(Ctrl+V)</b>는 클릭한 셀 위치부터 겹치는 칸만 채우고 나머지 칸은 그대로 둡니다.</p>
            <p class="help"><b>다중분석</b>에서는 프로젝트를 먼저 만든 뒤라야 파일·붙여넣기가 선택한 회차로 들어갑니다. 프로젝트가 없는 상태에서 올리면 데이터가 반영되지 않으므로, 프로젝트를 먼저 만들거나 선택한 뒤 다시 올려야 합니다.</p>
          </details>
        </div>

        <div class="field" id="ed-bridge-parse-field" style="display:none">
          <label>로컬 런처로 HWPX·PDF 등록문서 자동인식</label>
          <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
            <button class="btn btn-secondary" id="ed-bridge-parse" type="button">문서 선택…</button>
            <span id="ed-bridge-parse-status" class="help" style="margin:0"></span>
          </div>
        </div>
        <p class="help" id="ed-bridge-parse-locked" style="display:none">HWPX·PDF 등록문서 자동인식은 로컬 런처가 필요합니다 — <code>로컬 런처</code> 실행 후 다시 확인하세요.</p>

        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-bottom:0">
          <select id="ed-add-item" class="ed-add-select"><option value="">+ 항목 추가…</option></select>
          <button class="btn btn-secondary" id="ed-add-row">+ 지점 추가</button>
          <button class="btn btn-secondary" id="ed-reset">표 초기화</button>
        </div>
        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-2)">
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
        <label class="ed-chk-label" id="ed-grade-toggle-wrap" style="display:none">
          <input type="checkbox" id="ed-grade-toggle" checked>등급 표시
        </label>
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


    const mergedNotes = [...(standards.notes || [])];
    if (standards.dualStandard) {
      mergedNotes.push(`숫자 표기는 ${standards.dualStandard.concernLabel}/${standards.dualStandard.actionLabel} 순서입니다.`);
    }


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
      : `측정 결과를 표에 입력하면 ${standards.legal_basis} 초과 여부를 자동 판별하고 항목별 그래프를 그립니다. xlsx·csv 업로드, 엑셀에서 복사한 내용 붙여넣기, 표 직접 입력을 모두 지원합니다.`;


    $("#ed-add-item").parentElement.style.display = (!canAddItems() || analysisMode === "multi") ? "none" : "";

    renderReferencePanel();
  }


  function refreshAddSelect() {
    if (!canAddItems()) return;
    const sel = $("#ed-add-item");




    const used = new Set(columns.filter((c) => !c.custom).map((c) => c.code));
    const stdOptions = columnsFixed() ? "" : standards.items.filter((i) => !used.has(i.code))
      .map((i) => `<option value="${i.code}">${escapeHtml(i.label)}</option>`).join("");
    sel.innerHTML = `<option value="">+ 항목 추가…</option>${stdOptions}`
      + `<option value="__custom">직접 입력(사용자 정의 항목)</option>`;
  }





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
    const showItemAxis = !columnsFixed();
    const itemBtns = showItemAxis ? activeProject.itemCodes.map((code) => {
      const item = standards.items.find((i) => i.code === code);
      return `<span class="ed-slice-btn-wrap"><button type="button" class="ed-slice-btn" data-axis="item" data-key="${escapeHtml(code)}" aria-pressed="${sliceAxis === "item" && sliceKey === code}">${escapeHtml(item?.label || code)}</button><span class="ed-slice-del" data-del-item="${escapeHtml(code)}" title="항목 삭제">×</span></span>`;
    }).join("") : "";
    el.innerHTML = `
      <div class="ed-slice-group"><span class="ed-slice-group-label">조사지점</span>${siteBtns}<button type="button" class="ed-slice-btn ed-slice-btn-add" id="ed-site-add">+ 지점</button></div>
      ${showItemAxis ? `<div class="ed-slice-group"><span class="ed-slice-group-label">조사항목</span>${itemBtns}<button type="button" class="ed-slice-btn ed-slice-btn-add" id="ed-item-add">+ 항목</button></div>` : ""}
      <button type="button" class="btn btn-secondary" id="ed-round-add">+ 회차 추가</button>`;
  }





  function refreshCurrentView() {
    if (analysisMode !== "multi" || !activeProject) return;
    if (multiViewMode === "newRound") { buildNewRoundColumnsAndRows(); renderGrid(); scheduleCharts(); }
    else if (multiViewMode === "slice") { buildSliceColumnsAndRows(); renderGrid(); scheduleCharts(); }
  }


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






  function renderGradeToggle() {
    const wrap = $("#ed-grade-toggle-wrap");
    if (!wrap) return;
    wrap.style.display = hasGradeScale() ? "" : "none";
    const chk = $("#ed-grade-toggle");
    if (chk) chk.checked = showGrades;
  }
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




    const exceedList = (pairs, includeCol = true) => pairs
      .filter(({ col, row, value }) => isExceed(effectiveStandard(col, row), value))
      .map(({ col, row }) => (includeCol ? `${row.label || ""} ${col.label || ""}`.trim() : (row.label || "").trim()))
      .filter(Boolean);
    const unitOf = (col) => col.unit || dbStandard(col)?.unit || standards.unit || "";





    const isSingle = analysisMode === "single";
    const isNewRoundShape = analysisMode === "multi" && multiViewMode === "newRound";
    const isSiteSlice = analysisMode === "multi" && multiViewMode === "slice" && sliceAxis === "site";
    const isItemSlice = analysisMode === "multi" && multiViewMode === "slice" && sliceAxis === "item";
    let html = "";




    const stdLabelOf = (skey) => standardOptions().find((o) => o.key === skey)?.label || skey;


    const judgedByHtml = () => {
      const dual = standards.dualStandard;
      if (!dual || columnsFixed()) return "";
      const label = soilStandardMode === "action" ? dual.actionLabel : dual.concernLabel;
      return `<p class="ed-summary-grade">판정 기준: <b>${escapeHtml(label)}</b></p>`;
    };
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

        const achievedTxt = (gp) => {
          const sp = gradeSpan(gp.map((p) => achievedGrade(col, p.value)));
          return sp ? ` <span class="ed-summary-achieved">달성등급 ${escapeHtml(sp)}</span>` : "";
        };
        if (groups.size <= 1) {
          const range = fmtRange(pairs.map((p) => p.value));
          const exceeds = exceedList(pairs, false);
          const exceedTxt = exceeds.length ? ` <span class="ed-summary-exceed">⚠ 초과: ${exceeds.map(escapeHtml).join(", ")}</span>` : "";
          return `<li><b>${escapeHtml(col.label)}</b> <span class="ed-nowrap">${escapeHtml(range)}${escapeHtml(unit)}</span>${achievedTxt(pairs)}${exceedTxt}</li>`;
        }
        const subLines = [...groups.entries()].map(([skey, gp]) => {
          const range = fmtRange(gp.map((p) => p.value));
          const exceeds = exceedList(gp, false);
          const exceedTxt = exceeds.length ? ` <span class="ed-summary-exceed">⚠ 초과: ${exceeds.map(escapeHtml).join(", ")}</span>` : "";
          return `<li>${escapeHtml(stdLabelOf(skey))}: <span class="ed-nowrap">${escapeHtml(range)}${escapeHtml(unit)}</span>${achievedTxt(gp)}${exceedTxt}</li>`;
        });
        return `<li><b>${escapeHtml(col.label)}</b><ul class="ed-summary-substd">${subLines.join("")}</ul></li>`;
      }).filter(Boolean);
      const grade = gradeRangeOf(cells.map(({ col, row }) => ({ col, row })));



      let achievedHtml = "";
      if (hasGradeScale()) {
        const items = rows.map((row) => {
          const w = worstGradeOf(cells.filter((c) => c.row === row));
          return w ? `<li><b>${escapeHtml(row.label)}</b> ${escapeHtml(w.label)}</li>` : null;
        }).filter(Boolean);
        if (items.length)
          achievedHtml = `<p class="ed-summary-sub">달성등급 — 측정값에서 자동 판정(항목 중 가장 낮은 등급이 그 ${isSiteSlice ? "회차" : "지점"}의 등급)</p>`
            + `<ul class="ed-summary-list">${items.join("")}</ul>`;
      }
      html = `<h3 style="margin:0 0 var(--space-2)">분석 요약</h3>`
        + judgedByHtml()
        + (grade ? `<p class="ed-summary-grade">목표등급 범위: <b>${escapeHtml(grade)}</b></p>` : "")
        + `<ul class="ed-summary-list">${lines.join("")}</ul>`
        + achievedHtml;
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
        return `<li><b>${escapeHtml(col.label)}</b> <span class="ed-nowrap">${escapeHtml(range)}${escapeHtml(overallUnit)}</span>${exceedTxt}</li>`;
      }).filter(Boolean);
      html = `<h3 style="margin:0 0 var(--space-2)">분석 요약</h3>`
        + `<p class="ed-summary-overall">전체(지점 무시): <b class="ed-nowrap">${escapeHtml(overallRange)}${escapeHtml(overallUnit)}</b>`
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
        texts: Object.fromEntries(columns.map((c) => [c.id, r.texts?.[site?.code]?.[c.code]]).filter(([, v]) => v != null)),
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
        texts: Object.fromEntries(columns.map((c) => [c.id, r.texts?.[c.siteCode]?.[item.code]]).filter(([, v]) => v != null)),
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
      values: {}, texts: {},
    }));
  }



  function persistSliceEdits() {
    if (analysisMode !== "multi" || !activeProject) return;
    if (multiViewMode === "newRound") {


      const round = activeProject.rounds.find((r) => r.id === currentEditRoundId);
      if (!round) return;
      for (const row of rows) {
        const site = activeProject.sites.find((s) => s.code === row.id);
        if (site && row.region != null) site.region = row.region;
        if (site && row.standardKey != null) site.standardKey = row.standardKey;
        if (site) site.noiseSource = row.noiseSource ?? null;
        round.values[row.id] = round.values[row.id] || {};
        round.texts = round.texts || {};
        round.texts[row.id] = round.texts[row.id] || {};
        for (const col of columns) {
          round.values[row.id][col.code] = row.values[col.id] ?? null;


          const t = row.texts?.[col.id];
          if (t) round.texts[row.id][col.code] = t; else delete round.texts[row.id][col.code];
        }
      }
      saveProjects(FIELDS[fieldIdx].code, projects);
      return;
    }
    if (multiViewMode !== "slice") return;


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
          round.texts = round.texts || {};
          round.texts[sliceKey] = round.texts[sliceKey] || {};
          const t1 = row.texts?.[col.id];
          if (t1) round.texts[sliceKey][col.code] = t1; else delete round.texts[sliceKey][col.code];
        } else {
          round.values[col.siteCode] = round.values[col.siteCode] || {};
          round.values[col.siteCode][sliceKey] = val;
          round.texts = round.texts || {};
          round.texts[col.siteCode] = round.texts[col.siteCode] || {};
          const t2 = row.texts?.[col.id];
          if (t2) round.texts[col.siteCode][sliceKey] = t2; else delete round.texts[col.siteCode][sliceKey];
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



    const withGrade = showGrades && hasGradeScale();
    const aoa = [["측정지점/회차", ...columns.flatMap((c) => (withGrade ? [c.label, "등급"] : [c.label]))]];
    for (const row of rows) {
      aoa.push([row.label || "", ...columns.flatMap((c) => {
        const v = row.values[c.id] ?? row.texts?.[c.id] ?? "";
        return withGrade ? [v, gradeBadgeFor(c, row.values[c.id]).replace(/^\(|\)$/g, "")] : [v];
      })]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "측정데이터");
    XLSX.writeFile(wb, `${standards.field}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast("엑셀을 다운로드 폴더에 저장했습니다 — 차트는 엑셀에서 표를 선택한 뒤 삽입 메뉴로 추가해주세요", "ok");
  }


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



  function attachRowDrag(handle, row, dropZone) {
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/ed-row", row.id));
    const onDrop = (e) => {
      e.preventDefault();
      const srcId = e.dataTransfer.getData("text/ed-row");
      if (!srcId || srcId === row.id) return;
      const from = rows.findIndex((r) => r.id === srcId);
      const to = rows.findIndex((r) => r.id === row.id);
      if (from < 0 || to < 0) return;
      const [moved] = rows.splice(from, 1);
      rows.splice(to, 0, moved);
      renderGrid(); scheduleCharts();
    };
    for (const el of new Set([handle, dropZone || handle])) {
      el.addEventListener("dragover", (e) => e.preventDefault());
      el.addEventListener("drop", onDrop);
    }
  }



  function addResizer(th, onResize) {
    const h = document.createElement("span");
    h.className = "ed-resizer";
    h.title = "끌어서 너비 조절";
    h.draggable = false;
    th.appendChild(h);
    let x0 = 0, w0 = 0;


    const move = (ev) => { th.style.width = `${Math.max(40, w0 + (ev.clientX - x0))}px`; syncTableWidth(); };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("ed-resizing");
      onResize(th.style.width);
      syncTableWidth();
    };
    h.addEventListener("mousedown", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      x0 = ev.clientX; w0 = th.offsetWidth;
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      document.body.classList.add("ed-resizing");
    });
  }




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








  function syncTableWidth() {
    const table = $("#ed-table");
    if (!table) return;
    let total = 0;
    for (const th of table.querySelectorAll("thead th")) {
      total += parseFloat(th.style.width) || th.offsetWidth || 0;
    }
    table.style.minWidth = total ? `${Math.round(total)}px` : "";
  }

  function renderGrid() {
    updateItemSliceInfo();
    renderSoilModeToggle();
    renderGradeToggle();



    $("#ed-transpose")?.setAttribute("aria-pressed", String(transposed));
    renderSummary();


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


    const dragTh = document.createElement("th");
    dragTh.style.width = "22px";
    thead.appendChild(dragTh);
    const corner = document.createElement("th");
    corner.textContent = "측정지점";
    corner.style.width = cornerWidth || "110px";
    addResizer(corner, (w) => { cornerWidth = w; });
    thead.appendChild(corner);



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



        th.title = "";
        th.innerHTML = `<div class="ed-col-label">${packLabel(col.label)}</div>`;
        addResizer(th, (w) => { col.width = w; });
        thead.appendChild(th);
        continue;
      }
      if (isRegionMode() && columnsFixed()) {
        const unitTxt = col.custom ? (col.unit || "") : (standards.unit || "");
        const unitHtml = unitTxt ? ` <span class="ed-unit">(${escapeHtml(unitTxt)})</span>` : "";
        if (!canAddItems()) {

          th.title = "";
          th.innerHTML = `<div class="ed-col-label">${packLabel(col.label)}${unitHtml}</div>`;
          addResizer(th, (w) => { col.width = w; });
          thead.appendChild(th);
          continue;
        }



        th.title = "드래그해서 항목 순서 변경";
        th.innerHTML = `
          <div class="ed-col-grip">⋮⋮</div>
          <div class="ed-col-label">${packLabel(col.label)}${unitHtml}</div>
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
      if (isRegionMode() && !columnsFixed()) {


        th.title = "드래그해서 항목 순서 변경";
        th.innerHTML = `
          <div class="ed-col-grip">⋮⋮</div>
          <div class="ed-col-label">${packLabel(col.label)}${col.unit ? ` <span class="ed-unit">(${escapeHtml(col.unit)})</span>` : ""}</div>
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
        <div class="ed-col-label">${packLabel(col.label)}${dispUnit ? ` <span class="ed-unit">(${escapeHtml(dispUnit)})</span>` : ""}</div>
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
      attachRowDrag(handleTd, row, tr);
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
        const tip = tooltipFor(col, row, val);
        if (tip) td.title = tip;
        td.contentEditable = "true";
        td.dataset.row = row.id;
        td.dataset.col = col.id;
        td.textContent = val == null ? (row.texts?.[col.id] ?? "") : String(val);
        setGradeBadge(td, col, val);
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
    syncTableWidth();
  }






  function renderGridTransposed() {
    const thead = $("#ed-thead-row");
    thead.innerHTML = "";
    const dragTh = document.createElement("th");
    dragTh.style.width = "22px";
    thead.appendChild(dragTh);
    const corner = document.createElement("th");
    corner.textContent = "조사항목";
    corner.style.width = cornerWidth || "140px";
    addResizer(corner, (w) => { cornerWidth = w; });
    thead.appendChild(corner);

    for (const row of rows) {
      const th = document.createElement("th");
      th.dataset.row = row.id;
      th.style.width = row.transWidth || "128px";
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
      addResizer(th, (w) => { row.transWidth = w; });
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

      const onColDrop = (e) => {
        e.preventDefault();
        const srcId = e.dataTransfer.getData("text/ed-col");
        if (!srcId || srcId === col.id) return;
        const from = columns.findIndex((c) => c.id === srcId);
        const to = columns.findIndex((c) => c.id === col.id);
        if (from < 0 || to < 0) return;
        const [moved] = columns.splice(from, 1);
        columns.splice(to, 0, moved);
        renderGrid(); scheduleCharts();
      };
      for (const el of [handleTd, tr]) {
        el.addEventListener("dragover", (e) => e.preventDefault());
        el.addEventListener("drop", onColDrop);
      }
      tr.appendChild(handleTd);

      const labelTd = document.createElement("td");
      labelTd.className = "ed-row-label";
      buildGroupCellContent(labelTd, col);
      tr.appendChild(labelTd);

      for (const row of rows) {
        const td = document.createElement("td");
        const val = row.values[col.id];
        td.className = `ed-cell ${judge(col, row, val)}`;
        const tip = tooltipFor(col, row, val);
        if (tip) td.title = tip;
        td.contentEditable = "true";
        td.dataset.row = row.id;
        td.dataset.col = col.id;
        td.textContent = val == null ? (row.texts?.[col.id] ?? "") : String(val);
        setGradeBadge(td, col, val);
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
    syncTableWidth();
  }




  function buildGroupCellContent(el, col) {
    if (isRegionMode() && columnsFixed()) {
      el.innerHTML = `<div class="ed-col-label">${packLabel(col.label)}${standards.unit ? ` <span class="ed-unit">(${escapeHtml(standards.unit)})</span>` : ""}</div>`;
      return;
    }
    if (isRegionMode() && !columnsFixed()) {
      el.innerHTML = `
        <div class="ed-col-grip">⋮⋮</div>
        <div class="ed-col-label">${packLabel(col.label)}${col.unit ? ` <span class="ed-unit">(${escapeHtml(col.unit)})</span>` : ""}</div>
        <button type="button" class="ed-col-del" title="항목 삭제">×</button>`;
      attachColDrag(el, col);
      el.querySelector(".ed-col-del").addEventListener("click", () => {
        columns = columns.filter((c) => c.id !== col.id);
        rows.forEach((r) => delete r.values[col.id]);
        refreshAddSelect(); renderGrid(); scheduleCharts();
      });
      return;
    }

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
      <div class="ed-col-label">${packLabel(col.label)}${dispUnit ? ` <span class="ed-unit">(${escapeHtml(dispUnit)})</span>` : ""}</div>
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
          const txt = cell.textContent.trim();
          const v = parseNum(txt);
          row.values[colId] = v;

          if (!row.texts) row.texts = {};
          if (v == null && txt !== "") row.texts[colId] = txt; else delete row.texts[colId];
          if (col) {
            cell.className = `ed-cell ${judge(col, row, v)}`;


            setGradeBadge(cell, col, v);
            cell.title = tooltipFor(col, row, v);
          }
        }
        scheduleCharts();
      });
    });


    const table = section.querySelector("#ed-table");
    table.addEventListener("paste", onPaste);
    table.addEventListener("mousedown", onCellMouseDown);
    table.addEventListener("mouseover", onCellMouseOver);
  }




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



  function transposeGrid(g) {
    const nCols = Math.max(0, ...g.map((r) => r.length));
    const out = [];
    for (let c = 0; c < nCols; c++) { const line = []; for (let r = 0; r < g.length; r++) line.push(g[r][c] ?? ""); out.push(line); }
    return out;
  }




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
          if (colIdx < 0 || colIdx >= columns.length) return;
        } else {
          while (columns.length <= colIdx) ensureCustomColumn(`열${columns.length + 1}`);
        }
        const cid = columns[colIdx].id, n2 = parseNum(text2);
        row.values[cid] = n2;
        if (!row.texts) row.texts = {};
        if (n2 == null && String(text2).trim() !== "") row.texts[cid] = String(text2).trim(); else delete row.texts[cid];
      });
    });
    refreshAddSelect(); renderGrid(); scheduleCharts();
    toast(`붙여넣기 완료 — ${grid.length}행 반영`, "ok");
  }









  function detectLabelCol(header, dataRows) {
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
    return labelCol;
  }
  function detectRegionCol(header, dataRows, labelCol) {
    for (let c = 0; c < header.length; c++) {
      if (c === labelCol) continue;
      if (!/지역|등급|구분/.test(String(header[c] || ""))) continue;
      const sample = dataRows.find((line) => line[c] != null && String(line[c]).trim() !== "");
      if (sample && findRegionByAlias(standards, sample[c])) return c;
    }
    return -1;
  }












  const NOISE_MIN_ROUNDS = { day: 4, night: 2 };
  function meanOfRounds(values) {
    const nums = values.map(parseNum).filter((v) => v != null);
    if (!nums.length) return null;
    return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  }
  function foldPeriodRows(header, dataRows, labelCol, regionCol) {

    let periodCol = -1;
    for (let c = 0; c < header.length; c++) {
      if (c === labelCol || c === regionCol) continue;
      let filled = 0, hit = 0;
      for (const line of dataRows) {
        const v = line[c];
        if (v == null || String(v).trim() === "") continue;
        filled++;
        if (findPeriodByAlias(standards, v)) hit++;
      }
      if (filled >= 2 && hit / filled > 0.6) { periodCol = c; break; }
    }
    if (periodCol < 0) return null;


    const numericCols = [];
    for (let c = 0; c < header.length; c++) {
      if (c === labelCol || c === regionCol || c === periodCol) continue;
      if (isAdminHeader(header[c])) continue;
      if (dataRows.some((line) => parseNum(line[c]) != null)) numericCols.push(c);
    }
    if (!numericCols.length) return { error: "측정값 열을 찾지 못했습니다" };
    const avgCol = numericCols.find((c) => norm(header[c]).includes(norm("평균")));
    const roundCols = numericCols.filter((c) => c !== avgCol);


    const byLabel = new Map();
    const shortRounds = [], mismatched = [];
    for (const line of dataRows) {
      const label = String(line[labelCol] ?? "").trim();
      if (!label) continue;
      const p = findPeriodByAlias(standards, line[periodCol]);
      if (!p) continue;
      if (!byLabel.has(label)) byLabel.set(label, { region: regionCol >= 0 ? line[regionCol] : null, vals: {} });
      const rounds = roundCols.map((c) => line[c]).filter((v) => parseNum(v) != null);
      const calc = meanOfRounds(rounds);
      const given = avgCol != null ? parseNum(line[avgCol]) : null;



      if (given != null && calc != null && Math.abs(given - calc) >= 1)
        mismatched.push(`${label} ${p.label.split(/[(（]/)[0]} ${given}≠${calc}`);
      byLabel.get(label).vals[p.code] = given != null ? given : calc;

      const need = standards.field?.includes("소음") ? NOISE_MIN_ROUNDS[p.code] : null;
      if (need && rounds.length && rounds.length < need)
        shortRounds.push(`${label} ${p.label.split(/[(（]/)[0]} ${rounds.length}회`);
    }
    if (!byLabel.size) return { error: "주간·야간 구분을 읽지 못했습니다 — 표에 시간대 표기가 필요합니다" };

    const periods = standards.periods;
    const outHeader = ["측정지점", ...(regionCol >= 0 ? ["지역구분"] : []), ...periods.map((p) => p.label)];
    const outRows = [...byLabel.entries()].map(([label, rec]) =>
      [label, ...(regionCol >= 0 ? [rec.region] : []), ...periods.map((p) => rec.vals[p.code] ?? "")]);
    const src = avgCol != null ? `${String(header[avgCol] || "평균").trim()} 열 사용`
      : `회차 ${roundCols.length}개를 산술평균(공정시험기준 ES 03301.1c — 최종값은 소수점 첫째자리에서 반올림)`;
    const warns = [];
    if (shortRounds.length)
      warns.push(`⚠ 측정 회차가 기준(낮 4회·밤 2회 이상)보다 적습니다 — ${shortRounds.slice(0, 3).join("·")}${shortRounds.length > 3 ? " 등" : ""}`);
    if (mismatched.length)
      warns.push(`⚠ 파일의 평균값이 회차값 산술평균과 다릅니다 — ${mismatched.slice(0, 3).join("·")}${mismatched.length > 3 ? " 등" : ""}`);
    return { header: outHeader, dataRows: outRows, regionCol: regionCol >= 0 ? 1 : -1,
             note: `시간대 ${byLabel.size}개 지점으로 정리(값은 ${src})`, warns };
  }

  function applyAoaToGrid(aoa) {
    if (!aoa.length) { toast("빈 파일입니다", "fail"); return; }
    const regionMode = isRegionMode();
    const fixedCols = columnsFixed();
    const matchFn = fixedCols
      ? (cell) => !!findPeriodByAlias(standards, cell)
      : (cell) => !!findItemByAlias(standards, cell);


    const rowScan = scanBestHeaderRow(aoa, matchFn);
    const colScan = scanBestHeaderRow(aoaTranspose(aoa), matchFn);
    const flipped = colScan.score > rowScan.score;
    const work = flipped ? aoaTranspose(aoa) : aoa;
    const headerScan = flipped ? colScan : rowScan;
    const headerRowIdx = headerScan.idx >= 0 ? headerScan.idx : 0;
    let header = work[headerRowIdx] || [];
    let dataRows = work.slice(headerRowIdx + 1);


    let labelCol = detectLabelCol(header, dataRows);

    let regionCol = regionMode ? detectRegionCol(header, dataRows, labelCol) : -1;








    let foldNote = null, foldWarns = [];
    if (regionMode && fixedCols && !hasGradeScale()) {



      let foldErr = null;



      outer:
      for (const v of [{ work: aoa, scan: rowScan }, { work: aoaTranspose(aoa), scan: colScan }]) {
        const cands = [...new Set([0, v.scan.idx].filter((i) => i >= 0 && i < v.work.length))];
        for (const hIdx of cands) {
          const hdr = v.work[hIdx] || [];
          const drows = v.work.slice(hIdx + 1);
          const lc = detectLabelCol(hdr, drows);
          const folded = foldPeriodRows(hdr, drows, lc, detectRegionCol(hdr, drows, lc));
          if (!folded) continue;
          if (folded.error) { foldErr = folded.error; continue; }
          header = folded.header; dataRows = folded.dataRows;
          labelCol = 0; regionCol = folded.regionCol; foldNote = folded.note;
          foldWarns = folded.warns || [];
          break outer;
        }
      }
      if (!foldNote && foldErr) { toast(foldErr, "fail"); return; }
    }


    const newColumns = fixedCols ? standards.periods.map(makePeriodColumn) : [];
    const colIndexMap = [];
    const unmatchedHeaders = [], skippedAdmin = [];

    let posFallbackHeaders = [], unusedDataHeaders = [];
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


      const restIdxs = header.map((_, idx) => idx).filter((idx) => idx !== labelCol && idx !== regionCol && !isAdminHeader(header[idx]));




      newColumns.forEach((col) => {
        const hi = header.findIndex((h, idx) => idx !== labelCol && idx !== regionCol && findPeriodByAlias(standards, h)?.code === col.code);
        colIndexMap.push(hi);
      });
      const anyLabelMatch = colIndexMap.some((hi) => hi >= 0);
      colIndexMap.forEach((hi, ci) => {
        if (hi < 0) colIndexMap[ci] = anyLabelMatch ? -1 : restIdxs[ci];
      });





      if (!anyLabelMatch && restIdxs.some((idx) => String(header[idx] || "").trim() !== "")) {



        if (!hasGradeScale()) {
          toast(`${standards.periods.map((p) => p.label.split(/[(（]/)[0]).join("·")} 구분을 찾지 못했습니다 — 표의 열 이름이나 구분 열에 시간대를 적어주세요`, "fail");
          return;
        }
        posFallbackHeaders = restIdxs.slice(0, newColumns.length)
          .map((idx) => String(header[idx] || "").trim()).filter(Boolean);
      }
      const usedIdxs = new Set(colIndexMap.filter((i) => i >= 0));
      const leftover = restIdxs.filter((idx) => !usedIdxs.has(idx));





      if (hasGradeScale() && anyLabelMatch) {
        for (const idx of leftover) {
          const h = String(header[idx] || "").trim();
          if (!h) continue;
          newColumns.push(makeCustomColumn(h));
          colIndexMap.push(idx);
          unmatchedHeaders.push(h);
        }
      } else {
        unusedDataHeaders = leftover.map((idx) => String(header[idx] || "").trim()).filter(Boolean);
      }
    }




    const namelessCols = [];
    for (let c = 0; c < header.length; c++) {
      if (c === labelCol || c === regionCol) continue;
      if (String(header[c] ?? "").trim() !== "") continue;
      if (colIndexMap.includes(c)) continue;
      if (dataRows.some((line) => parseNum(line[c]) != null)) namelessCols.push(c + 1);
    }


    const newRows = [];
    const droppedRows = [];
    let regionAssigned = 0;
    let extraTableCut = 0;
    for (let li = 0; li < dataRows.length; li++) {
      const line = dataRows[li];




      if (newRows.length && (line || []).every((v) => v == null || String(v).trim() === "")) {
        extraTableCut = dataRows.length - li - 1;
        break;
      }
      const label = String(line[labelCol] ?? "").trim();
      if (!label) continue;
      const values = {}, texts = {};
      newColumns.forEach((col, ci) => {
        const raw = line[colIndexMap[ci]];
        const num = parseNum(raw);
        values[col.id] = num;




        const txt = raw == null ? "" : String(raw).trim();
        if (num == null && txt !== "") texts[col.id] = txt;
      });
      let region = standards.regions?.[0]?.code || null;
      if (regionCol >= 0) {
        const hit = findRegionByAlias(standards, line[regionCol]);
        if (hit) { region = hit.code; regionAssigned++; }
      }



      if (!newColumns.some((col) => values[col.id] != null || texts[col.id] != null)) { droppedRows.push(label); continue; }
      newRows.push({ id: `r${++rowSeq}`, label, region, values, texts });
    }
    if (!newRows.length) {
      toast("표 형식을 인식하지 못했습니다 — 헤더행·지점명열을 찾지 못했습니다. 직접 입력하거나 붙여넣기를 이용해주세요", "warn");
      return;
    }
    columns = newColumns; rows = newRows;
    refreshAddSelect(); renderGrid(); scheduleCharts();

    const parts = [`${newRows.length}개 지점 × ${newColumns.length}개 항목을 불러왔습니다`];


    if (!foldNote && headerRowIdx > 0) parts.push(`${headerRowIdx + 1}행을 헤더로 인식(상단 안내문 ${headerRowIdx}행 제외)`);
    if (!foldNote && flipped) parts.push("행/열이 뒤집힌 표를 자동으로 맞춤");


    const axisLabel = standards.regionLabel || "지역구분";
    if (regionMode)
      parts.push(regionAssigned > 0
        ? `${axisLabel} ${regionAssigned}건 자동인식`
        : `${axisLabel}은 직접 선택해주세요(현재 ${standards.regions?.[0]?.label || "첫 항목"} 기준으로 판정 중)`);
    if (unmatchedHeaders.length) parts.push(`미인식 ${unmatchedHeaders.length}개는 사용자 항목으로 추가(${unmatchedHeaders.slice(0, 3).join("·")}${unmatchedHeaders.length > 3 ? " 등" : ""})`);
    if (foldNote) parts.push(foldNote);
    for (const w of foldWarns) parts.push(w);
    if (skippedAdmin.length) parts.push(`관리열 ${skippedAdmin.length}개 제외(${skippedAdmin.slice(0, 3).join("·")}${skippedAdmin.length > 3 ? " 등" : ""})`);
    if (posFallbackHeaders.length)
      parts.push(`⚠ 항목명을 찾지 못해 열 순서대로 배정했습니다(${posFallbackHeaders.join("·")} → ${newColumns.map((c) => c.label).join("·")}) — 값이 맞는지 확인하세요`);
    if (unusedDataHeaders.length)
      parts.push(`⚠ 사용되지 않은 열 ${unusedDataHeaders.length}개(${unusedDataHeaders.slice(0, 4).join("·")}${unusedDataHeaders.length > 4 ? " 등" : ""})`);
    if (namelessCols.length)
      parts.push(`⚠ 이름 없는 ${namelessCols.length}개 열(${namelessCols.join("·")}번째)에 값이 있으나 읽지 않았습니다 — 2단 헤더는 항목마다 이름을 적어주세요`);
    if (extraTableCut)
      parts.push(`⚠ 빈 줄 뒤 ${extraTableCut}줄은 다른 표로 보아 읽지 않았습니다 — 표 하나만 담아 올려주세요`);


    const dropLooksMeta = droppedRows.every((l) => /^(단위|구분|비고|unit|항목|기준)/i.test(l));
    if (droppedRows.length)
      parts.push(`${dropLooksMeta ? "" : "⚠ "}값이 없는 행 ${droppedRows.length}개 제외(${droppedRows.slice(0, 3).join("·")}${droppedRows.length > 3 ? " 등" : ""})`);
    toast(parts.join(" · "),
      unmatchedHeaders.length || skippedAdmin.length || posFallbackHeaders.length || unusedDataHeaders.length
        || foldWarns.length || extraTableCut || namelessCols.length
        || (droppedRows.length && !dropLooksMeta) ? "warn" : "ok");
  }




  function applyAoaToRound(aoa) {
    if (!aoa.length) { toast("빈 파일입니다", "fail"); return; }
    const round = activeProject.rounds.find((r) => r.id === currentEditRoundId);
    if (!round || !rows.length) { toast("입력할 회차가 열려 있지 않습니다", "fail"); return; }
    const fixedCols = columnsFixed();
    const matchFn = fixedCols
      ? (cell) => !!findPeriodByAlias(standards, cell)
      : (cell) => !!findItemByAlias(standards, cell);
    const rowScan = scanBestHeaderRow(aoa, matchFn);
    const colScan = scanBestHeaderRow(aoaTranspose(aoa), matchFn);
    const flipped = colScan.score > rowScan.score;
    const work = flipped ? aoaTranspose(aoa) : aoa;
    const headerScan = flipped ? colScan : rowScan;
    const headerRowIdx = headerScan.idx >= 0 ? headerScan.idx : 0;
    let header = work[headerRowIdx] || [];
    let dataRows = work.slice(headerRowIdx + 1);
    const scanCols = Math.min(header.length, 6);
    let labelCol = 0, labelScore = -1;
    for (let c = 0; c < scanCols; c++) {
      let filled = 0, textish = 0;
      for (const line of dataRows) {
        const v = line[c];
        if (v == null || String(v).trim() === "") continue;
        filled++; if (parseNum(v) == null) textish++;
      }
      const score = filled > 0 ? textish / filled : -1;
      if (score > labelScore) { labelScore = score; labelCol = c; }
    }
    const colFileIdx = columns.map((col) =>
      header.findIndex((h, idx) => {
        if (idx === labelCol) return false;
        const it = fixedCols ? findPeriodByAlias(standards, h) : findItemByAlias(standards, h);
        return it && it.code === col.code;
      }));
    const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
    let matchedSites = 0, filledCells = 0;
    const unmatched = [];
    for (const line of dataRows) {
      const flabel = norm(line[labelCol]);
      if (!flabel) continue;
      const row = rows.find((r) => norm(r.label) === flabel);
      if (!row) { unmatched.push(String(line[labelCol]).trim()); continue; }
      matchedSites++;
      columns.forEach((col, ci) => {
        const fi = colFileIdx[ci];
        if (fi < 0) return;
        const raw = line[fi], v = parseNum(raw);
        if (v != null) { row.values[col.id] = v; filledCells++; return; }

        const t = raw == null ? "" : String(raw).trim();
        if (t !== "") { row.texts = row.texts || {}; row.texts[col.id] = t; filledCells++; }
      });
    }
    if (!matchedSites) {
      toast("파일의 지점명이 이 프로젝트의 지점과 맞지 않습니다 — 지점명을 프로젝트와 똑같이 맞춰주세요", "warn");
      return;
    }
    persistSliceEdits(); renderGrid(); scheduleCharts();
    const parts = [`회차 "${round.label}"에 지점 ${matchedSites}개·값 ${filledCells}개를 채웠습니다`];
    if (flipped) parts.push("행/열이 뒤집힌 표를 자동으로 맞춤");
    if (unmatched.length) parts.push(`프로젝트에 없는 지점 ${unmatched.length}개는 건너뜀(${unmatched.slice(0, 3).join("·")}${unmatched.length > 3 ? " 등" : ""})`);
    toast(parts.join(" · "), unmatched.length ? "warn" : "ok");
  }



  function ingestAoa(aoa) {
    if (analysisMode !== "multi") { applyAoaToGrid(aoa); return; }
    if (!activeProject) {
      toast("먼저 위에서 프로젝트를 만들거나 선택한 뒤 파일을 올려주세요", "warn"); return;
    }
    if (multiViewMode !== "newRound" || !currentEditRoundId) startNewRound();
    applyAoaToRound(aoa);
  }

  async function handleFile(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    try {
      if (["xlsx", "xls", "csv"].includes(ext)) {
        const wb = await readWorkbook(XLSX, file);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        ingestAoa(aoa);
      } else if (["hwpx", "pdf"].includes(ext)) {


        toast("HWPX·PDF는 브라우저에서 직접 열 수 없습니다 — 위쪽 \"로컬 런처로 HWPX·PDF 등록문서 자동인식 → 문서 선택…\" 버튼을 사용해주세요(로컬 런처 연결 필요)", "warn");
      } else if (ext === "hwp") {
        toast("구형 HWP(.hwp)는 지원하지 않습니다 — 한글에서 HWPX로 저장해 변환해 주세요", "fail");
      } else {
        toast("지원하지 않는 파일 형식입니다 (xlsx·csv·hwpx·pdf)", "fail");
      }
    } catch (e) {
      toast(`파일 읽기 실패: ${e.message}`, "fail");
    }
  }


  function scheduleCharts() {
    clearTimeout(chartDebounce);
    chartDebounce = setTimeout(() => { renderCharts(); renderSummary(); persistSliceEdits(); }, 350);
  }





  const patternTileCache = {};
  function patternTile(kind, fg, bg) {
    const key = `${kind}|${fg}|${bg}`;
    if (patternTileCache[key]) return patternTileCache[key];
    const dense = kind === "diagonalDense";
    const s = dense ? 5 : 8;
    const t = document.createElement("canvas");
    t.width = t.height = s;
    const p = t.getContext("2d");
    if (bg) { p.fillStyle = bg; p.fillRect(0, 0, s, s); }
    p.strokeStyle = fg; p.fillStyle = fg; p.lineWidth = dense ? 1.6 : 1.4;
    if (kind === "diagonal" || kind === "diagonalDense") {

      p.beginPath(); p.moveTo(-1, s + 1); p.lineTo(s + 1, -1); p.stroke();
    } else if (kind === "grid") {
      p.strokeRect(0, 0, s, s);
    } else if (kind === "dots") {
      p.beginPath(); p.arc(s / 2, s / 2, s * 0.22, 0, Math.PI * 2); p.fill();
    }
    patternTileCache[key] = t;
    return t;
  }
  function makePattern(ctx2d, kind, fg, bg) {
    return ctx2d.createPattern(patternTile(kind, fg, bg), "repeat");
  }


  const MONO_SPEC = [
    { fill: "#d4d4d4", pattern: null },
    { fill: "#8f8f8f", pattern: "diagonal", fg: "#4a4a4a" },
    { fill: "#3d3d3d", pattern: "diagonalDense", fg: "#000000" },
  ];

  const PATTERN_FG_ON_COLOR = "rgba(0,0,0,0.38)";


  function barFill(context, col, forExport) {
    const opts = chartOptsOf(col);
    const v = context.dataset.data[context.dataIndex];
    if (v == null) return "transparent";
    const regionMode = isRegionMode();
    const lvl = judgeLevel(col, regionMode ? rows[context.dataIndex] : null, Number(v));
    const ctx2d = context.chart.ctx;
    if (opts.mono) {
      const spec = MONO_SPEC[lvl] || MONO_SPEC[0];
      return spec.pattern ? makePattern(ctx2d, spec.pattern, spec.fg, spec.fill) : spec.fill;
    }
    const failColor = forExport ? "#DC2626" : cssVar("--fail", "#d64545");
    const actionColor = "#9b1c1c";
    const base = lvl === 2 ? actionColor : lvl === 1 ? failColor : opts.color;

    if (opts.type !== "line" && opts.pattern && opts.pattern !== "none") {
      return makePattern(ctx2d, opts.pattern, PATTERN_FG_ON_COLOR, base);
    }
    return base;
  }

  function barBorder(context, col, forExport) {
    const opts = chartOptsOf(col);
    const v = context.dataset.data[context.dataIndex];
    if (v == null) return "transparent";
    const regionMode = isRegionMode();
    const lvl = judgeLevel(col, regionMode ? rows[context.dataIndex] : null, Number(v));
    if (opts.mono) return (MONO_SPEC[lvl] || MONO_SPEC[0]).fill;
    const failColor = forExport ? "#DC2626" : cssVar("--fail", "#d64545");
    const actionColor = "#9b1c1c";
    return lvl === 2 ? actionColor : lvl === 1 ? failColor : opts.color;
  }

  function buildChartConfig(col, { forExport } = {}) {
    const opts = chartOptsOf(col);
    const regionMode = isRegionMode();




    const warnColor = forExport ? "#D97706" : cssVar("--warn", "#c98a1c");
    const data = rows.map((r) => (r.values[col.id] == null ? null : Number(r.values[col.id])));

    const barBorderWidth = opts.type === "line" ? undefined
      : ((opts.mono || (opts.pattern && opts.pattern !== "none")) ? 1 : 0);
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
          label: col.label, data,
          backgroundColor: (c) => barFill(c, col, forExport),
          borderColor: (c) => barBorder(c, col, forExport),
          borderWidth: barBorderWidth,
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
              afterLabel: (ctx) => tooltipFor(col, rows[ctx.dataIndex], ctx.parsed?.y) || "기준 미등록",
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





  const EXPORT_DPI_SCALE = 3.2;
  function exportChartPNG(col, filename) {
    const opts = chartOptsOf(col);






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



  let chartCardRefs = {};





  function syncFollowers(sourceCol) {
    const src = chartOptsOf(sourceCol);
    for (const c of columns) {
      if (c === sourceCol) continue;
      c.chartOpts = { ...src };
      const ref = chartCardRefs[c.id];
      if (!ref) continue;
      const { card, canvas } = ref;
      card.style.width = `${src.width}px`;
      const wrap = card.querySelector(".ed-chart-canvas-wrap");
      if (wrap) wrap.style.height = `${src.height}px`;
      card.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.type === src.type)));
      const set = (sel, prop, val) => { const el = card.querySelector(sel); if (el) el[prop] = val; };
      set(".ed-c-color", "value", src.color);
      set(".ed-c-pattern", "value", src.pattern);
      set(".ed-c-mono", "checked", src.mono);
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
    let cardIdx = 0;
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
          <label class="ed-chk-label">무늬
            <select class="ed-c-pattern ed-c-select" title="막대 채움 무늬 — 흑백 인쇄 시 항목 구분에 유용합니다" ${dis || opts.mono ? "disabled" : ""}>
              <option value="none"${opts.pattern === "none" ? " selected" : ""}>없음</option>
              <option value="diagonal"${opts.pattern === "diagonal" ? " selected" : ""}>빗금</option>
              <option value="grid"${opts.pattern === "grid" ? " selected" : ""}>격자</option>
              <option value="dots"${opts.pattern === "dots" ? " selected" : ""}>점</option>
            </select>
          </label>
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
          <label class="ed-chk-label" title="초과 단계를 색이 아닌 진하기+빗금으로 구분 — 흑백 인쇄용"><input type="checkbox" class="ed-c-mono" ${opts.mono ? "checked" : ""} ${dis}> 흑백</label>
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
        toast("차트 이미지를 다운로드 폴더에 저장했습니다", "ok");
      });






      const thickInputs = () => [card.querySelector(".ed-c-thick"), card.querySelector(".ed-c-thick-num")];
      card.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
        opts.type = b.dataset.type;
        card.querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        thickInputs().forEach((el) => { el.disabled = opts.type === "line"; });
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      }));
      card.querySelector(".ed-c-color").addEventListener("input", (e) => {
        opts.color = e.target.value;
        rebuildChart(col, canvas);
        if (bulkApplyCharts && isLeader) syncFollowers(col);
      });
      card.querySelector(".ed-c-pattern").addEventListener("change", (e) => {
        opts.pattern = e.target.value;
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
      card.querySelector(".ed-c-mono").addEventListener("change", (e) => {
        opts.mono = e.target.checked;

        const patEl = card.querySelector(".ed-c-pattern");
        if (patEl) patEl.disabled = opts.mono;
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
    transposed = false;
    initColumnsAndRows();


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
  $("#ed-grade-toggle").addEventListener("change", (e) => {
    showGrades = e.target.checked;
    renderGrid();
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



  document.addEventListener("mouseup", () => { selecting = false; });
  document.addEventListener("keydown", (e) => {
    if (!selectionRect || !section.classList.contains("active")) return;
    const span = (selectionRect.r1 > selectionRect.r0) || (selectionRect.c1 > selectionRect.c0);
    if (!span) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!section.contains(document.activeElement) && document.activeElement !== document.body) return;
    e.preventDefault();
    for (let ri = selectionRect.r0; ri <= selectionRect.r1; ri++) {
      for (let ci = selectionRect.c0; ci <= selectionRect.c1; ci++) {
        const row = rows[ri], col = columns[ci];
        if (row && col) { delete row.values[col.id]; delete row.texts?.[col.id]; }
      }
    }
    renderGrid(); scheduleCharts();
  });
  document.addEventListener("copy", (e) => {
    if (!selectionRect || !section.classList.contains("active")) return;
    const span = (selectionRect.r1 > selectionRect.r0) || (selectionRect.c1 > selectionRect.c0);
    if (!span) return;
    const lines = [];
    for (let ri = selectionRect.r0; ri <= selectionRect.r1; ri++) {
      const line = [];
      for (let ci = selectionRect.c0; ci <= selectionRect.c1; ci++) {
        const row = rows[ri], col = columns[ci];
        const v = row && col ? (row.values[col.id] ?? row.texts?.[col.id]) : null;
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
      $("#ed-drop-hint").textContent = `선택됨: ${fileInput.files[0].name}`;
      handleFile(fileInput.files[0]);
    }
  });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });




  function renderBridgeParseUI() {
    const ok = bridge.state === "ok" && bridge.info?.features?.pdf2excel;
    $("#ed-bridge-parse-field").style.display = ok ? "" : "none";
    $("#ed-bridge-parse-locked").style.display = ok ? "none" : "";
  }
  bridge.addEventListener("change", renderBridgeParseUI);
  renderBridgeParseUI();

  $("#ed-bridge-parse").addEventListener("click", async () => {
    const statusEl = $("#ed-bridge-parse-status");
    try {
      const picked = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "files", patterns: "*.hwpx *.pdf" } });
      const path = picked.path || (picked.paths || [])[0];
      if (!path) return;
      const name = path.split(/[\\/]/).pop();
      statusEl.textContent = `"${name}" 처리 중…`;
      const job = await bridge.call("/jobs", { method: "POST", body: { type: "envdata_parse", path } });
      const done = await bridge.pollJob(job.job_id, {
        label: "측정자료 표 인식",
        onProgress: (p) => { if (p?.stage) statusEl.textContent = `"${name}" — ${p.stage}`; },
      });
      const aoa = done.result?.aoa;
      if (!aoa || !aoa.length) { statusEl.textContent = ""; toast("표를 찾지 못했습니다", "fail"); return; }
      ingestAoa(aoa);
      statusEl.textContent = `"${name}" 인식 완료`;
    } catch (e) {
      statusEl.textContent = "";
      toast(`문서 선택·처리 실패: ${e.message}`, "fail");
    }
  });



  bindRangeNumber($("#ed-font-size"), $("#ed-font-size-num"), (pct) => {
    $("#ed-scroll").style.zoom = `${pct}%`;
  });

  renderGrid();
  renderCharts();
}
