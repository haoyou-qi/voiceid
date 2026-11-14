// 即時辨識引擎：接 100ms 音訊 → 保留最近 1.5 秒 → 每 0.5 秒判斷一次是誰在說話
// 辨識方法（CAM++ 或 GMM）由 Backend 提供，引擎只負責緩衝、靜音過濾、平滑。

import { pcm16ToFloat, voicedAudio } from './features';
import type { Backend, IdResult, Profile, Source } from './types';

export interface EngineSettings {
  windowSec: number; // 每次判斷看最近幾秒
  stepSec: number; // 多久判斷一次
  minVoicedSec: number; // 視窗內至少要有多少秒人聲才判斷
  threshold: number; // 陌生人門檻（意義依引擎而定）
  margin: number; // 第一、二名最小差距
}

export type EngineMode = 'idle' | 'listening' | 'enrolling';
const SR = 16000;

export class VoiceIdEngine {
  settings: EngineSettings;
  profiles: Profile[] = [];
  mode: EngineMode = 'idle';

  private win = new Float32Array(0);
  private sinceLast = 0;
  private busy = false;
  private enrollChunks: Float32Array[] = [];
  private enrollLen = 0;
  private lastName: string | null = null;
  /** 最近 20 秒的音訊（含收到的時間），給字幕整句辨識用 */
  private recent: { t: number; x: Float32Array }[] = [];
  /** 取得現在時間（毫秒）；測試時可換成模擬時鐘 */
  now: () => number = () => Date.now();
  private pending: { name: string | null; count: number } = { name: null, count: 0 };

  /** 判斷結果（已做平滑：同一人連續 2 次才切換） */
  onResult: (r: IdResult & { stable: string | null; changed: boolean }) => void = () => {};
  /** 音量（0~1），給畫面顯示用 */
  onLevel: (level: number) => void = () => {};
  onError: (e: Error) => void = (e) => console.warn(e);

  constructor(public backend: Backend) {
    this.settings = { windowSec: 2, stepSec: 0.5, minVoicedSec: 0.6, ...backend.defaults };
  }

  /** 目前引擎能用的聲紋檔（另一種引擎建的檔不能混用） */
  usable(): Profile[] {
    return this.profiles.filter((p) => p.kind === this.backend.kind);
  }

  startListening() {
    this.mode = 'listening';
    this.reset();
  }

  startEnrolling() {
    this.mode = 'enrolling';
    this.reset();
    this.enrollChunks = [];
    this.enrollLen = 0;
  }

  stop() {
    this.mode = 'idle';
  }

  enrolledSeconds(): number {
    return this.enrollLen / SR;
  }

  /** 結束建檔：去掉靜音後交給引擎算聲紋 */
  async finishEnrolling(name: string, source: Source): Promise<Profile> {
    this.mode = 'idle';
    const all = new Float32Array(this.enrollLen);
    let p = 0;
    for (const c of this.enrollChunks) { all.set(c, p); p += c.length; }
    this.enrollChunks = [];
    const voiced = voicedAudio(all);
    if (voiced.length < 3 * SR) throw new Error(`有效語音太少（${(voiced.length / SR).toFixed(1)} 秒），請至少講 3 秒以上`);
    const profile = await this.backend.enroll(name, source, voiced);
    this.profiles = this.profiles.filter((x) => x.name !== name || x.kind !== profile.kind).concat(profile);
    return profile;
  }

  /** 餵 SDK 給的 PCM（Uint8Array, 16-bit LE） */
  pushPcm16(bytes: Uint8Array) {
    this.pushFloat(pcm16ToFloat(bytes));
  }

  pushFloat(samples: Float32Array) {
    if (this.mode === 'idle') return;
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    this.onLevel(Math.min(1, peak * 3));

    if (this.mode === 'enrolling') {
      this.enrollChunks.push(samples.slice());
      this.enrollLen += samples.length;
      return;
    }
    // listening：存一份到最近 20 秒的緩衝
    const t = this.now();
    this.recent.push({ t, x: samples.slice() });
    while (this.recent.length && this.recent[0].t < t - 20_000) this.recent.shift();
    // 只保留最近 windowSec 秒做即時判斷
    const max = Math.round(this.settings.windowSec * SR);
    const merged = new Float32Array(Math.min(max, this.win.length + samples.length));
    const keepOld = merged.length - samples.length;
    if (keepOld > 0) merged.set(this.win.subarray(this.win.length - keepOld), 0);
    merged.set(samples.subarray(Math.max(0, samples.length - merged.length)), Math.max(0, keepOld));
    this.win = merged;
    this.sinceLast += samples.length / SR;
    if (this.sinceLast >= this.settings.stepSec) {
      this.sinceLast = 0;
      void this.evaluate();
    }
  }

  private async evaluate() {
    if (this.busy || !this.usable().length) return; // 上一次還沒算完就跳過，不堆積
    const voiced = voicedAudio(this.win);
    if (voiced.length < this.settings.minVoicedSec * SR) {
      // 沒人講話：不改變目前顯示，只回報「安靜」
      this.onResult({ name: null, best: null, scores: [], conf: 0, stranger: false, stable: this.lastName, changed: false });
      return;
    }
    this.busy = true;
    try {
      const r = await this.backend.identify(this.usable(), voiced, this.settings);
      if (this.mode !== 'listening') return;
      // 平滑：同樣結果連續出現 2 次才切換，避免名字跳來跳去
      if (r.name === this.pending.name) this.pending.count++;
      else this.pending = { name: r.name, count: 1 };
      let changed = false;
      if (this.pending.count >= 2 && this.pending.name !== this.lastName) {
        this.lastName = this.pending.name;
        changed = true;
      }
      this.onResult({ ...r, stable: this.lastName, changed });
    } catch (e) {
      this.onError(e as Error);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 整句辨識：拿 [startMs, endMs] 這段時間收到的音訊，一次算出聲紋。
   * 比 2 秒小段投票可靠很多（句子越長越準）。人聲不到 minSec 秒時回傳 null。
   */
  async identifyRange(startMs: number, endMs: number, minSec = 0.8): Promise<IdResult | null> {
    if (!this.usable().length) return null;
    const parts = this.recent.filter((c) => c.t >= startMs && c.t <= endMs + 100).map((c) => c.x);
    const all = new Float32Array(parts.reduce((s, x) => s + x.length, 0));
    let p = 0;
    for (const x of parts) { all.set(x, p); p += x.length; }
    const voiced = voicedAudio(all);
    if (voiced.length < minSec * SR) return null;
    return this.backend.identify(this.usable(), voiced, this.settings);
  }

  private reset() {
    this.recent = [];
    this.win = new Float32Array(0);
    this.sinceLast = 0;
    this.busy = false;
    this.lastName = null;
    this.pending = { name: null, count: 0 };
  }
}
