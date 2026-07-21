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
            <button class="btn btn-secondary" id="gc-remap" type="button" style="display:none">열 매핑 수정</button>
            <input type="file" id="gc-file" accept=".csv,.xlsx,.xls" hidden>
          </div>
        </div>
      </div>
      <p class="help" style="margin-top:-6px">
        좌표계는 <b>파일에 들어 있는 좌표의 좌표계</b>입니다. 주소만 있는 파일이면 결과 좌표를
        어느 좌표계로 낼지 정하는 값이 됩니다. 자동으로 추정하지 않습니다 —
        원점을 잘못 고르면 오류 없이 수백 km 어긋난 결과가 나오기 때문입니다.
      </p>

      <div id="gc-map-panel" class="gc-map-panel" style="display:none"></div>

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
    lastTable = null; pending = null;
    $("#gc-filename").value = "";
    $("#gc-remap").style.display = "none";
    $("#gc-map-panel").style.display = "none";
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
      $("#gc-filename").value = f.name;
      log(`파일 ${f.name} — ${table.length}행 · 열 ${Object.keys(table[0]).length}개`);
      showMapping(table);          // 바로 넣지 않고 어느 열을 쓸지 먼저 정한다
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      ev.target.value = "";      // 같은 파일을 다시 고를 수 있게
    }
  });

  /** CSV·엑셀을 행 객체 배열로.
   *
   *  ⚠ CSV 인코딩을 xlsx의 `codepage` 옵션에 맡기면 안 된다 — 벤더링한
   *  xlsx.min.js에는 코드페이지 모듈(cpexcel.js)이 들어 있지 않고, 브라우저에는
   *  require가 없어 **조용히 건너뛴다**. 실측(2026-07-21): 공공데이터포털
   *  보호수 표준데이터(EUC-KR)를 UTF-8로 읽으면 첫 줄에만 치환문자가 206개
   *  생겨 열 이름이 통째로 깨진다. 그러면 열 추정도 주소도 전부 무너진다.
   *
   *  그래서 CSV는 **직접 디코딩**한다. TextDecoder는 브라우저 기본 기능이라
   *  추가 의존이 없다. xlsx에는 이미 정상인 문자열을 넘긴다.
   *  엑셀(xlsx/xls)은 바이너리 포맷이 인코딩을 스스로 담고 있어 해당 없다.
   */
  async function readTable(file) {
    if (!window.XLSX) throw new Error("엑셀 라이브러리를 불러오지 못했습니다");
    const buf = await file.arrayBuffer();
    const isCsv = /\.(csv|txt|tsv)$/i.test(file.name);

    let wb;
    if (isCsv) {
      wb = window.XLSX.read(decodeText(new Uint8Array(buf)), { type: "string" });
    } else {
      wb = window.XLSX.read(buf, { type: "array" });
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  }

  /** 바이트를 문자열로. UTF-8을 먼저 보고, 깨지면 국내 인코딩으로 되읽는다.
   *  판단은 **치환문자(U+FFFD) 개수**로 한다 — 확장자·BOM보다 확실하다. */
  function decodeText(bytes) {
    // BOM이 있으면 UTF-8이 확실하다
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    const head = bytes.subarray(0, Math.min(bytes.length, 4096));
    const count = (enc) => {
      try { return (new TextDecoder(enc).decode(head).match(/�/g) || []).length; }
      catch (_) { return Infinity; }
    };
    const utf8 = count("utf-8");
    if (utf8 === 0) return new TextDecoder("utf-8").decode(bytes);
    for (const enc of ["euc-kr", "windows-949"]) {
      if (count(enc) < utf8) return new TextDecoder(enc).decode(bytes);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* ── 열 매핑 ─────────────────────────────────────────────────────
     자동 추정만으로 결정하지 않는다. 실사고(2026-07-21): 보호수 표준데이터는
     29개 열이고 [0]개방자치단체코드=3000000·[1]관리번호=2024300...가 **둘 다
     숫자로 파싱**돼 좌표쌍으로 오인됐다. 결과는 캄차카 근처(57.6N 177.2E).
     이름으로 후보를 제안하되 **최종 선택은 사용자가** 한다. */

  /* 매핑을 적용해도 표를 버리지 않는다 — 사용자가 열 선택을 잘못했을 때
     파일을 다시 고르게 하면 번거롭다(2026-07-21 사용자 요청). */
  let pending = null;         // 매핑 화면이 열려 있는 동안의 {table, cols}
  let lastTable = null;       // 마지막으로 불러온 표 (다시 열기용)

  const GUESS = {
    lat:  /^(wgs84)?\s*(위도|latitude|lat|y좌표|위도\(y\))/i,
    lon:  /^(wgs84)?\s*(경도|longitude|lon|lng|x좌표|경도\(x\))/i,
    x:    /^(x|tm\s*x|동서|횡좌표)/i,
    y:    /^(y|tm\s*y|남북|종좌표)/i,
    addr: /(지번\s*주소|소재지지번주소|도로명\s*주소|소재지도로명주소|주소|address|소재지)/i,
    name: /(이름|명칭|지점명|수목명|시설명|name)/i,
  };
  const guess = (cols, re) => cols.find((c) => re.test(String(c).trim())) || "";

  function showMapping(table) {
    const cols = Object.keys(table[0]);
    pending = { table, cols };
    const opts = (sel) => `<option value="">— 선택 안 함 —</option>` +
      cols.map((c) => `<option value="${esc(c)}"${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");

    const gLat = guess(cols, GUESS.lat) || guess(cols, GUESS.y);
    const gLon = guess(cols, GUESS.lon) || guess(cols, GUESS.x);
    const gAddr = guess(cols, GUESS.addr);
    const gName = guess(cols, GUESS.name);
    const hasCoord = Boolean(gLat && gLon);

    $("#gc-map-panel").innerHTML = `
      <b>불러온 열 ${cols.length}개 — 무엇으로 조회할지 골라주세요</b>
      <p class="help" style="margin:4px 0 10px">
        열 이름으로 후보를 제안했지만 <b>확인은 직접</b> 해주세요.
        코드·관리번호처럼 숫자로 된 열이 좌표로 오인될 수 있습니다.
      </p>
      <div class="gc-map-row">
        <label><input type="radio" name="gc-mode" value="coord"${hasCoord ? " checked" : ""}> 좌표로 조회 <span class="gc-dim">(좌표 → 주소)</span></label>
        <select id="gc-col-lat" ${hasCoord ? "" : "disabled"}>${opts(gLat)}</select>
        <span class="gc-dim">위도 / Y</span>
        <select id="gc-col-lon" ${hasCoord ? "" : "disabled"}>${opts(gLon)}</select>
        <span class="gc-dim">경도 / X</span>
      </div>
      <div class="gc-map-row">
        <label><input type="radio" name="gc-mode" value="addr"${hasCoord ? "" : " checked"}> 주소로 조회 <span class="gc-dim">(주소 → 좌표)</span></label>
        <select id="gc-col-addr">${opts(gAddr)}</select>
      </div>
      <div class="gc-map-row">
        <span class="gc-dim" style="min-width:150px">지점 이름 열 (선택)</span>
        <select id="gc-col-name">${opts(gName)}</select>
      </div>
      <div id="gc-preview" class="gc-preview"></div>
      <div class="gc-map-row" style="margin-top:10px">
        <button class="btn btn-primary" id="gc-mapok">이 설정으로 ${table.length}건 추가</button>
        <button class="btn btn-secondary" id="gc-mapcancel">취소</button>
      </div>`;
    $("#gc-map-panel").style.display = "";

    const sync = () => {
      const mode = section.querySelector('input[name="gc-mode"]:checked').value;
      $("#gc-col-lat").disabled = $("#gc-col-lon").disabled = mode !== "coord";
      $("#gc-col-addr").disabled = mode !== "addr";
      preview(mode);
    };
    section.querySelectorAll('input[name="gc-mode"]').forEach((r) =>
      r.addEventListener("change", sync));
    ["#gc-col-lat", "#gc-col-lon", "#gc-col-addr", "#gc-col-name"].forEach((id) =>
      $(id).addEventListener("change", sync));
    $("#gc-mapok").addEventListener("click", applyMapping);
    $("#gc-mapcancel").addEventListener("click", () => {
      pending = null;
      $("#gc-map-panel").style.display = "none";
      // 표는 남겨둔다 — [열 매핑 수정]으로 다시 열 수 있어야 한다
      if (!lastTable) $("#gc-filename").value = "";
    });
    sync();
  }

  /* 미리보기 — 고른 열의 실제 값을 3행 보여준다. 이걸 봤다면 3000000이
     좌표가 아니라는 것을 바로 알 수 있었다. */
  function preview(mode) {
    const { table } = pending;
    const rows3 = table.slice(0, 3);
    let html = "";
    if (mode === "coord") {
      const cl = $("#gc-col-lat").value, co = $("#gc-col-lon").value;
      if (!cl || !co) { $("#gc-preview").innerHTML = `<span class="gc-warn">위도·경도 열을 모두 고르세요</span>`; return; }
      const e = epsg();
      const f0 = rows3.find((r) => !Number.isNaN(parseCoord(r[cl])));
      const mis = f0 ? crsMismatch(parseCoord(f0[cl]), parseCoord(f0[co])) : null;
      html = rows3.map((r) => {
        const a = parseCoord(r[cl]), b = parseCoord(r[co]);
        if (Number.isNaN(a) || Number.isNaN(b)) return `<div class="gc-warn">숫자가 아닙니다: ${esc(r[cl])} / ${esc(r[co])}</div>`;
        let la = a, lo = b;
        if (e !== 4326) { try { [la, lo] = toWgs84(a, b, e); } catch (_) { return `<div class="gc-warn">변환 실패</div>`; } }
        const bad = !inKorea(la, lo);
        return `<div${bad ? ' class="gc-warn"' : ""}>${esc(r[cl])}, ${esc(r[co])}`
             + ` → 위도 ${la.toFixed(6)}, 경도 ${lo.toFixed(6)}${bad ? "  ⚠ 한국 밖" : ""}</div>`;
      }).join("");
      if (mis) {
        html = `<div class="gc-mismatch">⚠ <b>좌표계가 맞지 않습니다</b><br>${esc(mis.msg)}`
             + (mis.want ? ` <button type="button" class="btn btn-secondary gc-fixcrs" data-epsg="${mis.want}">EPSG:${mis.want}로 바꾸기</button>` : "")
             + `</div>` + html;
      }
    } else {
      const ca = $("#gc-col-addr").value;
      if (!ca) { $("#gc-preview").innerHTML = `<span class="gc-warn">주소 열을 고르세요</span>`; return; }
      html = rows3.map((r) => `<div>${esc(String(r[ca] ?? "").slice(0, 70)) || '<span class="gc-warn">비어 있음</span>'}</div>`).join("");
    }
    $("#gc-preview").innerHTML = `<div class="gc-dim" style="margin-bottom:4px">미리보기 (앞 3행)</div>${html}`;
    const fix = $("#gc-preview").querySelector(".gc-fixcrs");
    if (fix) fix.addEventListener("click", () => {
      $("#gc-crs").value = fix.dataset.epsg;
      syncCrsHeader();
      preview(mode);
    });
  }

  /** 대한민국 대략 범위 — 결과가 여기를 벗어나면 열·좌표계 선택이 틀렸을 가능성이 높다 */
  const inKorea = (lat, lon) => lat > 33 && lat < 39.5 && lon > 124.5 && lon < 132;

  /* ── 좌표계 불일치 감지 ────────────────────────────────────────────
     범위 검사만으로는 부족했다(2026-07-21 2차 실사고). 경위도 값을 5186
     미터로 해석하면 32.6N 124.9E — **서해 한복판**이 나오는데, 넉넉히 잡은
     범위 안이라 통과해버렸다.

     그래서 변환 결과가 아니라 **입력값의 생김새**를 본다. 이쪽이 훨씬 결정적이다.
       · 33~39 / 124~132 범위의 소수 → 경위도다. 평면좌표라면 이런 값이 나올 수
         없다(가원점 때문에 최소 수만 단위다).
       · 절댓값 10,000 이상 → 평면좌표다. 경위도라면 불가능한 크기다. */
  const looksGeographic = (a, b) =>
    Math.abs(a) > 32 && Math.abs(a) < 40 && Math.abs(b) > 123 && Math.abs(b) < 133;
  const looksPlanar = (a, b) => Math.abs(a) > 10000 || Math.abs(b) > 10000;

  /** 고른 좌표 열의 값과 선택한 좌표계가 어긋나면 사유를 돌려준다(맞으면 null) */
  function crsMismatch(a, b) {
    const e = epsg();
    if (e === 4326 && looksPlanar(a, b))
      return { want: null, msg: "값이 수만~수백만 단위입니다 — 경위도가 아니라 평면좌표로 보입니다. 좌표계를 5186 등으로 바꾸세요" };
    if (e !== 4326 && looksGeographic(a, b))
      return { want: 4326, msg: `값이 위경도로 보입니다(${a}, ${b}). 지금 좌표계가 EPSG:${e}(평면)라 미터로 해석돼 엉뚱한 곳이 됩니다` };
    return null;
  }

  function applyMapping() {
    if (!pending) return;
    const { table } = pending;
    const mode = section.querySelector('input[name="gc-mode"]:checked').value;
    const cn = $("#gc-col-name").value;
    let n = 0, outside = 0;

    // 다시 매핑하는 경우 — 같은 파일이 두 벌 쌓이지 않게 이전 업로드분을 걷어낸다.
    // 지도로 찍은 지점은 파일과 무관하므로 건드리지 않는다.
    const prev = rows.filter((r) => r.source === SRC_UPLOAD).length;
    if (prev) {
      rows = rows.filter((r) => r.source !== SRC_UPLOAD);
      log(`이전 업로드분 ${prev}건을 교체합니다`);
    }

    if (mode === "coord") {
      const cl = $("#gc-col-lat").value, co = $("#gc-col-lon").value;
      if (!cl || !co) { toast("위도·경도 열을 모두 고르세요", "fail"); return; }
      for (const rec of table) {
        const a = parseCoord(rec[cl]), b = parseCoord(rec[co]);
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        addRow({ source: SRC_UPLOAD, name: String(rec[cn] ?? "").trim(),
                 input: `${rec[cl]}, ${rec[co]}`, raw: rec, _pair: [a, b] });
        n++;
      }
      // 첫 행으로 범위를 한 번 본다 — 전량 조회 후에 알면 늦다
      const first = table.find((r) => !Number.isNaN(parseCoord(r[cl])));
      if (first) {
        const e = epsg();
        let la = parseCoord(first[cl]), lo = parseCoord(first[co]);
        try { if (e !== 4326) [la, lo] = toWgs84(la, lo, e); } catch (_) {}
        if (!inKorea(la, lo)) outside = 1;
      }
    } else {
      const ca = $("#gc-col-addr").value;
      if (!ca) { toast("주소 열을 고르세요", "fail"); return; }
      for (const rec of table) {
        const a = String(rec[ca] ?? "").trim();
        if (!a) continue;
        addRow({ source: SRC_UPLOAD, name: String(rec[cn] ?? "").trim(),
                 input: a, raw: rec });
        n++;
      }
    }
    uploadCols = pending.cols;
    lastTable = pending.table;
    pending = null;
    $("#gc-map-panel").style.display = "none";
    $("#gc-remap").style.display = "";
    log(`${n}건 추가 (${mode === "coord" ? "좌표 → 주소" : "주소 → 좌표"})`);
    if (outside) {
      log("⚠ 첫 행이 대한민국 범위 밖입니다 — 열 선택이나 좌표계를 확인하세요", "fail");
      toast("좌표가 한국 밖입니다 — 열·좌표계를 확인하세요", "warn");
    } else {
      toast(`${n}건을 불러왔습니다 — [조회 실행]을 누르세요`, "ok");
    }
    render(); drawMarkers();
  }

  $("#gc-remap").addEventListener("click", () => {
    if (!lastTable) { toast("불러온 파일이 없습니다", "warn"); return; }
    if (busy) { toast("조회 중에는 바꿀 수 없습니다", "warn"); return; }
    showMapping(lastTable);
  });

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
      // 한국 밖이면 vworld에 물어봐야 NOT_FOUND다 — 헛호출 대신 사유를 명확히 준다
      if (!inKorea(r.lat, r.lon)) {
        r.status = "실패";
        r.reason = `변환 결과가 대한민국 밖입니다 (위도 ${r.lat.toFixed(4)}, 경도 ${r.lon.toFixed(4)}) `
                 + `— 좌표 열 선택 또는 입력 좌표계(EPSG:${e})를 확인하세요`;
        return false;
      }
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
