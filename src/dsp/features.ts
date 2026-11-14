// 聲紋特徵擷取：16kHz PCM → MFCC(+delta)
// 純 TypeScript、零相依，手機 WebView / 瀏覽器 / Node 都能跑。

export const SAMPLE_RATE = 16000;
const FRAME_LEN = 400; // 25ms
const HOP = 160; // 10ms
const NFFT = 512;
const N_MEL = 40;
const N_CEP = 13; // 取 c1..c12（丟掉 c0 能量項，避免音量影響辨識）

export const FEATURE_DIM = (N_CEP - 1) * 2; // MFCC + delta = 24 維

// ---------- 預先計算的表 ----------
const hamming = new Float32Array(FRAME_LEN);
for (let i = 0; i < FRAME_LEN; i++) hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

// Mel 濾波器組（80Hz–7600Hz，涵蓋人聲）
const melFilters: Float32Array[] = (() => {
  const lo = hz2mel(80), hi = hz2mel(7600);
  const pts = Array.from({ length: N_MEL + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (N_MEL + 1)));
  const bins = pts.map((f) => Math.floor(((NFFT + 1) * f) / SAMPLE_RATE));
  const out: Float32Array[] = [];
  for (let m = 1; m <= N_MEL; m++) {
    const f = new Float32Array(NFFT / 2 + 1);
    for (let k = bins[m - 1]; k < bins[m]; k++) f[k] = (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]);
    for (let k = bins[m]; k < bins[m + 1]; k++) f[k] = (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]);
    out.push(f);
  }
  return out;
})();

// DCT-II 矩陣
const dct: Float32Array[] = Array.from({ length: N_CEP }, (_, c) => {
  const row = new Float32Array(N_MEL);
  for (let m = 0; m < N_MEL; m++) row[m] = Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
  return row;
});

// ---------- FFT（radix-2，就地運算） ----------
const re = new Float32Array(NFFT);
const im = new Float32Array(NFFT);
function fft() {
  for (let i = 1, j = 0; i < NFFT; i++) {
    let bit = NFFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < NFFT; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Uint8Array（16-bit little-endian）→ Float32 [-1,1] */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export interface Frame {
  cep: Float32Array; // c1..c12
  logE: number; // 對數能量（給 VAD 用）
}

/**
 * 串流式 MFCC 擷取器：每次餵 100ms 音訊，吐出這段產生的 frame。
 * 跨 chunk 的殘餘樣本會保留，不會漏掉。
 */
export class MfccStream {
  private buf = new Float32Array(0); // pre-emphasis 後（算 MFCC 用）
  private raw = new Float32Array(0); // 原始音訊（算能量 / VAD 用）
  private prevSample = 0;

  push(samples: Float32Array): Frame[] {
    // 接到上次殘餘的樣本後面
    const merged = new Float32Array(this.buf.length + samples.length);
    const mergedRaw = new Float32Array(this.raw.length + samples.length);
    merged.set(this.buf);
    mergedRaw.set(this.raw);
    mergedRaw.set(samples, this.raw.length);
    for (let i = 0; i < samples.length; i++) {
      merged[this.buf.length + i] = samples[i] - 0.97 * this.prevSample;
      this.prevSample = samples[i];
    }
    const frames: Frame[] = [];
    let pos = 0;
    for (; pos + FRAME_LEN <= merged.length; pos += HOP) frames.push(this.frame(merged, mergedRaw, pos));
    this.buf = merged.slice(pos);
    this.raw = mergedRaw.slice(pos);
    return frames;
  }

  reset() {
    this.buf = new Float32Array(0);
    this.raw = new Float32Array(0);
    this.prevSample = 0;
  }

  private frame(x: Float32Array, raw: Float32Array, start: number): Frame {
    // 能量用原始音訊算：pre-emphasis 會壓低人聲主要的低頻，讓人聲跟雜音拉不開
    let energy = 1e-10;
    for (let i = 0; i < FRAME_LEN; i++) energy += raw[start + i] * raw[start + i];
    for (let i = 0; i < NFFT; i++) {
      re[i] = i < FRAME_LEN ? x[start + i] * hamming[i] : 0;
      im[i] = 0;
    }
    fft();
    const mel = new Float32Array(N_MEL);
    for (let m = 0; m < N_MEL; m++) {
      const f = melFilters[m];
      let s = 1e-10;
      for (let k = 0; k <= NFFT / 2; k++) if (f[k]) s += f[k] * (re[k] * re[k] + im[k] * im[k]);
      mel[m] = Math.log(s);
    }
    const cep = new Float32Array(N_CEP - 1);
    for (let c = 1; c < N_CEP; c++) {
      let s = 0;
      for (let m = 0; m < N_MEL; m++) s += dct[c][m] * mel[m];
      cep[c - 1] = s;
    }
    return { cep, logE: Math.log(energy) };
  }
}

/**
 * 簡易語音偵測（VAD）。背景雜音用最低能量的 10% 分位數估計。
 * 影片常有背景音樂、沒有安靜的停頓，所以動態範圍小時改用寬鬆規則。
 */
export function voicedFrames(frames: Frame[], dbAboveFloor = 6): Frame[] {
  const mask = voicedMask(frames.map((f) => f.logE), dbAboveFloor);
  return frames.filter((_, i) => mask[i]);
}

/** 依每個 frame 的對數能量，判斷哪些是人聲 */
export function voicedMask(logE: number[], dbAboveFloor = 6): boolean[] {
  const none = logE.map(() => false);
  if (logE.length < 10) return none;
  const sorted = [...logE].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const max = sorted[sorted.length - 1];
  const nat = (dbAboveFloor / 10) * Math.LN10; // dB → 自然對數
  // 幾乎靜音（音量極小）→ 沒人講話
  if (max < -11) return none;
  // 有明顯停頓（一般對話）：只留比背景大 6dB 以上的 frame
  if (max - floor >= nat) return logE.map((e) => e > Math.max(floor + nat, -11));
  // 沒有停頓（影片背景音樂、持續講話）：只去掉最小聲的 20%
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
  return logE.map((e) => e > p20);
}

/** 從原始音訊中只留下人聲的部分（以 10ms 為單位接起來） */
export function voicedAudio(x: Float32Array, dbAboveFloor = 6): Float32Array {
  const T = x.length < FRAME_LEN ? 0 : 1 + Math.floor((x.length - FRAME_LEN) / HOP);
  const logE: number[] = [];
  for (let t = 0; t < T; t++) {
    let e = 1e-10;
    for (let i = 0; i < FRAME_LEN; i++) e += x[t * HOP + i] ** 2;
    logE.push(Math.log(e));
  }
  const mask = voicedMask(logE, dbAboveFloor);
  const out = new Float32Array(x.length);
  let n = 0;
  for (let t = 0; t < T; t++) {
    if (!mask[t]) continue;
    // 每個 frame 只取它負責的 10ms，避免重複
    const start = t * HOP, end = t === T - 1 ? x.length : start + HOP;
    out.set(x.subarray(start, end), n);
    n += end - start;
  }
  return out.slice(0, n);
}

/** 加上 delta（±2 frame 回歸），輸出 24 維向量 */
export function withDeltas(frames: Frame[]): Float32Array[] {
  const n = frames.length;
  const d = N_CEP - 1;
  const out: Float32Array[] = [];
  for (let t = 0; t < n; t++) {
    const v = new Float32Array(FEATURE_DIM);
    v.set(frames[t].cep, 0);
    for (let j = 0; j < d; j++) {
      let num = 0;
      for (let k = 1; k <= 2; k++) {
        const a = frames[Math.min(n - 1, t + k)].cep[j];
        const b = frames[Math.max(0, t - k)].cep[j];
        num += k * (a - b);
      }
      v[d + j] = num / 10;
    }
    out.push(v);
  }
  return out;
}
