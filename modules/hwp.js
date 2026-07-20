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
        <label>대상 폴더 <span class="req">*</span></label>
        <div class="input-row">
          <input type="text" id="hw-dir" readonly placeholder="[폴더 선택]을 누르면 브리지가 선택창을 띄웁니다">
          <button class="btn btn-secondary" id="hw-pick" type="button">폴더 선택</button>
        </div>
        <p class="help">파일은 PC 안에서만 처리됩니다 — 웹으로 전송되지 않습니다.</p>
      </div>
      ${kind === "pagenum" ? `
      <div class="field" style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:flex-end">
        <div style="max-width:180px">
          <label for="hw-start">시작 쪽번호 <span class="req">*</span></label>
          <input type="number" id="hw-start" value="1" min="1" step="1">
        </div>
        <label style="font-size:var(--text-sm);display:flex;align-items:center;gap:6px;height:40px">
          <input type="checkbox" id="hw-divider"> 장별 간지 포함
        </label>
      </div>
      <p class="help" style="margin-top:-8px">간지 포함 시 각 장 <b>첫 파일</b>은 간지를 1면으로 보고 <b>2번을 결번</b> 처리해 본문이 3면(홀수)에서 시작하게 합니다
        — 빈 페이지를 물리적으로 넣지 않고 쪽번호로 제어하므로, 이미 그렇게 작성된 문서는 변경 없이 그대로 유지됩니다.
        간지를 별도 인쇄하신다면 체크하지 마세요.</p>` : ""}
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
            <th>현재 쪽번호</th><th>→ 적용 후</th><th>공란</th><th>감추기</th><th>처리</th>
          </tr></thead>
          <tbody id="hw-tbody"></tbody>
        </table>
      </div>
      <p class="help" id="hw-warn" style="display:none;color:var(--fail);margin-top:var(--space-3)">
        ⚠ <b>원본 문서를 직접 수정합니다.</b> 실행 전 폴더를 백업해두세요.
        기존 새 쪽번호(nwno)는 삭제 후 재부여되며, 쪽번호 표시 서식은 보존됩니다.</p>` : ""}
      <div class="progress-wrap" id="hw-prog">
        <div class="progress-head"><span class="stage" id="hw-stage"></span><span class="count" id="hw-count"></span></div>
        <div class="progress-track"><div class="progress-fill" id="hw-fill"></div></div>
      </div>
      <div class="log" id="hw-log" aria-live="polite"></div>
    </div>
  </div>

  ${kind === "pagenum" ? `
  <div class="panel" id="hw-probe-panel">
    <h2>COM 기능 검증 <span style="font-size:var(--text-sm);font-weight:400;color:var(--text-dim)">— SYS-31 선행 조사</span></h2>
    <p class="desc">쪽번호 규칙(장 짝수끝·홀수시작, A3 홀수 부여, 감추기)을 구현하기 전에
      한컴이 <b>실제로 무엇을 할 수 있는지</b> 확인합니다. <b>읽기 전용 — 원본을 수정하지 않습니다.</b>
      hwpx 열기 가능 여부와 잔존 조판부호도 함께 조사합니다.</p>
    <div class="field">
      <label>검사할 보고서 폴더 <span class="req">*</span></label>
      <div class="input-row">
        <input type="text" id="hw-probe-dir" readonly placeholder="[폴더 선택]을 누르면 브리지가 선택창을 띄웁니다">
        <button class="btn btn-secondary" id="hw-probe-pick" type="button">폴더 선택</button>
      </div>
      <p class="help">.hwp·.hwpx 앞 5개만 검사합니다. 결과는 그 폴더에 probe_result.txt로도 저장됩니다.</p>
    </div>
    <div style="display:flex;gap:var(--space-2);align-items:center">
      <button class="btn btn-primary" id="hw-probe-run">검증 실행</button>
      <button class="btn btn-secondary" id="hw-probe-copy">결과 복사</button>
    </div>
    <div class="progress-wrap" id="hw-probe-prog">
      <div class="progress-head"><span class="stage" id="hw-probe-stage"></span><span class="count"></span></div>
      <div class="progress-track"><div class="progress-fill indeterminate"></div></div>
    </div>
    <div class="log" id="hw-probe-log" aria-live="polite"></div>
  </div>` : ""}`;

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
    // 검증 패널은 pagenum 기능 가용성과 무관하게 브리지만 붙으면 쓸 수 있다
    // (한컴 COM으로 무엇이 되는지 조사하는 것이 목적이므로)
    const pp = $("#hw-probe-panel");
    if (pp) pp.style.display = bridge.state === "ok" ? "" : "none";
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
  $("#hw-pick").addEventListener("click", pickInto("#hw-dir"));
  if (kind === "pdf") $("#hw-pick-out").addEventListener("click", pickInto("#hw-outdir"));

  $("#hw-reset").addEventListener("click", () => {
    if (running) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    $("#hw-dir").value = "";
    if (kind === "pdf") $("#hw-outdir").value = "";
    if (kind === "pagenum") $("#hw-start").value = "1";
    $("#hw-log").textContent = ""; $("#hw-log").classList.remove("active");
    $("#hw-prog").classList.remove("active"); $("#hw-fill").style.width = "0%";
    if (kind === "pagenum") {
      scanned = null;
      $("#hw-tbody").innerHTML = "";
      $("#hw-tblwrap").classList.remove("active");
      $("#hw-warn").style.display = "none";
      $("#hw-run").disabled = true;
      $("#hw-divider").checked = false;
    }
  });

  /* 입력이 바뀌면 스캔 결과가 낡는다 — 적용을 막고 재스캔을 요구한다
     (낡은 계획으로 원본을 고치는 사고 방지) */
  if (kind === "pagenum") {
    for (const sel of ["#hw-start", "#hw-divider", "#hw-dir"]) {
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

  /* ── COM 기능 검증 (쪽번호 탭 전용, SYS-31 1단계) ─────────────────── */
  if (kind === "pagenum") {
    let probeRunning = false;
    let probeText = "";
    const plog = (msg, cls = "") => {
      const el = $("#hw-probe-log");
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = msg;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      probeText += msg + "\n";
    };

    $("#hw-probe-pick").addEventListener("click", async () => {
      try {
        const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
        if (r.path) $("#hw-probe-dir").value = r.path;
      } catch (e) { toast(e.message, "fail"); }
    });

    $("#hw-probe-copy").addEventListener("click", async () => {
      if (!probeText.trim()) { toast("먼저 검증을 실행하세요", "warn"); return; }
      try { await navigator.clipboard.writeText(probeText); toast("결과를 복사했습니다 — 그대로 붙여주세요", "ok"); }
      catch { toast("복사 실패 — 로그를 직접 선택해 복사하세요", "fail"); }
    });

    $("#hw-probe-run").addEventListener("click", async () => {
      if (probeRunning) return;
      const dir = $("#hw-probe-dir").value.trim();
      if (!dir) { toast("검사할 폴더를 먼저 선택하세요", "fail"); return; }
      probeRunning = true; probeText = "";
      const btn = $("#hw-probe-run");
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> 검증 중…`;
      $("#hw-probe-prog").classList.add("active");
      $("#hw-probe-log").classList.add("active");
      $("#hw-probe-log").textContent = "";
      $("#hw-probe-stage").textContent = "한컴 기동 중… (첫 실행은 시간이 걸립니다)";
      try {
        const job = await bridge.call("/jobs", {
          method: "POST", body: { type: "hwp_probe", folder: dir, max_files: 5 },
        });
        await bridge.pollJob(job.job_id, {
          onLog: (line) => plog(line),
          onProgress: (p) => { if (p?.stage) $("#hw-probe-stage").textContent = p.stage; },
        });
        toast("검증 완료 — [결과 복사]로 전체를 복사해 전달해주세요", "ok");
      } catch (e) {
        plog(`✗ ${e.message}`, "fail");
        toast(e.message, "fail");
      } finally {
        probeRunning = false;
        btn.disabled = false;
        btn.textContent = "검증 실행";
        $("#hw-probe-prog").classList.remove("active");
      }
    });
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
           r.pad ? "공란 +1" : "",
           r.div_skip ? "간지(2번 결번)" : "",
           (r.marks?.length > 1) ? `번호제어 ${r.marks.length}곳` : ""]
          .filter(Boolean).join(" · ") || "연속";
      tr.innerHTML = `
        <td>${r.error ? "⚠ " : ""}${r.name}</td>
        <td class="num">${r.chapter ?? "-"}</td>
        <td class="num">${r.phys_pages ?? "-"}</td>
        <td class="num">${r.a3_count || ""}</td>
        <td class="num" style="color:var(--text-dim)">${cur}</td>
        <td class="num"${same ? ' style="color:var(--text-dim)"' : ' style="font-weight:600"'}>${rng}${same ? " (동일)" : ""}</td>
        <td class="num">${r.pad || ""}</td>
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
      const dir = $("#hw-dir").value.trim();
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
                  divider: $("#hw-divider").checked },
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
        // 브리지가 구버전이면 '현재 쪽번호'가 전부 비어 나온다 — 웹만 갱신되고
        // 로컬 브리지는 재시작 전까지 옛 코드로 응답하기 때문(2026-07-20 실사고)
        const noCur = rows.some((r) => !r.skip) &&
                      rows.every((r) => r.start_page == null);
        if (noCur) {
          toast("현재 쪽번호를 읽지 못했습니다 — 브리지가 구버전입니다. "
                + "브리지 창을 닫고 run_bridge.bat을 다시 실행한 뒤 스캔해주세요", "fail");
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
    const dir = $("#hw-dir").value.trim();
    if (!dir) { toast("대상 폴더를 먼저 선택하세요", "fail"); return; }
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
        ? { type: "hwp2pdf", paths: [dir], out_dir: $("#hw-outdir").value.trim() || null }
        : { type: "pagenum_apply", folder: dir, files: scanned,
            start_num: parseInt($("#hw-start").value, 10) || 1 };
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
