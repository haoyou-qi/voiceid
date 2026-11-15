// 電腦運算：把麥克風聲音即時傳到自己電腦上的 VoiceID 服務（server/voiceid_server.py），字幕由電腦辨識後傳回。
// 跟本機辨識（StreamingAsr）用同樣的介面：push / reset / flush / onPartial / onFinal，主程式可以隨時切換。
// 斷線時 main.ts 會自動改回手機本機辨識。

export type RemoteState = 'off' | 'connecting' | 'ready' | 'error';

const URL_KEY = 'voiceid.remote.url.v1';
const KEY_KEY = 'voiceid.remote.key.v1';
const MODE_KEY = 'voiceid.compute.v1';
export type ComputeMode = 'auto' | 'pc' | 'phone';

export const remoteSettings = {
  get url() { try { return localStorage.getItem(URL_KEY) || ''; } catch { return ''; } },
  set url(v: string) { try { localStorage.setItem(URL_KEY, v); } catch { /* 略過 */ } },
  get key() { try { return localStorage.getItem(KEY_KEY) || ''; } catch { return ''; } },
  set key(v: string) { try { localStorage.setItem(KEY_KEY, v); } catch { /* 略過 */ } },
  get mode(): ComputeMode {
    try { const m = localStorage.getItem(MODE_KEY); return m === 'pc' || m === 'phone' ? m : 'auto'; } catch { return 'auto'; }
  },
  set mode(v: ComputeMode) { try { localStorage.setItem(MODE_KEY, v); } catch { /* 略過 */ } },
};

/** 使用者貼上的網址 → wss://…/ws（接受 https://xxx、xxx.ts.net、ws://localhost:8765 等寫法） */
export function wsUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return '';
  if (!/^[a-z]+:\/\//i.test(u)) u = (/^(localhost|127\.)/.test(u) ? 'ws://' : 'wss://') + u;
  u = u.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return u.replace(/\/+$/, '') + (/\/ws$/.test(u) ? '' : '/ws');
}

export class RemoteAsr {
  onPartial: (text: string) => void = () => {};
  /** 一句話結束；startMs / endMs 是這句話在手機時鐘上的時間（給聲紋判斷說話者用） */
  onFinal: (text: string, startMs: number, endMs: number) => void = () => {};
  onLag: (sec: number) => void = () => {};
  onState: (s: RemoteState, msg: string) => void = () => {};
  state: RemoteState = 'off';
  info = { sensevoice: false, denoise: false, rttMs: 0 };

  private ws: WebSocket | null = null;
  private sent = 0; // 已送出的樣本數
  private marks: { n: number; t: number }[] = []; // 樣本數 ↔ 手機時間（換算字幕時間用）
  private pingTimer: number | null = null;
  private lastPong = 0;
  private wanted = false;
  private retryTimer: number | null = null;
  private opts = { model: 'zhen', denoise: 'auto' as 'auto' | 'on' | 'off' };

  get ready() { return this.state === 'ready'; }

  /** 連線（失敗會每 10 秒自動重試，直到 disconnect） */
  connect(url: string, key: string, model: string, denoise: 'auto' | 'on' | 'off') {
    this.opts = { model, denoise };
    this.wanted = true;
    this.open(url, key);
  }

  disconnect() {
    this.wanted = false;
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.cleanup();
    this.setState('off', '');
  }

  private setState(s: RemoteState, msg: string) {
    this.state = s;
    this.onState(s, msg);
  }

  private cleanup() {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch { /* 已關閉 */ } }
  }

  private retry(url: string, key: string) {
    if (!this.wanted || this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => { this.retryTimer = null; if (this.wanted) this.open(url, key); }, 10_000);
  }

  private open(url: string, key: string) {
    this.cleanup();
    const u = wsUrl(url);
    if (!u || !key) { this.setState('error', '還沒填電腦網址或通行金鑰'); return; }
    this.setState('connecting', '連線到電腦中…');
    let ws: WebSocket;
    try { ws = new WebSocket(u); } catch { this.setState('error', '電腦網址格式不正確'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const timeout = window.setTimeout(() => { if (this.state === 'connecting') { this.cleanup(); this.setState('error', '連不到電腦（電腦沒開或網址錯誤），改用手機運算'); this.retry(url, key); } }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', key, model: this.opts.model, denoise: this.opts.denoise }));
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'ready') {
        clearTimeout(timeout);
        this.info.sensevoice = !!m.sensevoice;
        this.info.denoise = !!m.denoise;
        this.lastPong = Date.now();
        this.pingTimer = window.setInterval(() => this.ping(url, key), 5000);
        this.setState('ready', '已連上電腦');
      } else if (m.type === 'partial') this.onPartial(m.text);
      else if (m.type === 'final') this.onFinal(m.text, this.toMs(m.start), this.toMs(m.end));
      else if (m.type === 'lag') this.onLag(m.sec);
      else if (m.type === 'pong') { this.lastPong = Date.now(); if (m.t) this.info.rttMs = Date.now() - m.t; }
      else if (m.type === 'error') {
        clearTimeout(timeout);
        this.cleanup();
        this.setState('error', m.code === 'key' ? '通行金鑰不正確（請確認電腦上顯示的金鑰）' : m.message || '電腦回報錯誤');
        if (m.code !== 'key') this.retry(url, key);
        else this.wanted = false;
      }
    };
    const lost = () => {
      clearTimeout(timeout);
      if (this.ws !== ws) return;
      this.cleanup();
      this.setState('error', '和電腦的連線中斷，改用手機運算（10 秒後自動重連）');
      this.retry(url, key);
    };
    ws.onclose = lost;
    ws.onerror = lost;
  }

  private ping(url: string, key: string) {
    if (!this.ws) return;
    if (Date.now() - this.lastPong > 15_000) { // 15 秒沒回應：當作斷線
      this.cleanup();
      this.setState('error', '電腦沒有回應，改用手機運算（10 秒後自動重連）');
      this.retry(url, key);
      return;
    }
    try { this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch { /* 下次再試 */ }
  }

  /** 樣本編號 → 手機時間（毫秒） */
  private toMs(n: number): number {
    const m = this.marks;
    if (!m.length) return Date.now();
    for (let i = m.length - 1; i >= 0; i--) if (m[i].n <= n) return m[i].t + ((n - m[i].n) / 16000) * 1000;
    return m[0].t - ((m[0].n - n) / 16000) * 1000;
  }

  /** 餵 16kHz 音訊 */
  push(f: Float32Array) {
    if (!this.ws || this.state !== 'ready' || this.ws.readyState !== 1) return;
    const b = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) b[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
    // 送出的這一塊「最後一個樣本」大約就是現在
    this.marks.push({ n: this.sent, t: Date.now() - (f.length / 16000) * 1000 });
    if (this.marks.length > 600) this.marks.splice(0, this.marks.length - 600);
    this.sent += f.length;
    if (this.ws.bufferedAmount > 16000 * 2 * 5) return; // 網路太慢塞了超過 5 秒：先丟掉，避免越來越延遲
    this.ws.send(b.buffer);
  }

  /** 告訴電腦現在的環境（自動降噪用：有音樂、車聲才降噪） */
  scene(s: string[]) {
    if (this.ready) try { this.ws!.send(JSON.stringify({ type: 'scene', scene: s })); } catch { /* 略過 */ }
  }

  reset() {
    if (this.ready) try { this.ws!.send(JSON.stringify({ type: 'reset' })); } catch { /* 略過 */ }
  }

  flush() {
    if (this.ready) try { this.ws!.send(JSON.stringify({ type: 'flush' })); } catch { /* 略過 */ }
  }
}
