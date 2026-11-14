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
  /** 一句話說完後，依時間範圍（毫秒時間戳）決定是誰說的（整句聲紋判斷，非同步） */
  attribute: (startMs: number, endMs: number) => Promise<Attribution> = async () => ({ speaker: null, stranger: false, drop: false });
  /** 正在說的句子用的快速判斷（同步，給即時顯示） */
  liveAttribute: (startMs: number, endMs: number) => Attribution = () => ({ speaker: null, stranger: false, drop: false });
  onChange: () => void = () => {};
  onError: (msg: string) => void = () => {};

  private rec: SR | null = null;
  private running = false;
  private segStart = 0; // 目前這句話開始的時間
  private commitQueue: Promise<void> = Promise.resolve(); // 整句判斷是非同步的，用佇列維持字幕順序

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
    this.spawn();
  }

  stop() {
    this.running = false;
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
    rec.onresult = (e: any) => {
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
      if (this.running) setTimeout(() => this.running && this.spawn(), 250);
    };
    try {
      rec.start();
      this.rec = rec;
    } catch (e) {
      this.onError(`字幕無法啟動：${(e as Error).message}`);
    }
  }

  private commit(text: string) {
    const now = Date.now();
    // 沒抓到開始時間（辨識直接給最終結果）→ 用字數估計長度（中文大約每秒 4 個字）
    const start = this.segStart || now - Math.max(1000, text.length * 250);
    this.segStart = 0;
    // 說話到出現字幕大約有 0.5 秒延遲，開始時間往前推一點
    const pending = this.attribute(start - 500, now).catch(() => this.liveAttribute(start - 500, now));
    this.commitQueue = this.commitQueue.then(async () => {
      const a = await pending;
      if (a.drop) return; // 陌生人：直接濾掉
      const last = this.lines[this.lines.length - 1];
      // 同一個人連續講，合併成同一行（太長才換行）
      if (last && last.speaker === a.speaker && last.stranger === a.stranger && last.text.length + text.length < 40)
        last.text += '，' + text;
      else this.lines.push({ speaker: a.speaker, stranger: a.stranger, text });
      if (this.lines.length > 200) this.lines.shift();
      this.onChange();
    });
  }
}
