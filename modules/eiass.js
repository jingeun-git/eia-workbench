/* EIASS 다운로더 모듈 (SYS-29 6단계)
 * 경로 2개:
 *  ① 웹 완결 — FILE_SEQ 직접 입력 → iframe navigation 순차 다운로드.
 *     원본: 배포용/eiass_downloader.html 로직 그대로(파싱·1.2s 간격·중지).
 *     fetch 불가(EIASS ACAO 오리진 잠김 실측) — iframe만 가능, 파일명·경로 제어 불가.
 *  ② 브리지 — 사업코드 자동탐색(eiass_doc_resolver.py). 검색 API가 ACAO 헤더
 *     2중(스펙 위반)이라 브라우저 원천 불가 → 브리지 job으로 실행, 로그 스트림 표시.
 */

const BASE_URL = "https://www.eiass.go.kr/common/file/downloadFileByFileSeq.do";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSeqs(raw) {   // 원본 동일 — 공백·쉼표 구분, 숫자만, 중복 제거
  return [...new Set(
    raw.split(/[\s,，\n\r]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
  )];
}

function downloadViaIframe(seq) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:absolute;width:0;height:0;border:none;visibility:hidden;";
    iframe.src = `${BASE_URL}?FILE_SEQ=${encodeURIComponent(seq)}`;
    document.body.appendChild(iframe);
    setTimeout(() => { try { iframe.remove(); } catch (_) {} resolve(); }, 3000);
  });
}

export function init(section, { bridge, toast }) {
  section.innerHTML = `
  <div class="panel">
    <h2>EIASS 원문 다운로더</h2>
    <p class="desc">FILE_SEQ 직접 입력(웹 완결) 또는 사업코드 자동탐색(브리지 연결 시)으로 EIASS 원문을 내려받습니다.</p>

    <div class="field">
      <div class="segment" role="group" aria-label="다운로드 방식">
        <button type="button" data-emode="seq" aria-pressed="true">FILE_SEQ 직접</button>
        <button type="button" data-emode="code" aria-pressed="false">사업코드 자동 (브리지)</button>
      </div>
    </div>

    <!-- ① FILE_SEQ 직접 -->
    <div data-epane="seq">
      <div class="field">
        <label for="es-input">FILE_SEQ 목록 <span class="req">*</span></label>
        <textarea id="es-input" placeholder="3228100&#10;3228101, 3228102&#10;(공백·쉼표·줄바꿈 구분 — 숫자만 추출됩니다)" spellcheck="false"></textarea>
        <p class="help">EIASS 문서 링크의 <code>downloadFileByFileSeq.do?FILE_SEQ=<b>숫자</b></code> 부분입니다.
          파일은 브라우저 기본 다운로드 폴더로 저장됩니다(웹 방식의 한계 — 경로·파일명 지정은 브리지 방식 사용).</p>
      </div>
      <div style="display:flex;gap:var(--space-2);align-items:center">
        <button class="btn btn-primary" id="es-run">전체 다운로드</button>
        <button class="btn btn-secondary" id="es-reset">초기화</button>
        <button class="btn btn-danger" id="es-stop" style="display:none">중지</button>
      </div>
      <div class="progress-wrap" id="es-prog">
        <div class="progress-head">
          <span class="stage" id="es-stage"></span><span class="count" id="es-count"></span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="es-fill"></div></div>
      </div>
      <div class="log" id="es-log" aria-live="polite"></div>
    </div>

    <!-- ② 사업코드 자동 (브리지) -->
    <div data-epane="code" style="display:none">
      <div id="ec-locked" class="placeholder" style="margin-bottom:var(--space-4)">
        ○ 브리지 미연결 — 이 방식은 로컬 브리지가 필요합니다. 우상단 상태칩에서 안내를 확인하세요.
      </div>
      <div id="ec-form">
        <div class="field">
          <label for="ec-code">사업코드 <span class="req">*</span></label>
          <input type="text" id="ec-code" placeholder="예: WJ20260098" spellcheck="false" autocomplete="off">
          <p class="help">EIASS 관리번호. 유형(소규모/정식/사후)은 자동 판별되며, 아래에서 강제 지정할 수 있습니다.</p>
        </div>
        <div class="field" style="display:flex;gap:var(--space-3);flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <label for="ec-gubn">평가 유형</label>
            <select id="ec-gubn">
              <option value="auto" selected>자동 판별</option>
              <option value="per">소규모(per)</option>
              <option value="eia">정식(eia)</option>
              <option value="after">사후(after)</option>
            </select>
          </div>
          <div style="flex:2;min-width:200px">
            <label for="ec-kw">장 키워드 (비우면 전체 다운로드)</label>
            <input type="text" id="ec-kw" placeholder="예: 동식물상" spellcheck="false">
          </div>
        </div>
        <div class="field">
          <label>저장 폴더 <span class="req">*</span></label>
          <div class="input-row">
            <input type="text" id="ec-dir" readonly placeholder="[폴더 선택]을 누르면 브리지가 선택창을 띄웁니다">
            <button class="btn btn-secondary" id="ec-pick" type="button">폴더 선택</button>
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2);align-items:center">
          <button class="btn btn-primary" id="ec-run">다운로드 실행</button>
          <button class="btn btn-secondary" id="ec-reset">초기화</button>
        </div>
        <div class="progress-wrap" id="ec-prog">
          <div class="progress-head"><span class="stage" id="ec-stage"></span><span class="count"></span></div>
          <div class="progress-track"><div class="progress-fill indeterminate" id="ec-fill"></div></div>
        </div>
        <div class="log" id="ec-log" aria-live="polite"></div>
      </div>
    </div>
  </div>`;

  const $ = (s) => section.querySelector(s);
  const logTo = (el) => (msg, kind = "") => {
    const line = document.createElement("div");
    if (kind) line.className = kind;
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };

  /* 모드 전환 */
  section.querySelectorAll("[data-emode]").forEach((b) =>
    b.addEventListener("click", () => {
      section.querySelectorAll("[data-emode]").forEach((x) =>
        x.setAttribute("aria-pressed", String(x === b)));
      section.querySelectorAll("[data-epane]").forEach((p) =>
        p.style.display = p.dataset.epane === b.dataset.emode ? "" : "none");
    }));

  /* ── ① FILE_SEQ 직접 ─────────────────────────────────────────────── */
  const esLog = logTo($("#es-log"));
  let stopping = false, esRunning = false;

  $("#es-stop").addEventListener("click", () => { stopping = true; });
  $("#es-reset").addEventListener("click", () => {
    if (esRunning) { toast("다운로드 중입니다 — 먼저 [중지]를 눌러주세요", "warn"); return; }
    $("#es-input").value = "";
    $("#es-log").textContent = ""; $("#es-log").classList.remove("active");
    $("#es-prog").classList.remove("active"); $("#es-fill").style.width = "0%";
  });
  $("#es-run").addEventListener("click", async () => {
    if (esRunning) return;
    const seqs = parseSeqs($("#es-input").value);
    if (!seqs.length) { toast("유효한 FILE_SEQ가 없습니다 — 숫자만 추출됩니다", "fail"); return; }
    esRunning = true; stopping = false;
    $("#es-run").disabled = true;
    $("#es-stop").style.display = "";
    $("#es-prog").classList.add("active");
    $("#es-log").classList.add("active");
    esLog(`${seqs.length}건 등록 — 순차 다운로드 시작 (간격 1.2초)`);

    let ok = 0;
    for (let i = 0; i < seqs.length; i++) {
      if (stopping) { esLog("── 사용자에 의해 중지됨", "warn"); break; }
      const seq = seqs[i];
      $("#es-stage").textContent = `FILE_SEQ ${seq}`;
      $("#es-count").textContent = `${i + 1}/${seqs.length}`;
      await downloadViaIframe(seq);
      esLog(`[${seq}] 다운로드 요청됨`, "ok");
      ok++;
      $("#es-fill").style.width = `${((i + 1) / seqs.length) * 100}%`;
      if (i < seqs.length - 1 && !stopping) await sleep(1200);   // 원본 동일 간격
    }
    esLog(`─── 완료: ${ok}건 요청됨`);
    toast(`다운로드 요청 ${ok}건 완료 — 브라우저 다운로드 폴더를 확인하세요`, "ok");
    esRunning = false;
    $("#es-run").disabled = false;
    $("#es-stop").style.display = "none";
  });

  /* ── ② 사업코드 자동 (브리지) ─────────────────────────────────────── */
  const ecLog = logTo($("#ec-log"));
  let ecRunning = false;

  const renderBridgeState = () => {
    const ok = bridge.state === "ok";
    $("#ec-locked").style.display = ok ? "none" : "";
    $("#ec-form").style.display = ok ? "" : "none";
  };
  bridge.addEventListener("change", renderBridgeState);
  renderBridgeState();

  $("#ec-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
      if (r.path) $("#ec-dir").value = r.path;
    } catch (e) { toast(e.message, "fail"); }
  });
  $("#ec-reset").addEventListener("click", () => {
    if (ecRunning) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    $("#ec-code").value = ""; $("#ec-kw").value = ""; $("#ec-dir").value = "";
    $("#ec-gubn").value = "auto";
    $("#ec-log").textContent = ""; $("#ec-log").classList.remove("active");
    $("#ec-prog").classList.remove("active");
  });
  $("#ec-run").addEventListener("click", async () => {
    if (ecRunning) return;
    const code = $("#ec-code").value.trim();
    const dir = $("#ec-dir").value.trim();
    if (!code) { toast("사업코드를 입력하세요 (예: WJ20260098)", "fail"); return; }
    if (!dir) { toast("저장 폴더를 먼저 선택하세요", "fail"); return; }
    ecRunning = true;
    $("#ec-run").disabled = true;
    $("#ec-prog").classList.add("active");
    $("#ec-log").classList.add("active");
    $("#ec-stage").textContent = "브리지에서 실행 중…";
    try {
      const job = await bridge.call("/jobs", {
        method: "POST",
        body: {
          type: "eiass",
          code, gubn: $("#ec-gubn").value,
          keyword: $("#ec-kw").value.trim() || null,
          out_dir: dir,
        },
      });
      await bridge.pollJob(job.job_id, {
        onLog: (line) => ecLog(line),
        onProgress: (p) => { if (p?.stage) $("#ec-stage").textContent = p.stage; },
      });
      ecLog("─── 완료", "ok");
      toast("다운로드 완료 — 선택한 폴더를 확인하세요", "ok");
    } catch (e) {
      ecLog(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      ecRunning = false;
      $("#ec-run").disabled = false;
      $("#ec-prog").classList.remove("active");
    }
  });
}
