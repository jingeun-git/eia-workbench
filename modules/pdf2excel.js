/* PDF 표 → 엑셀 (SYS-33 ②)
 *
 * 변환 로직은 99.Tools/pdf2excel/pdf2excel_core.py가 전부 담당한다 — 이 파일은
 * UI만 맡는다. 코어는 SYS-30에서 검증을 마쳤으므로 **로직을 다시 짜지 않는다**
 * (브리지 러너도 GUI와 같은 순서·인자로 scan → group → write_xlsx를 호출한다).
 *
 * 흐름: [1.표 찾기] → 표 목록 확인·선택 → [2.엑셀로 저장]
 *   찾기 단계에서 파일을 만들지 않는 이유는, 페이지 범위를 잘못 넣었을 때
 *   빈 엑셀이 생기지 않고 그 사실이 드러나야 하기 때문이다(코어 설계와 동일).
 */
export function init(section, { bridge, toast }) {
  section.innerHTML = `
  <div class="panel">
    <h2>PDF 표 → 엑셀</h2>
    <p class="desc">PDF 안의 표만 골라 엑셀로 옮깁니다 — 연속된 페이지에 걸친 표는 하나로 합치고,
      중간에 반복되는 머리행은 지웁니다. 표마다 <b>표명·출처</b> 2행이 머리부로 붙습니다.</p>
    <p class="desc" style="margin-top:calc(-1*var(--space-2))">
      <b>지원 파일 — PDF</b> · 한글·Word 문서는 <b>PDF로 저장한 뒤</b> 넣어 주세요.
      <b style="color:var(--warn)">스캔(이미지) PDF는 표를 뽑을 수 없습니다</b> —
      글자가 그림이라 표의 칸을 읽을 수 없습니다(그 경우 [문서 → MD] 탭의 OCR을 쓰세요).
      페이지 범위는 <b>PDF에 실제로 매겨진 물리 쪽번호</b> 기준입니다(보고서 인쇄 쪽번호와 다를 수 있습니다).</p>
    <div id="px-locked" class="placeholder" style="margin-bottom:var(--space-2)">
      ○ 로컬 런처 미연결 — 로컬 런처 실행 후 활성화됩니다.
    </div>
    <div id="px-form" style="display:none">
      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:flex-end;margin-bottom:var(--space-4)">
        <div class="field" style="margin-bottom:0;flex:1 1 340px">
          <label for="px-file">대상 PDF <span class="req">*</span></label>
          <div class="input-row">
            <input type="text" id="px-file" readonly placeholder="[파일 선택]을 누르세요">
            <button class="btn btn-secondary" id="px-pick" type="button">파일 선택</button>
          </div>
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 190px">
          <label for="px-range">페이지 범위</label>
          <input type="text" id="px-range" placeholder="비우면 전체 · 예: 3-12, 20">
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 120px">
          <label for="px-gap">표 사이 공백</label>
          <input type="number" id="px-gap" value="4" min="0" max="20" step="1">
        </div>
      </div>
      <p class="help" style="margin-top:-10px">
        페이지 번호는 <b>PDF 물리 쪽번호</b>입니다(문서에 인쇄된 번호가 아니라 뷰어에 보이는 순번).
        스캔 이미지 PDF는 표를 추출할 수 없습니다 — 텍스트 레이어가 있어야 합니다.
      </p>
      <div style="display:flex;gap:var(--space-2);align-items:center">
        <button class="btn btn-primary" id="px-scan">1. 표 찾기</button>
        <button class="btn btn-primary" id="px-save" disabled>2. 엑셀로 저장</button>
        <button class="btn btn-secondary" id="px-reset">초기화</button>
      </div>
      <div class="progress-wrap" id="px-prog">
        <div class="progress-head"><span class="stage" id="px-stage"></span><span class="count" id="px-count"></span></div>
        <div class="progress-track"><div class="progress-fill" id="px-fill"></div></div>
      </div>
      <div class="table-wrap" id="px-tblwrap">
        <table class="data-table">
          <thead><tr>
            <th style="width:36px"><input type="checkbox" id="px-all" checked></th>
            <th>표제</th><th>쪽</th><th class="num">행</th><th class="num">열</th><th>비고</th>
          </tr></thead>
          <tbody id="px-tbody"></tbody>
        </table>
      </div>
      <div class="log" id="px-log" aria-live="polite"></div>
    </div>
  </div>`;

  const $ = (s) => section.querySelector(s);
  let running = false, scanned = null, srcPath = "";

  const log = (msg, kind = "") => {
    const el = $("#px-log");
    const d = document.createElement("div");
    if (kind) d.className = kind;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    el.classList.add("active");
  };

  const renderState = () => {
    const ok = bridge.state === "ok" && bridge.info?.features?.pdf2excel;
    $("#px-form").style.display = ok ? "" : "none";
    $("#px-locked").style.display = ok ? "none" : "";
    if (!ok) {
      $("#px-locked").textContent = bridge.state !== "ok"
        ? "○ 로컬 런처 미연결 — 로컬 런처를 실행하세요."
        : "⚠ 로컬 런처에서 이 기능을 찾지 못했습니다 — 로컬 런처를 최신 버전으로 다시 실행하세요.";
    }
  };
  bridge.addEventListener("change", renderState);
  renderState();

  $("#px-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "files", patterns: "*.pdf" } });
      const p = r.path || (r.paths || [])[0];
      if (p) { srcPath = p; $("#px-file").value = p; invalidate(); }
    } catch (e) { toast(e.message, "fail"); }
  });

  /* 조건이 바뀌면 이전 표 목록은 더 이상 그 조건의 결과가 아니다 —
     저장 버튼을 잠가 옛 목록으로 저장하는 것을 막는다. */
  function invalidate() {
    scanned = null;
    $("#px-save").disabled = true;
    $("#px-tbody").innerHTML = "";
    $("#px-tblwrap").classList.remove("active");
  }
  for (const sel of ["#px-range", "#px-gap"]) $(sel).addEventListener("change", invalidate);

  function render(tables) {
    const tb = $("#px-tbody");
    tb.innerHTML = "";
    for (const t of tables) {
      const notes = [
        t.removed_headers ? `중간 머리행 ${t.removed_headers}개 제거` : "",
        t.filled_cells ? `격자 판독 ${t.filled_cells}칸 복원` : "",
        t.header_out_of_range ? `<span class="warn-mark" title="표의 머리행이 선택한 페이지 범위 밖에 있습니다 — 범위를 앞으로 넓히면 머리행이 살아납니다">⚠ 머리행 범위 밖</span>` : "",
        t.lost_chars ? `<span class="warn-mark" title="표 영역에서 끝내 읽지 못한 글자입니다. 원본과 대조해 확인하세요">⚠ 미포착 ${t.lost_chars}자</span>` : "",
      ].filter(Boolean).join(" · ");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" class="px-chk" value="${t.idx}" checked></td>
        <td>${t.caption}</td>
        <td class="num">${t.pages}</td>
        <td class="num">${t.rows}</td>
        <td class="num">${t.cols}</td>
        <td style="color:var(--text-muted);font-size:var(--text-xs)">${notes || "—"}</td>`;
      tb.appendChild(tr);
    }
    $("#px-tblwrap").classList.add("active");
    $("#px-save").disabled = false;
  }

  $("#px-all").addEventListener("change", (e) =>
    section.querySelectorAll(".px-chk").forEach((c) => { c.checked = e.target.checked; }));

  async function runJob(body, onDone) {
    running = true;
    $("#px-scan").disabled = $("#px-save").disabled = true;
    $("#px-prog").classList.add("active");
    try {
      const job = await bridge.call("/jobs", { method: "POST", body });
      const done = await bridge.pollJob(job.job_id, {
        label: "PDF 표 추출",
        onLog: (l) => log(l),
        onProgress: (p) => {
          if (!p) return;
          if (p.stage) $("#px-stage").textContent = p.stage;
          if (p.total) {
            $("#px-count").textContent = `${p.done}/${p.total}`;
            $("#px-fill").style.width = `${(p.done / p.total) * 100}%`;
          }
        },
      });
      onDone(done);
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      running = false;
      $("#px-scan").disabled = false;
      $("#px-prog").classList.remove("active");
    }
  }

  $("#px-scan").addEventListener("click", () => {
    if (running) return;
    if (!srcPath) { toast("대상 PDF를 먼저 선택하세요", "fail"); return; }
    $("#px-log").textContent = "";
    invalidate();
    runJob({ type: "pdf2excel_scan", path: srcPath, page_range: $("#px-range").value.trim() },
      (d) => {
        scanned = d.result?.tables || [];
        render(scanned);
        toast(`표 ${scanned.length}개 — 저장할 표를 고른 뒤 [2. 엑셀로 저장]`, "ok");
      });
  });

  $("#px-save").addEventListener("click", () => {
    if (running || !scanned) return;
    const picked = [...section.querySelectorAll(".px-chk:checked")].map((c) => +c.value);
    if (!picked.length) { toast("저장할 표를 하나 이상 고르세요", "fail"); return; }
    runJob({ type: "pdf2excel_write", path: srcPath,
             page_range: $("#px-range").value.trim(),
             picked, gap_rows: parseInt($("#px-gap").value, 10) || 4 },
      () => toast(`표 ${picked.length}개를 엑셀로 저장했습니다 — PDF와 같은 폴더`, "ok"));
  });

  $("#px-reset").addEventListener("click", () => {
    if (running) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    srcPath = ""; $("#px-file").value = ""; $("#px-range").value = "";
    invalidate();
    $("#px-log").textContent = ""; $("#px-log").classList.remove("active");
    $("#px-prog").classList.remove("active"); $("#px-fill").style.width = "0%";
  });
}
