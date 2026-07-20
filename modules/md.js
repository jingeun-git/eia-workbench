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

const BRIDGE_EXTS = ["hwp", "hwpx"];

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

async function convertPdf(buf) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
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
  }
  return pages.join("\n\n---\n\n");
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
  section.innerHTML = `
  <div class="panel">
    <h2>문서 → 마크다운 변환</h2>
    <p class="desc">PDF·Word·Excel을 브라우저 안에서 마크다운으로 변환합니다 (파일은 업로드되지 않습니다).
      HWP·HWPX와 OCR(스캔 PDF)은 로컬 브리지 연결 시 고품질 경로로 처리됩니다.</p>

    <div class="field">
      <label>변환할 파일 <span class="req">*</span></label>
      <label class="dropzone" id="md-drop">
        <input type="file" id="md-files" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.hwp,.hwpx">
        <span>PDF·DOCX·XLSX 파일을 끌어다 놓거나 클릭해 선택하세요 (여러 개 가능)</span>
      </label>
    </div>

    <div id="md-list" class="md-list"></div>

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
      b.addEventListener("click", () => { files.splice(+b.dataset.rm, 1); renderList(); updateUI(); }));
  }
  function updateUI() {
    $("#md-run").disabled = running ||
      !files.some((f) => !BRIDGE_EXTS.includes(f.ext));
  }
  function addFiles(newFiles) {
    let bridgeCnt = 0;
    for (const f of newFiles) {
      const e = ext(f.name);
      if (files.some((x) => x.name === f.name)) continue;
      files.push({ file: f, name: f.name, ext: e, status: "ready" });
      if (BRIDGE_EXTS.includes(e)) bridgeCnt++;
    }
    if (bridgeCnt)
      toast(`HWP·HWPX ${bridgeCnt}건은 로컬 브리지 연결 시 변환됩니다 (7단계 배포 예정)`, "warn");
    renderList(); updateUI();
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
    renderList(); renderTabs(); updateUI();
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
          const buf = await item.file.arrayBuffer();
          let md;
          if (item.ext === "pdf") md = await convertPdf(buf);
          else if (item.ext === "docx" || item.ext === "doc") md = await convertDocx(buf);
          else if (item.ext === "xlsx" || item.ext === "xls") md = convertXlsx(buf);
          else throw new Error("지원하지 않는 형식입니다");
          results.push({ name: item.name, md });
          item.status = "ok"; ok++;
        } catch (e) {
          results.push({ name: item.name, md: `[변환 오류] ${e.message}` });
          item.status = "err"; err++;
        }
        done++;
        $("#md-fill").style.width = `${(done / targets.length) * 100}%`;
        renderList();
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
