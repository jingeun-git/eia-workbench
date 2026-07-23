/* md 변환 모듈 (SYS-29 5단계)
 * 원본: 99.Tools/배포용/md_converter.html (최신판, 2026-07-19) — 변환 엔진 그대로 이식:
 *  - QA-11 헤딩 승격(EIA 번호체계 → #~#####, JS \b 한글 함정 회피 룩어헤드)
 *  - 의사볼드(문자 2회 겹침) 복원 dedupDoubledLine — convert_core.py와 동일 로직,
 *    수정 시 양쪽 동시 반영 필수
 *  - QA-13 표 셀 개행 → 공백 치환(표 구조 파괴 방지)
 *  - UTF-8 BOM 저장 + 한글 깨짐 감지
 * 라이브러리(pdf.js 1.4MB·mammoth 0.6MB)는 이 탭 첫 진입 시에만 lazy 로드 —
 * 건축물대장만 쓰는 사용자가 2MB를 내려받지 않게 한다.
 * HWP·HWPX는 브라우저 변환 불가 — 브리지(7단계) 경로로 안내.
 */

const BRIDGE_EXTS = ["hwpx"];

/* ── vendor lazy 로드 ─────────────────────────────────────────────── */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error(`${src} 로드 실패`));
    document.head.appendChild(s);
  });
}
let _libsReady = null;
function ensureLibs() {
  if (!_libsReady) {
    _libsReady = (async () => {
      if (!window.pdfjsLib) {
        await loadScript("vendor/pdf.min.js");
        await loadScript("vendor/pdf.worker.blob.js");
      }
      if (!window.mammoth) await loadScript("vendor/mammoth.min.js");
    })();
  }
  return _libsReady;
}

/* ══ 변환 엔진 — md_converter.html 원본 그대로 ═══════════════════════ */

const HEADING_PATTERNS = [
  // JS \b는 한글을 \w로 안 봐 Python re와 다르다 → (?=\s|$) 룩어헤드 (원본 주석 유지)
  [1, /^제?\s*\d+\s*장(?=\s|$)/],
  [3, /^\d+\.\d+\.\d+\s+\S/],
  [2, /^\d+\.\d+\s+\S/],
  [4, /^[가-힣]\.\s+\S/],
  [5, /^\d+\)\s+\S/],
];
const HEADING_FONT_MIN_RATIO = 0.95;

function dedupDoubledLine(text) {
  const chars = Array.from(text);
  const nonSpaceCount = chars.filter((c) => !/\s/.test(c)).length;
  if (nonSpaceCount < 4 || nonSpaceCount % 2 !== 0) return null;
  const out = [];
  let pending = null;
  for (const c of chars) {
    if (/\s/.test(c)) {
      if (pending !== null) return null;
      out.push(c);
      continue;
    }
    if (pending === null) pending = c;
    else if (pending === c) { out.push(pending); pending = null; }
    else return null;
  }
  if (pending !== null) return null;
  return out.join("");
}

function detectHeadingLevel(text) {
  const stripped = text.trim();
  if (!stripped) return null;
  if (stripped.includes("┃")) return null;
  for (const [level, pattern] of HEADING_PATTERNS)
    if (pattern.test(stripped)) return level;
  return null;
}

function promoteHeading(text, size, bodySize) {
  let title = text;
  let level = detectHeadingLevel(text);
  if (level === null) {
    const dedup = dedupDoubledLine(text);
    if (dedup !== null) {
      level = detectHeadingLevel(dedup);
      if (level !== null) title = dedup;
    }
  }
  if (level === null) return text;
  if (size > 0 && bodySize > 0 && size < bodySize * HEADING_FONT_MIN_RATIO) return text;
  return "#".repeat(level) + " " + title.trim();
}

async function convertPdf(buf, onPage) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false,
  }).promise;
  const pages = [];
  try {
  for (let p = 1; p <= pdf.numPages; p++) {
    onPage?.(p, pdf.numPages);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const rawLines = [];
    let curText = [], curSizes = [], prevY = null;
    const flush = () => {
      if (curText.length) {
        const avg = curSizes.length ? curSizes.reduce((a, b) => a + b, 0) / curSizes.length : 0;
        rawLines.push({ text: curText.join(" ").replace(/ {2,}/g, " ").trim(), size: avg });
      }
      curText = []; curSizes = [];
    };
    for (const item of tc.items) {
      if (!("str" in item)) continue;
      const str = item.str.trim();
      if (prevY !== null && item.transform[5] !== prevY) flush();
      if (str) {
        curText.push(str);
        curSizes.push(Math.abs(item.height) || Math.abs(item.transform[3]) || 0);
      }
      prevY = item.transform[5];
      if (item.hasEOL) { flush(); prevY = null; }
    }
    flush();

    const sizes = rawLines.map((l) => l.size).filter((s) => s > 0).sort((a, b) => a - b);
    const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    const promoted = rawLines.filter((l) => l.text).map((l) => promoteHeading(l.text, l.size, bodySize));
    const deduped = [];
    for (const line of promoted) {
      if (deduped.length && line === deduped[deduped.length - 1] && line.startsWith("#")) continue;
      deduped.push(line);
    }
    pages.push(`<!-- 페이지 ${p} -->\n${deduped.join("\n")}`);
    // 페이지 단위 자원 해제 — 대용량 PDF에서 페이지 객체가 누적되면 탭이 죽는다(SYS-32)
    page.cleanup();
  }
  return pages.join("\n\n---\n\n");
  } finally {
    // 문서 자원·워커 참조 해제. 없으면 다수 파일 연속 변환 시 메모리가 단조 증가한다.
    try { await pdf.destroy(); } catch (_) {}
  }
}

async function convertDocx(buf) {
  const result = await mammoth.convertToMarkdown({ arrayBuffer: buf });
  return (result.value || "").replace(/\n{3,}/g, "\n\n");
}

function convertXlsx(buf) {
  const wb = XLSX.read(buf, { type: "array" });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
    if (!data || !data.length) continue;
    parts.push(`## ${sheetName}\n`);
    const rows = data.filter((r) => r.some((c) => c !== ""));
    if (!rows.length) continue;
    const cols = Math.max(...rows.map((r) => r.length));
    // 셀 안 줄바꿈 → 공백 (QA-13 — 표 행이 물리적으로 쪼개지는 것 방지)
    const clean = (c) => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    parts.push("| " + rows[0].map(clean).join(" | ") + " |");
    parts.push("| " + Array(cols).fill("---").join(" | ") + " |");
    for (let i = 1; i < rows.length; i++) {
      const row = [];
      for (let j = 0; j < cols; j++) row.push(clean(rows[i][j]));
      parts.push("| " + row.join(" | ") + " |");
    }
    parts.push("");
  }
  return parts.join("\n");
}

function detectGarbledHangul(text) {
  const garbled = text.match(/[?□]{2,}/g);
  if (garbled && garbled.length > 0)
    return garbled.join("").length / text.length > 0.01;
  return false;
}

/* ══ UI ══════════════════════════════════════════════════════════════ */

export function init(section, { bridge, toast }) {
  /* 형식별 지원 범위 — **코드에서 확인한 사실만 적는다.**
     쪽번호는 pdf_to_markdown이 '## Page N'을 넣는 PDF에만 있고,
     한글·Word는 쪽 나눔이 파일에 저장되지 않아 원리상 불가능하다.
     표: HWPX <hp:tbl> · PDF find_tables() · Excel DataFrame · Word docx.table
         (구형 HWP는 미지원 — HWPX로 저장 안내) */
  const CAPS = [
    ["", "HWPX", "PDF", "Excel", "Word"],
    ["쪽번호 <code>## Page N</code>", 0, 1, 0, 0],
    ["표 → 마크다운 표", 1, 1, 1, 1],
    ["제목·목차(헤딩)", 1, 1, "시트명", 1],
    ["스캔 문서 OCR", "—", 1, "—", "—"],
    ["브라우저만으로 변환", 0, 1, 1, 1],
  ];
  const cell = (v) =>
    v === 1 ? '<span class="cap-y">○</span>' :
    v === 0 ? '<span class="cap-n">✕</span>' :
    `<span class="cap-p">${v}</span>`;
  const capTable = `
    <table class="cap-table">
      <thead><tr>${CAPS[0].map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead>
      <tbody>${CAPS.slice(1).map((r) =>
        `<tr><th>${r[0]}</th>${r.slice(1).map((v) => `<td class="num">${cell(v)}</td>`).join("")}</tr>`
      ).join("")}</tbody>
    </table>
    <p class="help" style="margin-top:8px">
      <b>쪽번호가 PDF에만 있는 이유</b> — 한글·Word는 쪽 나눔을 파일에 저장하지 않고
      프로그램이 화면에 그릴 때 정합니다. 그래서 파일을 읽는 방식으로는 알 수 없습니다.
      검토 지적처럼 <b>"몇 쪽인지"가 필요하면 PDF로 변환한 뒤 MD 변환</b>하세요.
    </p>
    <p class="help"><b>HWPX로 저장해 변환하세요</b> — HWPX는 내부가 XML이라 목차·표 구조가 그대로 살아납니다.
      구형 HWP(.hwp)는 지원하지 않으니 한글에서 HWPX로 저장해 변환해 주세요.</p>`;

  section.innerHTML = `
  <div class="md-layout">
  <div class="md-main">
  <div class="panel">
    <h2>문서 → 마크다운 변환</h2>
    <p class="desc">PDF·Word·Excel을 브라우저 안에서 마크다운으로 변환합니다 (파일은 업로드되지 않습니다).
      HWPX와 OCR(스캔 PDF)은 브라우저가 열 수 없어 아래 <b>브리지 경로</b>에서 처리합니다.</p>

    <div class="field">
      <label>변환할 파일 <span class="req">*</span></label>
      <label class="dropzone" id="md-drop">
        <input type="file" id="md-files" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.hwpx">
        <span>PDF·DOCX·XLSX 파일을 끌어다 놓거나 클릭해 선택하세요 (여러 개 가능)</span>
      </label>
    </div>

    <div id="md-list" class="md-list"></div>
    <p class="help" id="md-heavy" style="display:none;color:var(--warn);margin-top:var(--space-2)"></p>

    <div style="display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-4)">
      <button class="btn btn-primary" id="md-run" disabled>변환 실행</button>
      <button class="btn btn-secondary" id="md-reset">초기화</button>
    </div>

    <div class="progress-wrap" id="md-prog">
      <div class="progress-head">
        <span class="stage" id="md-stage"></span>
        <span class="count" id="md-count"></span>
      </div>
      <div class="progress-track"><div class="progress-fill" id="md-fill"></div></div>
    </div>

    <div id="md-result" style="display:none;margin-top:var(--space-4)">
      <div class="rtabs" id="md-tabs"></div>
      <textarea id="md-text" readonly style="min-height:280px;margin-top:var(--space-2)" spellcheck="false"></textarea>
      <p class="help" id="md-warn" style="color:var(--fail);display:none">⚠ 한글 깨짐 감지됨 — 원본 파일 인코딩을 확인하세요</p>
      <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
        <button class="btn btn-secondary" id="md-copy">복사</button>
        <button class="btn btn-secondary" id="md-save">.md 저장</button>
        <button class="btn btn-primary" id="md-saveall">전체 저장</button>
      </div>
    </div>
  </div>

  <div class="panel">
    <h2>한글·스캔 문서 변환 (브리지)</h2>
    <p class="desc">브라우저가 열 수 없는 형식(HWPX·스캔 PDF)과 폴더 일괄 처리를 담당합니다
      — <b>변환 품질이 다른 것이 아니라 다룰 수 있는 형식이 다릅니다.</b> 로컬 브리지의 convert_core 엔진을 씁니다
      — 듀얼 PDF 엔진·품질 게이트 포함. 결과는 대상 폴더의 <code>markdown_output/</code>에 저장됩니다.</p>
    <p class="help" style="margin-top:-6px">
      <b>내용만 필요하면</b> 한글 문서(HWPX)를 바로 변환하셔도 됩니다 — 목차·소제목·표 구조가 그대로 살아납니다.
      다만 <b>쪽번호처럼 "문서 안 어디에 있는지"가 중요한 경우에는 PDF로 먼저 변환한 뒤 MD 변환</b>을 권합니다.
      한글 문서는 쪽 나눔이 파일에 저장되지 않고 한글이 화면에 그릴 때 정해지므로, 변환 결과에 쪽번호를 남길 수 없습니다.
    </p>
    <div id="mb-locked" class="placeholder" style="margin-bottom:var(--space-2)">
      ○ 브리지 미연결 — 브리지 실행 후 활성화됩니다.
    </div>
    <div id="mb-form" style="display:none">
      <div class="field">
        <label>변환 대상 <span class="req">*</span> — 폴더(하위 포함) 또는 파일 여러 개</label>
        <div class="input-row">
          <input type="text" id="mb-dir" readonly placeholder="[폴더 선택] 또는 [파일 선택]을 누르세요">
          <button class="btn btn-secondary" id="mb-pick" type="button">폴더 선택</button>
          <button class="btn btn-secondary" id="mb-pick-files" type="button">파일 선택</button>
        </div>
      </div>
      <div style="display:flex;gap:var(--space-2);align-items:center">
        <button class="btn btn-primary" id="mb-run">브리지 변환 실행</button>
        <button class="btn btn-secondary" id="mb-reset">초기화</button>
      </div>
      <div class="progress-wrap" id="mb-prog">
        <div class="progress-head"><span class="stage" id="mb-stage"></span><span class="count" id="mb-count"></span></div>
        <div class="progress-track"><div class="progress-fill" id="mb-fill"></div></div>
      </div>
      <div class="log" id="mb-log" aria-live="polite"></div>
    </div>
  </div>
  </div>

  <aside class="md-side">
    <div class="panel">
      <h2 style="font-size:var(--text-base)">형식별 지원 범위</h2>
      <p class="desc" style="margin-bottom:var(--space-3)">같은 문서라도 원본 형식에 따라 살릴 수 있는 정보가 다릅니다.</p>
      ${capTable}
    </div>
  </aside>
  </div>`;

  const $ = (s) => section.querySelector(s);
  const files = [];    // {file, name, ext, status}
  const results = [];  // {name, md}
  let activeTab = 0;
  let running = false;

  const ext = (n) => n.split(".").pop().toLowerCase();

  function renderList() {
    const list = $("#md-list");
    list.innerHTML = "";
    files.forEach((item, i) => {
      const isBridge = BRIDGE_EXTS.includes(item.ext);
      const row = document.createElement("div");
      row.className = "md-item";
      const st =
        item.status === "ok"  ? `<span class="pill ok">✓ 완료</span>` :
        item.status === "err" ? `<span class="pill fail">✗ 오류</span>` :
        isBridge              ? `<span class="pill warn">브리지 필요</span>` :
                                `<span class="pill">대기</span>`;
      row.innerHTML = `<span class="md-name" title="${item.name}">${item.name}</span>${st}
        <button class="icon-btn" data-rm="${i}" aria-label="${item.name} 제거" style="width:26px;height:26px">✕</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { files.splice(+b.dataset.rm, 1); renderList(); updateUI(); warnIfHeavy(); }));
  }
  function updateUI() {
    $("#md-run").disabled = running ||
      !files.some((f) => !BRIDGE_EXTS.includes(f.ext));
  }
  /* 브라우저 경로는 파일 전체를 메모리에 올린다 — 임계를 넘으면 탭이 죽을 수 있어
     브리지 경로를 권한다(SYS-32). 막지는 않는다: 실제 한계는 PC마다 다르다. */
  const BIG_FILE_MB = 80;      // 단일 파일
  const BIG_TOTAL_MB = 200;    // 합계
  const BIG_COUNT = 20;        // 건수

  function warnIfHeavy() {
    const webTargets = files.filter((f) => !BRIDGE_EXTS.includes(f.ext));
    const totalMB = webTargets.reduce((s, f) => s + f.file.size, 0) / 1024 / 1024;
    const biggest = webTargets.reduce((m, f) => Math.max(m, f.file.size), 0) / 1024 / 1024;
    const reasons = [];
    if (biggest > BIG_FILE_MB) reasons.push(`단일 파일 ${biggest.toFixed(0)}MB`);
    if (totalMB > BIG_TOTAL_MB) reasons.push(`합계 ${totalMB.toFixed(0)}MB`);
    if (webTargets.length > BIG_COUNT) reasons.push(`${webTargets.length}건`);
    const el = $("#md-heavy");
    if (!reasons.length) { el.style.display = "none"; return; }
    el.style.display = "";
    el.innerHTML = `⚠ <b>${reasons.join(" · ")}</b> — 브라우저 변환은 파일을 메모리에 올려 처리하므로
      탭이 멈추거나 종료될 수 있습니다. 아래 <b>브리지 변환</b>으로 폴더째 처리하시길 권합니다.`;
  }

  function addFiles(newFiles) {
    let bridgeCnt = 0, rejected = 0;
    for (const f of newFiles) {
      const e = ext(f.name);
      if (e === "hwp") { rejected++; continue; }   // 구형 HWP(.hwp)는 미지원 — HWPX로 저장 안내
      if (files.some((x) => x.name === f.name)) continue;
      files.push({ file: f, name: f.name, ext: e, status: "ready" });
      if (BRIDGE_EXTS.includes(e)) bridgeCnt++;
    }
    if (rejected)
      toast(`구형 HWP(.hwp) ${rejected}건은 지원하지 않습니다 — 한글에서 HWPX로 저장해 변환해 주세요`, "fail");
    if (bridgeCnt)
      toast(`HWPX ${bridgeCnt}건은 브리지 연결 시 아래 한글·스캔 문서 변환에서 처리됩니다`, "warn");
    renderList(); updateUI(); warnIfHeavy();
  }

  /* 드롭존 */
  const drop = $("#md-drop"), input = $("#md-files");
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  /* 결과 탭 */
  function renderTabs() {
    const tabs = $("#md-tabs");
    tabs.innerHTML = "";
    results.forEach((r, i) => {
      const b = document.createElement("button");
      b.className = "rtab" + (i === activeTab ? " active" : "");
      b.textContent = r.name.replace(/\.[^.]+$/, "");
      b.title = r.name;
      b.addEventListener("click", () => { activeTab = i; renderTabs(); });
      tabs.appendChild(b);
    });
    const cur = results[activeTab];
    $("#md-text").value = cur?.md || "";
    $("#md-warn").style.display =
      cur && detectGarbledHangul(cur.md) ? "" : "none";
    $("#md-result").style.display = results.length ? "" : "none";
  }

  /* 초기화 (공통 규격) */
  $("#md-reset").addEventListener("click", () => {
    if (running) { toast("변환 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    files.length = 0; results.length = 0; activeTab = 0;
    renderList(); renderTabs(); updateUI(); warnIfHeavy();
    $("#md-prog").classList.remove("active");
    $("#md-fill").style.width = "0%";
  });

  /* 변환 실행 */
  $("#md-run").addEventListener("click", async () => {
    if (running) return;
    running = true; updateUI();
    const runBtn = $("#md-run");
    runBtn.innerHTML = `<span class="spinner"></span> 변환 중…`;
    $("#md-prog").classList.add("active");
    results.length = 0; activeTab = 0;

    try {
      $("#md-stage").textContent = "변환 라이브러리 로드 중…";
      $("#md-fill").classList.add("indeterminate");
      await ensureLibs();
      $("#md-fill").classList.remove("indeterminate");

      const targets = files.filter((f) => !BRIDGE_EXTS.includes(f.ext));
      let done = 0, ok = 0, err = 0;
      for (const item of targets) {
        $("#md-stage").textContent = item.name;
        $("#md-count").textContent = `${done + 1}/${targets.length}`;
        try {
          let buf = await item.file.arrayBuffer();
          let md;
          if (item.ext === "pdf") {
            // 페이지 진행 표시 — 수백 쪽 PDF에서 "멈춘 것처럼" 보이는 구간 제거
            md = await convertPdf(buf, (p, total) => {
              $("#md-stage").textContent = `${item.name} — ${p}/${total}쪽`;
            });
          } else if (item.ext === "docx" || item.ext === "doc") md = await convertDocx(buf);
          else if (item.ext === "xlsx" || item.ext === "xls") md = convertXlsx(buf);
          else throw new Error("지원하지 않는 형식입니다");
          buf = null;   // 원본 버퍼 참조 해제 — 다음 파일 처리 전 회수 가능하게
          results.push({ name: item.name, md });
          item.status = "ok"; ok++;
        } catch (e) {
          results.push({ name: item.name, md: `[변환 오류] ${e.message}` });
          item.status = "err"; err++;
        }
        done++;
        $("#md-fill").style.width = `${(done / targets.length) * 100}%`;
        renderList();
        // 이벤트 루프 양보 — 연속 변환 중 UI가 얼어붙지 않게 하고 GC 기회를 준다
        await new Promise((r) => setTimeout(r, 0));
      }
      renderTabs();
      toast(err ? `완료 ${ok}건 / 오류 ${err}건` : `변환 완료 — ${ok}건`, err ? "warn" : "ok");
    } catch (e) {
      toast(e.message, "fail");
    } finally {
      running = false;
      runBtn.textContent = "변환 실행";
      updateUI();
    }
  });

  /* 복사·저장 — UTF-8 BOM (원본 동일: 한글 깨짐 방지) */
  const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const downloadMd = (name, md) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([BOM, md], { type: "text/markdown;charset=utf-8" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("#md-copy").addEventListener("click", async () => {
    const t = $("#md-text").value;
    if (!t) return;
    try { await navigator.clipboard.writeText(t); toast("복사됨", "ok"); }
    catch { $("#md-text").select(); document.execCommand("copy"); }
  });
  $("#md-save").addEventListener("click", () => {
    const cur = results[activeTab];
    if (cur) downloadMd(cur.name.replace(/\.[^.]+$/, "") + ".md", cur.md);
  });
  /* ── 브리지 경로(한글·스캔·일괄) ─────────────────────────────────── */
  let mbRunning = false;
  const mbLog = (msg, cls = "") => {
    const el = $("#mb-log");
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };
  const renderBridge = () => {
    const ok = bridge.state === "ok" && bridge.info?.features?.convert;
    $("#mb-locked").style.display = ok ? "none" : "";
    $("#mb-form").style.display = ok ? "" : "none";
    if (!ok && bridge.state === "ok")
      $("#mb-locked").textContent = "⚠ 브리지에 convert_core가 없습니다 — 브리지 설치 구성을 확인하세요.";
  };
  bridge.addEventListener("change", renderBridge);
  renderBridge();

  /* 선택한 대상은 경로 배열로 들고 있는다 — 브리지 run_convert는 paths[]를
     받으므로 폴더 1개든 파일 여러 개든 같은 경로로 처리된다. */
  let mbPaths = [];
  const mbShow = () => {
    $("#mb-dir").value = mbPaths.length === 1 ? mbPaths[0]
      : mbPaths.length ? `${mbPaths.length}개 선택 — ${mbPaths.map((p) => p.split(/[\\/]/).pop()).join(", ")}`
      : "";
  };
  $("#mb-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
      if (r.path) { mbPaths = [r.path]; mbShow(); }
    } catch (e) { toast(e.message, "fail"); }
  });
  $("#mb-pick-files").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "files", patterns: "*.pdf *.hwpx *.docx *.xlsx *.xls" } });
      if (r.paths?.length) { mbPaths = r.paths; mbShow(); }
    } catch (e) { toast(e.message, "fail"); }
  });
  $("#mb-reset").addEventListener("click", () => {
    if (mbRunning) { toast("변환 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    mbPaths = []; $("#mb-dir").value = "";
    $("#mb-log").textContent = ""; $("#mb-log").classList.remove("active");
    $("#mb-prog").classList.remove("active"); $("#mb-fill").style.width = "0%";
  });
  $("#mb-run").addEventListener("click", async () => {
    if (mbRunning) return;
    if (!mbPaths.length) { toast("변환할 폴더 또는 파일을 먼저 선택하세요", "fail"); return; }
    mbRunning = true;
    $("#mb-run").disabled = true;
    $("#mb-run").innerHTML = `<span class="spinner"></span> 변환 중…`;
    $("#mb-prog").classList.add("active");
    $("#mb-log").classList.add("active");
    try {
      const job = await bridge.call("/jobs", { method: "POST", body: { type: "convert", paths: mbPaths } });
      await bridge.pollJob(job.job_id, {
        onLog: (line) => mbLog(line),
        onProgress: (p) => {
          if (!p) return;
          if (p.stage) $("#mb-stage").textContent = p.stage;
          if (p.total) {
            $("#mb-count").textContent = `${p.done}/${p.total}`;
            $("#mb-fill").style.width = `${(p.done / p.total) * 100}%`;
          }
        },
      });
      mbLog("─── 완료", "ok");
      toast("브리지 변환 완료 — markdown_output 폴더를 확인하세요", "ok");
    } catch (e) {
      mbLog(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      mbRunning = false;
      $("#mb-run").disabled = false;
      $("#mb-run").textContent = "브리지 변환 실행";
    }
  });

  $("#md-saveall").addEventListener("click", async () => {
    const targets = results.filter((r) => !r.md.startsWith("[변환 오류]"));
    if (!targets.length) return;
    const used = new Set();
    for (let i = 0; i < targets.length; i++) {
      let base = targets[i].name.replace(/\.[^.]+$/, "") || "output";
      let fn = base + ".md", n = 2;
      while (used.has(fn)) fn = `${base} (${n++}).md`;
      used.add(fn);
      downloadMd(fn, targets[i].md);
      await new Promise((r) => setTimeout(r, 250));   // 연속 다운로드 차단 회피 (원본 동일)
    }
    toast(`전체 저장 완료 (${targets.length}개)`, "ok");
  });
}
