// 說話者模型：每個人一個「對角高斯混合模型」(GMM)
// 建檔時用 EM 訓練，辨識時比較每個人的平均對數似然度。

import { FEATURE_DIM, MfccStream, voicedFrames, withDeltas } from './features';
import type { Backend, IdResult as SharedIdResult, Profile, Source } from './types';

export type SpeakerProfile = Extract<Profile, { kind: 'gmm' }>;

const LOG2PI = Math.log(2 * Math.PI);

function logGauss(x: Float32Array, mean: number[], vars: number[], logDet: number): number {
  let s = 0;
  for (let d = 0; d < FEATURE_DIM; d++) {
    const diff = x[d] - mean[d];
    s += (diff * diff) / vars[d];
  }
  return -0.5 * (FEATURE_DIM * LOG2PI + logDet + s);
}

function logSumExp(a: number[]): number {
  const m = Math.max(...a);
  let s = 0;
  for (const v of a) s += Math.exp(v - m);
  return m + Math.log(s);
}

/** 平均每個 frame 的對數似然度 */
export function scoreFrames(p: SpeakerProfile, X: Float32Array[]): number {
  if (!X.length) return -Infinity;
  const K = p.weights.length;
  const logDet = p.vars.map((v) => v.reduce((s, x) => s + Math.log(x), 0));
  const logW = p.weights.map(Math.log);
  let total = 0;
  const comp = new Array<number>(K);
  for (const x of X) {
    for (let k = 0; k < K; k++) comp[k] = logW[k] + logGauss(x, p.means[k], p.vars[k], logDet[k]);
    total += logSumExp(comp);
  }
  return total / X.length;
}

/** 用 EM 訓練 GMM。K 會依資料量自動調小，避免過度擬合。 */
export function trainProfile(
  name: string,
  source: Source,
  X: Float32Array[],
  K = 8,
  iters = 15,
): SpeakerProfile {
  const N = X.length;
  if (N < 200) throw new Error(`有效語音太少（${(N / 100).toFixed(1)} 秒），請至少講 3 秒以上`);
  K = Math.max(1, Math.min(K, Math.floor(N / 60)));
  const D = FEATURE_DIM;

  // 全域平均 / 變異數，當作變異數下限的參考
  const gMean = new Array(D).fill(0), gVar = new Array(D).fill(0);
  for (const x of X) for (let d = 0; d < D; d++) gMean[d] += x[d] / N;
  for (const x of X) for (let d = 0; d < D; d++) gVar[d] += (x[d] - gMean[d]) ** 2 / N;
  const varFloor = gVar.map((v) => Math.max(v * 0.01, 1e-4));

  // 初始化：等距挑 K 個點當中心（可重現，不用亂數）
  let means = Array.from({ length: K }, (_, k) => Array.from(X[Math.floor(((k + 0.5) * N) / K)]));
  let vars = Array.from({ length: K }, () => gVar.slice());
  let weights = new Array(K).fill(1 / K);

  const resp = Array.from({ length: N }, () => new Float64Array(K));
  for (let it = 0; it < iters; it++) {
    // E-step
    const logDet = vars.map((v) => v.reduce((s, x) => s + Math.log(x), 0));
    const comp = new Array<number>(K);
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < K; k++) comp[k] = Math.log(weights[k]) + logGauss(X[n], means[k], vars[k], logDet[k]);
      const lse = logSumExp(comp);
      for (let k = 0; k < K; k++) resp[n][k] = Math.exp(comp[k] - lse);
    }
    // M-step
    const Nk = new Array(K).fill(0);
    const newMeans = Array.from({ length: K }, () => new Array(D).fill(0));
    const newVars = Array.from({ length: K }, () => new Array(D).fill(0));
    for (let n = 0; n < N; n++)
      for (let k = 0; k < K; k++) {
        const r = resp[n][k];
        if (r < 1e-8) continue;
        Nk[k] += r;
        for (let d = 0; d < D; d++) newMeans[k][d] += r * X[n][d];
      }
    for (let k = 0; k < K; k++) for (let d = 0; d < D; d++) newMeans[k][d] /= Math.max(Nk[k], 1e-8);
    for (let n = 0; n < N; n++)
      for (let k = 0; k < K; k++) {
        const r = resp[n][k];
        if (r < 1e-8) continue;
        for (let d = 0; d < D; d++) newVars[k][d] += r * (X[n][d] - newMeans[k][d]) ** 2;
      }
    for (let k = 0; k < K; k++)
      for (let d = 0; d < D; d++) newVars[k][d] = Math.max(newVars[k][d] / Math.max(Nk[k], 1e-8), varFloor[d]);
    // 空掉的成分重新放回全域分布
    for (let k = 0; k < K; k++)
      if (Nk[k] < 2) {
        newMeans[k] = gMean.slice();
        newVars[k] = gVar.slice();
        Nk[k] = 2;
      }
    const sumN = Nk.reduce((a, b) => a + b, 0);
    weights = Nk.map((v) => v / sumN);
    means = newMeans;
    vars = newVars;
  }

  const profile: SpeakerProfile = {
    kind: 'gmm', name, source, weights, means, vars, selfScore: 0, selfStd: 1,
    seconds: N / 100, createdAt: new Date().toISOString(),
  };
  // 用 1.5 秒小段算基準線，跟即時辨識的視窗長度一致
  const seg = 100;
  const segScores: number[] = [];
  for (let i = 0; i + seg <= N; i += seg / 2) segScores.push(scoreFrames(profile, X.slice(i, i + seg)));
  const mu = segScores.reduce((a, b) => a + b, 0) / segScores.length;
  const sd = Math.sqrt(segScores.reduce((a, b) => a + (b - mu) ** 2, 0) / segScores.length);
  profile.selfScore = mu;
  profile.selfStd = Math.max(sd, 0.5);
  return profile;
}

export interface IdResult {
  name: string | null; // null = 不認識 / 不確定
  best: { name: string; ll: number; rel: number } | null;
  /** ll = 平均對數似然度（拿來比誰最像）；rel = 離本人基準線幾個標準差（拿來判斷是不是陌生人） */
  scores: { name: string; ll: number; rel: number }[];
}

/**
 * 辨識：
 * 1. 誰的模型分數（ll）最高，就是最可能的人
 * 2. 第一名跟第二名的 ll 差距 < margin → 太接近，判「不確定」
 * 3. 第一名離他本人基準線超過 threshold 個標準差 → 跟誰都不像，判「未知」
 */
export function identify(profiles: SpeakerProfile[], X: Float32Array[], threshold = 4, margin = 1): IdResult {
  const scores = profiles
    .map((p) => {
      const ll = scoreFrames(p, X);
      return { name: p.name, ll, rel: (ll - p.selfScore) / (p.selfStd ?? 1) };
    })
    .sort((a, b) => b.ll - a.ll);
  const best = scores[0] ?? null;
  if (!best || best.rel < -threshold) return { name: null, best, scores };
  if (scores.length > 1 && best.ll - scores[1].ll < margin) return { name: null, best, scores };
  return { name: best.name, best, scores };
}

/** 傳統方法（MFCC + GMM）：不需要下載模型，當作 CAM++ 載入失敗時的備援 */
export class GmmBackend implements Backend {
  kind = 'gmm' as const;
  label = 'GMM 傳統方法（備援）';
  defaults = { threshold: 8, margin: 1 };
  range = { threshold: [1, 20, 0.5], margin: [0, 5, 0.25] } as const;

  private feats(audio: Float32Array) {
    const frames = new MfccStream().push(audio);
    // 送進來的已經是去掉靜音的語音；再過一次 VAD 只是保險
    const v = voicedFrames(frames);
    return withDeltas(v.length >= frames.length * 0.5 ? v : frames);
  }

  async enroll(name: string, source: Source, voiced: Float32Array): Promise<Profile> {
    return trainProfile(name, source, this.feats(voiced));
  }

  async identify(profiles: Profile[], voiced: Float32Array, s: { threshold: number; margin: number }): Promise<SharedIdResult> {
    const gmm = profiles.filter((p): p is SpeakerProfile => p.kind === 'gmm');
    const r = identify(gmm, this.feats(voiced), s.threshold, s.margin);
    const rows = r.scores.map((x) => ({ name: x.name, score: x.rel, detail: `z ${x.rel.toFixed(1)}（ll ${x.ll.toFixed(1)}）` }));
    const conf = r.best ? Math.max(0, 1 + r.best.rel / s.threshold) : 0;
    const stranger = !r.best || r.best.rel < -s.threshold;
    return { name: r.name, best: rows[0] ?? null, scores: rows, conf, stranger };
  }
}
