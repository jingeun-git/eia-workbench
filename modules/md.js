











const BRIDGE_EXTS = ["hwpx"];


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



const HEADING_PATTERNS = [

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



    pages.push(`## Page ${p}\n${deduped.join("\n")}`);

    page.cleanup();
  }
  return pages.join("\n\n---\n\n");
  } finally {

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




function outBase(name, allNames) {
  const stem = (n) => n.replace(/\.[^.]+$/, "") || "output";
  const base = stem(name);
  const ext = (name.match(/\.([^.]+)$/) || ["", ""])[1].toLowerCase();
  const dup = allNames.filter((n) => stem(n) === base).length > 1;
  return dup && ext ? `${base}(${ext})` : base;
}

function detectGarbledHangul(text) {
  const garbled = text.match(/[?□]{2,}/g);
  if (garbled && garbled.length > 0)
    return garbled.join("").length / text.length > 0.01;
  return false;
}



export function init(section, { bridge, toast }) {











  const CAPS = [
    ["", "HWPX", "PDF", "Excel", "Word"],
    ["쪽번호 <code>## Page N</code>", 0, 1, 0, 0],
    ["표 → 마크다운 표 <b>(로컬 런처)</b>", 1, 1, 1, 1],
    ["표 → 마크다운 표 <b>(브라우저)</b>", "—", 0, 1, 0],
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
    <p class="cap-summary">
      <b>표가 중요한 문서는 아래 [로컬 런처]로 변환하세요.</b>
      브라우저 변환은 PDF·Word의 표를 살리지 못하지만, Excel은 브라우저에서도 표가 그대로 나옵니다.
    </p>
    <details class="md-more">
      <summary>변환 방식이 왜 다른지 자세히 보기</summary>
      <p class="help"><b>표 품질</b> — 브라우저 변환은 PDF·Word의 표를 마크다운 표로 만들지 못해, 셀 내용이 낱줄로 흩어집니다(브라우저에서 쓸 수 있는 라이브러리의 한계입니다). 로컬 런처는 같은 파일에서 표를 <code>| … |</code> 표로 뽑아냅니다.</p>
      <p class="help"><b>쪽번호</b> — 한글·Word는 쪽 나눔을 파일에 저장하지 않고, 프로그램이 화면에 그릴 때 정합니다. 그래서 이 도구는 파일만 읽어서는 쪽번호를 알 수 없습니다. "몇 쪽인지"가 필요하면 PDF로 변환한 뒤 MD로 변환하세요.</p>
      <p class="help"><b>HWPX 권장</b> — HWPX는 내부가 XML이라 목차·표 구조가 그대로 살아납니다. 구형 HWP(.hwp)는 지원하지 않으니, 한글에서 HWPX로 저장해 변환하세요.</p>
    </details>`;

  section.innerHTML = `
  <div class="md-layout">
  <div class="md-main">
  <div class="panel">
    <h2>문서 → 마크다운 변환</h2>
    <p class="desc">PDF·Word·Excel을 브라우저 안에서 마크다운으로 변환합니다 (파일은 업로드되지 않습니다).
      HWPX와 OCR(스캔 PDF)은 브라우저가 열 수 없어 아래 <b>로컬 런처</b>에서 처리합니다.</p>

    <div id="md-prefer" class="placeholder" style="display:none;margin-bottom:var(--space-3)">
      ✓ <b>로컬 런처가 연결돼 있습니다.</b> 표와 목차까지 살리는 변환은 아래
      <b>한글·스캔 문서 변환</b>에서 처리합니다 — 이 위쪽은 표를 살리지 못하는 <b>간이 변환</b>입니다.
      <button class="btn btn-secondary" id="md-goto-bridge" type="button"
              style="margin-left:var(--space-2)">아래로 이동</button>
    </div>

    <div class="field">
      <label>변환할 파일 <span class="req">*</span></label>
      <label class="dropzone" id="md-drop">
        <input type="file" id="md-files" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.hwpx">
        <b class="dz-formats">지원 파일 — PDF · Word · Excel</b>
        <span class="dz-hint">끌어다 놓거나 클릭해 선택하세요 (여러 개 가능). 구형 .hwp는 열지 못하니 한글에서 HWPX로 저장해 주세요.</span>
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
    <h2>한글·스캔 문서 변환 (로컬 런처)</h2>
    <p class="desc">브라우저가 열 수 없는 한글(HWPX)·스캔 PDF와 폴더 통째 변환을 이 로컬 런처가 처리합니다.
      PDF·Word도 이쪽이 표를 더 잘 살립니다. 변환 결과는 원본이 있는 폴더 안 <code>markdown_output</code> 폴더에 만들어집니다.
      <span class="desc-hint">한글 문서는 쪽번호를 남길 수 없습니다 — 오른쪽 [형식별 지원 범위]의 접힌 설명을 참고하세요.</span></p>
    <div id="mb-locked" class="placeholder" style="margin-bottom:var(--space-2)">
      ○ 로컬 런처 미연결 — 로컬 런처 실행 후 활성화됩니다.
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
        <button class="btn btn-primary" id="mb-run">로컬 런처로 변환</button>
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
  const files = [];
  const results = [];
  let activeTab = 0;
  let running = false;




  let bridgeReady = false;

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
        isBridge              ? `<span class="pill warn">로컬 런처 필요</span>` :
                                `<span class="pill">대기</span>`;
      row.innerHTML = `<span class="md-name" title="${item.name}">${item.name}</span>${st}
        <button class="icon-btn" data-rm="${i}" aria-label="${item.name} 제거" style="width:26px;height:26px">✕</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { files.splice(+b.dataset.rm, 1); renderList(); updateUI(); warnIfHeavy(); }));
  }
  function updateUI() {
    const btn = $("#md-run");
    btn.disabled = running ||
      !files.some((f) => !BRIDGE_EXTS.includes(f.ext));

    if (!running) {
      btn.textContent = bridgeReady ? "간이 변환 실행" : "변환 실행";
      btn.className = bridgeReady ? "btn btn-secondary" : "btn btn-primary";
    }
  }


  const BIG_FILE_MB = 80;
  const BIG_TOTAL_MB = 200;
  const BIG_COUNT = 20;

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
      탭이 멈추거나 종료될 수 있습니다. 아래 <b>한글·스캔 문서 변환(로컬 런처)</b>으로 폴더째 처리하시길 권합니다.`;
  }

  function addFiles(newFiles) {
    let bridgeCnt = 0, rejected = 0;
    for (const f of newFiles) {
      const e = ext(f.name);
      if (e === "hwp") { rejected++; continue; }
      if (files.some((x) => x.name === f.name)) continue;
      files.push({ file: f, name: f.name, ext: e, status: "ready" });
      if (BRIDGE_EXTS.includes(e)) bridgeCnt++;
    }
    if (rejected)
      toast(`구형 HWP(.hwp) ${rejected}건은 지원하지 않습니다 — 한글에서 HWPX로 저장해 변환해 주세요`, "fail");
    if (bridgeCnt)
      toast(`HWPX ${bridgeCnt}건은 로컬 런처 연결 시 아래 한글·스캔 문서 변환에서 처리됩니다`, "warn");
    renderList(); updateUI(); warnIfHeavy();
  }


  const drop = $("#md-drop"), input = $("#md-files");
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));


  function renderTabs() {
    const tabs = $("#md-tabs");
    tabs.innerHTML = "";
    results.forEach((r, i) => {
      const b = document.createElement("button");
      b.className = "rtab" + (i === activeTab ? " active" : "");
      b.textContent = outBase(r.name, results.map((x) => x.name));
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


  $("#md-reset").addEventListener("click", () => {
    if (running) { toast("변환 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    files.length = 0; results.length = 0; activeTab = 0;
    renderList(); renderTabs(); updateUI(); warnIfHeavy();
    $("#md-prog").classList.remove("active");
    $("#md-fill").style.width = "0%";
  });


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

            md = await convertPdf(buf, (p, total) => {
              $("#md-stage").textContent = `${item.name} — ${p}/${total}쪽`;
            });
          } else if (item.ext === "docx" || item.ext === "doc") md = await convertDocx(buf);
          else if (item.ext === "xlsx" || item.ext === "xls") md = convertXlsx(buf);
          else throw new Error("지원하지 않는 형식입니다");
          buf = null;
          results.push({ name: item.name, md });
          item.status = "ok"; ok++;
        } catch (e) {
          results.push({ name: item.name, md: `[변환 오류] ${e.message}` });
          item.status = "err"; err++;
        }
        done++;
        $("#md-fill").style.width = `${(done / targets.length) * 100}%`;
        renderList();

        await new Promise((r) => setTimeout(r, 0));
      }
      renderTabs();
      toast(err ? `완료 ${ok}건 / 오류 ${err}건` : `변환 완료 — ${ok}건`, err ? "warn" : "ok");
    } catch (e) {
      toast(e.message, "fail");
    } finally {
      running = false;
      updateUI();
    }
  });


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
    if (!cur) return;
    downloadMd(outBase(cur.name, results.map((x) => x.name)) + ".md", cur.md);
    toast("MD 파일을 다운로드 폴더에 저장했습니다", "ok");
  });

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
      $("#mb-locked").textContent = "⚠ 로컬 런처에서 이 기능을 찾지 못했습니다 — 로컬 런처를 최신 버전으로 다시 실행하세요.";


    bridgeReady = !!ok;
    $("#md-prefer").style.display = ok ? "" : "none";
    updateUI();
  };
  bridge.addEventListener("change", renderBridge);
  renderBridge();

  $("#md-goto-bridge").addEventListener("click", () => {
    $("#mb-form").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#mb-pick").focus();
  });



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
        label: "문서 → MD 변환",
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
      toast("변환 완료 — 원본 폴더 안 markdown_output 폴더를 확인하세요", "ok");
    } catch (e) {
      mbLog(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      mbRunning = false;
      $("#mb-run").disabled = false;
      $("#mb-run").textContent = "로컬 런처로 변환";
    }
  });

  $("#md-saveall").addEventListener("click", async () => {
    const targets = results.filter((r) => !r.md.startsWith("[변환 오류]"));
    if (!targets.length) return;
    const used = new Set();
    for (let i = 0; i < targets.length; i++) {
      const base = outBase(targets[i].name, targets.map((x) => x.name));


      let fn = base + ".md", n = 2;
      while (used.has(fn)) fn = `${base} (${n++}).md`;
      used.add(fn);
      downloadMd(fn, targets[i].md);
      await new Promise((r) => setTimeout(r, 250));
    }
    toast(`${targets.length}개를 다운로드 폴더에 저장했습니다`, "ok");
  });
}
