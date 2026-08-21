






const PORTS = [8765, 8766, 8767, 8768, 8769, 8770];
const PING_INTERVAL = 15000;

export class BridgeClient extends EventTarget {
  constructor() {
    super();
    this.base = null;
    this.info = null;
    this.state = "checking";
    this._timer = null;




    this.activeJobs = new Map();
  }


  get busy() { return this.activeJobs.size > 0; }


  async cancelJob(jobId) {
    return this.call(`/jobs/${jobId}/cancel`, { method: "POST", timeoutMs: 25000 });
  }


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









    addEventListener("pagehide", () => {
      if (!this.base || !this.token) return;
      try { navigator.sendBeacon(`${this.base}/bye`, this.token); } catch (_) {}
    });
  }

  async _probe() {








    this._probeCount = (this._probeCount || 0) + 1;
    const rescan = this.state !== "ok" || !this.base || this._probeCount % 20 === 0;

    if (!rescan) {
      try {
        const res = await this._fetch(`${this.base}/ping`, { timeoutMs: 1500 });
        if (res && res.ok) {
          const info = await res.json();
          if (info.features) { this.info = info; this._setState("ok"); return; }
        }
      } catch (_) {  }
    }


    const hinted = localStorage.getItem("eiaw.bridge.port");
    const all = PORTS.map((p) => `http://127.0.0.1:${p}`);
    if (hinted) {
      const hb = `http://127.0.0.1:${hinted}`;
      if (!all.includes(hb)) all.unshift(hb);
      else all.sort((a, b) => (a === hb ? -1 : b === hb ? 1 : 0));
    }

    const candidates = all;













    const probes = await Promise.all(candidates.map(async (base) => {
      try {
        const res = await this._fetch(`${base}/ping`, { timeoutMs: 1500 });
        if (res && res.ok) {
          const info = await res.json();
          if (!info.features) return { stub: true };
          return { base, info };
        }
      } catch (_) {  }
      return null;
    }));


    const found = probes.filter((r) => r && r.base);
    const stubFound = probes.some((r) => r && r.stub);

    if (found.length) {
      const ver = (v) => String(v || "0").split(".").map((n) => parseInt(n, 10) || 0);
      const newer = (a, b) => {
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


      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_) {}
      throw new Error(detail || `브리지 오류 HTTP ${res.status}`);
    }
    return res.json();
  }





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
        if (j.status === "done") return j;



        if (j.status === "cancelled") return j;
        if (j.status === "error") throw new Error(j.error || "브리지 작업 실패");
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally {


      this.activeJobs.delete(jobId);
      this.dispatchEvent(new CustomEvent("busy",
        { detail: { busy: this.busy, jobId } }));
    }
  }

  _fetch(url, { timeoutMs = 5000, ...opts } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { ...opts, cache: "no-store", signal: ctrl.signal };

    try { init.targetAddressSpace = "loopback"; } catch (_) {}
    return fetch(url, init).finally(() => clearTimeout(t));
  }
}

export const bridge = new BridgeClient();
