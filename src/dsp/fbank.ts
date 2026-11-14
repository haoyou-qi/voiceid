// Kaldi 相容的 80 維 log-mel fbank（CAM++ / 3D-Speaker 模型訓練時用的特徵）
// 設定：25ms 窗、10ms 位移、Povey 窗、pre-emphasis 0.97、去直流、20Hz~8kHz、dither 0
// 最後做「整段平均值正規化」（模型 metadata: feature_normalize_type = global-mean）

const SR = 16000;
const WIN = 400;
const HOP = 160;
const NFFT = 512;
export const N_MELS = 80;

const povey = new Float32Array(WIN);
for (let i = 0; i < WIN; i++) povey[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)), 0.85);

const mel = (f: number) => 1127 * Math.log(1 + f / 700);

// Kaldi 的 mel 濾波器：在 mel 尺度上畫三角形，只用 0..NFFT/2-1 這些頻率格
const banks: { start: number; w: Float32Array }[] = (() => {
  const lo = mel(20), hi = mel(SR / 2);
  const delta = (hi - lo) / (N_MELS + 1);
  const binHz = SR / NFFT;
  const out: { start: number; w: Float32Array }[] = [];
  for (let b = 0; b < N_MELS; b++) {
    const left = lo + b * delta, center = left + delta, right = center + delta;
    const w: number[] = [];
    let start = -1;
    for (let i = 0; i < NFFT / 2; i++) {
      const m = mel(binHz * i);
      if (m > left && m < right) {
        if (start < 0) start = i;
        w.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center));
      } else if (start >= 0) break;
    }
    out.push({ start: Math.max(0, start), w: Float32Array.from(w) });
  }
  return out;
})();

const re = new Float64Array(NFFT);
const im = new Float64Array(NFFT);
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
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const EPS = 1.1920928955078125e-7; // float32 epsilon，同 Kaldi

/** 整段音訊 → [T × 80] 的 fbank（已做平均值正規化），回傳攤平的 Float32Array 與 frame 數 */
export function fbank(x: Float32Array): { data: Float32Array; frames: number } {
  const T = x.length < WIN ? 0 : 1 + Math.floor((x.length - WIN) / HOP);
  const data = new Float32Array(T * N_MELS);
  const frame = new Float64Array(WIN);
  for (let t = 0; t < T; t++) {
    const off = t * HOP;
    let mean = 0;
    for (let i = 0; i < WIN; i++) { frame[i] = x[off + i] * 32768; mean += frame[i]; }
    mean /= WIN;
    for (let i = 0; i < WIN; i++) frame[i] -= mean; // 去直流
    for (let i = WIN - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1]; // pre-emphasis
    frame[0] -= 0.97 * frame[0];
    for (let i = 0; i < NFFT; i++) { re[i] = i < WIN ? frame[i] * povey[i] : 0; im[i] = 0; }
    fft();
    for (let b = 0; b < N_MELS; b++) {
      const { start, w } = banks[b];
      let s = 0;
      for (let k = 0; k < w.length; k++) { const i = start + k; s += w[k] * (re[i] * re[i] + im[i] * im[i]); }
      data[t * N_MELS + b] = Math.log(Math.max(s, EPS));
    }
  }
  // global-mean：每個維度減掉整段平均（也讓音量大小不影響結果）
  for (let b = 0; b < N_MELS; b++) {
    let m = 0;
    for (let t = 0; t < T; t++) m += data[t * N_MELS + b];
    m /= Math.max(T, 1);
    for (let t = 0; t < T; t++) data[t * N_MELS + b] -= m;
  }
  return { data, frames: T };
}
