












export function init(section, { bridge, toast }) {
  section.innerHTML = `
  <div class="panel">
    <h2>PDF 병합</h2>
    <div class="desc-cols">
      <p class="desc">여러 PDF를 <b>하나로 합칩니다</b> — 원본 파일마다 <b>책갈피</b>가 자동으로 붙어
        합본에서 원하는 문서를 바로 찾을 수 있습니다.</p>
      <p class="desc">순서는 <b>파일명을 읽어 자동</b>으로 정합니다(<code>자료-2</code>가
        <code>자료-10</code>보다 앞). 다르게 넣고 싶으면 목록에서 <b>끌어서 옮기면</b> 됩니다.
        <b>해상도는 기본이 「자동(원본 품질)」</b>이라 화질이 그대로입니다 — 용량을 줄여야 할 때만 낮추세요.</p>
    </div>
    <div id="pm-locked" class="placeholder" style="margin-bottom:var(--space-2)">
      ○ 로컬 런처 미연결 — 로컬 런처 실행 후 활성화됩니다.
    </div>
    <div id="pm-form" style="display:none">
      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:flex-end;margin-bottom:var(--space-4)">
        <div class="field" style="margin-bottom:0;flex:1 1 340px">
          <label for="pm-src">대상 PDF <span class="req">*</span></label>
          <div class="input-row">
            <input type="text" id="pm-src" readonly placeholder="[파일 선택] 또는 [폴더 선택]">
            <button class="btn btn-secondary" id="pm-pick">파일 선택</button>
            <button class="btn btn-secondary" id="pm-pickdir">폴더 선택</button>
          </div>
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 260px">
          <label for="pm-quality">해상도</label>
          <select id="pm-quality"></select>
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 180px">
          <label for="pm-bookmark">책갈피 이름</label>
          <select id="pm-bookmark">
            <option value="topic">파일명의 주제 부분</option>
            <option value="filename">파일명 그대로</option>
            <option value="none">책갈피 없음</option>
          </select>
        </div>
      </div>
      <p class="help" id="pm-qdesc" style="margin-top:-10px"></p>
      <div class="field" style="flex:1 1 100%">
        <label for="pm-out">저장 위치</label>
        <div class="input-row">
          <input type="text" id="pm-out" readonly placeholder="비우면 첫 파일과 같은 폴더에 「병합본.pdf」">
          <button class="btn btn-secondary" id="pm-pickout">저장 위치 지정</button>
        </div>
      </div>
      <div style="display:flex;gap:var(--space-2);align-items:center">
        <button class="btn btn-primary" id="pm-scan">1. 목록 만들기</button>
        <button class="btn btn-primary" id="pm-run" disabled>2. 하나로 합치기</button>
        <button class="btn btn-secondary" id="pm-reset">초기화</button>
        <span class="help" id="pm-summary"></span>
      </div>
      <div class="progress-wrap" id="pm-prog">
        <div class="progress-head"><span class="stage" id="pm-stage"></span><span class="count" id="pm-count"></span></div>
        <div class="progress-track"><div class="progress-fill" id="pm-fill"></div></div>
      </div>
      <div class="result-table-wrap" id="pm-tblwrap">
        <table class="data-table">
          <thead><tr>
            <th style="width:44px">순서</th>
            <th>파일명 <span class="help">(끌어서 순서 변경)</span></th>
            <th class="num">쪽</th><th class="num">크기(KB)</th><th>비고</th>
          </tr></thead>
          <tbody id="pm-tbody"></tbody>
        </table>
      </div>
      <div class="log" id="pm-log" aria-live="polite"></div>
    </div>
  </div>`;

  const $ = (s) => section.querySelector(s);
  let running = false;
  let rows = [];
  let srcPaths = [];
  let outPath = "";

  const log = (msg, kind = "") => {
    const el = $("#pm-log");
    const d = document.createElement("div");
    if (kind) d.className = kind;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    el.classList.add("active");
  };

  const renderState = () => {
    const ok = bridge.state === "ok" && bridge.info?.features?.pdf_merge;
    $("#pm-form").style.display = ok ? "" : "none";
    $("#pm-locked").style.display = ok ? "none" : "";
    if (!ok) {
      $("#pm-locked").textContent = bridge.state !== "ok"
        ? "○ 로컬 런처 미연결 — 로컬 런처를 실행하세요."
        : "⚠ 로컬 런처에서 이 기능을 찾지 못했습니다 — 로컬 런처를 최신 버전으로 다시 실행하세요.";
    }
  };
  bridge.addEventListener("change", renderState);
  renderState();




  let presets = [{ key: "auto", label: "자동 (원본 품질)", desc: "무손실 — 화질 그대로" }];
  function renderPresets() {
    const sel = $("#pm-quality");
    const keep = sel.value;
    sel.innerHTML = presets
      .map((p) => `<option value="${p.key}">${p.label}</option>`).join("");
    sel.value = presets.some((p) => p.key === keep) ? keep : "auto";
    showDesc();
  }
  function showDesc() {
    const p = presets.find((x) => x.key === $("#pm-quality").value);
    $("#pm-qdesc").textContent = p ? p.desc : "";
  }
  $("#pm-quality").addEventListener("change", showDesc);
  renderPresets();

  $("#pm-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "files", patterns: "*.pdf" } });
      const ps = r.paths || (r.path ? [r.path] : []);
      if (ps.length) { srcPaths = ps; $("#pm-src").value = ps.length === 1 ? ps[0] : `${ps.length}개 파일`; invalidate(); }
    } catch (e) { toast(e.message, "fail"); }
  });
  $("#pm-pickdir").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "folder" } });
      const p = r.path || (r.paths || [])[0];
      if (p) { srcPaths = [p]; $("#pm-src").value = p; invalidate(); }
    } catch (e) { toast(e.message, "fail"); }
  });
  $("#pm-pickout").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "save", initial: "병합본.pdf", patterns: [["PDF 파일", "*.pdf"]] } });
      const p = r.path || (r.paths || [])[0];
      if (p) { outPath = p; $("#pm-out").value = p; }
    } catch (e) { toast(e.message, "fail"); }
  });


  function invalidate() {
    rows = [];
    $("#pm-run").disabled = true;
    $("#pm-tbody").innerHTML = "";
    $("#pm-tblwrap").classList.remove("active");
    $("#pm-summary").textContent = "";
  }




  let dragFrom = null;
  function render() {
    const tb = $("#pm-tbody");
    tb.innerHTML = "";
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.draggable = true;
      tr.dataset.pos = String(i);
      tr.style.cursor = "grab";
      if (r.warn) tr.style.opacity = "0.55";
      tr.innerHTML = `
        <td class="num">${i + 1}</td>
        <td>⠿ ${r.name}</td>
        <td class="num">${r.pages ?? "—"}</td>
        <td class="num">${r.size_kb}</td>
        <td style="color:var(--text-muted);font-size:var(--text-xs)">${
          r.warn ? `<span class="warn-mark">⚠ ${r.warn}</span>` : "—"}</td>`;
      tr.addEventListener("dragstart", () => { dragFrom = i; tr.style.opacity = "0.4"; });
      tr.addEventListener("dragend", () => { dragFrom = null; render(); });
      tr.addEventListener("dragover", (e) => e.preventDefault());
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragFrom === null || dragFrom === i) return;
        const [moved] = rows.splice(dragFrom, 1);
        rows.splice(i, 0, moved);
        dragFrom = null;
        render();
      });
      tb.appendChild(tr);
    });
    $("#pm-tblwrap").classList.add("active");
    const usable = rows.filter((r) => !r.warn);
    const pages = usable.reduce((n, r) => n + (r.pages || 0), 0);
    $("#pm-summary").textContent =
      `${usable.length}개 · ${pages}쪽`
      + (rows.length !== usable.length ? ` (제외 ${rows.length - usable.length}개)` : "");
    $("#pm-run").disabled = usable.length === 0;
  }

  async function runJob(body, label, onDone) {
    running = true;
    $("#pm-scan").disabled = $("#pm-run").disabled = true;
    $("#pm-prog").classList.add("active");
    try {
      const job = await bridge.call("/jobs", { method: "POST", body });
      const done = await bridge.pollJob(job.job_id, {
        label,
        onLog: (l) => log(l),
        onProgress: (p) => {
          if (!p) return;
          if (p.stage) $("#pm-stage").textContent = p.stage;
          if (p.total) {
            $("#pm-count").textContent = `${p.done}/${p.total}`;
            $("#pm-fill").style.width = `${(p.done / p.total) * 100}%`;
          }
        },
      });

      if (done.status === "cancelled") { toast("작업을 중단했습니다", "ok"); return; }
      onDone(done);
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      running = false;
      $("#pm-scan").disabled = false;
      $("#pm-prog").classList.remove("active");
    }
  }

  $("#pm-scan").addEventListener("click", () => {
    if (running) return;
    if (!srcPaths.length) { toast("대상 PDF를 먼저 고르세요", "fail"); return; }
    $("#pm-log").textContent = "";
    invalidate();
    runJob({ type: "pdf_merge_scan", paths: srcPaths }, "PDF 목록", (d) => {
      rows = d.result?.files || [];
      if (d.result?.presets?.length) { presets = d.result.presets; renderPresets(); }
      render();
      toast(`PDF ${rows.length}개 — 순서를 확인한 뒤 [2. 하나로 합치기]`, "ok");
    });
  });

  $("#pm-run").addEventListener("click", () => {
    if (running || !rows.length) return;
    const files = rows.filter((r) => !r.warn).map((r) => r.path);
    if (!files.length) { toast("합칠 수 있는 PDF가 없습니다", "fail"); return; }
    runJob({ type: "pdf_merge", files, out: outPath,
             quality: $("#pm-quality").value,
             bookmark: $("#pm-bookmark").value },
      "PDF 병합",
      (d) => toast(`병합했습니다 — ${d.result?.pages ?? "?"}쪽 · ${d.result?.size_mb ?? "?"}MB`, "ok"));
  });

  $("#pm-reset").addEventListener("click", () => {
    if (running) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    srcPaths = []; outPath = "";
    $("#pm-src").value = ""; $("#pm-out").value = "";
    invalidate();
    $("#pm-log").textContent = ""; $("#pm-log").classList.remove("active");
    $("#pm-prog").classList.remove("active"); $("#pm-fill").style.width = "0%";
  });
}
