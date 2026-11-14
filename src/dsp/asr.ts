// 本機串流語音辨識（中文）：sherpa-onnx streaming zipformer 14M（int8，約 25MB）
// 全部在手機 / 瀏覽器上用 onnxruntime-web 推論，不上傳、不需要網路；
// 跟聲紋、環境偵測共用同一份 16kHz 音訊，所以 iPhone 和 G2 眼鏡的麥克風都能用。

import { AsrFbankStream } from './fbank';
import { getOrt, runExclusive } from './ort';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ASR_BASE = './models/asr/';

interface AsrConfig {
  T: number; // 每次送進編碼器的 frame 數（含前瞻）
  chunk: number; // 每次往前推進的 frame 數
  contextSize: number;
  blank: number;
  states: { name: string; shape: number[]; type: 'float32' | 'int64' }[];
}

interface S2T {
  chars: Record<string, string>;
  phrases: Record<string, string>;
  maxLen: number;
}

/** 簡體 → 台灣繁體：先比對詞組（處理 后/後、发/發/髮 這類一對多），再逐字轉 */
function makeConverter(d: S2T) {
  return (text: string) => {
    let out = '';
    for (let i = 0; i < text.length; ) {
      let hit = false;
      for (let L = Math.min(d.maxLen, text.length - i); L >= 2; L--) {
        const w = text.slice(i, i + L);
        const t = d.phrases[w];
        if (t) { out += t; i += L; hit = true; break; }
      }
      if (!hit) { out += d.chars[text[i]] ?? text[i]; i++; }
    }
    return out;
  };
}

export class StreamingAsr {
  /** 正在說的句子（還會變） */
  onPartial: (text: string) => void = () => {};
  /** 一句話結束（停頓超過 endpointSec 秒） */
  onFinal: (text: string) => void = () => {};
  /** 處理速度跟不上時回報落後幾秒 */
  onLag: (sec: number) => void = () => {};

  endpointSec = 1.0; // 停頓多久算一句結束
  maxSentenceSec = 15; // 一句話最長多久就強制斷句

  private fb = new AsrFbankStream();
  private frames: Float32Array[] = [];
  private states: Record<string, any> = {};
  private hyp: number[] = [];
  private seg: number[] = []; // 這句話目前辨識出的字
  private decOut: any = null;
  private trailingBlank = 0; // 這句話尾端連續沒有字的秒數
  private segSec = 0;
  private busy = false;
  private pendingSamples = 0;

  private constructor(
    private ort: any,
    private enc: any,
    private dec: any,
    private joi: any,
    private cfg: AsrConfig,
    private tokens: string[],
    private toTw: (s: string) => string,
  ) {}

  static async load(base = ASR_BASE): Promise<StreamingAsr> {
    const ort = getOrt();
    const opt = { executionProviders: ['wasm'] };
    const [enc, dec, joi, cfg, tokTxt, s2t] = await Promise.all([
      ort.InferenceSession.create(base + 'encoder.int8.onnx', opt),
      ort.InferenceSession.create(base + 'decoder.int8.onnx', opt),
      ort.InferenceSession.create(base + 'joiner.int8.onnx', opt),
      fetch(base + 'asr_config.json').then((r) => r.json()),
      fetch(base + 'tokens.txt').then((r) => r.text()),
      fetch(base + 's2t.json').then((r) => r.json()),
    ]);
    const tokens: string[] = [];
    for (const line of tokTxt.split('\n')) {
      const i = line.lastIndexOf(' ');
      if (i > 0) tokens[Number(line.slice(i + 1))] = line.slice(0, i);
    }
    const asr = new StreamingAsr(ort, enc, dec, joi, cfg, tokens, makeConverter(s2t));
    asr.reset();
    return asr;
  }

  /** 全部清空（開始新的一次聆聽時呼叫） */
  reset() {
    this.fb.reset();
    this.frames = [];
    this.states = {};
    for (const s of this.cfg.states) {
      const n = s.shape.reduce((a, b) => a * b, 1);
      this.states[s.name] =
        s.type === 'int64'
          ? new this.ort.Tensor('int64', new BigInt64Array(n), s.shape)
          : new this.ort.Tensor('float32', new Float32Array(n), s.shape);
    }
    this.hyp = new Array(this.cfg.contextSize).fill(this.cfg.blank);
    this.seg = [];
    this.decOut = null;
    this.trailingBlank = 0;
    this.segSec = 0;
    this.pendingSamples = 0;
  }

  /** 餵 16kHz 音訊（任意長度） */
  push(samples: Float32Array) {
    this.frames.push(...this.fb.push(samples));
    this.pendingSamples += samples.length;
    void this.pump();
  }

  /** 強制把目前這句話結束（停止聆聽時用） */
  flush() {
    this.endSentence();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.frames.length >= this.cfg.T) {
        const lag = (this.frames.length - this.cfg.T) / 100;
        if (lag > 2) this.onLag(lag);
        const x = new Float32Array(this.cfg.T * 80);
        for (let i = 0; i < this.cfg.T; i++) x.set(this.frames[i], i * 80);
        this.frames.splice(0, this.cfg.chunk);
        await runExclusive(() => this.decodeChunk(x));
      }
    } catch (e) {
      console.warn('語音辨識錯誤', e);
    } finally {
      this.busy = false;
    }
  }

  private async runDecoder() {
    const ctx = this.hyp.slice(-this.cfg.contextSize).map((v) => BigInt(v));
    const out = await this.dec.run({ y: new this.ort.Tensor('int64', BigInt64Array.from(ctx), [1, this.cfg.contextSize]) });
    this.decOut = out.decoder_out;
  }

  private async decodeChunk(x: Float32Array) {
    const ort = this.ort;
    const feeds: Record<string, any> = { x: new ort.Tensor('float32', x, [1, this.cfg.T, 80]), ...this.states };
    const out = await this.enc.run(feeds);
    for (const s of this.cfg.states) this.states[s.name] = out['new_' + s.name];
    const eo = out.encoder_out;
    const [, F, D] = eo.dims as number[];
    const frameSec = this.cfg.chunk / 100 / F;
    if (!this.decOut) await this.runDecoder();
    let changed = false;
    for (let f = 0; f < F; f++) {
      const ef = new ort.Tensor('float32', (eo.data as Float32Array).subarray(f * D, (f + 1) * D), [1, D]);
      const logit = (await this.joi.run({ encoder_out: ef, decoder_out: this.decOut })).logit.data as Float32Array;
      let best = 0;
      for (let k = 1; k < logit.length; k++) if (logit[k] > logit[best]) best = k;
      this.segSec += frameSec;
      if (best !== this.cfg.blank) {
        this.hyp.push(best);
        this.seg.push(best);
        this.trailingBlank = 0;
        changed = true;
        await this.runDecoder();
      } else {
        this.trailingBlank += frameSec;
      }
    }
    if (changed) this.onPartial(this.text());
    // 斷句：說完停頓夠久，或一句話太長
    if (this.seg.length && (this.trailingBlank >= this.endpointSec || this.segSec >= this.maxSentenceSec)) this.endSentence();
    else if (!this.seg.length) this.segSec = 0;
  }

  private text() {
    return this.toTw(this.seg.map((k) => this.tokens[k] ?? '').join(''));
  }

  private endSentence() {
    if (!this.seg.length) return;
    const t = this.text();
    this.seg = [];
    this.segSec = 0;
    this.trailingBlank = 0;
    this.onFinal(t);
  }
}
