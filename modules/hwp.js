/* 한컴(HWP) 도구 모듈 — 4종 공용 (SYS-29 7단계)
 * 전부 로컬 브리지 필요 (설치된 한글을 COM으로 조종 — 브라우저 원천 불가).
 *  - pdf     : hwp2pdf_core.convert_batch (파일/폴더 일괄)
 *  - toc     : hwpContent1.1.py — 폴더 내 전체 .hwp → 차례출력.hwp (경동2팀 스타일 규격)
 *  - pagenum : hwpPageNum2.0.py — 폴더 내 전체 .hwp 쪽번호 재부여(시작번호 지정)
 *  - merge   : 한컴 매크로(.Egg)라 자동화 불가 — 수동 실행 안내만 제공
 */

const META = {
  pdf: {
    title: "HWP → PDF 일괄 변환",
    desc: "선택한 폴더(하위 포함)의 HWP·HWPX를 PDF로 일괄 변환합니다. 모아찍기 무시·단면, 텍스트 보존(이미지화 안 함).",
    feature: "hwp2pdf",
  },
  toc: {
    title: "차례 만들기",
    desc: "폴더 안 모든 .hwp에서 제목 스타일(경동2팀 명명 규격)을 추출해 「차례출력.hwp」를 생성합니다.",
    feature: "toc",
  },
  pagenum: {
    title: "쪽번호 일괄 부여",
    desc: "폴더 안 모든 .hwp의 쪽번호를 시작번호부터 연속 재부여하고, 필요 시 파일명의 쪽 표기도 갱신합니다.",
    feature: "pagenum",
  },
  merge: {
    title: "한글문서 끼워넣기",
    desc: "",
    feature: "merge",
  },
};

export function init(section, { bridge, toast }, kind) {
  const m = META[kind];

  /* merge — 자동화 불가 안내 전용 */
  if (kind === "merge") {
    section.innerHTML = `
    <div class="panel">
      <h2>${m.title}</h2>
      <p class="desc">이 도구는 한컴오피스 <b>매크로(.Egg)</b>로 만들어져 있어 브리지가 자동 실행할 수 없습니다.
        아래 절차로 한글에서 직접 실행해주세요.</p>
      <div class="placeholder" style="text-align:left;line-height:2">
        ① 한글 실행 → 도구 → 매크로 → <b>매크로 정의/실행</b><br>
        ② 매크로 파일 위치: <code>99.Tools/배포용/한글문서 끼워넣기/한글문서 끼워넣기 자동화.Egg</code><br>
        ③ 매크로 불러오기 후 실행
      </div>
    </div>`;
    return;
  }

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
      <div class="field" style="max-width:220px">
        <label for="hw-start">시작 쪽번호 <span class="req">*</span></label>
        <input type="number" id="hw-start" value="1" min="1" step="1">
      </div>` : ""}
      ${kind === "pdf" ? `
      <div class="field">
        <label>PDF 저장 폴더 (비우면 원본 옆에 저장)</label>
        <div class="input-row">
          <input type="text" id="hw-outdir" readonly placeholder="선택 안 함 — 원본 파일 옆에 저장">
          <button class="btn btn-secondary" id="hw-pick-out" type="button">폴더 선택</button>
        </div>
      </div>` : ""}
      <div style="display:flex;gap:var(--space-2);align-items:center">
        <button class="btn btn-primary" id="hw-run">실행</button>
        <button class="btn btn-secondary" id="hw-reset">초기화</button>
      </div>
      <div class="progress-wrap" id="hw-prog">
        <div class="progress-head"><span class="stage" id="hw-stage"></span><span class="count" id="hw-count"></span></div>
        <div class="progress-track"><div class="progress-fill" id="hw-fill"></div></div>
      </div>
      <div class="log" id="hw-log" aria-live="polite"></div>
    </div>
  </div>`;

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
  $("#hw-pick").addEventListener("click", pickInto("#hw-dir"));
  if (kind === "pdf") $("#hw-pick-out").addEventListener("click", pickInto("#hw-outdir"));

  $("#hw-reset").addEventListener("click", () => {
    if (running) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    $("#hw-dir").value = "";
    if (kind === "pdf") $("#hw-outdir").value = "";
    if (kind === "pagenum") $("#hw-start").value = "1";
    $("#hw-log").textContent = ""; $("#hw-log").classList.remove("active");
    $("#hw-prog").classList.remove("active"); $("#hw-fill").style.width = "0%";
  });

  $("#hw-run").addEventListener("click", async () => {
    if (running) return;
    const dir = $("#hw-dir").value.trim();
    if (!dir) { toast("대상 폴더를 먼저 선택하세요", "fail"); return; }
    running = true;
    $("#hw-run").disabled = true;
    $("#hw-run").innerHTML = `<span class="spinner"></span> 실행 중…`;
    $("#hw-prog").classList.add("active");
    $("#hw-log").classList.add("active");
    $("#hw-fill").classList.add("indeterminate");
    try {
      const body = kind === "pdf"
        ? { type: "hwp2pdf", paths: [dir], out_dir: $("#hw-outdir").value.trim() || null }
        : { type: "hwptool", tool: kind, folder: dir,
            ...(kind === "pagenum" ? { start_num: parseInt($("#hw-start").value, 10) || 1 } : {}) };
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
