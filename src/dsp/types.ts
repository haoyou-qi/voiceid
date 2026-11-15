// 兩種辨識引擎共用的型別

export type Source = 'glasses' | 'phone' | 'browser' | 'tab';

export type Profile =
  | {
      kind: 'campp';
      name: string;
      source: Source;
      emb: number[]; // 192 維、已正規化的聲紋向量
      seconds: number;
      createdAt: string;
      /** 追加錄音：同一個人在不同環境（吵雜、遠近、不同麥克風、說英文）多錄的幾段，辨識時取最像的一段 */
      extra?: { emb: number[]; seconds: number; source: Source; createdAt: string }[];
    }
  | {
      kind: 'gmm';
      name: string;
      source: Source;
      weights: number[];
      means: number[][];
      vars: number[][];
      selfScore: number;
      selfStd: number;
      seconds: number;
      createdAt: string;
    };

export interface ScoreRow {
  name: string;
  score: number; // 越大越像（CAM++ 是相似度；GMM 是 z 分數）
  detail: string; // 顯示用
}

export interface IdResult {
  name: string | null; // null = 不認識 / 不確定
  best: ScoreRow | null;
  scores: ScoreRow[];
  conf: number; // 0~1，給信心條用
  /** 跟所有建檔者都不像（陌生人）。注意：name 為 null 也可能只是「兩個建檔者分不出來」，那種情況 stranger = false */
  stranger: boolean;
}

export interface Backend {
  kind: Profile['kind'];
  label: string;
  defaults: { threshold: number; margin: number };
  range: { threshold: readonly [number, number, number]; margin: readonly [number, number, number] };
  enroll(name: string, source: Source, voiced: Float32Array): Promise<Profile>;
  identify(profiles: Profile[], voiced: Float32Array, s: { threshold: number; margin: number }): Promise<IdResult>;
}
