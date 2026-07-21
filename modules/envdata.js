/* 환경질 측정 데이터 분석·그래프화 (SYS-41, Phase 1: 대기질 단일분석)
 * 설계: tasks/specs/2026-07-22-환경질측정데이터분석도구-design.md
 *
 * 입력 4단계 폴백: HWP/PDF 자동파싱(브리지, 이번 초안에서는 미구현 — step 6)
 *   → xlsx/csv 업로드(브라우저) → 붙여넣기 → 그리드 직접입력.
 * 기준DB(air.json)는 law_client.py로 원문 직접 검증한 값만 담는다(추정값 금지).
 */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

async function loadStandards(V) {
  const url = new URL(`../shared/env_standards/air.json?v=${V || ""}`, import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`기준DB 로드 실패 (HTTP ${r.status})`);
  return r.json();
}

function findItemByAlias(standards, text) {
  const norm = String(text || "").toLowerCase().replace(/[\s()（）·./\-]/g, "");
  if (!norm) return null;
  for (const item of standards.items) {
    for (const alias of item.aliases) {
      const an = alias.toLowerCase().replace(/[\s()（）·./\-]/g, "");
      if (an && (norm.includes(an) || an.includes(norm))) return item;
    }
  }
  return null;
}

export async function init(section, { toast, bridge, V }) {
  section.innerHTML = `<div class="panel"><h2>환경질 측정 데이터 분석</h2>
    <div class="placeholder">기준DB를 불러오는 중…</div></div>`;

  let standards;
  try {
    standards = await loadStandards(V);
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
  function makeColumnFromItem(item) {
    const def = item.standards.find((s) => s.default) || item.standards[0];
    return { id: `c${++colSeq}`, code: item.code, label: item.label, unit: def?.unit || "",
             averaging: def?.averaging || null, custom: false, overrideValue: null, unitScale: 1 };
  }
  function makeCustomColumn(label) {
    return { id: `c${++colSeq}`, code: null, label: label || `열${columns.length + 1}`,
             unit: "", averaging: null, custom: true, overrideValue: null, unitScale: 1 };
  }
  let columns = standards.items.map(makeColumnFromItem);
  let rows = [1, 2, 3].map(() => ({ id: `r${++rowSeq}`, label: "", values: {} }));
  let chartType = "bar";
  let chartColor = cssVar("--accent", "#2f6fed");
  let chartHeight = 260;
  let charts = {}; // colId -> Chart 인스턴스
  let chartDebounce = null;

  /* ── 판정 로직 ─────────────────────────────────────────────────────── */
  /* ppm 항목만 ppb 표시로 전환 가능(질량농도 항목은 ppb 개념이 없다) */
  function isPpmItem(col) {
    if (col.custom || !col.code) return false;
    const item = standards.items.find((i) => i.code === col.code);
    return item?.standards?.[0]?.unit === "ppm";
  }
  function dbStandard(col) {
    if (col.custom || !col.code) return null;
    const item = standards.items.find((i) => i.code === col.code);
    if (!item) return null;
    const raw = item.standards.find((s) => s.averaging === col.averaging)
        || item.standards.find((s) => s.default) || item.standards[0];
    if (!raw) return null;
    const scale = col.unitScale || 1;
    return scale === 1000 ? { ...raw, value: raw.value * 1000, unit: "ppb" } : raw;
  }
  function effectiveStandard(col) {
    const db = dbStandard(col);
    if (col.overrideValue != null)
      return { value: col.overrideValue, unit: db?.unit || (col.unitScale === 1000 ? "ppb" : col.unit) || "",
                averaging: db?.averaging || "사용자지정", source: "custom" };
    if (db) return { ...db, source: "db" };
    return null;
  }
  function judge(col, value) {
    if (value == null) return "";
    const std = effectiveStandard(col);
    if (!std) return "ed-nostd";
    return value > std.value ? "ed-exceed" : "ed-ok";
  }

  /* ── 마크업 ────────────────────────────────────────────────────────── */
  section.innerHTML = `
  <div class="panel">
    <h2>환경질 측정 데이터 분석 — 대기질 (단일분석)</h2>
    <p class="desc">측정 결과를 표에 입력하면 대기환경기준(환경정책기본법 시행령 별표1) 초과 여부를 자동 판별하고
      항목별 그래프를 그립니다. xlsx·csv 업로드, 엑셀에서 복사한 내용 붙여넣기, 표 직접 입력을 모두 지원합니다.
      HWP·PDF 등록문서 자동인식은 브리지 연동 다음 업데이트에서 지원됩니다.</p>

    <div class="field">
      <label>등록문서 업로드 (xlsx·csv·hwp·pdf)</label>
      <label class="dropzone" id="ed-drop">
        <input type="file" id="ed-file" accept=".xlsx,.xls,.csv,.hwp,.pdf">
        <span id="ed-drop-msg">파일을 선택하거나 끌어다 놓으세요 — 첫 행은 항목명, 첫 열은 측정지점으로 인식합니다</span>
      </label>
      <p class="help">xlsx·csv는 바로 인식됩니다. 표의 셀을 클릭한 뒤 Ctrl+V로 엑셀 내용을 직접 붙여넣을 수도 있습니다.</p>
    </div>

    <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--space-3)">
      <select id="ed-add-item" class="ed-add-select"><option value="">+ 항목 추가…</option></select>
      <button class="btn btn-secondary" id="ed-add-row">+ 지점 추가</button>
      <button class="btn btn-secondary" id="ed-reset">표 초기화</button>
    </div>

    <div class="ed-scroll" id="ed-scroll">
      <table class="ed-table" id="ed-table">
        <thead><tr id="ed-thead-row"></tr></thead>
        <tbody id="ed-tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3 style="margin:0 0 var(--space-3)">그래프</h3>
    <div class="ed-chart-tools">
      <div class="segment" role="group" aria-label="그래프 타입">
        <button type="button" data-ctype="bar" aria-pressed="true">막대</button>
        <button type="button" data-ctype="line" aria-pressed="false">선</button>
      </div>
      <label class="ed-color-label">색상 <input type="color" id="ed-color" value="${chartColor.startsWith('#') ? chartColor : '#2f6fed'}"></label>
      <label class="ed-size-label">크기 <input type="range" id="ed-size" min="160" max="520" value="${chartHeight}"></label>
    </div>
    <div class="ed-charts" id="ed-charts"></div>
  </div>`;

  const $ = (s) => section.querySelector(s);

  /* ── 항목 추가 셀렉트 채우기 ───────────────────────────────────────── */
  function refreshAddSelect() {
    const sel = $("#ed-add-item");
    const used = new Set(columns.filter((c) => !c.custom).map((c) => c.code));
    sel.innerHTML = `<option value="">+ 항목 추가…</option>`
      + standards.items.filter((i) => !used.has(i.code))
          .map((i) => `<option value="${i.code}">${escapeHtml(i.label)}</option>`).join("")
      + `<option value="__custom">직접 입력(사용자 정의 항목)</option>`;
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

  function renderGrid() {
    const thead = $("#ed-thead-row");
    thead.innerHTML = "";
    // tbody 각 행은 [드래그핸들, 측정지점명, 항목…, 삭제] 순 — 헤더도 칸 수를 정확히 맞춰야
    // 컬럼이 한 칸씩 밀리지 않는다(2026-07-22 사용자 실사용 중 발견 — 헤더-바디 셀 수 불일치로
    // 항목명·기준초과 표시가 전부 한 칸씩 어긋나 보였던 근본 원인).
    const dragTh = document.createElement("th");
    dragTh.style.width = "22px";
    thead.appendChild(dragTh);
    const corner = document.createElement("th");
    corner.textContent = "측정지점";
    corner.style.minWidth = "110px";
    thead.appendChild(corner);

    for (const col of columns) {
      const th = document.createElement("th");
      th.dataset.col = col.id;
      th.title = "드래그해서 항목 순서 변경";
      const std = effectiveStandard(col);
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

      for (const col of columns) {
        const td = document.createElement("td");
        const val = row.values[col.id];
        td.className = `ed-cell ${judge(col, val)}`;
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
          if (col) cell.className = `ed-cell ${judge(col, v)}`;
        }
        scheduleCharts();
      });
    });
    section.querySelector("#ed-table").addEventListener("paste", onPaste);
  }

  /* ── 붙여넣기 ──────────────────────────────────────────────────────── */
  function ensureCustomColumn(label) {
    const col = makeCustomColumn(label);
    columns.push(col);
    return col;
  }
  function ensureRowAt(idx) {
    while (rows.length <= idx) rows.push({ id: `r${++rowSeq}`, label: "", values: {} });
    return rows[idx];
  }
  function onPaste(e) {
    const target = e.target.closest("[data-row]");
    if (!target) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    const grid = text.replace(/\r/g, "").split("\n").filter((l) => l.length).map((l) => l.split("\t"));
    if (!grid.length) return;
    const startRowIdx = rows.findIndex((r) => r.id === target.dataset.row);
    const startColIdx = columns.findIndex((c) => c.id === target.dataset.col);
    const baseColIdx = target.dataset.col === "-1" ? -1 : startColIdx;

    grid.forEach((line, ri) => {
      const row = ensureRowAt(startRowIdx + ri);
      line.forEach((cellText, ci) => {
        const colIdx = baseColIdx + ci;
        const text2 = cellText.trim();
        if (colIdx === -1) { row.label = text2; return; }
        while (columns.length <= colIdx) ensureCustomColumn(`열${columns.length + 1}`);
        row.values[columns[colIdx].id] = parseNum(text2);
      });
    });
    refreshAddSelect(); renderGrid(); scheduleCharts();
    toast(`붙여넣기 완료 — ${grid.length}행 반영`, "ok");
  }

  /* ── xlsx/csv 업로드 (첫 행=항목명, 첫 열=측정지점 — 실제 보고서 패턴과 동일) ── */
  function applyAoaToGrid(aoa) {
    if (!aoa.length) { toast("빈 파일입니다", "fail"); return; }
    const header = aoa[0];
    const newColumns = [];
    for (let i = 1; i < header.length; i++) {
      const h = String(header[i] || "").trim();
      if (!h) continue;
      const item = findItemByAlias(standards, h);
      newColumns.push(item ? makeColumnFromItem(item) : makeCustomColumn(h));
    }
    const newRows = [];
    for (let r = 1; r < aoa.length; r++) {
      const line = aoa[r];
      const label = String(line[0] || "").trim();
      if (!label) continue;
      const values = {};
      newColumns.forEach((col, ci) => { values[col.id] = parseNum(line[ci + 1]); });
      newRows.push({ id: `r${++rowSeq}`, label, values });
    }
    if (!newRows.length) { toast("표 형식을 인식하지 못했습니다 — 직접 입력해주세요", "warn"); return; }
    columns = newColumns; rows = newRows;
    refreshAddSelect(); renderGrid(); scheduleCharts();
    toast(`${newRows.length}개 지점 × ${newColumns.length}개 항목을 불러왔습니다`, "ok");
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
    chartDebounce = setTimeout(renderCharts, 350);
  }
  function renderCharts() {
    const container = $("#ed-charts");
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};
    container.innerHTML = "";

    const failColor = cssVar("--fail", "#d64545");
    let any = false;
    for (const col of columns) {
      const data = rows.map((r) => (r.values[col.id] == null ? null : Number(r.values[col.id])));
      if (!data.some((v) => v != null)) continue;
      any = true;

      const card = document.createElement("div");
      card.className = "panel ed-chart-card";
      card.innerHTML = `<div class="ed-chart-head"><h4>${escapeHtml(col.label)}</h4>
        <button type="button" class="btn btn-secondary ed-chart-png">PNG 저장</button></div>
        <div class="ed-chart-canvas-wrap" style="height:${chartHeight}px"><canvas></canvas></div>`;
      container.appendChild(card);

      const canvas = card.querySelector("canvas");
      const std = effectiveStandard(col);
      const colors = data.map((v) => (std && v != null && v > std.value) ? failColor : chartColor);
      const annotations = std ? {
        stdLine: {
          type: "line", yMin: std.value, yMax: std.value,
          borderColor: cssVar("--warn", "#c98a1c"), borderWidth: 2, borderDash: [6, 4],
          label: { display: true, content: `기준 ${std.value}${std.unit}(${std.averaging}${std.source === "custom" ? "·사용자지정" : ""})`,
                    position: "end", backgroundColor: cssVar("--warn", "#c98a1c"), color: "#fff", font: { size: 10 } },
        },
      } : {};

      charts[col.id] = new Chart(canvas.getContext("2d"), {
        type: chartType,
        data: {
          labels: rows.map((r) => r.label || "(이름없음)"),
          datasets: [{ label: col.label, data, backgroundColor: colors, borderColor: colors,
                       tension: chartType === "line" ? 0.25 : 0, fill: false }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, annotation: { annotations } },
          scales: { y: { beginAtZero: true, title: { display: !!std, text: std?.unit || "" } } },
        },
      });

      card.querySelector(".ed-chart-png").addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = `대기질_${col.code || col.label}_${new Date().toISOString().slice(0, 10)}.png`;
        a.click();
      });
    }
    if (!any) container.innerHTML = `<div class="placeholder">표에 측정값을 입력하면 그래프가 나타납니다</div>`;
  }

  /* ── 툴바 이벤트 ───────────────────────────────────────────────────── */
  refreshAddSelect();
  $("#ed-add-item").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    if (v === "__custom") {
      const name = prompt("새 항목 이름을 입력하세요 (예: 총부유먼지)");
      if (name && name.trim()) ensureCustomColumn(name.trim());
    } else {
      const item = standards.items.find((i) => i.code === v);
      columns.push(makeColumnFromItem(item));
    }
    e.target.value = "";
    refreshAddSelect(); renderGrid(); scheduleCharts();
  });
  $("#ed-add-row").addEventListener("click", () => {
    rows.push({ id: `r${++rowSeq}`, label: "", values: {} });
    renderGrid();
  });
  $("#ed-reset").addEventListener("click", () => {
    columns = standards.items.map(makeColumnFromItem);
    rows = [1, 2, 3].map(() => ({ id: `r${++rowSeq}`, label: "", values: {} }));
    refreshAddSelect(); renderGrid(); scheduleCharts();
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

  section.querySelectorAll("[data-ctype]").forEach((b) => b.addEventListener("click", () => {
    chartType = b.dataset.ctype;
    section.querySelectorAll("[data-ctype]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderCharts();
  }));
  $("#ed-color").addEventListener("input", (e) => { chartColor = e.target.value; renderCharts(); });
  $("#ed-size").addEventListener("input", (e) => {
    chartHeight = parseInt(e.target.value, 10);
    section.querySelectorAll(".ed-chart-canvas-wrap").forEach((w) => { w.style.height = `${chartHeight}px`; });
    Object.values(charts).forEach((c) => c.resize());
  });

  renderGrid();
  renderCharts();
}
