








const META = {
  pdf: {
    title: "한글(HWPX·HWP) → PDF 일괄 변환",
    desc: "선택한 폴더(하위 포함)의 HWPX·HWP를 PDF로 일괄 변환합니다. 모아찍기 무시·단면, 텍스트 보존(이미지화 안 함).",
    feature: "hwp2pdf",
  },
  pagenum: {
    title: "쪽번호 일괄 부여",
    desc: "폴더를 스캔해 파일별 쪽수·A3 위치·장 경계를 확인한 뒤, 제책 규칙(양면 인쇄 기준)에 맞춰 쪽번호를 재부여합니다.",
    feature: "pagenum",
  },
};

export function init(section, { bridge, toast, mountStopButton }, kind) {
  const m = META[kind];

  section.innerHTML = `
  <div class="panel">
    <h2>${m.title}</h2>
    <p class="desc">${m.desc}</p>
    <p class="desc" style="margin-top:calc(-1*var(--space-2))">
      <b>지원 파일 — HWP · HWPX</b> · 설치된 한글로 처리합니다(파일은 PC 밖으로 나가지 않습니다).</p>
    ${kind === "pagenum" ? `
    <div class="help hw-namerule">
      <b>파일 이름 규칙</b> — 장별 파일 이름 맨 앞의 <b>네 자리 코드</b>로 장·절과 편철 순서를 읽습니다(앞 두 자리 = 장, 뒤 두 자리 = 절). 파일은 이름 순서대로 편철되므로 코드가 곧 쪽 순서입니다.
      <table class="cap-table hw-code-table">
        <thead><tr><th>파일 이름 예</th><th>읽는 코드</th><th>결과</th></tr></thead>
        <tbody>
          <tr><td><code>0100 사업개요.hwp</code></td><td>0100</td><td>1장 — 번호 부여</td></tr>
          <tr><td><code>0711 동식물상.hwp</code></td><td>0711</td><td>7장 11절 — 번호 부여</td></tr>
          <tr><td><code>(사업명) 0100 요약문.hwp</code></td><td>0100</td><td>앞 글자는 건너뛰고 첫 코드 사용</td></tr>
          <tr><td><code>표지.hwp</code> · <code>00</code>장</td><td>없음 / 00</td><td>번호에서 제외(표지·옆표지·목차)</td></tr>
        </tbody>
      </table>
    </div>` : ""}
    <div id="hw-locked" class="placeholder" style="margin-bottom:var(--space-4)"></div>
    <div id="hw-form">
      <div class="field">
        <label>${kind === "pdf"
          ? '변환 대상 <span class="req">*</span> — 폴더(하위 포함) 또는 파일 여러 개'
          : '대상 폴더 <span class="req">*</span>'}</label>
        <div class="input-row">
          <input type="text" id="hw-dir" readonly placeholder="[폴더 선택]${kind === "pdf" ? " 또는 [파일 선택]" : ""}을 누르세요">
          <button class="btn btn-secondary" id="hw-pick" type="button">폴더 선택</button>
          ${kind === "pdf" ? '<button class="btn btn-secondary" id="hw-pick-files" type="button">파일 선택</button>' : ""}
        </div>
        <p class="help">파일은 PC 안에서만 처리됩니다 — 웹으로 전송되지 않습니다.</p>
      </div>
      ${kind === "pagenum" ? `
      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:flex-end;margin-bottom:var(--space-4)">
        <div class="field" style="margin-bottom:0;flex:0 0 180px">
          <label for="hw-start">시작 쪽번호 <span class="req">*</span></label>
          <input type="number" id="hw-start" value="1" min="1" step="1">
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 240px">
          <label for="hw-restart">쪽번호 방식</label>
          <select id="hw-restart">
            <option value="continuous">전체 연속 — 처음부터 끝까지 이어짐</option>
            <option value="chapter">장별 재시작 — 각 장이 1부터 다시</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 240px">
          <label for="hw-divider">장별 간지</label>
          <select id="hw-divider">
            <option value="none">없음 — 간지를 별도 인쇄</option>
            <option value="one">간지 1장 — 뒷면 공백 없음</option>
            <option value="two">간지 2장 — 뒷면 공백 페이지 포함</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 240px">
          <label for="hw-a3back">A3 뒷면</label>
          <select id="hw-a3back">
            <option value="skip">결번 — 빈 페이지 없음</option>
            <option value="blank">물리 공백 페이지 있음</option>
          </select>
        </div>
      </div>
      <p class="help" style="margin-top:-8px">
        <b>아래 설정은 이 문서가 이미 어떤 상태인지 알려주는 것</b>이며, 도구가 문서를 그 상태로 바꾸지는 않습니다.
        선언과 실제가 다른 파일은 스캔 결과 비고에 <b style="color:var(--fail)">빨간 경고</b>가 표시되니 확인 후 진행하세요.
      </p>
      <details class="help">
        <summary style="cursor:pointer">'장별 재시작'은 언제 고르나요?</summary>
        <p style="margin:8px 0 0"><b>각 장의 쪽번호가 1부터 다시 시작하는 문서</b>(1-1, 1-2 … 2-1, 2-2 …)일 때 고릅니다.
          문서의 머리말·꼬리말에 <b>"장-" 접두어("1-", "2-")가 이미 들어가 있는 경우</b>를 전제로 하며,
          도구는 각 장 본문의 <b>숫자 부분만</b> 1로 되돌립니다(접두어는 문서가 그대로 표시).</p>
        <p style="margin:8px 0 0">특정 장을 앞 장에서 <b>이어서 매기려면</b>(예: 8장이 7장에 연속),
          스캔 후 표에서 그 장의 <b>[연속]</b>을 켜면 그 장만 재시작을 건너뜁니다.</p>
        <p style="margin:8px 0 0"><b>전체 연속</b>은 처음부터 끝까지 하나로 이어지는 일반 문서용입니다.</p>
      </details>
      <details class="help">
        <summary style="cursor:pointer">간지·A3 뒷면은 어떤 기준으로 고르나요?</summary>
        <p style="margin:8px 0 0">양면 인쇄에서는 <b>간지 뒷면</b>과 <b>A3 뒷면</b>을 비워 둡니다.
          같은 인쇄 결과를 내는 두 가지 작성 방식이 있어, 이 문서가 어느 쪽인지 골라주셔야 번호가 맞습니다.</p>
        <ul style="margin:8px 0 0 18px;line-height:1.7">
          <li><b>빈 페이지를 실제로 넣어 둔 문서</b>는 간지 "2장"·A3 뒷면 "물리 공백 페이지 있음"을 고릅니다.</li>
          <li><b>페이지 없이 쪽번호만 건너뛴 문서</b>는 간지 "1장"·A3 뒷면 "결번"을 고릅니다.</li>
        </ul>
        <p style="margin:8px 0 0"><b>간지와 물리 공백면은 항상 감추기 처리</b>됩니다(그 면의 머리말·꼬리말·쪽번호를 숨깁니다).
          결번은 페이지 자체가 없어 감출 대상이 아닙니다.</p>
      </details>
      <details class="help">
        <summary style="cursor:pointer">도구가 문서에 실제로 하는 일</summary>
        <p style="margin:8px 0 0">이 두 선택은 <b>계산 조건일 뿐이며, 문서를 그 방식으로 바꾸지 않습니다.</b>
          실행해도 쪽수는 늘거나 줄지 않습니다.</p>
        <ol style="margin:8px 0 0 18px;line-height:1.7">
          <li>기존 쪽번호 조판부호 삭제 — 새 쪽번호·쪽 번호 제어</li>
          <li>새 쪽번호 부여 — 계산된 번호를 필요한 쪽에</li>
          <li>간지 감추기 — 간지가 있는 장의 첫 쪽만(머리말·꼬리말·쪽번호)</li>
        </ol>
        <p style="margin:8px 0 0"><b>하지 않는 것</b> — 페이지 삽입·삭제, 머리말/꼬리말 내용 변경,
          용지 방향·크기 변경, 본문 수정</p>
      </details>` : ""}
      ${kind === "pdf" ? `
      <div class="field">
        <label>PDF 저장 폴더 (비우면 원본 옆에 저장)</label>
        <div class="input-row">
          <input type="text" id="hw-outdir" readonly placeholder="선택 안 함 — 원본 파일 옆에 저장">
          <button class="btn btn-secondary" id="hw-pick-out" type="button">폴더 선택</button>
        </div>
      </div>` : ""}
      <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
        ${kind === "pagenum"
          ? `<button class="btn btn-primary" id="hw-scan">1. 스캔</button>
             <button class="btn btn-primary" id="hw-run" disabled>2. 쪽번호 적용</button>`
          : `<button class="btn btn-primary" id="hw-run">실행</button>`}
        <button class="btn btn-secondary" id="hw-reset">초기화</button>
        <span id="hw-stopslot"></span>
      </div>
      ${kind === "pagenum" ? `
      <div class="result-table-wrap" id="hw-tblwrap" style="margin-top:var(--space-4)">
        <table class="result-table">
          <thead><tr>
            <th>파일</th><th>장</th><th>물리 쪽수</th><th>A3</th>
            <th>현재 쪽번호</th><th>→ 적용 후</th><th>감추기</th><th>처리</th>
          </tr></thead>
          <tbody id="hw-tbody"></tbody>
        </table>
      </div>
      <p class="help" id="hw-warn" style="display:none;color:var(--fail);margin-top:var(--space-3)">
        ⚠ <b>원본 문서를 직접 수정합니다.</b> 실행 전 폴더를 백업해두세요.
        기존 쪽번호 조판부호(<b>새 쪽번호·쪽 번호 제어</b>)를 모두 삭제한 뒤 다시 부여합니다 — 작성자가 넣어둔 설정에 의존하지 않습니다. 쪽번호 표시 서식은 보존됩니다.</p>` : ""}
      <div class="progress-wrap" id="hw-prog">
        <div class="progress-head"><span class="stage" id="hw-stage"></span><span class="count" id="hw-count"></span></div>
        <div class="progress-track"><div class="progress-fill" id="hw-fill"></div></div>
      </div>
      <div class="log" id="hw-log" aria-live="polite"></div>
    </div>
  </div>

`;

  const $ = (s) => section.querySelector(s);



  mountStopButton?.($("#hw-stopslot"));
  let running = false;
  const log = (msg, kindCls = "") => {
    const el = $("#hw-log");
    const line = document.createElement("div");
    if (kindCls) line.className = kindCls;
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };

  const renderState = () => {
    const feats = bridge.info?.features || {};
    const ok = bridge.state === "ok" && feats[m.feature];
    $("#hw-locked").style.display = ok ? "none" : "";
    $("#hw-form").style.display = ok ? "" : "none";
    if (!ok) {
      $("#hw-locked").textContent = bridge.state !== "ok"
        ? "○ 로컬 런처 미연결 — 로컬 런처 실행 후 이 탭이 활성화됩니다."
        : "⚠ 로컬 런처는 연결됐지만 이 기능을 쓸 수 없습니다 — Windows + 한컴오피스 + 해당 도구가 필요합니다.";
    }
  };
  bridge.addEventListener("change", renderState);
  renderState();

  const pickInto = (inputSel) => async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
      if (r.path) $(inputSel).value = r.path;
    } catch (e) { toast(e.message, "fail"); }
  };


  let hwPaths = [];
  const hwShow = () => {
    $("#hw-dir").value = hwPaths.length === 1 ? hwPaths[0]
      : hwPaths.length ? `${hwPaths.length}개 선택 — ${hwPaths.map((p) => p.split(/[\\/]/).pop()).join(", ")}`
      : "";
  };
  $("#hw-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
      if (r.path) { hwPaths = [r.path]; hwShow(); }
    } catch (e) { toast(e.message, "fail"); }
  });
  if (kind === "pdf") {
    $("#hw-pick-files").addEventListener("click", async () => {
      try {
        const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
          body: { kind: "files", patterns: "*.hwp *.hwpx" } });
        if (r.paths?.length) { hwPaths = r.paths; hwShow(); }
      } catch (e) { toast(e.message, "fail"); }
    });
    $("#hw-pick-out").addEventListener("click", pickInto("#hw-outdir"));
  }

  $("#hw-reset").addEventListener("click", () => {
    if (running) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    hwPaths = []; $("#hw-dir").value = "";
    if (kind === "pdf") $("#hw-outdir").value = "";
    if (kind === "pagenum") $("#hw-start").value = "1";
    $("#hw-log").textContent = ""; $("#hw-log").classList.remove("active");
    $("#hw-prog").classList.remove("active"); $("#hw-fill").style.width = "0%";
    if (kind === "pagenum") {
      scanned = null; overrides = {};
      $("#hw-tbody").innerHTML = "";
      $("#hw-tblwrap").classList.remove("active");
      $("#hw-warn").style.display = "none";
      $("#hw-run").disabled = true;
      $("#hw-divider").value = "none";
      $("#hw-restart").value = "continuous";
    }
  });



  if (kind === "pagenum") {
    for (const sel of ["#hw-start", "#hw-restart", "#hw-divider", "#hw-a3back", "#hw-dir"]) {
      const el = $(sel);
      el?.addEventListener("change", () => {
        if (!scanned) return;
        scanned = null;
        $("#hw-run").disabled = true;
        $("#hw-tblwrap").classList.remove("active");
        $("#hw-warn").style.display = "none";
        toast("설정이 바뀌었습니다 — 다시 스캔해주세요", "warn");
      });
    }
  }


  let scanned = null;
  let overrides = {};



  async function setOverride(file, key, value) {
    const o = overrides[file] || (overrides[file] = {});
    if (value == null) delete o[key]; else o[key] = value;
    if (!Object.keys(o).length) delete overrides[file];
    try {
      const r = await bridge.call("/replan", { method: "POST", body: {
        files: scanned,
        start_num: parseInt($("#hw-start").value, 10) || 1,
        divider: $("#hw-divider").value,
        a3_back: $("#hw-a3back").value,
        restart: $("#hw-restart").value === "chapter",
        overrides,
      }});
      scanned = r.plan;
      renderPlan(scanned);
      const n = Object.keys(overrides).length;
      toast(n ? `${n}개 파일을 직접 지정했습니다 — 표를 확인하세요` : "기본 계산으로 돌아왔습니다", "ok");
    } catch (e) { toast(`재계산 실패: ${e.message}`, "fail"); }
  }

  function renderPlan(rows) {
    const tb = $("#hw-tbody");
    tb.innerHTML = "";

    const restartMode = $("#hw-restart")?.value === "chapter";
    let prevEnd = null;
    for (const r of rows) {
      const tr = document.createElement("tr");


      const cur = (r.start_page != null && r.end_page != null)
        ? `${r.start_page}~${r.end_page}` : "—";
      const rng = r.skip ? "—" : `${r.start}~${r.end}`;
      const same = !r.skip && cur === rng;



      const stray = r.stray_hide || [];
      const hideCell = [
        r.expect_hide?.length ? `${r.expect_hide.join(",")}면` : "",
        stray.length ? `<span class="warn-mark" title="도구가 의도하지 않은 위치입니다 — 오기입 여부를 확인하세요">⚠ ${stray.join(",")}면</span>` : "",
      ].filter(Boolean).join(" ") || (r.hide_pages?.length ? `${r.hide_pages.join(",")}면` : "");


      const d = r.detail;
      const calc = !d ? "" : [
        d.divider != null ? `간지 <b>${d.divider}</b>` : "",
        d.gaps?.length ? `결번 <b>${d.gaps.join(",")}</b>` : "",
        `본문 <b>${d.body[0]}~${d.body[1]}</b>`,
      ].filter(Boolean).join(" · ");
      const tail = d?.tail_a3_gap
        ? `<div class="plan-note">※ 마지막이 A3 — 뒷면 ${d.tail_a3_gap} 결번(다음 장에서 소비)</div>`
        : "";

      const act = r.skip ? "번호 제외"
        : [r.is_chapter_head ? "장 시작" : "",
           r.divider ? (r.div_skip ? "간지 1장(결번)" : "간지 2장") : "",
           r.gap_count ? `기존 결번 ${r.gap_count}곳` : "",
           r.force_odd?.length ? `쪽번호제어 ${r.force_odd.join(",")}면` : "",
           r.pgct_phys?.length ? `기존 쪽번호제어 ${r.pgct_phys.length}곳(삭제됨)` : "",
           r.a3_bad?.length ? `<span class="warn-mark" title="A3 뒷면에 같은 규격의 공백면이 없어 결번으로 처리했습니다. 양면 인쇄에서 A3는 용지 한 장의 앞뒤를 함께 쓰므로, 뒷면에 A4가 오면 인쇄가 어긋납니다.">⚠ A3 뒷면 미처리 ${r.a3_bad.join(",")}면</span>` : "",
           r.marks?.length ? `새쪽번호 ${r.marks[0][0]}면` : ""]
          .filter(Boolean).join(" · ") || "연속";
      tr.innerHTML = `
        <td>${r.error ? "⚠ " : ""}${r.name}</td>
        <td class="num">${r.chapter ?? "-"}</td>
        <td class="num">${r.phys_pages ?? "-"}</td>
        <td class="num">${r.a3_count || ""}</td>
        <td class="num" style="color:var(--text-dim)">${cur}</td>
        <td class="num">${r.skip ? "—" : `
          <input class="plan-start" type="number" min="1" step="1" value="${r.start}"
                 data-file="${r.name.replace(/"/g, "&quot;")}"
                 title="시작 쪽번호를 고치면 이 파일부터 다시 계산합니다">
          <span class="plan-end${same ? "" : " changed"}">~${r.end}${same ? " (동일)" : ""}</span>${
          restartMode && r.is_chapter_head ? `
          <label class="plan-cont" title="이 장을 앞 장에서 이어서 매깁니다 — 장별 재시작을 건너뜁니다">
            <input type="checkbox" class="plan-cont-cb" data-file="${r.name.replace(/"/g, "&quot;")}"
                   ${r.override?.continue_chapter ? "checked" : ""}> 연속</label>` : ""}`}</td>
        <td class="num">${hideCell}</td>

        <td>${r.error ? r.error : `
          <div class="plan-calc">${calc}</div>
          <div class="plan-tags">${act}</div>${tail}${
          r.mismatch ? `<div class="plan-warn">⚠ ${r.mismatch}</div>` : ""}`}</td>`;
      if (r.skip) tr.style.color = "var(--text-dim)";
      if (!r.skip && r.detail) {

        if (r.is_chapter_head && prevEnd != null) {
          const odd = prevEnd % 2 === 1;
          tr.querySelector(".plan-calc").insertAdjacentHTML("beforebegin",
            `<div class="plan-note">앞 장 ${prevEnd}(${odd ? "홀수" : "짝수"}) 끝`
            + `${odd ? ` → ${prevEnd + 1} 결번` : ""} → ${r.start} 시작</div>`);
        }
        prevEnd = r.detail.tail_a3_gap || r.end;
      }
      tb.appendChild(tr);
    }



    tb.querySelectorAll(".plan-start").forEach((el) =>
      el.addEventListener("change", () => {
        const v = parseInt(el.value, 10);
        setOverride(el.dataset.file, "start", v > 0 ? v : null);
      }));

    tb.querySelectorAll(".plan-cont-cb").forEach((el) =>
      el.addEventListener("change", () => {
        setOverride(el.dataset.file, "continue_chapter", el.checked ? true : null);
      }));

    $("#hw-tblwrap").classList.add("active");
    $("#hw-warn").style.display = "";
    $("#hw-run").disabled = false;
  }

  if (kind === "pagenum") {
    $("#hw-scan").addEventListener("click", async () => {
      if (running) return;
      const dir = hwPaths[0] || "";
      if (!dir) { toast("대상 폴더를 먼저 선택하세요", "fail"); return; }
      running = true;
      const btn = $("#hw-scan");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 스캔 중…`;
      $("#hw-prog").classList.add("active");
      $("#hw-log").classList.add("active");
      $("#hw-log").textContent = "";
      try {
        const job = await bridge.call("/jobs", {
          method: "POST",
          body: { type: "pagenum_scan", folder: dir,
                  start_num: parseInt($("#hw-start").value, 10) || 1,
                  divider: $("#hw-divider").value,
                  a3_back: $("#hw-a3back").value,
                  restart: $("#hw-restart").value === "chapter",
                  },
        });
        const done = await bridge.pollJob(job.job_id, {
          label: "쪽번호 스캔",
          onLog: (l) => log(l),
          onProgress: (p) => {
            if (!p) return;
            if (p.stage) $("#hw-stage").textContent = p.stage;
            if (p.total) {
              $("#hw-count").textContent = `${p.done}/${p.total}`;
              $("#hw-fill").style.width = `${(p.done / p.total) * 100}%`;
            }
          },
        });


        if (done.status === "cancelled") {
          toast("스캔을 중단했습니다 — 문서는 그대로입니다", "");
          return;
        }
        scanned = done.result || [];
        renderPlan(scanned);


        const noCur = scanned.some((r) => !r.skip) &&
                      scanned.every((r) => r.start_page == null);
        if (noCur) {
          toast("현재 쪽번호를 읽지 못했습니다 — 로컬 런처 창을 닫고 "
                + "로컬 런처를 다시 실행한 뒤 스캔해주세요 "
                + `(현재 연결: v${bridge.info?.bridge_version ?? "?"})`, "fail");
        } else {
          toast(`스캔 완료 — 표를 확인한 뒤 [2. 쪽번호 적용]을 누르세요`, "ok");
        }
      } catch (e) {
        log(`✗ ${e.message}`, "fail");
        toast(e.message, "fail");
      } finally {
        running = false;
        btn.disabled = false; btn.textContent = "1. 스캔";
      }
    });
  }

  $("#hw-run").addEventListener("click", async () => {
    if (running) return;

    const dir = hwPaths[0] || "";
    if (!hwPaths.length) {
      toast(kind === "pdf" ? "변환할 폴더 또는 파일을 먼저 선택하세요"
                           : "대상 폴더를 먼저 선택하세요", "fail");
      return;
    }
    if (kind === "pagenum") {
      if (!scanned) { toast("먼저 [1. 스캔]을 실행하세요", "fail"); return; }
      const n = scanned.filter((r) => !r.skip).length;
      if (!confirm(`원본 문서 ${n}개를 수정합니다.\n\n`
        + `· 기존 새 쪽번호(nwno)는 삭제 후 재부여됩니다\n`
        + `· 되돌리기가 어려우니 폴더를 백업했는지 확인하세요\n\n계속할까요?`)) return;
    }
    running = true;
    $("#hw-run").disabled = true;
    $("#hw-run").innerHTML = `<span class="spinner"></span> 실행 중…`;
    $("#hw-prog").classList.add("active");
    $("#hw-log").classList.add("active");
    $("#hw-fill").classList.add("indeterminate");
    try {
      const body = kind === "pdf"
        ? { type: "hwp2pdf", paths: hwPaths, out_dir: $("#hw-outdir").value.trim() || null }
        : { type: "pagenum_apply", folder: dir, files: scanned,
            start_num: parseInt($("#hw-start").value, 10) || 1,


            divider: $("#hw-divider").value,
            a3_back: $("#hw-a3back").value,
            restart: $("#hw-restart").value === "chapter",
            overrides };
      const job = await bridge.call("/jobs", { method: "POST", body });
      const done = await bridge.pollJob(job.job_id, {
        label: kind === "pagenum" ? "쪽번호 적용" : "HWP→PDF 변환",
        onLog: (line) => log(line),
        onProgress: (p) => {
          if (!p) return;
          if (p.stage) $("#hw-stage").textContent = p.stage;
          if (p.total) {
            $("#hw-count").textContent = `${p.done}/${p.total}`;
            $("#hw-fill").classList.remove("indeterminate");
            $("#hw-fill").style.width = `${(p.done / p.total) * 100}%`;
          }
        },
      });

      if (done.status === "cancelled") {
        log("─── 중단됨 (완료된 파일은 그대로 남아 있습니다)");
        toast("작업을 중단했습니다 — 완료된 파일은 남아 있습니다", "");
        return;
      }
      log("─── 완료", "ok");
      toast("작업 완료 — 대상 폴더를 확인하세요", "ok");
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      running = false;
      $("#hw-run").disabled = false;
      $("#hw-run").textContent = "실행";
      $("#hw-fill").classList.remove("indeterminate");
    }
  });
}
