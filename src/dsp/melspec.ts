// CED 聲音分類模型用的特徵：64 維 log-mel（dB），跟模型訓練時的 torchaudio 設定一致
// MelSpectrogram(n_fft=512, win=512, hop=160, f_min=0, f_max=8000, n_mels=64, center=True)
// + AmplitudeToDB(top_db=120)

const SR = 16000;
const NFFT = 512;
const HOP = 160;
export const N_MELS_CED = 64;

// 週期性 Hann 窗（torch.hann_window 預設）
const hann = new Float32Array(NFFT);
for (let i = 0; i < NFFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

// torchaudio 的 HTK mel 濾波器（不做面積正規化）
const NB = NFFT / 2 + 1;
const fb: Float32Array[] = (() => {
  const mMin = hz2mel(0), mMax = hz2mel(SR / 2);
  const fPts = Array.from({ length: N_MELS_CED + 2 }, (_, i) => mel2hz(mMin + ((mMax - mMin) * i) / (N_MELS_CED + 1)));
  const out: Float32Array[] = [];
  for (let m = 0; m < N_MELS_CED; m++) {
    const w = new Float32Array(NB);
    for (let k = 0; k < NB; k++) {
      const f = (k * (SR / 2)) / (NB - 1);
      const down = (f - fPts[m]) / (fPts[m + 1] - fPts[m]);
      const up = (fPts[m + 2] - f) / (fPts[m + 2] - fPts[m + 1]);
      w[k] = Math.max(0, Math.min(down, up));
    }
    out.push(w);
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

/** 音訊 → [64 × T] 的 log-mel dB（模型輸入是「先 mel 再時間」的排列） */
export function melDb(x: Float32Array): { data: Float32Array; frames: number } {
  const pad = NFFT / 2;
  const n = x.length;
  // center=True：前後各補 256 個樣本（反射）
  const at = (i: number) => {
    let j = i - pad;
    if (j < 0) j = -j;
    if (j >= n) j = 2 * (n - 1) - j;
    return x[Math.max(0, Math.min(n - 1, j))];
  };
  const T = 1 + Math.floor(n / HOP);
  const data = new Float32Array(N_MELS_CED * T);
  let maxDb = -Infinity;
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < NFFT; i++) { re[i] = at(t * HOP + i) * hann[i]; im[i] = 0; }
    fft();
    for (let m = 0; m < N_MELS_CED; m++) {
      const w = fb[m];
      let s = 0;
      for (let k = 0; k < NB; k++) if (w[k]) s += w[k] * (re[k] * re[k] + im[k] * im[k]);
      const db = 10 * Math.log10(Math.max(s, 1e-10));
      data[m * T + t] = db;
      if (db > maxDb) maxDb = db;
    }
  }
  const floor = maxDb - 120; // top_db = 120
  for (let i = 0; i < data.length; i++) if (data[i] < floor) data[i] = floor;
  return { data, frames: T };
}
