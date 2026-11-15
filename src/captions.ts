// 即時字幕：用 Chrome / Edge 內建的語音辨識（Web Speech API）
// 注意：語音會送到瀏覽器廠商（Google / Microsoft）的伺服器辨識，需要網路。
// 它固定使用瀏覽器設定裡的「預設麥克風」，沒辦法吃分頁音訊。

/* eslint-disable @typescript-eslint/no-explicit-any */
type SR = any;

export interface CaptionLine {
  speaker: string | null; // null = 不確定是誰
  stranger: boolean; // 判定為陌生人（關掉過濾時才會出現在字幕裡）
  text: string;
}

/** 一句話的歸屬：說話者、是否陌生人、要不要濾掉 */
export interface Attribution {
  speaker: string | null;
  stranger: boolean;
  drop: boolean;
}

export class Captions {
  lines: CaptionLine[] = []; // 已確定的句子
  interim = ''; // 正在說、還沒確定的句子
  lang = 'zh-TW';
  /** web = 瀏覽器內建語音辨識；local = 本機模型（由外部餵 localPartial / localFinal） */
  mode: 'web' | 'local' = 'web';
  /** 一句話說完後，依時間範圍（毫秒時間戳）決定是誰說的（整句聲紋判斷，非同步） */
  attribute: (startMs: number, endMs: number) => Promise<Attribution> = async () => ({ speaker: null, stranger: false, drop: false });
  /** 正在說的句子用的快速判斷（同步，給即時顯示） */
  liveAttribute: (startMs: number, endMs: number) => Attribution = () => ({ speaker: null, stranger: false, drop: false });
  onChange: () => void = () => {};
  onError: (msg: string) => void = () => {};
  /** 字幕目前狀態（給畫面顯示，方便判斷問題出在哪） */
  onStatus: (msg: string) => void = () => {};
  private gotResult = false;
  private ends: number[] = []; // 最近幾次自動結束的時間

  private rec: SR | null = null;
  private running = false;
  private segStart = 0; // 目前這句話開始的時間
  private commitQueue: Promise<void> = Promise.resolve(); // 整句判斷是非同步的，用佇列維持字幕順序

  /** 本機辨識：正在說的句子更新 */
  localPartial(text: string) {
    if (!this.running) return;
    if (!this.segStart) this.segStart = Date.now() - 800; // 辨識出第一個字時，人大約已經說了快 1 秒
    if (!this.gotResult) { this.gotResult = true; this.onStatus('字幕狀態：本機辨識聆聽中（不需網路）'); }
    this.interim = text;
    this.onChange();
  }

  /** 本機辨識：一句話結束 */
  localFinal(text: string) {
    if (!this.running && !text) return;
    this.interim = '';
    if (text) this.commit(text);
    this.onChange();
  }

  /** 電腦運算：一句話結束（電腦提供這句話的開始 / 結束時間，聲紋判斷更準） */
  remoteFinal(text: string, startMs: number, endMs: number, id?: number) {
    if (!this.running && !text) return;
    this.interim = '';
    this.segStart = 0;
    if (text) this.commit(text, startMs, endMs, id);
    this.onChange();
  }

  /** 電腦運算：先出現的快速字幕，被較準的整句辨識結果取代 */
  revise(id: number, text: string) {
    const line = this.byId.get(id);
    if (line) { line.text = text; this.onChange(); }
    else this.pendingRevise.set(id, text); // 這句還在判斷說話者，等加進字幕時再換
  }
  private byId = new Map<number, { text: string }>();
  private pendingRevise = new Map<number, string>();

  /** 正在說的這句話目前的歸屬（給畫面顯示用） */
  interimAttribution(): Attribution {
    return this.liveAttribute(this.segStart || Date.now(), Date.now());
  }

  static supported(): boolean {
    return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start() {
    if (!Captions.supported()) {
      this.onError('這個瀏覽器不支援即時字幕，請改用 Chrome 或 Edge');
      return;
    }
    this.running = true;
    this.gotResult = false;
    this.ends = [];
    this.onError('');
    if (this.mode === 'local') {
      this.onStatus('字幕狀態：本機辨識聆聽中（不需網路）');
      return;
    }
    this.onStatus('字幕狀態：啟動中…');
    this.spawn();
  }

  stop() {
    this.running = false;
    this.onStatus('字幕狀態：已停止');
    try { this.rec?.stop(); } catch { /* 已停止 */ }
    this.rec = null;
    if (this.interim) this.commit(this.interim);
    this.interim = '';
    this.onChange();
  }

  clear() {
    this.lines = [];
    this.interim = '';
    this.segStart = 0;
    this.onChange();
  }

  private spawn() {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec: SR = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => this.onStatus(this.gotResult ? '字幕狀態：聆聽中' : '字幕狀態：聆聽中（請說話，還沒收到任何文字）');
    rec.onresult = (e: any) => {
      if (!this.gotResult) { this.gotResult = true; this.onStatus('字幕狀態：聆聽中'); }
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = String(r[0].transcript || '').trim();
        if (!t) continue;
        if (r.isFinal) this.commit(t);
        else interim += t;
      }
      if (interim && !this.interim && !this.segStart) this.segStart = Date.now();
      this.interim = interim;
      this.onChange();
    };
    rec.onerror = (e: any) => {
      const err = e.error as string;
      if (err === 'no-speech' || err === 'aborted') return; // 一陣子沒人講話，屬正常
      const msg: Record<string, string> = {
        'not-allowed': '麥克風權限被拒絕，請在網址列左邊把麥克風改成「允許」',
        'service-not-allowed': '瀏覽器不允許語音辨識服務',
        network: '語音辨識需要網路，請確認已連上網路',
        'audio-capture': '字幕抓不到麥克風：請到瀏覽器設定確認預設麥克風',
        'language-not-supported': `不支援這個語言：${this.lang}`,
      };
      this.onError(msg[err] ?? `字幕發生錯誤：${err}`);
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'language-not-supported') this.running = false;
    };
    // Chrome 講完一段或安靜太久會自己停，聆聽中就自動重開
    rec.onend = () => {
      // 一直被系統中斷又沒有任何文字 → 多半是 iPhone 不讓兩個功能同時用麥克風
      const now = Date.now();
      this.ends = this.ends.filter((t) => now - t < 15_000).concat(now);
      if (this.running && !this.gotResult && this.ends.length >= 5) {
        this.onError('字幕一直被系統中斷、收不到文字：這支手機可能不允許「字幕」和「聲紋 / 環境偵測」同時使用麥克風');
        this.onStatus('字幕狀態：被系統中斷（已重試 5 次）');
        this.running = false;
        return;
      }
      if (this.running) setTimeout(() => this.running && this.spawn(), 250);
    };
    try {
      rec.start();
      this.rec = rec;
    } catch (e) {
      this.onError(`字幕無法啟動：${(e as Error).message}`);
      this.onStatus('字幕狀態：無法啟動');
    }
  }

  commit(text: string, startMs?: number, endMs?: number, id?: number) {
    const now = endMs ?? Date.now();
    // 沒抓到開始時間（辨識直接給最終結果）→ 用字數估計長度（中文大約每秒 4 個字）
    // 說話到出現字幕大約有 0.5 秒延遲，開始時間往前推一點
    const start = startMs ?? (this.segStart || now - Math.max(1000, text.length * 250)) - 500;
    this.segStart = 0;
    const pending = this.attribute(start, now).catch(() => this.liveAttribute(start, now));
    this.commitQueue = this.commitQueue.then(async () => {
      const a = await pending;
      if (a.drop) return; // 陌生人：直接濾掉
      // 每次停頓都是新的一行（不再把同一個人連續說的話併成一行）
      const finalText = (id !== undefined && this.pendingRevise.get(id)) || text;
      const line = { speaker: a.speaker, stranger: a.stranger, text: finalText };
      this.lines.push(line);
      if (id !== undefined) {
        this.pendingRevise.delete(id);
        this.byId.set(id, line);
        if (this.byId.size > 50) this.byId.delete(this.byId.keys().next().value as number);
      }
      if (this.lines.length > 200) this.lines.shift();
      this.onChange();
    });
  }
}
