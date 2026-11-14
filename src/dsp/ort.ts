// 共用的 onnxruntime-web 設定與推論佇列
// 聲紋模型和環境聲音模型共用同一個 WebAssembly 執行環境，一次只跑一個推論比較穩定。

/* eslint-disable @typescript-eslint/no-explicit-any */
let configured = false;

export function getOrt(): any {
  const ort = (globalThis as any).ort;
  if (!ort) throw new Error('找不到 onnxruntime-web（public/ort/ort.min.js 沒有載入）');
  if (!configured) {
    ort.env.wasm.numThreads = 1; // 多執行緒需要特殊網頁標頭，手機 WebView 不一定支援
    ort.env.wasm.wasmPaths = new URL('./ort/', location.href).href;
    configured = true;
  }
  return ort;
}

let queue: Promise<unknown> = Promise.resolve();
/** 排隊執行，避免兩個模型同時推論 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn);
  queue = job.catch(() => undefined);
  return job;
}
