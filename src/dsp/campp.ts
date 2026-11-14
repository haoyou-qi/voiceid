// CAM++ 深度學習聲紋模型（3D-Speaker，20 萬中文語者訓練，輸出 192 維聲紋向量）
// 用 onnxruntime-web（由 index.html 的 <script> 載入，全域變數 ort）在手機 / 瀏覽器上本機推論，不上傳。

import { fbank } from './fbank';
import { getOrt, runExclusive } from './ort';
import type { Backend, IdResult, Profile } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MODEL_URL = './models/campplus_zh.onnx';

export type EmbedFn = (fbankData: Float32Array, frames: number) => Promise<Float32Array>;

/** 載入模型。失敗會丟錯，由上層改用備援引擎 */
export async function loadCamppEmbedder(modelUrl = MODEL_URL): Promise<EmbedFn> {
  const ort = getOrt();
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];
  return (data, frames) =>
    runExclusive(async () => {
      const out = await session.run({ [inName]: new ort.Tensor('float32', data, [1, frames, 80]) });
      return out[outName].data as Float32Array;
    });
}

function normalize(v: ArrayLike<number>): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export class CamppBackend implements Backend {
  kind = 'campp' as const;
  label = 'CAM++ 深度模型';
  defaults = { threshold: 0.42, margin: 0.05 };
  /**
   * 整句判斷用的陌生人門檻：整句的聲紋比 2 秒小段可靠（本人通常 0.7 以上、陌生人 0.3 以下），
   * 所以比即時門檻低 0.12。調整頁面上的「陌生人門檻」滑桿會一起移動。
   */
  sentenceOffset = 0.12;
  range = { threshold: [0.2, 0.8, 0.01], margin: [0, 0.3, 0.01] } as const;

  constructor(private embedFn: EmbedFn) {}

  private async embed(audio: Float32Array): Promise<number[]> {
    const f = fbank(audio);
    if (f.frames < 30) throw new Error('語音太短');
    return normalize(await this.embedFn(f.data, f.frames));
  }

  async enroll(name: string, source: Profile['source'], voiced: Float32Array): Promise<Profile> {
    const emb = await this.embed(voiced);
    return { kind: 'campp', name, source, emb, seconds: voiced.length / 16000, createdAt: new Date().toISOString() };
  }

  async identify(profiles: Profile[], voiced: Float32Array, s: { threshold: number; margin: number }): Promise<IdResult> {
    const e = await this.embed(voiced);
    const scores = profiles
      .filter((p): p is Extract<Profile, { kind: 'campp' }> => p.kind === 'campp')
      .map((p) => ({ name: p.name, score: dot(e, p.emb) }))
      .sort((a, b) => b.score - a.score);
    const best = scores[0] ?? null;
    const conf = best ? Math.max(0, Math.min(1, (best.score - 0.2) / 0.6)) : 0;
    const rows = scores.map((x) => ({ name: x.name, score: x.score, detail: `相似度 ${x.score.toFixed(2)}` }));
    if (!best || best.score < s.threshold) return { name: null, best: rows[0] ?? null, scores: rows, conf, stranger: true };
    if (scores.length > 1 && best.score - scores[1].score < s.margin)
      return { name: null, best: rows[0], scores: rows, conf, stranger: false };
    return { name: best.name, best: rows[0], scores: rows, conf, stranger: false };
  }
}
