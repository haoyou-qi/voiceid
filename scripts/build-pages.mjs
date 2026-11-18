// 產生 GitHub Pages 用的網站到 docs/（haoyou-qi/voiceid 從 main 分支的 /docs 發佈）
//   node scripts/build-pages.mjs            → 輸出到 ./docs
//   node scripts/build-pages.mjs <輸出資料夾>
// 需要先 npm install（會用到 esbuild，vite 已經帶了；setup.mjs 會準備 public/ort 和 public/models）
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'docs'));
mkdirSync(join(out, 'assets'), { recursive: true });

// 版本號：台北時間 月日.時分（網站最下方會顯示，方便確認手機是不是最新版）
const t = new Date(Date.now() + 8 * 3600_000).toISOString();
const ver = `${t.slice(5, 7)}${t.slice(8, 10)}.${t.slice(11, 13)}${t.slice(14, 16)}`;

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  minify: true,
  outdir: join(out, 'assets'),
  define: { __BUILD__: JSON.stringify(ver) },
  logLevel: 'warning',
});

const js = readFileSync(join(out, 'assets', 'main.js'));
const css = existsSync(join(out, 'assets', 'main.css')) ? readFileSync(join(out, 'assets', 'main.css')) : Buffer.alloc(0);
const hash = createHash('sha1').update(js).update(css).digest('hex').slice(0, 8);

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(
  '<script type="module" src="/src/main.ts"></script>',
  `<script type="module" src="./assets/main.js?v=${hash}"></script>`,
);
html = html.replace(
  '<script src="./ort/ort.min.js"></script>',
  `<script src="./ort/ort.min.js"></script>\n    <link rel="stylesheet" href="./assets/main.css?v=${hash}" />`,
);
writeFileSync(join(out, 'index.html'), html);

// 靜態檔：圖示、manifest、ONNX Runtime、模型（模型很大，只在有變動時才會被 git 視為修改）
cpSync(join(root, 'public'), out, { recursive: true });
console.log(`built ${ver} ${hash} → ${out}`);
