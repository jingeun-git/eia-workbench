/* 로컬 브리지 클라이언트 (SYS-29)
 * 실측 확정 사항(2026-07-20 PoC)을 그대로 구현한다:
 *  - fetch에 targetAddressSpace:'loopback' (Chrome, 'local' 아님 — 실측 ⓓ)
 *  - Origin 헤더는 신뢰·사용하지 않음 (경로상 변조 실측 ⓒ) → 토큰 인증
 *  - 캐시 금지 (PoC 캐시 오진 사고 재발 방지)
 */

const PORTS = [8765, 8766, 8767, 8768, 8769, 8770];
const PING_INTERVAL = 15000;

export class BridgeClient extends EventTarget {
  constructor() {
    super();
    this.base = null;          // 연결된 베이스 URL
    this.info = null;          // /ping 응답 (버전·기능 목록)
    this.state = "checking";   // checking | ok | off
    this._timer = null;
    /* 지금 돌고 있는 작업 — 탭 전환·앱 종료 안전장치가 이걸 본다(SYS-76 W3).
       브리지 워커는 **순차 단일**이라 실질적으로 하나지만, 큐에 쌓인 것까지
       세려면 집합이어야 한다. 모듈마다 따로 관리하면 한 곳이 빠져도 모르니
       `pollJob`이 유일한 폴링 경로라는 점을 이용해 여기서만 기록한다. */
    this.activeJobs = new Map();   // jobId → { label, since }
  }

  /** 돌고 있는 작업이 있는가 (탭 전환 가드용) */
  get busy() { return this.activeJobs.size > 0; }

  /** 작업 취소 — 브리지가 한컴을 끊어 실제로 멈춘다. 완료분은 남는다. */
  async cancelJob(jobId) {
    return this.call(`/jobs/${jobId}/cancel`, { method: "POST", timeoutMs: 25000 });
  }

  /** 돌고 있는 작업 전부 취소 (탭 전환 '진행' · 앱 종료) */
  async cancelAll() {
    const ids = [...this.activeJobs.keys()];
    const out = [];
    for (const id of ids) {
      try { out.push(await this.cancelJob(id)); }
      catch (e) { out.push({ ok: false, error: String(e.message || e) }); }
    }
    return out;
  }

  get token() { return localStorage.getItem("eiaw.bridge.token") || ""; }
  set token(v) { localStorage.setItem("eiaw.bridge.token", v || ""); }

  start() {
    this._probe();
    this._timer = setInterval(() => this._probe(), PING_INTERVAL);

    /* 웹을 닫으면 브리지도 함께 끝난다 — 생애주기를 묶는다(사용자 지시).
       유휴 감시(90초)만으로도 결국 종료되지만 그 사이 트레이에 남아 있는 것이
       사용자에게는 "안 꺼진 것"으로 보인다. 닫히는 시점에 알려 곧바로 정리한다.

       `pagehide`를 쓰는 이유: `beforeunload`는 모바일·탭 복원에서 안 불리는
       경우가 있고, `unload`는 최신 브라우저가 무시한다.
       `sendBeacon`은 페이지가 사라지는 중에도 전송이 보장되는 유일한 수단이라
       일반 fetch로는 대체할 수 없다(헤더를 못 붙여 토큰은 본문으로 보낸다). */
    addEventListener("pagehide", () => {
      if (!this.base || !this.token) return;
      try { navigator.sendBeacon(`${this.base}/bye`, this.token); } catch (_) {}
    });
  }

  async _probe() {
    /* ── 연결된 뒤에는 **그 브리지 하나만** 확인한다 ──────────────────
       전에는 매번 6개 포트를 전부 두드렸는데, 브리지는 /ping을 받으면
       "쓰이고 있다"고 보고 유휴 타이머를 되돌린다. 결과적으로 **자동 종료가
       영원히 발동하지 않아** 실행할 때마다 인스턴스가 쌓였다(2026-07-21
       타 PC 실측: 4개 누적). 안 쓰는 브리지에 ping을 끊으면 90초 뒤 스스로
       종료한다 — 구버전 브리지에도 그대로 적용된다.
       더 최신 브리지가 떴을 때를 놓치지 않도록 가끔 전 포트를 다시 훑는다.
       재탐색 주기(5분)는 유휴 종료(90초)보다 길어야 중복이 살아나지 않는다. */
    this._probeCount = (this._probeCount || 0) + 1;
    const rescan = this.state !== "ok" || !this.base || this._probeCount % 20 === 0;

    if (!rescan) {
      try {
        const res = await this._fetch(`${this.base}/ping`, { timeoutMs: 1500 });
        if (res && res.ok) {
          const info = await res.json();
          if (info.features) { this.info = info; this._setState("ok"); return; }
        }
      } catch (_) { /* 끊겼으면 아래에서 다시 찾는다 */ }
    }

    // 우선순위: 연결 중 포트 → 페어링 힌트 포트 → 순차 탐색
    const hinted = localStorage.getItem("eiaw.bridge.port");
    const all = PORTS.map((p) => `http://127.0.0.1:${p}`);
    if (hinted) {
      const hb = `http://127.0.0.1:${hinted}`;
      if (!all.includes(hb)) all.unshift(hb);
      else all.sort((a, b) => (a === hb ? -1 : b === hb ? 1 : 0));
    }
    // 전 포트를 훑는다(첫 응답에서 멈추면 구버전을 잡는다)
    const candidates = all;

    /* 응답하는 브리지를 **전부** 모아 가장 최신 버전을 고른다.
       구버전 창을 닫지 않은 채 새 브리지를 띄우면 새 것이 포트를 비켜 뜨고,
       웹이 먼저 응답한 구버전에 붙어 "unknown job type" 같은 오류가 난다
       (2026-07-20 실사고 — PoC 스텁 사건과 동형). 버전으로 판정해 자동 회피한다. */
    const found = [];
    let stubFound = false;
    for (const base of candidates) {
      try {
        const res = await this._fetch(`${base}/ping`, { timeoutMs: 1500 });
        if (res && res.ok) {
          const info = await res.json();
          if (!info.features) { stubFound = true; continue; }   // PoC 진단 스텁
          found.push({ base, info });
        }
      } catch (_) { /* 다음 포트 */ }
    }

    if (found.length) {
      const ver = (v) => String(v || "0").split(".").map((n) => parseInt(n, 10) || 0);
      const newer = (a, b) => {                       // a > b 이면 true
        const [x, y] = [ver(a), ver(b)];
        for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
        return false;
      };
      let best = found[0];
      for (const f of found.slice(1))
        if (newer(f.info.bridge_version, best.info.bridge_version)) best = f;

      const changed = this.state !== "ok" || this.base !== best.base;
      this.base = best.base;
      this.info = best.info;
      /* 같은 버전이 여러 개면 **중복 실행**이고, 낮은 버전이 섞여 있으면
         **구버전 잔존**이다. 둘은 원인도 조치도 다른데 예전에는 뭉뚱그려
         "구버전"이라 불러서, 같은 버전 4개가 떠 있는데도 구버전이라고
         표시됐다(2026-07-21 사용자 지적). */
      const others = found.filter((f) => f !== best);
      this.duplicates = others.map((f) => `${f.base} v${f.info.bridge_version}`);
      this.duplicateKind = others.length
        ? (others.every((f) => f.info.bridge_version === best.info.bridge_version)
            ? "same" : "older")
        : null;
      this._setState("ok", changed);
      return;
    }
    this.base = null;
    this.info = null;
    this.duplicates = [];
    this.duplicateKind = null;
    this._setState(stubFound ? "stub" : "off");
  }

  _setState(s, force = false) {
    if (this.state !== s || force) {
      this.state = s;
      this.dispatchEvent(new CustomEvent("change", { detail: { state: s, info: this.info } }));
    }
  }

  /** 브리지 API 호출 (토큰 자동 부착) */
  async call(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
    if (!this.base) throw new Error("브리지 미연결");
    const res = await this._fetch(`${this.base}${path}`, {
      method, timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "Authorization": `Bearer ${this.token}` } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new Error("토큰 불일치 — 브리지를 재시작하면 자동 재등록됩니다");
    if (res.status === 400) {
      let d = ""; try { d = (await res.json()).error || ""; } catch (_) {}
      if (/unknown job type/i.test(d))
        throw new Error(`이 브리지(v${this.info?.bridge_version ?? "?"})가 지원하지 않는 기능입니다 — `
          + `열려 있는 브리지 창을 모두 닫고 브리지 런처를 다시 실행하세요`);
      throw new Error(d || "브리지 요청 오류 (400)");
    }
    if (!res.ok) {
      // 서버가 보낸 실제 사유를 살린다 — "HTTP 500"만 보여주면 원인 추적이 불가능
      // (2026-07-20 실사고: 구버전 브리지의 명확한 오류 메시지가 숫자에 가려짐)
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_) {}
      throw new Error(detail || `브리지 오류 HTTP ${res.status}`);
    }
    return res.json();
  }

  /** 이미지 등 바이너리를 blob URL로 받는다 (썸네일·미리보기).
   *  `<img src>`로 브리지를 직접 부르면 토큰을 쿼리에 실어야 하고, 그러면
   *  토큰이 브라우저 이력에 남는다 — 다른 요청과 같이 헤더 인증을 유지한다.
   *  ※ 반환된 URL은 다 쓴 뒤 URL.revokeObjectURL로 해제해야 누수가 없다. */
  async blobUrl(path, { timeoutMs = 30000 } = {}) {
    if (!this.base) throw new Error("브리지 미연결");
    const res = await this._fetch(`${this.base}${path}`, {
      method: "GET", timeoutMs,
      headers: this.token ? { "Authorization": `Bearer ${this.token}` } : {},
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_) {}
      throw new Error(detail || `이미지를 불러오지 못했습니다 (HTTP ${res.status})`);
    }
    return URL.createObjectURL(await res.blob());
  }

  /** 장시간 작업 폴링 — 새 로그 라인·진행 상태를 콜백으로 전달, 종료 시 resolve.
   *  일시적 통신 오류는 재시도하되(OCR 등 수십 분 작업 중 한 번 끊겼다고 죽이지 않는다),
   *  연속 실패가 누적되면 중단한다. 브리지 재시작으로 작업 정보가 사라진 경우는 즉시 구분. */
  async pollJob(jobId, { onLog, onProgress, intervalMs = 1000, maxRetries = 15,
                         label = "" } = {}) {
    let logOffset = 0;
    let fails = 0;
    this.activeJobs.set(jobId, { label, since: Date.now() });
    this.dispatchEvent(new CustomEvent("busy", { detail: { busy: true, jobId } }));
    try {
      for (;;) {
        let j;
        try {
          j = await this.call(`/jobs/${jobId}?log_from=${logOffset}`, { timeoutMs: 15000 });
          fails = 0;
        } catch (e) {
          if (/HTTP 404|job not found/i.test(e.message))
            throw new Error("브리지가 재시작되어 작업 정보가 사라졌습니다 — 다시 실행해주세요");
          if (++fails > maxRetries)
            throw new Error(`브리지 응답 없음 (${fails}회 연속) — 브리지 창이 닫혔는지 확인하세요`);
          onLog?.(`⚠ 브리지 응답 지연 — 재시도 ${fails}/${maxRetries}`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        for (const line of j.log || []) { onLog?.(line); logOffset++; }
        onProgress?.(j.progress || null);
        if (j.status === "done") return j;   // j.result에 스캔 표 데이터가 실려온다
        /* 취소는 실패가 아니다 — 사용자가 멈춘 것이다. 빨간 오류로 던지면
           "한컴을 확인하세요" 같은 틀린 진단이 뜬다. 부른 쪽이 status로
           구분할 수 있게 그대로 돌려준다(SYS-76 W3). */
        if (j.status === "cancelled") return j;
        if (j.status === "error") throw new Error(j.error || "브리지 작업 실패");
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally {
      /* 성공·실패·취소 어느 쪽이든 반드시 지운다 — 여기서 새면 탭 전환이
         영구히 막힌다(있지도 않은 작업 때문에 경고창이 계속 뜬다). */
      this.activeJobs.delete(jobId);
      this.dispatchEvent(new CustomEvent("busy",
        { detail: { busy: this.busy, jobId } }));
    }
  }

  _fetch(url, { timeoutMs = 5000, ...opts } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { ...opts, cache: "no-store", signal: ctrl.signal };
    // Chrome 전용 옵션 — 미지원 브라우저는 무시됨. 'loopback'이 정답(실측 ⓓ).
    try { init.targetAddressSpace = "loopback"; } catch (_) {}
    return fetch(url, init).finally(() => clearTimeout(t));
  }
}

export const bridge = new BridgeClient();
