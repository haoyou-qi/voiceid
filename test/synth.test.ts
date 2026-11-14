// 用合成人聲測試辨識流程（不能取代真人測試，只驗證程式邏輯與大致門檻）
// 執行：npx tsx test/synth.test.ts
import { VoiceIdEngine } from '../src/dsp/engine';
import { GmmBackend } from '../src/dsp/speaker';

// 簡單的可重現亂數
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

interface Voice { f0: number; tract: number; tilt: number; breath: number }
const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];

/** 合成一段「講話」：母音串 + 停頓 + 背景雜音，輸出 16-bit PCM bytes 的 100ms 切片 */
function speak(v: Voice, seconds: number): Uint8Array[] {
  const sr = 16000, n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  let phase = 0, i = 0;
  // 二階共振濾波器狀態
  const st = [0, 0, 0].map(() => ({ y1: 0, y2: 0 }));
  let lp = 0;
  while (i < n) {
    const sylLen = Math.floor(sr * (0.15 + rand() * 0.25));
    const pause = rand() < 0.3 ? Math.floor(sr * (0.1 + rand() * 0.3)) : 0;
    const vow = VOWELS[Math.floor(rand() * VOWELS.length)];
    const f0base = v.f0 * (0.85 + rand() * 0.3);
    const coefs = vow.map((F, k) => {
      const f = F * v.tract, bw = 80 + 40 * k;
      const r = Math.exp((-Math.PI * bw) / sr);
      return { a1: 2 * r * Math.cos((2 * Math.PI * f) / sr), a2: -r * r, g: 1 - r };
    });
    for (let j = 0; j < sylLen && i < n; j++, i++) {
      const env = Math.sin((Math.PI * j) / sylLen);
      const f0 = f0base * (1 + 0.1 * Math.sin((2 * Math.PI * j) / sylLen)) * (1 + (rand() - 0.5) * 0.01);
      phase += f0 / sr;
      let src = 0;
      if (phase >= 1) { phase -= 1; src = 1; }
      src += (rand() - 0.5) * v.breath;
      lp = lp + v.tilt * (src - lp); // 頻譜斜率（音色亮暗）
      let y = 0;
      coefs.forEach((c, k) => {
        const s = st[k];
        const yk = c.g * lp + c.a1 * s.y1 + c.a2 * s.y2;
        s.y2 = s.y1; s.y1 = yk; y += yk / (k + 1);
      });
      out[i] = y * env * 0.5;
    }
    for (let j = 0; j < pause && i < n; j++, i++) out[i] = 0;
  }
  // 正規化 + 背景雜音
  let peak = 1e-9;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  for (let k = 0; k < n; k++) out[k] = (out[k] / peak) * 0.4 + (rand() - 0.5) * 0.004;
  // 切成 100ms 的 Uint8Array，模擬 SDK audioEvent
  const chunks: Uint8Array[] = [];
  for (let k = 0; k < n; k += 1600) {
    const len = Math.min(1600, n - k);
    const b = new Uint8Array(len * 2);
    const dv = new DataView(b.buffer);
    for (let m = 0; m < len; m++) dv.setInt16(m * 2, Math.round(Math.max(-1, Math.min(1, out[k + m])) * 32767), true);
    chunks.push(b);
  }
  return chunks;
}

const voices: Record<string, Voice> = {
  Wanda: { f0: 210, tract: 1.15, tilt: 0.35, breath: 0.15 },
  阿明: { f0: 120, tract: 0.92, tilt: 0.25, breath: 0.05 },
  小美: { f0: 240, tract: 1.2, tilt: 0.6, breath: 0.3 },
  老陳: { f0: 105, tract: 0.88, tilt: 0.5, breath: 0.2 },
};
const outsider: Voice = { f0: 160, tract: 1.05, tilt: 0.45, breath: 0.4 };

// 這個測試只驗證 GMM 備援方法和即時引擎的流程（CAM++ 需要瀏覽器載入模型）
const eng = new VoiceIdEngine(new GmmBackend());
const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(v: Voice, label: string, sec = 6) {
  const results: string[] = [];
  const rels: string[] = [];
  eng.onResult = (r) => {
    if (!r.best) return;
    results.push(r.name ?? '?');
    rels.push(r.scores.map((s) => `${s.name}:${s.detail}`).join(' '));
  };
  eng.startListening();
  const t0 = performance.now();
  const chunks = speak(v, sec);
  for (const c of chunks) { eng.pushPcm16(c); await tick(); }
  const ms = (performance.now() - t0) / chunks.length;
  const hit = results.filter((r) => r === label).length;
  console.log(`[${label}] 正確 ${hit}/${results.length}  每100ms耗時 ${ms.toFixed(1)}ms  例：${rels[2] ?? ''}`);
  return { hit, total: results.length, results };
}

(async () => {
  for (const [name, v] of Object.entries(voices)) {
    eng.startEnrolling();
    for (const c of speak(v, 15)) eng.pushPcm16(c);
    const t0 = Date.now();
    const p = await eng.finishEnrolling(name, 'browser');
    console.log(`建檔 ${name}: ${p.seconds.toFixed(1)}s 有效語音, ${Date.now() - t0}ms`);
  }
  let ok = 0, tot = 0;
  for (const [name, v] of Object.entries(voices)) {
    const r = await run(v, name);
    ok += r.hit; tot += r.total;
  }
  const u = await run(outsider, '?');
  console.log(`\n已建檔者準確率: ${((ok / tot) * 100).toFixed(0)}%  | 陌生人判為未知: ${u.hit}/${u.total}`);
  if (ok / tot < 0.8) { console.error('FAIL: 準確率過低'); process.exit(1); }
})();
