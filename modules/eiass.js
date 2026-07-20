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

/* iframe 생존 시간. 3초는 위험하다 — EIASS 응답 헤더까지 실측 1.30초이고
   Content-Length가 없어 브라우저가 총량을 모른다. 서버가 혼잡하거나 파일이 크면
   3초 안에 응답이 시작되지 않아 다운로드가 걸리기도 전에 iframe이 사라진다
   (조용한 누락 — SYS-32 실측). 여유를 크게 두되, 대기 자체는 다음 요청 간격과
   분리해 전체 소요가 늘지 않게 한다. */
const IFRAME_TTL = 15000;

function downloadViaIframe(seq) {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:absolute;width:0;height:0;border:none;visibility:hidden;";
  iframe.src = `${BASE_URL}?FILE_SEQ=${encodeURIComponent(seq)}`;
  document.body.appendChild(iframe);
  // 제거만 지연시키고 즉시 반환 — 다운로드는 브라우저가 iframe과 무관하게 이어간다.
  setTimeout(() => { try { iframe.remove(); } catch (_) {} }, IFRAME_TTL);
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
        <p class="help">EIASS 문서 링크의 <code>downloadFileByFileSeq.do?FILE_SEQ=<b>숫자</b></code> 부분입니다.</p>
      </div>

      <div class="field">
        <label>저장 폴더 <span style="color:var(--text-dim);font-weight:400">(선택 — 지정하면 브리지가 처리)</span></label>
        <div class="input-row">
          <input type="text" id="es-dir" readonly placeholder="미지정 — 브라우저 기본 다운로드 폴더로 저장">
          <button class="btn btn-secondary" id="es-pick" type="button">폴더 선택</button>
        </div>
        <p class="help" id="es-mode-hint">폴더를 지정하면 <b>브리지</b>가 받아 저장하므로 실패가 로그로 검증되고 파일 크기가 남습니다.
          미지정 시 브라우저가 받아 <b>저장 성공 여부를 확인할 수 없습니다</b>.</p>
      </div>

      <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="es-run">전체 다운로드</button>
        <label style="font-size:var(--text-sm);display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="es-zip"> ZIP으로 묶기 <span style="color:var(--text-dim)">(브리지 경로만)</span>
        </label>
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
        <div class="field" style="display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:flex-end">
          <div style="flex:2;min-width:200px">
            <label for="ec-code">사업코드 <span class="req">*</span></label>
            <input type="text" id="ec-code" placeholder="예: WJ20260098 · GG2021A007" spellcheck="false" autocomplete="off">
          </div>
          <div style="flex:1;min-width:150px">
            <label for="ec-gubn">평가 유형</label>
            <select id="ec-gubn">
              <option value="auto" selected>자동 판별</option>
              <option value="per">소규모</option>
              <option value="eia">평가</option>
              <option value="sea">전략</option>
              <option value="after">사후</option>
            </select>
          </div>
          <button class="btn btn-primary" id="ec-search" type="button">목록 조회</button>
        </div>
        <p class="help" style="margin-top:-6px">⚠ <b>사후환경영향조사는 평가와 사업코드가 동일합니다.</b> 기본(자동 판별)은 항상 <b>평가 원문</b>을
          조회하므로, 사후 보고서를 받으려면 유형을 <b>사후</b>로 지정 후 조회하세요 — 연도별 조사회차가 표시됩니다.
          전략(SEA)은 '전략' 선택 시 평가와 같은 경로로 조회됩니다.</p>

        <div id="ec-listwrap" style="display:none">
          <div style="display:flex;align-items:center;gap:var(--space-3);margin:var(--space-4) 0 var(--space-2)">
            <b id="ec-listtitle" style="font-size:var(--text-sm)"></b>
            <label style="font-size:var(--text-xs);color:var(--text-muted);display:flex;align-items:center;gap:4px">
              <input type="checkbox" id="ec-selall" checked> 전체 선택
            </label>
          </div>
          <div class="result-table-wrap active" style="max-height:320px;overflow-y:auto">
            <table class="result-table">
              <thead><tr><th style="width:36px"></th><th>절차</th><th>장코드</th><th>파일명</th></tr></thead>
              <tbody id="ec-tbody"></tbody>
            </table>
          </div>

          <div class="field" style="margin-top:var(--space-4)">
            <label>저장 폴더 <span class="req">*</span></label>
            <div class="input-row">
              <input type="text" id="ec-dir" readonly placeholder="[폴더 선택]을 누르면 브리지가 선택창을 띄웁니다">
              <button class="btn btn-secondary" id="ec-pick" type="button">폴더 선택</button>
            </div>
          </div>
          <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" id="ec-run">선택 다운로드</button>
            <label style="font-size:var(--text-sm);display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="ec-zip" checked> ZIP으로 묶기
            </label>
            <button class="btn btn-secondary" id="ec-reset">초기화</button>
          </div>
        </div>

        <div class="progress-wrap" id="ec-prog">
          <div class="progress-head"><span class="stage" id="ec-stage"></span><span class="count" id="ec-count"></span></div>
          <div class="progress-track"><div class="progress-fill" id="ec-fill"></div></div>
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
    $("#es-input").value = ""; $("#es-dir").value = "";
    $("#es-log").textContent = ""; $("#es-log").classList.remove("active");
    $("#es-prog").classList.remove("active"); $("#es-fill").style.width = "0%";
  });

  /* 저장 폴더 선택 — 브리지 연결 시에만 의미가 있다 */
  $("#es-pick").addEventListener("click", async () => {
    if (bridge.state !== "ok") {
      toast("브리지가 연결돼 있어야 폴더를 지정할 수 있습니다 (미지정 시 브라우저 다운로드 폴더 사용)", "warn");
      return;
    }
    try {
      const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
      if (r.path) $("#es-dir").value = r.path;
    } catch (e) { toast(e.message, "fail"); }
  });
  $("#es-run").addEventListener("click", async () => {
    if (esRunning) return;
    const seqs = parseSeqs($("#es-input").value);
    if (!seqs.length) { toast("유효한 FILE_SEQ가 없습니다 — 숫자만 추출됩니다", "fail"); return; }
    const dir = $("#es-dir").value.trim();
    const viaBridge = bridge.state === "ok" && dir;

    esRunning = true; stopping = false;
    $("#es-run").disabled = true;
    $("#es-stop").style.display = viaBridge ? "none" : "";
    $("#es-prog").classList.add("active");
    $("#es-log").classList.add("active");

    try {
      if (viaBridge) {
        /* 브리지 경로 — 실패가 예외로 잡히고 저장 파일 크기가 로그에 남는다.
           웹 iframe 경로의 "조용한 누락"이 구조적으로 불가능하다(SYS-32). */
        esLog(`${seqs.length}건 — 브리지로 다운로드 (저장 검증됨)`);
        const job = await bridge.call("/jobs", {
          method: "POST",
          body: { type: "eiass_seq_dl", seqs, out_dir: dir, zip: $("#es-zip").checked },
        });
        await bridge.pollJob(job.job_id, {
          onLog: (line) => esLog(line),
          onProgress: (p) => {
            if (!p) return;
            if (p.stage) $("#es-stage").textContent = p.stage;
            if (p.total) {
              $("#es-count").textContent = `${p.done}/${p.total}`;
              $("#es-fill").style.width = `${(p.done / p.total) * 100}%`;
            }
          },
        });
        toast("다운로드 완료 — 선택한 폴더를 확인하세요", "ok");
      } else {
        /* 웹 단독 경로 — 브라우저에 요청을 넘길 뿐이라 저장 성공을 알 수 없다.
           로그 문구를 실제 의미대로 유지한다(성공 단언 금지). */
        esLog(`${seqs.length}건 — 브라우저로 요청 전송 (간격 1.2초)`);
        esLog("※ 이 경로는 저장 성공 여부를 확인할 수 없습니다. 완료 후 브라우저 다운로드 목록에서 건수를 대조하세요.", "warn");
        if (bridge.state === "ok")
          esLog("※ 저장 폴더를 지정하면 브리지로 처리되어 실패가 검증됩니다.", "warn");
        let sent = 0;
        for (let i = 0; i < seqs.length; i++) {
          if (stopping) { esLog("── 사용자에 의해 중지됨", "warn"); break; }
          const seq = seqs[i];
          $("#es-stage").textContent = `FILE_SEQ ${seq}`;
          $("#es-count").textContent = `${i + 1}/${seqs.length}`;
          downloadViaIframe(seq);
          esLog(`[${seq}] 요청 전송`);
          sent++;
          $("#es-fill").style.width = `${((i + 1) / seqs.length) * 100}%`;
          if (i < seqs.length - 1 && !stopping) await sleep(1200);
        }
        esLog(`─── 요청 전송 ${sent}건 — 브라우저 다운로드 목록에서 실제 저장 건수를 확인하세요`);
        toast(`요청 ${sent}건 전송 — 다운로드 목록에서 건수를 대조하세요`, "warn");
      }
    } catch (e) {
      esLog(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      esRunning = false;
      $("#es-run").disabled = false;
      $("#es-stop").style.display = "none";
    }
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

  /* gubn 매핑 — '전략'은 EIASS가 평가와 동일 엔드포인트(§9.7c) */
  const gubnValue = () => {
    const v = $("#ec-gubn").value;
    return v === "sea" ? "eia" : v;
  };

  /* 목록 조회 */
  $("#ec-search").addEventListener("click", async () => {
    const code = $("#ec-code").value.trim();
    if (!code) { toast("사업코드를 입력하세요 (예: WJ20260098)", "fail"); return; }
    const btn = $("#ec-search");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> 조회 중…`;
    try {
      const r = await bridge.call("/eiass/resolve", {
        method: "POST", body: { code, gubn: gubnValue() }, timeoutMs: 90000,
      });

      /* 사후: 회차 목록 — 연도가 소제목. [파일 보기]로 펼치면 PDF 단위 선택 */
      if (r.mode === "rounds") {
        const rounds = r.rounds || [];
        $("#ec-listtitle").textContent = `${r.code} — 사후 조사회차 ${rounds.length}건 (연도별)`;
        const tb = $("#ec-tbody");
        tb.innerHTML = "";
        const years = [...new Set(rounds.map((x) => x.year || "연도미상"))];
        for (const y of years) {
          const items = rounds.filter((x) => (x.year || "연도미상") === y);
          const gid = `ecy-${y}`;
          const head = document.createElement("tr");
          head.innerHTML = `
            <td style="background:var(--surface-2)">
              <input type="checkbox" id="${gid}" class="ec-gchk" checked aria-label="${y}년 전체 선택"></td>
            <td colspan="3" style="background:var(--surface-2);font-weight:var(--weight-semibold)">${y}년 조사</td>`;
          head.querySelector(".ec-gchk").addEventListener("change", (e) => {
            tb.querySelectorAll(`[data-group="${gid}"], [data-rgroup="${gid}"]`)
              .forEach((c) => { c.checked = e.target.checked; });
          });
          tb.appendChild(head);

          for (const x of items) {
            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td><input type="checkbox" class="ec-chk" data-kind="round" data-group="${gid}"
                   value="${x.aes_seq}" data-year="${x.year}" checked
                   aria-label="${x.year}년 회차 ${x.aes_seq} 선택"></td>
              <td style="white-space:nowrap;color:var(--text-dim)">${x.status || "-"}</td>
              <td style="white-space:nowrap">${x.period || "-"}</td>
              <td>${x.biz_nm || "(사업명 없음)"}
                <button type="button" class="btn btn-secondary ec-expand" data-seq="${x.aes_seq}"
                  style="height:24px;padding:0 10px;font-size:11px;margin-left:8px">파일 보기</button></td>`;

            const rchk = tr.querySelector(".ec-chk");
            // 회차 체크 → 펼쳐진 파일 전체 연동
            rchk.addEventListener("change", () =>
              tb.querySelectorAll(`.ec-fchk[data-round="${x.aes_seq}"]`)
                .forEach((c) => { c.checked = rchk.checked; }));

            // [파일 보기] — 해당 회차 파일목록 lazy 조회 후 하위 행 삽입
            tr.querySelector(".ec-expand").addEventListener("click", async (e) => {
              const btn = e.target;
              if (btn.dataset.loaded) {   // 재클릭 = 접기/펴기 토글
                const show = btn.dataset.open !== "1";
                tb.querySelectorAll(`tr[data-file-of="${x.aes_seq}"]`)
                  .forEach((row) => { row.style.display = show ? "" : "none"; });
                btn.dataset.open = show ? "1" : "0";
                btn.textContent = show ? "접기" : "파일 보기";
                return;
              }
              btn.disabled = true;
              btn.textContent = "조회 중…";
              try {
                const fr = await bridge.call("/eiass/resolve", {
                  method: "POST",
                  body: { code: $("#ec-code").value.trim(), gubn: "after", aes_seq: x.aes_seq },
                  timeoutMs: 60000,
                });
                let anchor = tr;
                for (const d of fr.docs || []) {
                  const frow = document.createElement("tr");
                  frow.dataset.fileOf = x.aes_seq;
                  frow.innerHTML = `
                    <td style="padding-left:var(--space-5)">
                      <input type="checkbox" class="ec-fchk" data-round="${x.aes_seq}" data-rgroup="${gid}"
                        value="${d.file_seq}" ${rchk.checked ? "checked" : ""}
                        aria-label="${d.filename} 선택"></td>
                    <td></td>
                    <td style="white-space:nowrap;color:var(--text-dim)">${d.chapter_code || "-"}</td>
                    <td style="color:var(--text-muted)">${d.filename}</td>`;
                  anchor.after(frow);
                  anchor = frow;
                }
                btn.dataset.loaded = "1";
                btn.dataset.open = "1";
                btn.textContent = "접기";
              } catch (err) {
                toast(err.message, "fail");
                btn.textContent = "파일 보기";
              } finally {
                btn.disabled = false;
              }
            });
            tb.appendChild(tr);
          }
        }
        $("#ec-selall").checked = true;
        $("#ec-listwrap").style.display = "";
        toast("회차 체크 = 그 연도 전체 다운로드 · [파일 보기]로 PDF 단위 선택 가능", "ok");
        return;
      }

      const docs = r.docs || [];
      if (!docs.length) {
        toast("원문 목록이 비어 있습니다 — 코드·유형을 확인하세요 (비공개/미공개 사업일 수 있음)", "warn");
        return;
      }
      $("#ec-listtitle").textContent = `${r.code} — ${docs.length}건 (유형: ${docs[0].gubn})`;

      /* 절차단계(stage_label)별 그룹 소제목 — EIASS 아코디언 원문 순서 유지.
         '연계' 문서 그룹은 기본 체크 해제(다른 절차의 참조 문서 — 필요 시만 선택). */
      const groups = [];
      const byStage = new Map();
      for (const d of docs) {
        const key = d.stage_label || "기타";
        if (!byStage.has(key)) { byStage.set(key, []); groups.push(key); }
        byStage.get(key).push(d);
      }
      const tb = $("#ec-tbody");
      tb.innerHTML = "";
      for (const g of groups) {
        const items = byStage.get(g);
        const linked = g.includes("연계");
        const gid = `ecg-${groups.indexOf(g)}`;
        const head = document.createElement("tr");
        head.innerHTML = `
          <td style="background:var(--surface-2)">
            <input type="checkbox" id="${gid}" class="ec-gchk" ${linked ? "" : "checked"}
                   aria-label="${g} 전체 선택"></td>
          <td colspan="3" style="background:var(--surface-2);font-weight:var(--weight-semibold)">
            ${g} <span style="color:var(--text-dim);font-weight:400">(${items.length}건${linked ? " — 연계문서, 기본 제외" : ""})</span></td>`;
        head.querySelector(".ec-gchk").addEventListener("change", (e) => {
          tb.querySelectorAll(`[data-group="${gid}"]`).forEach((c) => { c.checked = e.target.checked; });
        });
        tb.appendChild(head);
        for (const d of items) {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><input type="checkbox" class="ec-chk" data-group="${gid}" value="${d.file_seq}"
                 ${linked ? "" : "checked"} aria-label="${d.filename} 선택"></td>
            <td style="white-space:nowrap;color:var(--text-dim)">${g}</td>
            <td style="white-space:nowrap">${d.chapter_code || "-"}</td>
            <td>${d.filename}</td>`;
          tb.appendChild(tr);
        }
      }
      $("#ec-selall").checked = true;
      $("#ec-listwrap").style.display = "";
    } catch (e) {
      toast(e.message, "fail");
    } finally {
      btn.disabled = false;
      btn.textContent = "목록 조회";
    }
  });

  $("#ec-selall").addEventListener("change", (e) =>
    section.querySelectorAll(".ec-chk, .ec-gchk, .ec-fchk").forEach((c) => { c.checked = e.target.checked; }));

  $("#ec-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", body: { kind: "folder" }, timeoutMs: 120000 });
      if (r.path) $("#ec-dir").value = r.path;
    } catch (e) { toast(e.message, "fail"); }
  });

  $("#ec-reset").addEventListener("click", () => {
    if (ecRunning) { toast("실행 중입니다 — 완료 후 초기화하세요", "warn"); return; }
    $("#ec-code").value = ""; $("#ec-dir").value = "";
    $("#ec-gubn").value = "auto";
    $("#ec-tbody").innerHTML = "";
    $("#ec-listwrap").style.display = "none";
    $("#ec-log").textContent = ""; $("#ec-log").classList.remove("active");
    $("#ec-prog").classList.remove("active"); $("#ec-fill").style.width = "0%";
  });

  /* 선택 다운로드 */
  $("#ec-run").addEventListener("click", async () => {
    if (ecRunning) return;
    const code = $("#ec-code").value.trim();
    const dir = $("#ec-dir").value.trim();
    const roundChks = [...section.querySelectorAll('.ec-chk[data-kind="round"]')];
    const body = { type: "eiass_dl", code, gubn: gubnValue(),
                   out_dir: dir, zip: $("#ec-zip").checked };
    let count = 0;
    if (roundChks.length) {
      // 사후: 회차 단위 + 펼친 회차는 파일 단위 부분 선택
      body.rounds = [];
      for (const rc of roundChks) {
        const files = [...section.querySelectorAll(`.ec-fchk[data-round="${rc.value}"]`)];
        if (files.length) {   // 펼쳐진 회차 — 파일 체크가 기준
          const sel = files.filter((f) => f.checked).map((f) => f.value);
          if (sel.length) { body.rounds.push({ seq: rc.value, year: rc.dataset.year, files: sel }); count += sel.length; }
        } else if (rc.checked) {   // 안 펼친 회차 — 회차 체크가 기준(전체 다운로드)
          body.rounds.push({ seq: rc.value, year: rc.dataset.year });
          count++;
        }
      }
      if (!body.rounds.length) { toast("다운로드할 회차 또는 파일을 선택하세요", "fail"); return; }
    } else {
      const seqs = [...section.querySelectorAll(".ec-chk:checked")].map((c) => c.value);
      if (!seqs.length) { toast("다운로드할 파일을 선택하세요", "fail"); return; }
      body.seqs = seqs;
      count = seqs.length;
    }
    if (!dir) { toast("저장 폴더를 먼저 선택하세요", "fail"); return; }
    const checked = { length: count };   // 완료 토스트용 건수
    ecRunning = true;
    $("#ec-run").disabled = true;
    $("#ec-prog").classList.add("active");
    $("#ec-log").classList.add("active");
    try {
      const job = await bridge.call("/jobs", { method: "POST", body });
      await bridge.pollJob(job.job_id, {
        onLog: (line) => ecLog(line),
        onProgress: (p) => {
          if (!p) return;
          if (p.stage) $("#ec-stage").textContent = p.stage;
          if (p.total) {
            $("#ec-count").textContent = `${p.done}/${p.total}`;
            $("#ec-fill").style.width = `${(p.done / p.total) * 100}%`;
          }
        },
      });
      ecLog("─── 완료", "ok");
      toast(`다운로드 완료 (${checked.length}건 선택) — 폴더를 확인하세요`, "ok");
    } catch (e) {
      ecLog(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      ecRunning = false;
      $("#ec-run").disabled = false;
    }
  });
}
