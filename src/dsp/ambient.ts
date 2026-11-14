// 環境聲音偵測：吵雜程度、聲音種類（音樂 / 人聲吵雜 / 有人說話 / 車聲）、說話音量建議、警報提醒
// 聲音種類用 CED-tiny（AudioSet 527 類）在本機推論；模型沒載入時只提供吵雜程度。

import { melDb, N_MELS_CED } from './melspec';
import { getOrt, runExclusive } from './ort';

export const CED_URL = './models/ced_tiny.onnx';
const SR = 16000;

export type TagFn = (audio: Float32Array) => Promise<Float32Array>; // 527 類機率

export async function loadCedTagger(url = CED_URL): Promise<TagFn> {
  const ort = getOrt();
  const session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];
  return (audio) =>
    runExclusive(async () => {
      const m = melDb(audio);
      const out = await session.run({ [inName]: new ort.Tensor('float32', m.data, [1, N_MELS_CED, m.frames]) });
      return out[outName].data as Float32Array;
    });
}

// AudioSet 類別編號（class_labels_indices.csv）
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const GROUPS = {
  speech: [0, 1, 2, 3, 4, 5], // 說話、男聲、女聲、小孩、對話、旁白
  crowd: [66, 67, 68, 69, 70], // 歡呼、鼓掌、閒聊、人群、嘈雜人聲
  music: range(137, 282), // 音樂與各種樂器、曲風
  traffic: range(300, 344), // 交通工具、引擎
};
const ALERTS: { label: string; ids: number[] }[] = [
  { label: '警笛聲', ids: [322, 323, 324, 325, 396, 397] },
  { label: '喇叭聲', ids: [308, 318, 330, 331, 401] },
  { label: '警報聲', ids: [310, 388, 395, 399, 400] },
  { label: '門鈴／電話', ids: [355, 389, 390, 391] },
  { label: '哭聲', ids: [22, 23] },
  { label: '尖叫聲', ids: [14] },
  { label: '巨響', ids: [426, 427] },
];

const LEVELS = [
  { label: '安靜', advice: '小聲說即可', short: '小聲即可' },
  { label: '普通', advice: '正常音量說話', short: '正常音量' },
  { label: '吵', advice: '請大聲一點', short: '請大聲' },
  { label: '很吵', advice: '請大聲說、靠近對方', short: '大聲+靠近' },
];
// 音量分級：用「估計分貝」（dB SPL）表示。
// 一般手機麥克風 94 dB SPL ≈ -26 dBFS，所以 分貝 ≈ dBFS + 120（實際依麥克風而異，可用校正 / 靈敏度調整）
const SPL_OFFSET = 120;
const LEVEL_EDGES = [45, 58, 68]; // 安靜 < 45 ≤ 普通 < 58 ≤ 吵 < 68 ≤ 很吵
/** 校正時「普通」對應的分貝 */
const CALIB_TARGET = 52;

export interface AmbientState {
  floorDb: number; // 環境音量（估計分貝，已含校正與靈敏度）
  level: number; // 0 安靜 ~ 3 很吵
  levelLabel: string;
  scene: string[]; // 例如 ['人聲吵雜', '有音樂']
  advice: string;
  short: string; // 眼鏡用的短建議
  probs: Record<'speech' | 'crowd' | 'music' | 'traffic', number> | null;
  fluct: number; // 音量起伏（dB）：一人說話通常 > 14，多人重疊 < 11
  alert: string | null; // 目前的警報（顯示 5 秒）
  tagged: boolean; // 有沒有用到聲音分類模型
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};

export class AmbientMonitor {
  calibOffset = 0; // 校正值（dB）
  sensitivity = 0; // 靈敏度（dB）：正值 = 更容易判成吵
  onUpdate: (s: AmbientState) => void = () => {};
  onAlert: (label: string) => void = () => {};

  private buf = new Float32Array(3 * SR); // 最近 3 秒
  private filled = 0;
  private sinceUpdate = 0;
  private busy = false;
  private smooth: Record<string, number> = {};
  private alertUntil = 0;
  private alertLabel: string | null = null;
  private alertHits = new Map<string, number>();
  private lastAlertAt = new Map<string, number>();
  /** 取得現在時間（毫秒）；測試時可換成模擬時鐘 */
  now: () => number = () => Date.now();

  constructor(public tagger: TagFn | null) {}

  reset() {
    this.buf.fill(0);
    this.filled = 0;
    this.sinceUpdate = 0;
    this.smooth = {};
    this.alertHits.clear();
  }

  push(samples: Float32Array) {
    const n = samples.length;
    if (n >= this.buf.length) this.buf.set(samples.subarray(n - this.buf.length));
    else {
      this.buf.copyWithin(0, n);
      this.buf.set(samples, this.buf.length - n);
    }
    this.filled = Math.min(this.buf.length, this.filled + n);
    this.sinceUpdate += n;
    if (this.sinceUpdate >= SR && this.filled >= SR) {
      this.sinceUpdate = 0;
      void this.update();
    }
  }

  /** 校正：把現在的背景音量當作「普通」 */
  calibrate(): number {
    const raw = this.rawFloor() + SPL_OFFSET + this.sensitivity;
    this.calibOffset = CALIB_TARGET - raw;
    return this.calibOffset;
  }

  private frameDb(): number[] {
    // 10ms 一格的音量（dB）
    const x = this.buf.subarray(this.buf.length - this.filled);
    const out: number[] = [];
    for (let i = 0; i + 160 <= x.length; i += 160) {
      let e = 1e-10;
      for (let j = 0; j < 160; j++) e += x[i + j] * x[i + j];
      out.push(10 * Math.log10(e / 160));
    }
    return out;
  }

  private rawFloor(): number {
    const db = this.frameDb();
    // 環境音量：取 30% 分位數。說話聲、音樂、人聲會反映進來，但偶爾一聲大響不會讓它跳到「很吵」
    return db.length ? pct(db, 0.3) : -90;
  }

  private async update() {
    if (this.busy) return;
    this.busy = true;
    try {
      const db = this.frameDb();
      const valid = db.filter((v) => v > Math.max(...db) - 50); // 忽略數位靜音
      const fluct = valid.length > 20 ? pct(valid, 0.9) - pct(valid, 0.2) : 0;
      const floorDb = this.rawFloor() + SPL_OFFSET + this.calibOffset + this.sensitivity;
      let level = LEVEL_EDGES.findIndex((e) => floorDb < e);
      if (level < 0) level = 3;

      let probs: AmbientState['probs'] = null;
      if (this.tagger) {
        const audio = this.buf.slice(this.buf.length - 2 * SR); // 最近 2 秒
        const p = await this.tagger(audio);
        const raw = {} as Record<'speech' | 'crowd' | 'music' | 'traffic', number>;
        for (const [k, ids] of Object.entries(GROUPS)) raw[k as keyof typeof raw] = Math.max(...ids.map((i) => p[i]));
        // 平滑：避免標籤一直閃
        for (const k of Object.keys(raw) as (keyof typeof raw)[])
          this.smooth[k] = this.smooth[k] === undefined ? raw[k] : 0.5 * this.smooth[k] + 0.5 * raw[k];
        probs = { speech: this.smooth.speech, crowd: this.smooth.crowd, music: this.smooth.music, traffic: this.smooth.traffic };
        this.checkAlerts(p);
      }

      const scene: string[] = [];
      if (probs) {
        // 人聲吵雜：模型判斷有人群，或「有人聲但音量起伏很小」（多人聲音重疊、或很吵的地方）
        const crowd = probs.crowd >= 0.3 || (probs.speech >= 0.5 && fluct > 0 && fluct < 11 && probs.music < 0.3 && probs.traffic < 0.3);
        if (crowd) scene.push('人聲吵雜');
        else if (probs.speech >= 0.5) scene.push('有人說話');
        if (probs.music >= 0.3) scene.push('有音樂');
        if (probs.traffic >= 0.4) scene.push('車聲／機器聲');
      }
      const L = LEVELS[level];
      let advice = L.advice;
      let short = L.short;
      if (scene.includes('人聲吵雜') && level >= 1) {
        advice = '人聲吵雜：請靠近對方、大聲一點';
        short = '靠近+大聲';
      }
      const now = this.now();
      this.onUpdate({
        floorDb, level, levelLabel: L.label, scene, advice, short, probs, fluct,
        alert: now < this.alertUntil ? this.alertLabel : null,
        tagged: !!this.tagger,
      });
    } finally {
      this.busy = false;
    }
  }

  /** 警報：機率 ≥ 0.5 一次，或 ≥ 0.3 連續兩次；同一種警報 15 秒內不重複提醒 */
  private checkAlerts(p: Float32Array) {
    const now = this.now();
    for (const a of ALERTS) {
      const v = Math.max(...a.ids.map((i) => p[i]));
      const hits = v >= 0.3 ? (this.alertHits.get(a.label) ?? 0) + 1 : 0;
      this.alertHits.set(a.label, hits);
      if (v >= 0.5 || hits >= 2) {
        if (now - (this.lastAlertAt.get(a.label) ?? 0) > 15_000) this.onAlert(a.label);
        this.lastAlertAt.set(a.label, now);
        this.alertLabel = a.label;
        this.alertUntil = now + 5000;
      }
    }
  }
}
