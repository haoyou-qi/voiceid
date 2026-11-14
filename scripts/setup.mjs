// npm install 之後自動執行：
// 1. 把 onnxruntime-web 的執行檔複製到 public/ort/（瀏覽器直接載入，避開打包工具的相容問題）
// 2. 下載 CAM++ 中文聲紋模型（約 28MB）到 public/models/
// 3. 下載 CED-tiny 環境聲音分類模型（壓縮檔約 28MB，解開後只留 6MB 的模型）
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
const MODEL_PATH = join(root, 'public', 'models', 'campplus_zh.onnx');

// 1. ONNX Runtime
const dist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const ortOut = join(root, 'public', 'ort');
mkdirSync(ortOut, { recursive: true });
if (!existsSync(dist)) {
  console.error('[setup] 找不到 node_modules/onnxruntime-web，請先執行 npm install');
  process.exit(1);
}
let n = 0;
for (const f of readdirSync(dist)) {
  if (f === 'ort.min.js' || /^ort-wasm.*\.(wasm|js|mjs)$/.test(f)) {
    copyFileSync(join(dist, f), join(ortOut, f));
    n++;
  }
}
console.log(`[setup] 已複製 ${n} 個 ONNX Runtime 檔案到 public/ort/`);

// 2. 模型
if (existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > 20_000_000) {
  console.log('[setup] 聲紋模型已存在，略過下載');
} else {
  mkdirSync(dirname(MODEL_PATH), { recursive: true });
  console.log('[setup] 下載 CAM++ 聲紋模型（約 28MB）…');
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20_000_000) throw new Error(`檔案大小不對（${buf.length} bytes）`);
    writeFileSync(MODEL_PATH, buf);
    console.log(`[setup] 模型下載完成（${(buf.length / 1e6).toFixed(1)} MB）`);
  } catch (e) {
    console.error(`[setup] 模型下載失敗：${e.message}`);
    console.error('        請手動下載下面這個網址，存成 public/models/campplus_zh.onnx：');
    console.error('        ' + MODEL_URL);
    console.error('        沒有模型也能用，只是會改用準確度較低的備援方法。');
  }
}

// 3. 環境聲音分類模型（GitHub 上只有 .tar.bz2，用系統內建的 tar 解壓；Windows 10 以上都有）
const CED_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2';
const CED_PATH = join(root, 'public', 'models', 'ced_tiny.onnx');
if (existsSync(CED_PATH) && statSync(CED_PATH).size > 5_000_000) {
  console.log('[setup] 環境聲音模型已存在，略過下載');
} else {
  console.log('[setup] 下載環境聲音分類模型（約 28MB）…');
  const work = join(tmpdir(), 'voiceid-ced-' + Date.now());
  try {
    mkdirSync(work, { recursive: true });
    const res = await fetch(CED_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = join(work, 'ced.tar.bz2');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const r = spawnSync('tar', ['-xjf', archive, '-C', work], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('解壓縮失敗（找不到 tar 指令？）');
    const src = join(work, 'sherpa-onnx-ced-tiny-audio-tagging-2024-04-19', 'model.int8.onnx');
    if (!existsSync(src)) throw new Error('壓縮檔裡找不到 model.int8.onnx');
    mkdirSync(dirname(CED_PATH), { recursive: true });
    copyFileSync(src, CED_PATH);
    console.log(`[setup] 環境聲音模型完成（${(statSync(CED_PATH).size / 1e6).toFixed(1)} MB）`);
  } catch (e) {
    console.error(`[setup] 環境聲音模型下載失敗：${e.message}`);
    console.error('        沒有這個模型也能用，只是只會顯示吵雜程度、不會分辨音樂 / 人群 / 警報。');
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* 略過 */ }
  }
}

// 4. 本機中文語音辨識模型（sherpa-onnx streaming zipformer 14M，只留 int8 版約 25MB）
const ASR_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2';
const ASR_DIR = join(root, 'public', 'models', 'asr');
mkdirSync(ASR_DIR, { recursive: true });
// 設定檔（狀態形狀、簡轉繁對照表）放在 repo 的 models-src/asr，複製過去
for (const f of ['asr_config.json', 's2t.json']) copyFileSync(join(root, 'models-src', 'asr', f), join(ASR_DIR, f));
if (existsSync(join(ASR_DIR, 'encoder.int8.onnx')) && statSync(join(ASR_DIR, 'encoder.int8.onnx')).size > 20_000_000) {
  console.log('[setup] 語音辨識模型已存在，略過下載');
} else {
  console.log('[setup] 下載中文語音辨識模型（壓縮檔約 74MB）…');
  const work = join(tmpdir(), 'voiceid-asr-' + Date.now());
  try {
    mkdirSync(work, { recursive: true });
    const res = await fetch(ASR_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = join(work, 'asr.tar.bz2');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const r = spawnSync('tar', ['-xjf', archive, '-C', work], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('解壓縮失敗（找不到 tar 指令？）');
    const src = join(work, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
    for (const [from, to] of [
      ['encoder-epoch-99-avg-1.int8.onnx', 'encoder.int8.onnx'],
      ['decoder-epoch-99-avg-1.int8.onnx', 'decoder.int8.onnx'],
      ['joiner-epoch-99-avg-1.int8.onnx', 'joiner.int8.onnx'],
      ['tokens.txt', 'tokens.txt'],
    ]) copyFileSync(join(src, from), join(ASR_DIR, to));
    console.log('[setup] 語音辨識模型完成');
  } catch (e) {
    console.error(`[setup] 語音辨識模型下載失敗：${e.message}`);
    console.error('        沒有這個模型時，字幕只能用瀏覽器內建的語音辨識。');
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* 略過 */ }
  }
}
