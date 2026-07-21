/* 지오코딩 — 위경도↔주소 양방향 (SYS-36)
 *
 * 브리지가 필요 없다. vworld가 ACAO를 주지 않지만 `callback` 파라미터를
 * 지원해 JSONP로 브라우저에서 바로 부를 수 있다(shared/geocode.js).
 *
 * ── 통합 목록 (사용자 지시 2026-07-21) ──
 * 파일 업로드분과 지도 클릭분을 **한 목록**에 담되 `출처` 칼럼으로 구분한다.
 * 따로 두면 내보내기 버튼이 두 개가 되고, 결국 사용자가 손으로 합쳐야 한다.
 *
 * 지도로 찍은 지점의 이름은 **자동 번호(지점-1…)로 넣고 목록에서 고칠 수
 * 있게** 했다 — 찍을 때마다 이름을 물으면 여러 지점을 빠르게 찍을 수 없고,
 * 주소를 그대로 이름으로 쓰면 너무 길다(사용자 승인).
 *
 * ── 좌표계는 자동 추정하지 않는다 ──
 * 숫자 크기로 경위도/평면직교는 구분되지만 5186·5185·5187 중 어느 원점인지는
 * 값만 보고 알 수 없다. 잘못 고르면 전국이 수백 km 어긋난 채 **예외 없이**
 * 결과가 나오므로, 반드시 사용자가 드롭다운으로 고른다(사용자 지시).
 */
import { createMap, baseSwitcherHtml, bindBaseSwitcher } from "../shared/mapview.js";
import { keys } from "../shared/keys.js";
import { toCoord, toAddress, toWgs84, fromWgs84, parseCoord, CRS_LIST } from "../shared/geocode.js";

const SRC_UPLOAD = "업로드";
const SRC_MAP = "지도지정";

export function init(section, { bridge, toast }) {
  section.innerHTML = `
  <div class="panel">
    <h2>지오코딩</h2>
    <p class="desc">주소를 좌표로, 좌표를 주소로 바꿉니다. <b>파일로 여러 건을 한 번에</b> 처리하거나,
      <b>지도를 더블클릭</b>해 그 자리의 주소·좌표를 확인할 수 있습니다.
      두 방법으로 모은 지점은 한 목록에 쌓이고, 내보낸 파일에서 <b>출처</b> 칼럼으로 구분됩니다.</p>

    <div id="gc-nokey" class="placeholder" style="display:none;margin-bottom:var(--space-3)"></div>

    <div id="gc-body">
      <div class="gc-tools">
        <div class="field" style="margin-bottom:0;flex:0 0 210px">
          <label for="gc-crs">입력 좌표계</label>
          <select id="gc-crs">${CRS_LIST.map((c, i) =>
            `<option value="${c.epsg}"${c.epsg === 5186 ? " selected" : ""}>${c.label}</option>`).join("")}</select>
        </div>
        <div class="field" style="margin-bottom:0;flex:1 1 300px">
          <label for="gc-file">파일 불러오기 (CSV · 엑셀)</label>
          <div class="input-row">
            <input type="text" id="gc-filename" readonly placeholder="A열에 주소 또는 좌표가 있는 파일">
            <button class="btn btn-secondary" id="gc-pickfile" type="button">파일 선택</button>
            <input type="file" id="gc-file" accept=".csv,.xlsx,.xls" hidden>
          </div>
        </div>
      </div>
      <p class="help" style="margin-top:-6px">
        좌표계는 <b>파일에 들어 있는 좌표의 좌표계</b>입니다. 주소만 있는 파일이면 결과 좌표를
        어느 좌표계로 낼지 정하는 값이 됩니다. 자동으로 추정하지 않습니다 —
        원점을 잘못 고르면 오류 없이 수백 km 어긋난 결과가 나오기 때문입니다.
      </p>

      <div id="gc-map-wrap">
        <div id="gc-bases" class="map-bases-wrap"></div>
        <div id="gc-map"></div>
        <p class="help" style="margin-top:6px">
          지도를 <b>더블클릭</b>하면 그 지점의 주소를 조회해 목록에 추가합니다.
          목록에서 지점을 누르면 지도가 이동하고, 지도의 표시를 누르면 목록에서 선택됩니다.
        </p>
      </div>

      <div class="gc-actions">
        <button class="btn btn-primary" id="gc-run">조회 실행</button>
        <button class="btn btn-secondary" id="gc-stop" disabled>중단</button>
        <button class="btn btn-secondary" id="gc-retry" disabled>실패분 다시 조회</button>
        <span class="gc-sep"></span>
        <button class="btn btn-secondary" id="gc-delsel">선택 삭제</button>
        <button class="btn btn-secondary" id="gc-delmap">지도지정만 비우기</button>
        <button class="btn btn-secondary" id="gc-clear">전체 비우기</button>
        <span class="gc-sep"></span>
        <button class="btn btn-primary" id="gc-export" disabled>엑셀로 내보내기</button>
        <span id="gc-count" class="gc-count"></span>
      </div>

      <div class="progress-wrap" id="gc-prog">
        <div class="progress-head"><span class="stage" id="gc-stage"></span><span class="count" id="gc-pcount"></span></div>
        <div class="progress-track"><div class="progress-fill" id="gc-fill"></div></div>
      </div>

      <div class="table-wrap active" id="gc-tblwrap">
        <table class="data-table gc-table">
          <thead><tr>
            <th style="width:34px"><input type="checkbox" id="gc-all"></th>
            <th style="width:76px">출처</th>
            <th style="width:110px">이름</th>
            <th>입력값</th>
            <th>지번주소</th>
            <th>도로명주소</th>
            <th class="num" style="width:100px">위도</th>
            <th class="num" style="width:100px">경도</th>
            <th class="num" id="gc-xh" style="width:96px">X</th>
            <th class="num" id="gc-yh" style="width:96px">Y</th>
            <th style="width:88px">상태</th>
            <th style="width:40px"></th>
          </tr></thead>
          <tbody id="gc-tbody"></tbody>
        </table>
      </div>
      <div id="gc-empty" class="placeholder">아직 지점이 없습니다 — 파일을 불러오거나 지도를 더블클릭하세요.</div>

      <div class="ph-note">
        <b>내보내기에 대해</b>
        <ul>
          <li><b>출처</b> 칼럼으로 <code>${SRC_UPLOAD}</code>과 <code>${SRC_MAP}</code>을 구분합니다.</li>
          <li>파일로 불러온 행은 <b>원본 열을 그대로 보존</b>한 채 조회 결과 열이 뒤에 붙습니다.</li>
          <li>실패한 행도 <b>지우지 않고</b> 사유와 함께 내보냅니다 — 무엇이 빠졌는지 알 수 있어야 합니다.</li>
        </ul>
      </div>

      <div class="log" id="gc-log" aria-live="polite"></div>
    </div>
  </div>`;

  const $ = (s) => section.querySelector(s);
  let rows = [];              // 통합 목록
  let seq = 0, mapSeq = 0;
  let map = null, markers = new Map();
  let busy = false, abort = false;
  let active = null;
  let uploadCols = [];        // 업로드 원본 열 이름(내보내기 시 보존)

  const log = (m, kind = "") => {
    const el = $("#gc-log");
    const d = document.createElement("div");
    if (kind) d.className = kind;
    d.textContent = m;
    el.appendChild(d); el.scrollTop = el.scrollHeight; el.classList.add("active");
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const epsg = () => parseInt($("#gc-crs").value, 10);

  /* ── 키 확인 ─────────────────────────────────────────────────────── */
  function checkKey() {
    const ok = Boolean(keys.vworld);
    $("#gc-body").style.display = ok ? "" : "none";
    $("#gc-nokey").style.display = ok ? "none" : "";
    if (!ok) {
      $("#gc-nokey").innerHTML =
        "⚙ <b>vworld API 키가 필요합니다</b> — 오른쪽 위 설정에서 입력하세요. "
        + "vworld.kr에서 무료로 발급받을 수 있습니다.";
    }
    return ok;
  }

  /* ── 좌표계 라벨 반영 ────────────────────────────────────────────── */
  function syncCrsHeader() {
    const e = epsg();
    const geo = e === 4326;
    $("#gc-xh").textContent = geo ? "—" : `X(${e})`;
    $("#gc-yh").textContent = geo ? "—" : `Y(${e})`;
    render();
  }
  $("#gc-crs").addEventListener("change", syncCrsHeader);

  /* ── 지도 ────────────────────────────────────────────────────────── */
  function ensureMap() {
    if (map) { map.invalidateSize(); return; }
    let view;
    try { view = createMap($("#gc-map"), keys.vworld); }
    catch (e) { log(`✗ ${e.message}`, "fail"); return; }
    map = view.map;
    $("#gc-bases").innerHTML = baseSwitcherHtml("gc", view.bases);
    bindBaseSwitcher(section, "gc", view);

    // 더블클릭 → 그 자리의 주소를 조회해 목록에 추가
    map.on("dblclick", async (ev) => {
      const { lat, lng } = ev.latlng;
      const row = addRow({
        source: SRC_MAP,
        name: `지점-${++mapSeq}`,
        input: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        lat, lon: lng,
        status: "조회중",
      });
      render(); drawMarkers();
      await reverse(row);
      render(); drawMarkers();
      selectRow(row.id, false);
    });
    // 더블클릭으로 지점을 찍는 화면이라 더블클릭 확대는 꺼야 한다
    map.doubleClickZoom.disable();
  }

  function drawMarkers() {
    const L = window.L;
    if (!map || !L) return;
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    const pts = [];
    for (const r of rows) {
      if (r.lat == null || r.lon == null) continue;
      const m = L.circleMarker([r.lat, r.lon], style(r, r.id === active))
        .addTo(map).bindTooltip(`${r.name} · ${r.source}`, { direction: "top" });
      m.on("click", () => selectRow(r.id, false));   // 지도 클릭은 지도를 옮기지 않는다
      markers.set(r.id, m);
      pts.push([r.lat, r.lon]);
    }
    if (pts.length && !active) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
  }

  const style = (r, on) => ({
    radius: on ? 9 : 6,
    color: on ? "#d92d20" : (r.source === SRC_MAP ? "#7a5af8" : "#1570ef"),
    fillColor: on ? "#f04438" : (r.source === SRC_MAP ? "#9b8afb" : "#2e90fa"),
    fillOpacity: 0.9, weight: on ? 3 : 2,
  });

  /** 목록에서 고르면 지도를 옮기고, 지도에서 고르면 옮기지 않는다
   *  (사진 좌표 탭과 같은 규칙 — 클릭한 지점이 튀면 UX가 나빠진다) */
  function selectRow(id, recenter) {
    active = id;
    const r = rows.find((x) => x.id === id);
    for (const [rid, m] of markers) {
      const rr = rows.find((x) => x.id === rid);
      m.setStyle(style(rr, rid === id));
    }
    if (markers.has(id)) markers.get(id).bringToFront();
    if (recenter && r?.lat != null) map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));
    section.querySelectorAll("tr[data-id]").forEach((tr) =>
      tr.classList.toggle("on", +tr.dataset.id === id));
  }

  /* ── 목록 조작 ───────────────────────────────────────────────────── */
  function addRow(o) {
    const r = { id: ++seq, source: SRC_UPLOAD, name: "", input: "",
                lat: null, lon: null, jibun: "", road: "", matched: "",
                status: "대기", reason: "", raw: null, ...o };
    rows.push(r);
    return r;
  }

  function render() {
    const tb = $("#gc-tbody");
    tb.innerHTML = "";
    const e = epsg(), geo = e === 4326;
    for (const r of rows) {
      let x = "", y = "";
      if (r.lat != null && !geo) {
        try { const p = fromWgs84(r.lat, r.lon, e); x = p[0].toFixed(3); y = p[1].toFixed(3); }
        catch (_) { x = y = "—"; }
      }
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      if (r.id === active) tr.classList.add("on");
      tr.innerHTML = `
        <td><input type="checkbox" class="gc-chk" value="${r.id}"></td>
        <td><span class="gc-src ${r.source === SRC_MAP ? "map" : "up"}">${r.source}</span></td>
        <td><input class="gc-name" value="${esc(r.name)}" data-id="${r.id}" aria-label="지점 이름"></td>
        <td class="gc-in" title="${esc(r.input)}">${esc(r.input)}</td>
        <td>${esc(r.jibun)}</td>
        <td>${esc(r.road)}</td>
        <td class="num">${r.lat != null ? r.lat.toFixed(6) : ""}</td>
        <td class="num">${r.lon != null ? r.lon.toFixed(6) : ""}</td>
        <td class="num">${x}</td>
        <td class="num">${y}</td>
        <td><span class="gc-st ${stCls(r.status)}" title="${esc(r.reason)}">${r.status}</span></td>
        <td><button class="gc-del" data-id="${r.id}" title="이 행 삭제" aria-label="삭제">×</button></td>`;
      tr.addEventListener("click", (ev) => {
        if (ev.target.closest("input,button")) return;
        selectRow(r.id, true);            // 목록에서 골랐으니 지도를 옮긴다
      });
      tb.appendChild(tr);
    }
    // 이름 편집
    section.querySelectorAll(".gc-name").forEach((inp) =>
      inp.addEventListener("change", () => {
        const r = rows.find((x) => x.id === +inp.dataset.id);
        if (r) { r.name = inp.value.trim(); drawMarkers(); }
      }));
    // 행 삭제
    section.querySelectorAll(".gc-del").forEach((b) =>
      b.addEventListener("click", () => removeIds([+b.dataset.id])));

    const n = rows.length;
    const done = rows.filter((r) => r.status === "완료").length;
    const fail = rows.filter((r) => r.status === "실패").length;
    $("#gc-count").textContent = n
      ? `${n}건 · 완료 ${done}${fail ? ` · 실패 ${fail}` : ""}` : "";
    $("#gc-empty").style.display = n ? "none" : "";
    $("#gc-tblwrap").style.display = n ? "" : "none";
    $("#gc-export").disabled = !done;
    $("#gc-retry").disabled = !fail || busy;
  }
  const stCls = (s) => s === "완료" ? "ok" : s === "실패" ? "fail" : s === "조회중" ? "run" : "";

  function removeIds(ids) {
    const set = new Set(ids);
    rows = rows.filter((r) => !set.has(r.id));
    if (set.has(active)) active = null;
    render(); drawMarkers();
  }

  $("#gc-all").addEventListener("change", (e) =>
    section.querySelectorAll(".gc-chk").forEach((c) => { c.checked = e.target.checked; }));

  $("#gc-delsel").addEventListener("click", () => {
    const ids = [...section.querySelectorAll(".gc-chk:checked")].map((c) => +c.value);
    if (!ids.length) { toast("삭제할 행을 고르세요", "fail"); return; }
    removeIds(ids);
    toast(`${ids.length}건을 지웠습니다`, "ok");
  });

  $("#gc-delmap").addEventListener("click", () => {
    const ids = rows.filter((r) => r.source === SRC_MAP).map((r) => r.id);
    if (!ids.length) { toast("지도로 찍은 지점이 없습니다", "warn"); return; }
    removeIds(ids);
    mapSeq = 0;
    toast(`지도지정 ${ids.length}건을 지웠습니다`, "ok");
  });

  $("#gc-clear").addEventListener("click", () => {
    if (!rows.length) return;
    // 되돌릴 수 없으므로 확인을 받는다
    if (!confirm(`목록 ${rows.length}건을 모두 지웁니다. 계속할까요?`)) return;
    rows = []; active = null; mapSeq = 0; uploadCols = [];
    $("#gc-filename").value = "";
    render(); drawMarkers();
  });

  /* ── 파일 불러오기 ───────────────────────────────────────────────── */
  $("#gc-pickfile").addEventListener("click", () => $("#gc-file").click());
  $("#gc-file").addEventListener("change", async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const table = await readTable(f);
      if (!table.length) { toast("빈 파일입니다", "fail"); return; }
      uploadCols = Object.keys(table[0]);
      const added = ingest(table);
      $("#gc-filename").value = f.name;
      log(`파일 ${f.name} — ${added}건 추가 (열: ${uploadCols.join(", ")})`);
      toast(`${added}건을 불러왔습니다 — [조회 실행]을 누르세요`, "ok");
      render(); drawMarkers();
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      ev.target.value = "";      // 같은 파일을 다시 고를 수 있게
    }
  });

  /** CSV·엑셀을 행 객체 배열로. xlsx.min.js가 둘 다 처리한다. */
  async function readTable(file) {
    if (!window.XLSX) throw new Error("엑셀 라이브러리를 불러오지 못했습니다");
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array", codepage: 949 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  }

  /** 첫 열을 입력으로 본다(사용자 지시: "A열에 주소 또는 위경도 좌표 기재").
   *  두 번째 열이 숫자면 좌표 2열로 간주한다. */
  function ingest(table) {
    const cols = Object.keys(table[0]);
    const c1 = cols[0], c2 = cols[1];
    let n = 0;
    for (const rec of table) {
      const a = String(rec[c1] ?? "").trim();
      if (!a) continue;
      const b = c2 ? String(rec[c2] ?? "").trim() : "";
      const na = parseCoord(a), nb = parseCoord(b);
      const isPair = !Number.isNaN(na) && !Number.isNaN(nb);
      addRow({
        source: SRC_UPLOAD,
        name: String(rec[cols.find((c) => /이름|명칭|지점|name/i.test(c))] ?? "").trim(),
        input: isPair ? `${a}, ${b}` : a,
        raw: rec,
        _pair: isPair ? [na, nb] : null,
      });
      n++;
    }
    return n;
  }

  /* ── 조회 ────────────────────────────────────────────────────────── */
  async function forward(r) {
    const res = await toCoord(keys.vworld, r.input);
    if (res.ok) {
      r.lat = res.lat; r.lon = res.lon; r.matched = res.matched;
      r.jibun = res.matched === "지번" ? res.refined : r.jibun;
      r.road = res.matched === "도로명" ? res.refined : r.road;
      // 좌표를 얻었으면 반대쪽 주소도 채워 표를 완성한다
      const rev = await toAddress(keys.vworld, r.lat, r.lon);
      if (rev.ok) { r.jibun = rev.jibun || r.jibun; r.road = rev.road || r.road; }
      r.status = "완료"; r.reason = "";
    } else {
      r.status = "실패"; r.reason = res.reason;
    }
  }

  async function reverse(r) {
    const res = await toAddress(keys.vworld, r.lat, r.lon);
    if (res.ok) {
      r.jibun = res.jibun; r.road = res.road;
      r.status = "완료"; r.reason = "";
    } else {
      r.status = "실패"; r.reason = res.reason;
    }
  }

  /** 좌표 2열로 들어온 행을 WGS84로 옮긴다. 어느 값이 X이고 Y인지는
   *  좌표계로 갈린다 — 경위도는 (위도, 경도) 순서로 적는 관습이 있고,
   *  평면직교는 (X, Y)다. */
  function placeFromPair(r) {
    const e = epsg();
    const [a, b] = r._pair;
    try {
      if (e === 4326) { r.lat = a; r.lon = b; }
      else { const [la, lo] = toWgs84(a, b, e); r.lat = la; r.lon = lo; }
      return true;
    } catch (err) {
      r.status = "실패"; r.reason = err.message;
      return false;
    }
  }

  async function runAll(targets) {
    if (busy) return;
    busy = true; abort = false;
    $("#gc-run").disabled = $("#gc-retry").disabled = true;
    $("#gc-stop").disabled = false;
    $("#gc-prog").classList.add("active");
    let done = 0, ok = 0, fail = 0;
    try {
      for (const r of targets) {
        if (abort) { log("사용자 중단 — 남은 건은 '대기'로 둡니다"); break; }
        r.status = "조회중";
        $("#gc-stage").textContent = r.input.slice(0, 40);
        $("#gc-pcount").textContent = `${done}/${targets.length}`;
        $("#gc-fill").style.width = `${(done / targets.length) * 100}%`;
        render();

        if (r._pair) { if (placeFromPair(r)) await reverse(r); }
        else if (r.lat != null) await reverse(r);
        else await forward(r);

        r.status === "완료" ? ok++ : fail++;
        done++;
        // 연속 호출로 차단되지 않게 간격을 둔다
        if (done < targets.length) await new Promise((s) => setTimeout(s, 120));
      }
      log(`조회 완료 — 성공 ${ok}건${fail ? ` · 실패 ${fail}건` : ""}`, fail ? "warn" : "ok");
      if (fail) log("실패분은 목록에 남아 있습니다 — [실패분 다시 조회]로 재시도할 수 있습니다");
      toast(`조회 ${ok}건 완료${fail ? `, ${fail}건 실패` : ""}`, fail ? "warn" : "ok");
    } finally {
      busy = false;
      $("#gc-run").disabled = false;
      $("#gc-stop").disabled = true;
      $("#gc-prog").classList.remove("active");
      $("#gc-fill").style.width = "0%";
      render(); drawMarkers();
    }
  }

  $("#gc-run").addEventListener("click", () => {
    const t = rows.filter((r) => r.status === "대기");
    if (!t.length) { toast("조회할 대기 항목이 없습니다", "warn"); return; }
    runAll(t);
  });
  $("#gc-retry").addEventListener("click", () => {
    const t = rows.filter((r) => r.status === "실패");
    if (!t.length) return;
    t.forEach((r) => { r.status = "대기"; r.reason = ""; });
    runAll(t);
  });
  $("#gc-stop").addEventListener("click", () => {
    abort = true;
    $("#gc-stop").disabled = true;
    log("중단 요청 — 진행 중인 건까지만 마칩니다");
  });

  /* ── 내보내기 ────────────────────────────────────────────────────── */
  $("#gc-export").addEventListener("click", () => {
    if (!window.XLSX) { toast("엑셀 라이브러리를 불러오지 못했습니다", "fail"); return; }
    const e = epsg(), geo = e === 4326;
    const out = rows.map((r) => {
      let x = "", y = "";
      if (r.lat != null && !geo) {
        try { const p = fromWgs84(r.lat, r.lon, e); x = +p[0].toFixed(3); y = +p[1].toFixed(3); }
        catch (_) {}
      }
      // 업로드분은 원본 열을 그대로 앞에 둔다 — 사용자가 자기 파일을 알아볼 수 있어야 한다
      const base = {};
      for (const c of uploadCols) base[c] = r.raw ? (r.raw[c] ?? "") : "";
      return {
        ...base,
        "출처": r.source,
        "지점명": r.name,
        "입력값": r.input,
        "지번주소": r.jibun,
        "도로명주소": r.road,
        "위도": r.lat ?? "",
        "경도": r.lon ?? "",
        [`X(EPSG:${e})`]: x,
        [`Y(EPSG:${e})`]: y,
        "조회상태": r.status,
        "실패사유": r.reason,
      };
    });
    const ws = window.XLSX.utils.json_to_sheet(out);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "지오코딩");
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    window.XLSX.writeFile(wb, `지오코딩_${stamp}.xlsx`);
    log(`엑셀 ${out.length}건 저장 — 출처 칼럼으로 ${SRC_UPLOAD}/${SRC_MAP}이 구분됩니다`, "ok");
    toast(`${out.length}건을 엑셀로 저장했습니다`, "ok");
  });

  /* ── 시작 ────────────────────────────────────────────────────────── */
  if (checkKey()) { ensureMap(); syncCrsHeader(); }
  // 설정에서 키를 넣고 오면 다시 확인한다
  addEventListener("storage", () => { if (checkKey()) { ensureMap(); syncCrsHeader(); } });
  render();
}
