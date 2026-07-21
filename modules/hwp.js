/* 한컴(HWP) 도구 모듈 — 4종 공용 (SYS-29 7단계)
 * 전부 로컬 브리지 필요 (설치된 한글을 COM으로 조종 — 브라우저 원천 불가).
 *  - pdf     : hwp2pdf_core.convert_batch (파일/폴더 일괄)
 *  - toc     : hwpContent1.1.py — 폴더 내 전체 .hwp → 차례출력.hwp (경동2팀 스타일 규격)
 *  - pagenum : hwpPageNum2.0.py — 폴더 내 전체 .hwp 쪽번호 재부여(시작번호 지정)
 *  - merge   : 한컴 매크로(.Egg)라 자동화 불가 — 수동 실행 안내만 제공
 */

/* 차례·끼워넣기: 2026-07-20 사용자 지시로 기능 삭제 */
const META = {
  pdf: {
    title: "HWP → PDF 일괄 변환",
    desc: "선택한 폴더(하위 포함)의 HWP·HWPX를 PDF로 일괄 변환합니다. 모아찍기 무시·단면, 텍스트 보존(이미지화 안 함).",
    feature: "hwp2pdf",
  },
  pagenum: {
    title: "쪽번호 일괄 부여",
    desc: "폴더를 스캔해 파일별 쪽수·A3 위치·장 경계를 확인한 뒤, 제책 규칙(양면 인쇄 기준)에 맞춰 쪽번호를 재부여합니다.",
    feature: "pagenum",
  },
};

export function init(section, { bridge, toast }, kind) {
  const m = META[kind];

  section.innerHTML = `
  <div class="panel">
    <h2>${m.title}</h2>
    <p class="desc">${m.desc}</p>
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
        <div class="field" style="margin-bottom:0;flex:0 0 100%">
          <label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer">
            <input type="checkbox" id="hw-hide">
            간지·여백면에 <b>감추기</b> 적용 (머리말·꼬리말·쪽번호·바탕쪽·테두리·배경)
          </label>
          <p class="help" style="margin-top:4px">
            쪽번호를 <b>머리말 안에</b> 넣는 문서는 간지에 번호가 아예 안 나오므로 <b>불필요</b>합니다.
            「쪽 번호 매기기」로 문서 전체에 거는 문서에서만 켜세요.
            대상 — 간지 1면 / 간지 2장이면 뒷 여백면까지 / A3 여백면.
          </p>
        </div>
      </div>
      <p class="help" style="margin-top:-8px">
        양면 인쇄에서 <b>간지 뒷면</b>과 <b>A3 뒷면</b>은 비워 둡니다. 이때 작성 방식이 둘로 갈립니다 —
        <b>빈 페이지를 실제로 넣어 둔 문서</b>가 있고, <b>페이지 없이 쪽번호만 건너뛴 문서</b>가 있습니다.
        인쇄 결과는 같지만 세는 방법이 달라서, 이 보고서가 어느 쪽인지 골라주셔야 번호가 맞습니다.
      </p>
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
        ? "○ 브리지 미연결 — 브리지 실행 후 이 탭이 활성화됩니다."
        : "⚠ 브리지는 연결됐지만 이 기능을 쓸 수 없습니다 — Windows + 한컴오피스 + 해당 도구가 필요합니다.";
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
  /* 대상은 경로 배열로 들고 있는다 — run_hwp2pdf가 paths[]를 받으므로
     폴더 1개든 파일 여러 개든 같은 경로로 처리된다. */
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
    if (kind === "pagenum") { $("#hw-start").value = "1"; $("#hw-hide").checked = false; }
    $("#hw-log").textContent = ""; $("#hw-log").classList.remove("active");
    $("#hw-prog").classList.remove("active"); $("#hw-fill").style.width = "0%";
    if (kind === "pagenum") {
      scanned = null;
      $("#hw-tbody").innerHTML = "";
      $("#hw-tblwrap").classList.remove("active");
      $("#hw-warn").style.display = "none";
      $("#hw-run").disabled = true;
      $("#hw-divider").value = "none";
    }
  });

  /* 입력이 바뀌면 스캔 결과가 낡는다 — 적용을 막고 재스캔을 요구한다
     (낡은 계획으로 원본을 고치는 사고 방지) */
  if (kind === "pagenum") {
    for (const sel of ["#hw-start", "#hw-divider", "#hw-a3back", "#hw-hide", "#hw-dir"]) {
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

  /* ── 쪽번호: 스캔 → 표 확인 → 적용 (SYS-31) ─────────────────────── */
  let scanned = null;                       // 스캔 결과(계획) — 적용 시 그대로 전달

  function renderPlan(rows) {
    const tb = $("#hw-tbody");
    tb.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      // 현재 상태와 적용 후를 나눠 보여준다 — 표의 숫자가 현황인지 예정인지
      // 구분되지 않는다는 지적(2026-07-20)에 따른 분리
      const cur = (r.start_page != null && r.end_page != null)
        ? `${r.start_page}~${r.end_page}` : "—";
      const rng = r.skip ? "—" : `${r.start}~${r.end}`;
      const same = !r.skip && cur === rng;

      /* 감추기: 도구가 걸 위치와, 사람이 이미 넣어둔 것을 함께 보여준다.
         예상 밖 위치의 감추기는 오기입일 수 있으므로 경고로 띄운다. */
      const stray = r.stray_hide || [];
      const hideCell = [
        r.expect_hide?.length ? `${r.expect_hide.join(",")}면` : "",
        stray.length ? `<span class="warn-mark" title="도구가 의도하지 않은 위치입니다 — 오기입 여부를 확인하세요">⚠ ${stray.join(",")}면</span>` : "",
      ].filter(Boolean).join(" ") || (r.hide_pages?.length ? `${r.hide_pages.join(",")}면` : "");
      const act = r.skip ? "번호 제외"
        : [r.is_chapter_head ? "장 시작" : "",
           r.divider ? (r.div_skip ? "간지 1장(결번)" : "간지 2장") : "",
           r.gap_count ? `기존 결번 ${r.gap_count}곳` : "",
           r.force_odd?.length ? `쪽번호제어 ${r.force_odd.join(",")}면` : "",
           r.pgct_phys?.length ? `기존 쪽번호제어 ${r.pgct_phys.length}곳(삭제됨)` : "",
           r.marks?.length ? `새쪽번호 ${r.marks[0][0]}면` : ""]
          .filter(Boolean).join(" · ") || "연속";
      tr.innerHTML = `
        <td>${r.error ? "⚠ " : ""}${r.name}</td>
        <td class="num">${r.chapter ?? "-"}</td>
        <td class="num">${r.phys_pages ?? "-"}</td>
        <td class="num">${r.a3_count || ""}</td>
        <td class="num" style="color:var(--text-dim)">${cur}</td>
        <td class="num"${same ? ' style="color:var(--text-dim)"' : ' style="font-weight:600"'}>${rng}${same ? " (동일)" : ""}</td>
        <td class="num">${hideCell}</td>
        <td style="color:var(--text-muted)">${r.error || act}</td>`;
      if (r.skip) tr.style.color = "var(--text-dim)";
      tb.appendChild(tr);
    }
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
                  do_hide: $("#hw-hide").checked },
        });
        const done = await bridge.pollJob(job.job_id, {
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
        scanned = done.result || [];
        renderPlan(scanned);
        // '현재 쪽번호'가 전부 비면 브리지가 구버전이거나(웹만 갱신됨)
        // 응답에서 필드가 누락된 것이다 — 둘 다 재시작으로 먼저 갈라낸다.
        const noCur = scanned.some((r) => !r.skip) &&
                      scanned.every((r) => r.start_page == null);
        if (noCur) {
          toast("현재 쪽번호를 읽지 못했습니다 — 브리지 창을 닫고 "
                + "run_bridge.bat을 다시 실행한 뒤 스캔해주세요 "
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
    // 쪽번호는 폴더 단위가 규칙이라 경로 1개, PDF 변환은 폴더·파일 다중을 받는다
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
            // 스캔과 **동일한 옵션**을 반드시 함께 보낸다 — 빠지면 브리지가
            // 기본값으로 계획을 다시 세워 스캔 표와 다른 번호가 찍힌다(2026-07-20)
            divider: $("#hw-divider").value,
            a3_back: $("#hw-a3back").value,
            do_hide: $("#hw-hide").checked };
      const job = await bridge.call("/jobs", { method: "POST", body });
      await bridge.pollJob(job.job_id, {
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
