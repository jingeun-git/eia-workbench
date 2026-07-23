/* 사진 좌표 (SYS-33 ③) — 지오세터(GeoSetter) 기능 이식
 *
 * 현장사진의 EXIF에서 촬영지점·촬영방향을 읽어 지도에 표시하고, CSV·KML로
 * 내보낸다. 계산은 브리지의 photo_exif.py가 전부 담당한다 — 이 파일은 UI만 맡는다.
 *
 * ── 지오세터 Map Log에서 확인한 동작 규칙 (2026-07-21) ──
 * 사용자가 제공한 실행 로그 덕분에 추측 없이 옮길 수 있었다.
 *
 *   [목록에서 선택]  setCenter(...) → showFocusMarker(..., true, ...)   지도를 이동한다
 *   [지도에서 클릭]  clearSelectedMarkerInfo() → showFocusMarker(..., false, ...)
 *                                                                       이동하지 않는다
 *
 * 마커를 클릭했는데 지도가 다시 중앙정렬되면 클릭한 지점이 튀어 UX가 나빠진다.
 * 양방향 선택의 핵심 디테일이라 그대로 지킨다.
 *
 * 화각은 원호가 아니라 **삼각형**이다(로그의 좌·우변 길이가 정확히 같았고 화면에도
 * 직선 변으로 그려진다). 부채꼴 길이는 줌에 연동된다 — 로그에서 같은 사진의 끝점이
 * 24.77km → 4.96km로 바뀌는 것이 확인된다.
 */

/* 공용 모듈도 버전을 붙여 부른다 — 붙이지 않으면 브라우저가 옛 파일을
   계속 써서, 고쳐도 화면이 안 바뀐다(2026-07-21 실사고). */
import { loadShared } from "../shared/loader.js";

export async function init(section, { bridge, toast, V }) {
  const { createMap, baseSwitcherHtml, bindBaseSwitcher, destination: dest } =
    await loadShared("mapview.js", V);
  const { keys } = await loadShared("keys.js", V);

  section.innerHTML = `
  <div class="panel">
    <h2>사진 좌표</h2>
    <p class="desc">현장사진의 EXIF에서 <b>촬영지점과 촬영방향</b>을 읽어 지도에 표시합니다.
      지도의 지점을 누르면 그 사진이, 사진을 누르면 그 지점이 선택됩니다.
      좌표는 <b>CSV·KML</b>로 내보낼 수 있습니다.</p>

    <div id="ph-locked" class="placeholder" style="margin-bottom:var(--space-2)">
      ○ 브리지 미연결 — 브리지 실행 후 활성화됩니다.
    </div>

    <div id="ph-form" style="display:none">
      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:flex-end;margin-bottom:var(--space-3)">
        <div class="field" style="margin-bottom:0;flex:1 1 380px">
          <label for="ph-folder">사진 폴더 <span class="req">*</span></label>
          <div class="input-row">
            <input type="text" id="ph-folder" readonly placeholder="[폴더 선택]을 누르세요">
            <button class="btn btn-secondary" id="ph-pick" type="button">폴더 선택</button>
          </div>
        </div>
        <div class="field" style="margin-bottom:0;flex:0 0 auto">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="ph-recursive"> 하위 폴더 포함
          </label>
        </div>
        <button class="btn btn-primary" id="ph-scan">사진 읽기</button>
      </div>

      <div id="ph-status" class="placeholder" style="display:none;margin-bottom:var(--space-3)"></div>

      <div id="ph-work" style="display:none">
        <div class="ph-split">
          <div class="ph-left">
            <div class="ph-grid" id="ph-grid"></div>
            <div class="ph-preview" id="ph-preview">
              <div class="ph-preview-empty">사진을 고르면 여기에 표시됩니다</div>
            </div>
          </div>
          <div class="ph-right">
            <div id="ph-bases" class="map-bases-wrap"></div>
            <div id="ph-map"></div>
            <div class="ph-readout" id="ph-readout">—</div>
          </div>
        </div>

        <div style="display:flex;gap:var(--space-3);align-items:flex-end;flex-wrap:wrap;margin-top:var(--space-4)">
          <div class="field" style="margin-bottom:0;flex:0 0 170px">
            <label for="ph-fmt">내보내기 형식</label>
            <select id="ph-fmt">
              <option value="csv">CSV (엑셀)</option>
              <option value="kml">KML (구글어스)</option>
            </select>
          </div>
          <div class="field" style="margin-bottom:0;flex:0 0 200px" id="ph-epsg-wrap">
            <label for="ph-epsg">좌표계</label>
            <select id="ph-epsg">
              <option value="5186">EPSG:5186 중부원점</option>
              <option value="5185">EPSG:5185 서부원점</option>
              <option value="5187">EPSG:5187 동부원점</option>
              <option value="5179">EPSG:5179 UTM-K</option>
              <option value="4326">EPSG:4326 WGS84 경위도</option>
            </select>
          </div>
          <div class="field" style="margin-bottom:0;flex:1 1 320px">
            <label for="ph-out">저장 위치</label>
            <div class="input-row">
              <input type="text" id="ph-out" readonly placeholder="비우면 사진 폴더에 저장됩니다">
              <button class="btn btn-secondary" id="ph-outpick" type="button">경로 지정</button>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-3)">
          <button class="btn btn-primary" id="ph-export">선택한 사진 내보내기</button>
          <button class="btn btn-secondary" id="ph-selall">전체 선택</button>
          <button class="btn btn-secondary" id="ph-selnone">선택 해제</button>
          <span id="ph-selcount" style="color:var(--text-muted);font-size:var(--text-sm)"></span>
        </div>

        <div class="ph-note" id="ph-expinfo">
          <b>내보내면 이런 정보가 함께 저장됩니다</b>
          <ul>
            <li><b>사진 파일명</b>이 속성으로 그대로 들어갑니다(CSV의 <code>파일명</code> 칸,
                KML의 지점 이름) — 어느 사진의 좌표인지 바로 찾을 수 있습니다.</li>
            <li>촬영지점 <b>위도·경도</b>와 선택한 좌표계의 <b>평면좌표 X·Y</b>가 나란히 기록됩니다.</li>
            <li><b>방위각·수평화각·초점거리·고도·촬영시각·기기명·GPS 오차</b>와
                사진 <b>원본 경로</b>가 함께 저장됩니다.</li>
          </ul>
          <p id="ph-note-fmt"></p>
          <p class="ph-note-warn">사진 파일 자체는 복사되지 않습니다 — 좌표와 속성만 저장됩니다.
            사진을 옮기거나 이름을 바꾸면 원본 경로가 더 이상 맞지 않으니, 내보낸 파일과
            사진 폴더는 함께 관리하세요.</p>
        </div>
        <p class="help" id="ph-exphelp"></p>
      </div>

      <div class="log" id="ph-log" aria-live="polite"></div>
    </div>
  </div>`;

  const $ = (s) => section.querySelector(s);
  let photos = [];        // 브리지가 돌려준 전체 목록(좌표 없는 것 포함)
  let selected = new Set();   // 내보낼 사진 index
  let active = null;      // 현재 크게 보고 있는 사진 index
  let map = null, markers = new Map(), wedgeLayer = null;
  let folder = "", outPath = "", busy = false;
  const thumbCache = new Map();   // index -> blob URL

  const log = (msg, kind = "") => {
    const el = $("#ph-log");
    const d = document.createElement("div");
    if (kind) d.className = kind;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    el.classList.add("active");
  };

  /* ── 브리지 상태 ─────────────────────────────────────────────── */
  const renderState = () => {
    const f = bridge.info?.features || {};
    const ok = bridge.state === "ok" && f.photo;
    $("#ph-form").style.display = ok ? "" : "none";
    $("#ph-locked").style.display = ok ? "none" : "";
    if (!ok) {
      $("#ph-locked").textContent = bridge.state !== "ok"
        ? "○ 브리지 미연결 — 브리지 런처를 실행하세요."
        : "⚠ 브리지에 photo_exif가 없습니다 — 브리지를 최신 버전으로 다시 실행하세요.";
      return;
    }
    // HEIC 미지원 같은 사정은 상단에 상시 경고하지 않는다 — 실제로 그런 사진을
    // 읽었을 때 **사진별 사유**로 정확히 표시되므로(스캔 결과 줄), 겪지도 않을
    // 문제를 미리 경고하면 소음만 된다(2026-07-21 사용자 정정).
    $("#ph-exphelp").textContent =
      "CSV는 위 좌표계로 저장됩니다. KML은 규격상 WGS84 고정이라 좌표계 선택이 적용되지 않습니다.";
  };
  bridge.addEventListener("change", renderState);
  renderState();

  /* KML은 WGS84 고정이라 좌표계 선택이 의미가 없다 — 숨기지 않고 흐리게 해서
     "왜 안 되는지"가 보이게 한다(사라지면 사용자는 고장으로 읽는다). */
  const FMT_NOTE = {
    csv: "CSV는 엑셀에서 바로 열리도록 UTF-8(BOM)으로 저장됩니다. "
       + "QGIS에서는 [구분 텍스트 레이어 추가]로 불러오면 점 레이어가 됩니다.",
    kml: "KML은 구글어스에서 바로 열립니다. 방위각이 있는 사진은 <b>화각 삼각형</b>도 "
       + "함께 저장돼 어느 쪽을 보고 찍었는지 지도에 나타납니다.",
  };
  const syncFmt = () => {
    const v = $("#ph-fmt").value;
    $("#ph-epsg-wrap").style.opacity = v === "kml" ? "0.45" : "1";
    $("#ph-note-fmt").innerHTML = FMT_NOTE[v] || "";
  };
  $("#ph-fmt").addEventListener("change", () => {
    syncFmt();
    outPath = "";                 // 형식이 바뀌면 확장자가 달라진다
    $("#ph-out").value = "";
  });
  syncFmt();

  /* ── 폴더 선택 ───────────────────────────────────────────────── */
  $("#ph-pick").addEventListener("click", async () => {
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "folder" } });
      const p = r.path || (r.paths || [])[0];
      if (p) { folder = p; $("#ph-folder").value = p; }
    } catch (e) { toast(e.message, "fail"); }
  });

  /* ── 스캔 ─────────────────────────────────────────────────────── */
  $("#ph-scan").addEventListener("click", async () => {
    if (busy) return;
    if (!folder) { toast("사진 폴더를 먼저 선택하세요", "fail"); return; }
    busy = true;
    $("#ph-scan").disabled = true;
    $("#ph-log").textContent = "";
    try {
      const r = await bridge.call("/photo/scan", { method: "POST", timeoutMs: 180000,
        body: { folder, recursive: $("#ph-recursive").checked } });
      photos = r.photos || [];
      resetSelection();
      renderStatus(r);
      renderGrid();
      syncCount();
      await ensureMap();
      drawMarkers();
      if (!r.with_geo) toast("좌표를 가진 사진이 없습니다", "warn");
      else toast(`사진 ${r.total}장 중 ${r.with_geo}장에 좌표가 있습니다`, "ok");
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      busy = false;
      $("#ph-scan").disabled = false;
    }
  });

  /* 좌표가 없는 사진도 **숨기지 않고** 사유와 함께 알린다 — 조용히 빠지면
     사용자는 몇 장이 누락됐는지조차 모른다. */
  function renderStatus(r) {
    const el = $("#ph-status");
    const noGeo = photos.filter((p) => p.lat == null);
    const parts = [`사진 <b>${r.total}</b>장 · 좌표 있음 <b>${r.with_geo}</b>장`];
    if (r.no_dir) parts.push(`방위각 없음 <b>${r.no_dir}</b>장 (지점만 표시)`);
    if (noGeo.length) {
      const why = {};
      for (const p of noGeo) why[p.reason || "사유 불명"] = (why[p.reason || "사유 불명"] || 0) + 1;
      parts.push("좌표 없음 <b>" + noGeo.length + "</b>장 — "
        + Object.entries(why).map(([k, v]) => `${k} ${v}장`).join(", "));
    }
    el.innerHTML = parts.join(" &nbsp;·&nbsp; ");
    el.style.display = "";
    $("#ph-work").style.display = r.with_geo ? "" : "none";
  }

  function resetSelection() {
    selected = new Set(photos.map((p, i) => (p.lat != null ? i : -1)).filter((i) => i >= 0));
    active = null;
    for (const u of thumbCache.values()) URL.revokeObjectURL(u);
    thumbCache.clear();
  }

  /* ── 썸네일 격자 ─────────────────────────────────────────────── */
  function renderGrid() {
    const g = $("#ph-grid");
    g.innerHTML = "";
    photos.forEach((p, i) => {
      const cell = document.createElement("div");
      cell.className = "ph-cell" + (p.lat == null ? " nogeo" : "");
      cell.dataset.idx = i;
      cell.innerHTML = `
        <div class="ph-thumb"><div class="ph-spin"></div></div>
        <div class="ph-cap" title="${esc(p.name)}">${esc(p.name)}</div>
        ${p.lat == null ? `<div class="ph-badge" title="${esc(p.reason || "")}">좌표 없음</div>`
                        : `<input type="checkbox" class="ph-chk" ${selected.has(i) ? "checked" : ""}>`}`;
      cell.addEventListener("click", (e) => {
        if (e.target.classList.contains("ph-chk")) {
          e.target.checked ? selected.add(i) : selected.delete(i);
          syncCount();
          return;
        }
        selectPhoto(i, true);    // 목록에서 골랐으니 지도를 이동한다
      });
      g.appendChild(cell);
      loadThumb(i, cell.querySelector(".ph-thumb"), 220);
    });
  }

  async function loadThumb(i, holder, size) {
    try {
      let url = thumbCache.get(i);
      if (!url) {
        url = await bridge.blobUrl(
          `/photo/thumb?path=${encodeURIComponent(photos[i].path)}&size=${size}`);
        thumbCache.set(i, url);
      }
      holder.innerHTML = `<img src="${url}" alt="${esc(photos[i].name)}">`;
    } catch (_) {
      holder.innerHTML = `<div class="ph-thumb-fail">미리보기 불가</div>`;
    }
  }

  /* ── 지도 ─────────────────────────────────────────────────────── */
  async function ensureMap() {
    if (map) { map.invalidateSize(); return; }
    let view;
    try {
      view = createMap($("#ph-map"), keys.vworld);
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      return;
    }
    map = view.map;

    // 배경 전환 버튼을 지도 위에 얹는다
    const sw = $("#ph-bases");
    if (sw) {
      sw.innerHTML = baseSwitcherHtml("ph", view.bases);
      bindBaseSwitcher(section, "ph", view);
      if (!view.usingVworld) {
        sw.insertAdjacentHTML("beforeend",
          `<span class="map-note">vworld 키를 넣으면 위성영상을 볼 수 있습니다 (⚙ 설정)</span>`);
      }
    }

    const L = window.L;
    wedgeLayer = L.layerGroup().addTo(map);
    // 줌·팬마다 부채꼴 길이를 다시 계산한다 — 지오세터도 그렇게 한다
    // (updateFocusMarkerDirection이 반복 호출되며 끝점이 계속 바뀐다).
    map.on("zoomend moveend", () => { if (active != null) drawWedge(active); });
  }

  function drawMarkers() {
    const L = window.L;
    if (!map || !L) return;
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    wedgeLayer.clearLayers();

    const pts = [];
    photos.forEach((p, i) => {
      if (p.lat == null) return;
      const m = L.circleMarker([p.lat, p.lon], markerStyle(false))
        .addTo(map)
        .bindTooltip(p.name, { direction: "top" });
      // 지도에서 클릭 → 사진 선택. **지도를 이동시키지 않는다**(지오세터 규칙).
      m.on("click", () => selectPhoto(i, false));
      markers.set(i, m);
      pts.push([p.lat, p.lon]);
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
  }

  const markerStyle = (on) => ({
    radius: on ? 9 : 6,
    color: on ? "#d92d20" : "#1570ef",
    fillColor: on ? "#f04438" : "#2e90fa",
    fillOpacity: 0.9, weight: on ? 3 : 2,
  });

  /* 부채꼴 길이는 현재 지도 크기에 맞춘다 — 고정 km로 하면 줌아웃에서 안 보이고
     줌인에서 화면을 덮는다. 지오세터도 줌에 연동한다(로그 실측). */
  function wedgeKm() {
    const b = map.getBounds();
    const diag = b.getNorthWest().distanceTo(b.getSouthEast()) / 1000;
    return diag * 0.22;
  }

  function drawWedge(i) {
    const L = window.L;
    wedgeLayer.clearLayers();
    const p = photos[i];
    if (!p || p.lat == null || p.direction == null) return;
    const km = wedgeKm();
    const apex = [p.lat, p.lon];
    const center = dest(p.lat, p.lon, p.direction, km);

    if (p.fov) {
      const half = p.fov / 2;
      const l = dest(p.lat, p.lon, p.direction - half, km);
      const r = dest(p.lat, p.lon, p.direction + half, km);
      // 원호가 아니라 삼각형 — 지오세터 로그에서 좌·우변 길이가 같았고
      // 화면에도 직선으로 그려진다.
      L.polygon([apex, l, r], {
        color: "#7a5af8", weight: 1.5, fillColor: "#7a5af8", fillOpacity: 0.25,
      }).addTo(wedgeLayer);
    }
    L.polyline([apex, center], { color: "#e0342c", weight: 2 }).addTo(wedgeLayer);
  }

  /* ── 양방향 선택 ─────────────────────────────────────────────── */
  /** @param {boolean} recenter 목록에서 고르면 true(지도 이동), 지도에서 고르면 false */
  function selectPhoto(i, recenter) {
    active = i;
    const p = photos[i];

    section.querySelectorAll(".ph-cell").forEach((c) =>
      c.classList.toggle("on", +c.dataset.idx === i));
    const cell = section.querySelector(`.ph-cell[data-idx="${i}"]`);
    if (cell) cell.scrollIntoView({ block: "nearest", behavior: "smooth" });

    for (const [j, m] of markers) m.setStyle(markerStyle(j === i));
    if (markers.has(i)) markers.get(i).bringToFront();

    if (p.lat != null) {
      if (recenter) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
      drawWedge(i);
    } else {
      wedgeLayer.clearLayers();
    }
    renderReadout(p);
    renderPreview(i);
  }

  function renderReadout(p) {
    if (p.lat == null) { $("#ph-readout").textContent = `${p.name} — ${p.reason || "좌표 없음"}`; return; }
    const bits = [`${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`];
    bits.push(p.direction != null ? `방위각 ${p.direction.toFixed(2)}°` : "방위각 없음");
    if (p.fov) bits.push(`화각 ${p.fov.toFixed(1)}° (35mm 환산 ${Math.round(p.fl35)}mm)`);
    if (p.alt != null) bits.push(`고도 ${p.alt.toFixed(1)}m`);
    if (p.gps_error != null) bits.push(`오차 ±${p.gps_error.toFixed(1)}m`);
    if (p.taken_at) bits.push(p.taken_at);
    $("#ph-readout").textContent = bits.join("  ·  ");
  }

  async function renderPreview(i) {
    const el = $("#ph-preview");
    el.innerHTML = `<div class="ph-preview-empty">불러오는 중…</div>`;
    try {
      const url = await bridge.blobUrl(
        `/photo/thumb?path=${encodeURIComponent(photos[i].path)}&size=1400`);
      if (active !== i) { URL.revokeObjectURL(url); return; }   // 그 사이 다른 걸 골랐다
      el.innerHTML = `<img src="${url}" alt="${esc(photos[i].name)}">`;
      el.querySelector("img").addEventListener("load", function () {
        URL.revokeObjectURL(this.src);   // 화면에 올라간 뒤 해제해도 표시는 유지된다
      }, { once: true });
    } catch (e) {
      el.innerHTML = `<div class="ph-preview-empty">미리보기를 불러오지 못했습니다</div>`;
    }
  }

  /* ── 선택·내보내기 ───────────────────────────────────────────── */
  function syncCount() {
    const el = $("#ph-selcount");
    if (el) el.textContent = selected.size ? `${selected.size}개 선택됨` : "선택된 사진 없음";
  }

  const setAll = (on) => {
    selected = on ? new Set(photos.map((p, i) => (p.lat != null ? i : -1)).filter((i) => i >= 0))
                  : new Set();
    section.querySelectorAll(".ph-cell").forEach((c) => {
      const chk = c.querySelector(".ph-chk");
      if (chk) chk.checked = on;
    });
    syncCount();
  };
  $("#ph-selall").addEventListener("click", () => setAll(true));
  $("#ph-selnone").addEventListener("click", () => setAll(false));

  const FMT_LABEL = { csv: "CSV", kml: "KML" };
  const defaultName = () => {
    const base = (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "photos");
    return `${base}_촬영지점.${$("#ph-fmt").value}`;
  };

  $("#ph-outpick").addEventListener("click", async () => {
    const fmt = $("#ph-fmt").value;
    try {
      const r = await bridge.call("/pick", { method: "POST", timeoutMs: 120000,
        body: { kind: "save", initial: defaultName(), initial_dir: folder,
                patterns: [[`${FMT_LABEL[fmt]} (*.${fmt})`, `*.${fmt}`]] } });
      const p = r.path || (r.paths || [])[0];
      if (p) { outPath = p; $("#ph-out").value = p; }
    } catch (e) { toast(e.message, "fail"); }
  });

  $("#ph-export").addEventListener("click", async () => {
    if (busy) return;
    const picked = [...selected].sort((a, b) => a - b).map((i) => photos[i]);
    if (!picked.length) { toast("내보낼 사진을 하나 이상 고르세요", "fail"); return; }
    const fmt = $("#ph-fmt").value;
    // 경로를 지정하지 않았으면 사진 폴더에 저장한다 — 지정을 강제하면
    // 매번 대화상자를 거쳐야 해서 단순한 경우가 번거로워진다.
    const out = outPath || `${folder}/${defaultName()}`;
    busy = true;
    $("#ph-export").disabled = true;
    try {
      const r = await bridge.call("/photo/export", { method: "POST", timeoutMs: 120000,
        body: { format: fmt, out, photos: picked, epsg: parseInt($("#ph-epsg").value, 10) } });
      log(`✓ ${r.count}개 지점을 저장했습니다 — ${r.path}`, "ok");
      toast(`${fmt.toUpperCase()} 저장 완료 — 사진 폴더에 있습니다`, "ok");
    } catch (e) {
      log(`✗ ${e.message}`, "fail");
      toast(e.message, "fail");
    } finally {
      busy = false;
      $("#ph-export").disabled = false;
    }
  });

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
