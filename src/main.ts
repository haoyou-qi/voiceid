declare const __BUILD__: string; // 打包時填入（用來確認手機拿到的是不是新版）
import './style.css';
import { requirePasscode } from './passcode';
import { exportBackup, inAppBrowserName, loadProfilesFromStorage, readBackup, requestPersist, saveProfilesToStorage } from './store';
import { VoiceIdEngine } from './dsp/engine';
import { CamppBackend, loadCamppEmbedder } from './dsp/campp';
import { GmmBackend } from './dsp/speaker';
import { AmbientMonitor, loadCedTagger, type AmbientState } from './dsp/ambient';
import { pcm16ToFloat } from './dsp/features';
import { ASR_MODELS, StreamingAsr, type AsrModelId } from './dsp/asr';
import type { Profile } from './dsp/types';
import { fromSentence, voteFrom, type TimelineItem } from './attribution';
import { Captions, type Attribution } from './captions';
import { detectPlatform, listMics, type MicSource, type Platform } from './platform';
import { RemoteAsr, remoteSettings, type ComputeMode } from './remote';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ENROLL_SEC = 20; // 錄久一點聲紋比較穩（同類產品也是約 20 秒）
const MIN_ENROLL_SEC = 8;
const STORE_KEY = 'voiceid.profiles.v1';
const SETTINGS_KEY = 'voiceid.settings.v2.'; // 後面接引擎種類
const MIC_KEY = 'voiceid.mic.v1';
const FILTER_KEY = 'voiceid.filterStrangers.v1';

let engine: VoiceIdEngine;
let platform: Platform;
let source: MicSource = 'browser';
let micOn = false;
const history: string[] = [];
let lastConf = 0;
let quiet = true;
let current: string | null = null; // 目前畫面上顯示的說話者
let micId = '';
let micDenoised = false; // 這次聆聽的麥克風有沒有開系統降噪
let capOnlyOn = false; // 「只開字幕」模式進行中
let asr: StreamingAsr | null = null; // 本機語音辨識
let asrOn = false;
let captionEngine: 'local' | 'browser' = 'local';
const CAP_ENGINE_KEY = 'voiceid.capEngine.v1';
const ASR_MODEL_KEY = 'voiceid.asrModel.v1';
let asrModel: AsrModelId = 'zhen';
const CALIB_KEY = 'voiceid.ambientCalib.v2'; // v2：改用估計分貝，舊的校正值不再適用
const SENS_KEY = 'voiceid.ambientSens.v1';
let ambient: AmbientMonitor = new AmbientMonitor(null);
let amb: AmbientState | null = null; // 最新的環境狀態
const captions = new Captions();
// 電腦運算：連到自己電腦上的 VoiceID 服務；斷線就自動改回手機本機辨識
const remote = new RemoteAsr();
let computeMode: ComputeMode = remoteSettings.mode;
let useRemote = false; // 這次聆聽目前有沒有連上電腦（電腦負責修正每一句字幕）
let segId = 0;
let lastSegEnd = 0;
let lastSceneKey = '';
let filterStrangers = true; // 只顯示認識的人（濾掉陌生人）
let lastStranger = false; // 最近一次判斷是不是陌生人
/** 聲紋辨識的時間軸：給字幕「整句投票」用 */
const timeline: TimelineItem[] = [];
/** 最近 50 句的說話者判斷紀錄（除錯用：在瀏覽器主控台輸入 voiceidDebug 可以看） */
const attrLog: { start: number; end: number; best: string | null; score: number | null }[] = [];
(window as unknown as { voiceidDebug: unknown }).voiceidDebug = { attrLog, timeline };
captions.liveAttribute = (start: number, end: number): Attribution => voteFrom(timeline, start, end, filterStrangers);
captions.attribute = async (start: number, end: number): Promise<Attribution> => {
  // 整句聲紋判斷；句子太短（人聲不到 0.8 秒）才退回投票
  const r = await engine.identifyRange(start, end);
  attrLog.push({ start, end, best: r?.best?.name ?? null, score: r?.best ? +r.best.score.toFixed(3) : null });
  if (attrLog.length > 50) attrLog.shift();
  if (r?.best) {
    const th = engine.backend instanceof CamppBackend ? engine.settings.threshold - engine.backend.sentenceOffset : null;
    // 短句（人聲不到 1.5 秒）聲紋比較不可靠：要更像（+0.1）才標名字；介於中間標「？」保留，不當陌生人濾掉
    if (th !== null && r.voicedSec < 1.5 && r.best.score >= th && r.best.score < th + 0.1) {
      return { speaker: null, stranger: false, drop: false };
    }
    const a = fromSentence(r, th, filterStrangers);
    // 不認識的人：夠長的句子（人聲 ≥ 1 秒）才分組，標成「說話者 1、2…」
    if (a.stranger && r.emb && r.voicedSec >= 1.0) return { ...a, speaker: clusterStranger(r.emb) };
    return a;
  }
  return voteFrom(timeline, start, end, filterStrangers);
};

const whoLabel = (speaker: string | null, stranger: boolean) => (capOnlyOn ? '' : stranger ? speaker ?? '陌生人' : speaker ?? '？');

// ---------- 自動更正：使用者自己列「錯字=正確」 ----------
// （實測過「熱詞加權」讓模型偏向某些詞：在我們的測試集上錯字率沒有改善，反而略增，所以改用最直接的替換）
function wireFixes() {
  const ta = $<HTMLTextAreaElement>('fixes');
  const KEY = 'voiceid.fixes.v1';
  try { ta.value = localStorage.getItem(KEY) || ''; } catch { /* 略過 */ }
  const apply = () => {
    const pairs = ta.value.split(/\n/).map((l) => l.split(/[=＝]/)).filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
      .map(([a, b]) => [a.trim(), b.trim()] as [string, string])
      .sort((x, y) => y[0].length - x[0].length); // 長的先換，避免短詞先換掉一部分
    captions.fix = (s) => pairs.reduce((t, [a, b]) => t.split(a).join(b), s);
    $('fixesMsg').textContent = pairs.length ? `已啟用 ${pairs.length} 組自動更正（新出現的字幕才會套用）` : '';
    try { localStorage.setItem(KEY, ta.value); } catch { /* 略過 */ }
  };
  ta.oninput = apply;
  apply();
}

// ---------- 不認識的人分組：說話者 1、2… ----------
// 實測（CAM++）：同一個人兩句話的相似度最低約 0.71，不同人最高約 0.39，所以用 0.5 當「是同一個人」的標準
const CLUSTER_SIM = 0.5;
const MAX_CLUSTERS = 9;
let strangerClusters: { label: string; c: number[]; n: number }[] = [];
function clusterStranger(emb: number[]): string | null {
  let best: (typeof strangerClusters)[number] | null = null;
  let bestS = -1;
  for (const k of strangerClusters) {
    let s = 0;
    for (let i = 0; i < emb.length; i++) s += emb[i] * k.c[i];
    if (s > bestS) { bestS = s; best = k; }
  }
  if (best && bestS >= CLUSTER_SIM) {
    // 中心點往新的這句移一點（平均），再正規化
    const n = Math.min(best.n, 10);
    let norm = 0;
    for (let i = 0; i < emb.length; i++) { best.c[i] = (best.c[i] * n + emb[i]) / (n + 1); norm += best.c[i] ** 2; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < emb.length; i++) best.c[i] /= norm;
    best.n++;
    return best.label;
  }
  if (strangerClusters.length >= MAX_CLUSTERS) return null;
  const label = `說話者 ${strangerClusters.length + 1}`;
  strangerClusters.push({ label, c: emb.slice(), n: 1 });
  return label;
}

// ---------- 儲存（localStorage 在少數環境會丟錯，所以全部包 try） ----------
async function loadProfiles() {
  // localStorage 被清掉時，會從 IndexedDB 的那一份找回來
  engine.profiles = await loadProfilesFromStorage(STORE_KEY);
  try {
    Object.assign(engine.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY + engine.backend.kind) || '{}'));
  } catch { /* 第一次使用或無法讀取 */ }
  if (engine.profiles.length) void saveProfilesToStorage(STORE_KEY, engine.profiles); // 補回另一份
}
function saveProfiles() {
  void saveProfilesToStorage(STORE_KEY, engine.profiles);
  try {
    localStorage.setItem(SETTINGS_KEY + engine.backend.kind, JSON.stringify(engine.settings));
  } catch { /* 無法儲存時只保留在記憶體 */ }
}

// ---------- 眼鏡畫面 ----------
const SOURCE_LABEL: Record<MicSource, string> = {
  glasses: '眼鏡麥克風',
  phone: '手機麥克風',
  browser: '電腦麥克風',
  tab: '分頁/影片的聲音',
};

function bar(v: number, n = 10) {
  const k = Math.round(Math.max(0, Math.min(1, v)) * n);
  return '[' + '#'.repeat(k) + '-'.repeat(n - k) + ']';
}

// ---------- 眼鏡排版 ----------
// G2 畫面 576×288：每行約 24 個中文字寬、最多 7 行。自己斷行，最新的字永遠在最下面，舊的從上面捲掉。
// 字幕大小可選：字越大，每行字數越少、行數越少
let GLASS_COLS = 14;
let GLASS_ROWS = 5;
function setGlassSize(cols: number) {
  GLASS_COLS = cols;
  GLASS_ROWS = Math.max(3, Math.floor((cols + 1) / 2.9)); // 24→8、18→6、14→5、12→4（剛好填滿畫面）
  document.documentElement.style.setProperty('--gcols', String(cols + 1));
}

/** 字寬：中文 / 全形 = 1，英數半形 = 0.5 */
const charW = (c: string) => (c.charCodeAt(0) < 0x2e80 ? 0.5 : 1);
const widthOf = (t: string) => [...t].reduce((a, c) => a + charW(c), 0);

/** 依眼鏡寬度斷行 */
function wrap(t: string, cols = GLASS_COLS): string[] {
  const out: string[] = [];
  let line = '', w = 0;
  for (const c of t) {
    if (w + charW(c) > cols) { out.push(line); line = ''; w = 0; }
    line += c; w += charW(c);
  }
  out.push(line);
  return out;
}

/** 太長就截斷（標題列、環境列用，不換行） */
const clip = (t: string, cols = GLASS_COLS) => {
  if (widthOf(t) <= cols) return t;
  let out = '', w = 0;
  for (const c of t) { if (w + charW(c) > cols - 1) break; out += c; w += charW(c); }
  return out + '…';
};

/** 眼鏡上的字幕：最近幾句 + 正在說的句子，斷行後只留最後 rows 行 */
function captionLines(rows: number): string[] {
  // 一句話裡依停頓分成好幾段：第一段前面加說話者名字，後面幾段縮排對齊
  const fmt = (who: string, text: string) =>
    text.split('\n').map((part, i) => (i === 0 ? (who ? `${who}：` : '') : who ? '　' : '') + part);
  const pieces = captions.lines.slice(-8).flatMap((l) => fmt(whoLabel(l.speaker, l.stranger), l.text));
  if (captions.interim) {
    const a = captions.interimAttribution();
    if (!a.drop) pieces.push(...fmt(whoLabel(a.speaker, a.stranger), captions.interim + '…'));
  }
  if (!pieces.length) pieces.push(captionSupported() ? '（等待說話…）' : '（此音源沒有字幕）');
  return pieces.flatMap((t) => wrap(t)).slice(-rows);
}

function glassesText(): string {
  const lines: string[] = [];
  const state = engine.mode === 'enrolling' ? '建檔中' : micOn ? '聆聽中' : '暫停';
  lines.push(`VoiceID  ${state}`);
  lines.push('');
  if (engine.mode === 'enrolling') {
    lines.push(`  錄音 ${engine.enrolledSeconds().toFixed(0)} / ${ENROLL_SEC} 秒`);
    lines.push(`  ${bar(engine.enrolledSeconds() / ENROLL_SEC, 15)}`);
  } else if (capOnlyOn) {
    lines[0] = 'VoiceID 只開字幕';
    lines.pop();
    lines.push(...captionLines(GLASS_ROWS - 1));
  } else if (!micOn) {
    lines.push(engine.usable().length ? '  單擊：開始聆聽' : '  尚未建立聲紋檔（仍可看字幕）');
    lines.push('');
    lines.push('單擊 開始/暫停   雙擊 離開');
  } else {
    const who = !engine.usable().length || quiet ? '' : ` ${current ?? '辨識中'}`;
    if (GLASS_COLS <= 14) {
      // 大字：狀態和環境合成一行，留更多行給字幕；有警報時整行顯示警報
      const env = amb?.alert ? `!!${amb.alert}!!` : amb ? `${amb.levelLabel}` : '';
      lines[0] = clip(`${filterStrangers ? '[濾]' : ''}${who.trim() || '聆聽中'} ${env}`);
      lines.pop();
      lines.push(...captionLines(GLASS_ROWS - 1));
    } else {
      // 標題列：精簡成一行（聆聽狀態 + 現在說話的人 + 信心條）
      lines[0] = clip(`聆聽中${filterStrangers ? '[濾]' : ''}${who ? ` >${who} ${bar(lastConf, 5)}` : ''}`);
      lines[1] = clip(ambientLine());
      lines.push(...captionLines(GLASS_ROWS - 2));
    }
  }
  return lines.join('\n');
}
function captionSupported() {
  // 本機辨識：任何音源都能用（眼鏡、手機、電腦、分頁）；瀏覽器內建：只能用瀏覽器自己的麥克風
  if (captionEngine === 'local') return !!asr || (computeMode !== 'phone' && !!remoteSettings.url);
  return platform?.kind === 'browser' && source === 'browser' && Captions.supported();
}


let renderTimer: number | null = null;
function render() {
  // 眼鏡更新限制在每 0.4 秒最多一次，避免塞爆藍牙
  if (renderTimer !== null) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    const t = glassesText();
    $('glasses').textContent = t;
    platform?.showOnGlasses(t).catch((e) => console.warn(e));
  }, 400);
}

// ---------- 麥克風控制 ----------
// ---------- 螢幕保持開啟（手機鎖定後瀏覽器會停止收音） ----------
/* eslint-disable @typescript-eslint/no-explicit-any */
let wakeLock: any = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && (navigator as any).wakeLock) wakeLock = await (navigator as any).wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* 不支援或被拒絕：不影響功能 */ }
}
// 切回這個頁面時，系統會自動釋放鎖定，要重新申請
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && micOn) { wakeLock = null; void keepAwake(true); }
});

/** 同一份音訊同時送給聲紋辨識和環境偵測 */
/** 這個時間點是不是已建檔的人在說話（聲紋每 0.5 秒看最近 3 秒，所以每次結果往前涵蓋 3.3 秒） */
function knownAt(t: number): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i];
    if (it.t < t - 200) break; // 更早的判斷涵蓋不到這個時間
    if (it.name && !it.stranger && t >= it.t - 3300) return true;
  }
  return false;
}

function feed(f: Float32Array) {
  engine.pushFloat(f);
  if (engine.mode === 'listening') ambient.push(f);
  // 本機字幕跟聲紋、環境偵測共用同一份音訊；用電腦運算時手機就不跑辨識模型（省電）
  // 字幕一律由手機即時辨識（出字最快、不受網路影響）；連上電腦時，聲音也同步傳過去，讓電腦修正每一句
  if (asrOn) {
    asr?.push(f);
    if (useRemote) remote.push(f);
  }
}

/** 眼鏡第二行：環境狀態（有警報時改成醒目提示） */
function ambientLine(): string {
  if (!amb) return '環境：偵測中…';
  if (amb.alert) return `!! ${amb.alert} 注意周圍 !!`;
  const scene = amb.scene[0] ? ` ${amb.scene[0]}` : '';
  return `${amb.levelLabel}${bar((amb.level + 1) / 4, 4)}${scene} → ${amb.short}`;
}

async function startMic() {
  if (micOn) return;
  // 用電腦運算時收原始聲音：電腦端的辨識模型用原始聲音最準，環境偵測也比較準
  // 麥克風一律收原始聲音：環境偵測、聲紋都在「降噪之前」分析；降噪只在電腦端用於字幕
  micDenoised = false;
  await platform.startMic(
    source,
    (b) => feed(pcm16ToFloat(b)),
    (f) => feed(f),
    micId || undefined,
    micDenoised,
  );
  micOn = true;
  void keepAwake(true);
  refreshMics(); // 取得權限後才看得到麥克風名稱
}
async function stopMic() {
  if (!micOn) return;
  micOn = false;
  void keepAwake(false);
  await platform.stopMic();
  $('level').style.width = '0';
  $('levelText').textContent = '';
}

async function toggleListening() {
  if (engine.mode === 'enrolling') return;
  if (capOnlyOn || micOn) {
    // 停止
    engine.stop();
    asrOn = false;
    asr?.flush();
    captions.stop();
    capOnlyOn = false;
    void keepAwake(false);
    if (micOn) await stopMic();
  } else {
    const capOnly = $<HTMLInputElement>('capOnly').checked;
    if (capOnly && !captionSupported()) {
      $('capStatus').textContent = '目前的字幕引擎在這裡不能用，「只開字幕」無法使用；請把字幕引擎改成「手機本機辨識」';
      return;
    }
    if (!capOnly && !engine.usable().length && !captionSupported()) return alert('請先建立至少一個聲紋檔');
    const mismatch = engine.usable().filter((p) => p.source !== source).map((p) => p.name);
    if (mismatch.length) console.warn(`這些聲紋檔是用其他音源建的，準確度可能下降：${mismatch.join('、')}`);
    history.length = 0;
    quiet = true;
    current = null;
    timeline.length = 0;
    ambient.reset();
    amb = null;
    if (capOnly) engine.stop();
    else engine.startListening();
    // 字幕：瀏覽器內建的語音辨識（iPhone）一定要在「按下按鈕」的當下啟動，所以要在等麥克風之前先開
    if (captionSupported()) {
      captions.mode = captionEngine === 'local' ? 'local' : 'web';
      captions.start();
      if (captionEngine === 'local') {
        asr?.reset();
        remote.reset();
        asrOn = true;
        useRemote = false;
        chooseEngine();
      }
    } else {
      $('capStatus').textContent = captionEngine === 'browser' && !Captions.supported()
        ? '這個瀏覽器不支援內建字幕；請把字幕引擎改成「手機本機辨識」'
        : '目前的字幕引擎只支援麥克風音源；目前只做說話者辨識';
    }
    const needMic = !capOnly || captionEngine === 'local';
    if (capOnly) capOnlyOn = true;
    if (needMic) await startMic();
    else void keepAwake(true); // 只開瀏覽器內建字幕：不占用麥克風，讓它獨占
  }
  updateButtons();
  render();
}

// ---------- 建檔 ----------
let enrollTimer: number | null = null;
async function toggleEnroll() {
  const name = $<HTMLInputElement>('name').value.trim();
  if (engine.mode === 'enrolling') return finishEnroll(name);
  if (!name) return alert('請先輸入名字');
  if (micOn) { engine.stop(); await stopMic(); }
  $('enrollStatus').textContent = '正在開啟麥克風…（瀏覽器若詢問權限，請按「允許」）';
  engine.startEnrolling();
  try {
    await startMic();
  } catch (e) {
    engine.stop();
    $('enrollStatus').textContent = `無法開啟麥克風：${(e as Error).message ?? e}`;
    updateButtons();
    return;
  }
  const t0 = Date.now();
  enrollTimer = window.setInterval(() => {
    const s = engine.enrolledSeconds();
    $('enrollStatus').textContent =
      s === 0 && Date.now() - t0 > 3000
        ? '收不到麥克風聲音：請確認瀏覽器網址列的麥克風權限是「允許」，以及 Windows 設定裡的麥克風沒有被關閉'
        : `錄音中… ${s.toFixed(0)} / ${ENROLL_SEC} 秒（${MIN_ENROLL_SEC} 秒後可提早結束）`;
    render();
    if (s >= ENROLL_SEC) finishEnroll(name);
  }, 250);
  updateButtons();
}

async function finishEnroll(name: string) {
  if (enrollTimer !== null) { clearInterval(enrollTimer); enrollTimer = null; }
  await stopMic();
  if (engine.enrolledSeconds() < MIN_ENROLL_SEC) {
    engine.stop();
    $('enrollStatus').textContent = `錄音太短（至少 ${MIN_ENROLL_SEC} 秒），已取消`;
  } else {
    try {
      $('enrollStatus').textContent = '分析聲紋中…';
      const append = !!findCampp(name);
      const p = await engine.finishEnrolling(name, source, append);
      saveProfiles();
      const n = p.kind === 'campp' ? 1 + (p.extra?.length ?? 0) : 1;
      $('enrollStatus').textContent = append
        ? `✓ 已追加到「${p.name}」，現在共 ${n} 段聲紋（最多 6 段，超過會替換最舊的追加段）。`
        : `✓ 已建立「${p.name}」，有效語音 ${p.seconds.toFixed(1)} 秒。建議按下方「備份聲紋檔」存一份，避免手機清掉資料後要重錄。`;
      void requestPersist();
      $<HTMLInputElement>('name').value = '';
    } catch (e) {
      engine.stop();
      $('enrollStatus').textContent = `建檔失敗：${(e as Error).message}`;
    }
  }
  renderProfiles();
  updateButtons();
  render();
}

/** 已有這個名字的聲紋檔（CAM++）→ 錄音會變成「追加」 */
function findCampp(name: string) {
  return name ? engine.profiles.find((x) => x.name === name && x.kind === 'campp') : undefined;
}

// ---------- 畫面 ----------
function renderProfiles() {
  const ul = $('profiles');
  ul.innerHTML = '';
  for (const p of engine.profiles) {
    const li = document.createElement('li');
    const old = p.kind !== engine.backend.kind ? ' · <b class="warn">舊格式，請重新建檔</b>' : '';
    const segs = p.kind === 'campp' ? 1 + (p.extra?.length ?? 0) : 1;
    li.innerHTML = `<span>${escapeHtml(p.name)} <small>· ${SOURCE_LABEL[p.source]} · ${p.seconds.toFixed(0)} 秒${segs > 1 ? ` · 共 ${segs} 段` : ''}${old}</small></span>`;
    if (p.kind === 'campp' && !old) {
      const add = document.createElement('button');
      add.textContent = '＋追加錄音';
      add.title = '在不同環境（吵雜處、離手機遠一點、說英文）再錄一段，辨識會更準';
      add.onclick = () => {
        if (engine.mode === 'enrolling') return;
        $<HTMLInputElement>('name').value = p.name;
        updateButtons();
        void toggleEnroll().catch((e) => alert(`無法啟動麥克風：${e.message ?? e}`));
      };
      li.append(add);
    }
    const del = document.createElement('button');
    del.textContent = '刪除';
    del.onclick = () => {
      if (!confirm(`刪除「${p.name}」的聲紋檔？`)) return;
      engine.profiles = engine.profiles.filter((x) => x !== p);
      saveProfiles();
      renderProfiles();
      render();
    };
    li.append(del);
    ul.append(li);
  }
}

function updateButtons() {
  const enrolling = engine.mode === 'enrolling';
  const listen = $<HTMLButtonElement>('listen');
  listen.textContent = (micOn || capOnlyOn) && !enrolling ? '暫停聆聽' : '開始聆聽';
  listen.disabled = enrolling;
  const enroll = $<HTMLButtonElement>('enroll');
  enroll.textContent = enrolling ? '結束建檔' : findCampp($<HTMLInputElement>('name').value.trim()) ? '追加錄音' : '錄音建檔';
  enroll.className = enrolling ? 'rec' : '';
  $<HTMLSelectElement>('source').disabled = micOn || capOnlyOn;
  $<HTMLInputElement>('capOnly').disabled = micOn || capOnlyOn;
  $<HTMLSelectElement>('capEngine').disabled = micOn || capOnlyOn;
  $<HTMLSelectElement>('asrModel').disabled = micOn || capOnlyOn;
  updateComputeBadge();
}

async function refreshMics() {
  const row = $('micRow');
  if (platform?.kind !== 'browser') { row.style.display = 'none'; return; }
  const mics = await listMics();
  const sel = $<HTMLSelectElement>('mic');
  sel.innerHTML = '<option value="">系統預設麥克風</option>' +
    mics.filter((m) => m.id && m.id !== 'default' && m.id !== 'communications')
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
  if (micId && [...sel.options].some((o) => o.value === micId)) sel.value = micId;
  else micId = sel.value = '';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function bindSliders() {
  const thr = $<HTMLInputElement>('thr'), mar = $<HTMLInputElement>('mar');
  const r = engine.backend.range;
  [thr.min, thr.max, thr.step] = r.threshold.map(String);
  [mar.min, mar.max, mar.step] = r.margin.map(String);
  const campp = engine.backend.kind === 'campp';
  $('thrLabel').textContent = campp ? '陌生人門檻（相似度低於這個值 → 判為未知）' : '陌生人門檻（z 低於負這個值 → 判為未知）';
  $('marLabel').textContent = '最小差距（第一、二名差距小於這個值 → 判為不確定）';
  $('scoreHint').textContent = campp
    ? '相似度：1 = 完全一樣，0.42 以上通常是同一人。陌生人常被認成某人（或沒被濾掉）→ 門檻調高；本人常被判未知（或被濾掉）→ 門檻調低。不同的人通常在 0.3 以下（同一支手機、同一個房間錄的會稍微高一點）；字幕整句判斷的門檻會自動比這個低 0.07，短句則要再高 0.1 才標名字。'
    : 'z = 離本人基準線幾個標準差（0 附近 = 很像）。';
  const sync = () => {
    engine.settings.threshold = +thr.value;
    engine.settings.margin = +mar.value;
    $('thrVal').textContent = thr.value;
    $('marVal').textContent = mar.value;
    saveProfiles();
  };
  thr.value = String(engine.settings.threshold);
  mar.value = String(engine.settings.margin);
  thr.oninput = mar.oninput = sync;
  sync();
}

// ---------- 引擎事件 ----------
function wireEngine() {
engine.onLevel = (v) => {
  $('level').style.width = `${v * 100}%`;
  $('levelText').textContent =
    v < 0.02 ? `音量 ${Math.round(v * 100)}%：幾乎沒收到聲音，請確認選對麥克風` : `音量 ${Math.round(v * 100)}%`;
};
captions.onChange = () => {
  const box = $('transcript');
  const ia = captions.interimAttribution();
  box.innerHTML = captions.lines
    .slice(-30)
    .map((l) => `<div class="${l.stranger ? 'hint' : ''}">${capOnlyOn ? "" : `<b>${escapeHtml(whoLabel(l.speaker, l.stranger))}</b>：`}${escapeHtml(l.text).replace(/\n/g, '<br>')}</div>`)
    .join('') +
    (captions.interim && !ia.drop
      ? `<div class="hint">${capOnlyOn ? '' : `${escapeHtml(whoLabel(ia.speaker, ia.stranger))}：`}${escapeHtml(captions.interim).replace(/\n/g, '<br>')}…</div>`
      : '');
  box.scrollTop = box.scrollHeight;
  render();
};
captions.onError = (m) => { $('capStatus').textContent = m; };
captions.onStatus = (m) => { $('capState').textContent = useRemote ? m.replace('本機辨識聆聽中（不需網路）', '手機即時辨識＋電腦逐句修正') : m; };
engine.onResult = (r) => {
  quiet = !r.best;
  if (r.best) {
    lastConf = r.conf;
    lastStranger = r.stranger;
    timeline.push({ t: Date.now(), name: r.name ?? (r.stranger ? null : r.best.name), stranger: r.stranger });
    while (timeline.length && timeline[0].t < Date.now() - 120_000) timeline.shift();
    const label = r.stable ?? (lastStranger ? '陌生人' : '不確定');
    current = label;
    // 只在穩定結果改變時記錄（剛開始還沒穩定時不記）
    if (r.changed && history[history.length - 1] !== label) {
      history.push(label);
      if (history.length > 20) history.shift();
    }
    const rows = r.scores
      .map((s, i) => `<tr><td class="${i === 0 ? 'best' : ''}">${escapeHtml(s.name)}</td><td>${escapeHtml(s.detail)}</td></tr>`)
      .join('');
    $('scores').innerHTML = `<tbody><tr><td colspan="2">本輪判斷：<b>${escapeHtml(r.name ?? '未知 / 不確定')}</b>　畫面顯示：<b>${escapeHtml(label)}</b></td></tr>${rows}</tbody>`;
  } else {
    $('scores').innerHTML = '<tbody><tr><td class="hint">聆聽中，但這 2 秒沒偵測到足夠的人聲（看上方音量條有沒有在動）</td></tr></tbody>';
  }
  render();
};
engine.onError = (e) => { $('scores').innerHTML = `<tbody><tr><td class="warn">辨識發生錯誤：${escapeHtml(e.message)}</td></tr></tbody>`; };
}

// ---------- 環境聲音 ----------
function wireAmbient(tagErr: string) {
  try { ambient.calibOffset = Number(localStorage.getItem(CALIB_KEY) || 0); } catch { /* 略過 */ }
  try { ambient.sensitivity = Number(localStorage.getItem(SENS_KEY) || 0); } catch { /* 略過 */ }
  const sens = $<HTMLInputElement>('sens');
  const showSens = () => {
    const v = ambient.sensitivity;
    $('sensVal').textContent = v === 0 ? '標準' : v > 0 ? `+${v}（更容易判成吵）` : `${v}（更不容易判成吵）`;
  };
  sens.value = String(ambient.sensitivity);
  showSens();
  sens.oninput = () => {
    ambient.sensitivity = Number(sens.value);
    try { localStorage.setItem(SENS_KEY, sens.value); } catch { /* 略過 */ }
    showSens();
  };
  ambient.isKnown = knownAt; // 已建檔的人說話的聲音不算環境音
  $('ambNote').textContent = tagErr
    ? `聲音分類模型沒有載入（${tagErr}），目前只顯示吵雜程度。請重新執行 install.bat。`
    : '';
  ambient.onUpdate = (st) => {
    amb = st;
    // 告訴電腦現在的環境：有音樂時電腦會開 AI 降噪（人群吵雜時不開，實測反而變差）
    const keys = [st.scene.includes('人聲吵雜') && 'crowd', st.scene.includes('有音樂') && 'music', st.scene.includes('車聲／機器聲') && 'traffic'].filter(Boolean) as string[];
    const k = keys.join(',');
    if (k !== lastSceneKey) { lastSceneKey = k; remote.scene(keys); }
    $('ambStatus').textContent = st.alert ? `⚠ ${st.alert}！注意周圍` : `${st.levelLabel}${st.scene.length ? '・' + st.scene.join('、') : ''}`;
    $('ambStatus').className = 'amb-status' + (st.alert ? ' alert' : ` lv${st.level}`);
    $('ambAdvice').textContent = st.alert ? '' : `建議：${st.advice}`;
    const p = st.probs;
    $('ambDetail').textContent =
      `環境音量約 ${st.floorDb.toFixed(0)} 分貝（估計${micDenoised ? '；目前開著降噪，音樂和背景聲會被壓低，可能誤判成安靜' : ''}）・音量起伏 ${st.fluct.toFixed(0)} dB` +
      (p ? `・說話 ${(p.speech * 100).toFixed(0)}%・人群 ${(p.crowd * 100).toFixed(0)}%・音樂 ${(p.music * 100).toFixed(0)}%・車聲 ${(p.traffic * 100).toFixed(0)}%` : '') +
      (st.knownFrac > 0 ? `・已排除建檔者說話的聲音（最近 2 秒的 ${(st.knownFrac * 100).toFixed(0)}%）` : '');
    if (st.scene.includes('有音樂') && !st.alert) $('ambAdvice').textContent += '（有音樂，字幕可能比較不準）';
    render();
  };
  ambient.onAlert = (label) => {
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })}　${label}`;
    $('alertLog').prepend(li);
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* 不支援震動 */ }
  };
  $('calib').onclick = () => {
    if (!micOn) return alert('請先按「開始聆聽」，在你覺得是「普通音量」的地方再按校正');
    const off = ambient.calibrate();
    try { localStorage.setItem(CALIB_KEY, String(off)); } catch { /* 略過 */ }
    $('ambAdvice').textContent = `已校正：目前的環境音量設為「普通」（修正 ${off >= 0 ? '+' : ''}${off.toFixed(0)} dB）`;
  };
  $('calibReset').onclick = () => {
    ambient.calibOffset = 0;
    ambient.sensitivity = 0;
    sens.value = '0';
    showSens();
    try { localStorage.removeItem(SENS_KEY); } catch { /* 略過 */ }
    try { localStorage.removeItem(CALIB_KEY); } catch { /* 略過 */ }
    $('ambAdvice').textContent = '已恢復預設校正';
  };
}

// ---------- 字幕引擎 ----------
/** 載入（或換成）指定的本機辨識模型；成功回傳空字串，失敗回傳原因 */
async function loadAsr(id: AsrModelId): Promise<string> {
  $('capState').textContent = `字幕狀態：下載「${ASR_MODELS[id].label}」辨識模型中…（第一次較久，之後會快取）`;
  try {
    const next = await StreamingAsr.load(ASR_MODELS[id].base);
    next.onPartial = (t) => captions.localPartial(t);
    next.onFinal = (t) => {
      const id = ++segId;
      const r = captions.localFinal(t, useRemote ? id : undefined);
      if (r && useRemote) {
        // 請電腦用較準的模型重新辨識這一句（開頭不跨進上一句，避免重複上一句的尾巴）
        remote.segment(id, Math.max(r[0], lastSegEnd - 100), r[1]);
        lastSegEnd = r[1];
      }
    };
    next.onLag = (sec) => { $('capStatus').textContent = `手機處理速度跟不上（落後 ${sec.toFixed(1)} 秒），字幕會延遲`; };
    asr = next;
    $('capState').textContent = `字幕狀態：「${ASR_MODELS[id].label}」模型已就緒`;
    return '';
  } catch (e) {
    console.warn('本機語音辨識模型載入失敗：', e);
    $('capState').textContent = '字幕狀態：模型沒有載入';
    return (e as Error).message ?? String(e);
  }
}

async function setupCaptionEngine() {
  const sel = $<HTMLSelectElement>('capEngine');
  // 字幕語言（本機辨識模型）：中英夾雜 / 純中文，用到哪個才下載
  const langSel = $<HTMLSelectElement>('asrModel');
  try { asrModel = (localStorage.getItem(ASR_MODEL_KEY) as AsrModelId) || 'zhen'; } catch { /* 略過 */ }
  if (!(asrModel in ASR_MODELS)) asrModel = 'zhen';
  langSel.value = asrModel;
  const asrErr = await loadAsr(asrModel);
  langSel.onchange = async () => {
    const id = langSel.value as AsrModelId;
    try { localStorage.setItem(ASR_MODEL_KEY, id); } catch { /* 略過 */ }
    langSel.disabled = true;
    $('listen').setAttribute('disabled', '');
    const err = await loadAsr(id);
    langSel.disabled = false;
    $('listen').removeAttribute('disabled');
    if (err) {
      $('capStatus').textContent = `${ASR_MODELS[id].label}模型載入失敗（${err}）`;
    } else {
      asrModel = id;
      $('capStatus').textContent = '';
      connectRemote(); // 電腦端也換成同一種語言
    }
  };
  const isPhoneOrGlasses = platform.kind === 'even' || /iPhone|iPad|Android/i.test(navigator.userAgent);
  let saved = '';
  try { saved = localStorage.getItem(CAP_ENGINE_KEY) || ''; } catch { /* 略過 */ }
  // 預設：手機 / 眼鏡用本機辨識；電腦上 Chrome 內建的比較準
  captionEngine = saved === 'local' || saved === 'browser'
    ? (saved as 'local' | 'browser')
    : asr && (isPhoneOrGlasses || !Captions.supported()) ? 'local' : Captions.supported() ? 'browser' : 'local';
  // iPhone / iPad 的瀏覽器內建語音辨識實測沒有作用（Safari、Chrome 都一樣）→ 一律用本機辨識
  const isApple = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isApple && asr) captionEngine = 'local';
  if (captionEngine === 'local' && !asr && computeMode === 'phone') captionEngine = 'browser';
  sel.value = captionEngine;
  (sel.querySelector('option[value="local"]') as HTMLOptionElement).disabled = !asr && computeMode === 'phone';
  const browserOpt = sel.querySelector('option[value="browser"]') as HTMLOptionElement;
  browserOpt.disabled = !Captions.supported() || platform.kind === 'even' || isApple;
  if (isApple) browserOpt.textContent = '瀏覽器內建（iPhone 不支援）';
  if (asrErr) $('capStatus').textContent = `本機辨識模型沒有載入（${asrErr}）`;
  sel.onchange = () => {
    captionEngine = sel.value as 'local' | 'browser';
    try { localStorage.setItem(CAP_ENGINE_KEY, captionEngine); } catch { /* 略過 */ }
  };
}

// ---------- 運算方式（電腦 / 手機） ----------
/** 依目前連線狀態決定字幕用電腦還是手機；聆聽中也可以隨時切換 */
function chooseEngine() {
  useRemote = computeMode !== 'phone' && remote.ready;
  if (asrOn) $('capState').textContent = useRemote ? '字幕狀態：手機即時辨識＋電腦逐句修正' : '字幕狀態：本機辨識聆聽中（不需網路）';
  updateComputeBadge();
}

function updateComputeBadge() {
  const b = $('computeBadge');
  if (computeMode === 'phone') { b.textContent = '手機運算'; b.className = 'badge'; return; }
  if (remote.ready) { b.textContent = asrOn ? '電腦修正中' : '已連上電腦'; b.className = 'badge pc'; return; }
  b.textContent = asrOn && asr ? '手機運算中' : '手機運算';
  b.className = 'badge';
}

function connectRemote() {
  if (computeMode === 'phone') { remote.disconnect(); return; }
  const url = remoteSettings.url, key = remoteSettings.key;
  if (!url || !key) { remote.disconnect(); $('remoteState').textContent = '電腦運算：請填入電腦網址和通行金鑰'; return; }
  remote.connect(url, key, asrModel, 'auto');
}

async function wireCompute() {
  await remoteSettings.restore();
  try { const m = localStorage.getItem(ASR_MODEL_KEY) as AsrModelId; if (m && m in ASR_MODELS) asrModel = m; } catch { /* 略過 */ }
  // 分享連結可以直接帶設定：…/voiceid/?pc=電腦網址&k=通行金鑰（填好後會從網址列移除）
  try {
    const q = new URLSearchParams(location.search);
    const pc = q.get('pc'), k = q.get('k');
    if (pc && k) {
      remoteSettings.url = pc;
      remoteSettings.key = k;
      if (remoteSettings.mode === 'phone') remoteSettings.mode = 'auto';
      computeMode = remoteSettings.mode;
      q.delete('pc'); q.delete('k');
      window.history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    }
  } catch { /* 略過 */ }
  const mode = $<HTMLSelectElement>('computeMode');
  const url = $<HTMLInputElement>('remoteUrl');
  const key = $<HTMLInputElement>('remoteKey');
  mode.value = computeMode;
  url.value = remoteSettings.url;
  key.value = remoteSettings.key;
  const showFields = () => { $('remoteFields').style.display = computeMode === 'phone' ? 'none' : ''; };
  showFields();
  mode.onchange = () => {
    computeMode = mode.value as ComputeMode;
    remoteSettings.mode = computeMode;
    showFields();
    connectRemote();
    chooseEngine();
  };
  $('remoteTest').onclick = () => {
    remoteSettings.url = url.value.trim();
    remoteSettings.key = key.value.trim();
    connectRemote();
  };
  remote.onPartial = (t) => { if (useRemote) captions.localPartial(t); };
  remote.onFinal = (t, s, e, id) => { if (useRemote) captions.remoteFinal(t, s, e, id); };
  remote.onRevise = (id, t) => captions.revise(id, t);
  remote.onLag = (sec) => { $('capStatus').textContent = `電腦處理速度跟不上或網路太慢（落後 ${sec.toFixed(1)} 秒）`; };
  remote.onState = (st, msg) => {
    const extra = st === 'ready'
      ? `（${remote.info.sensevoice ? '高準確度整句辨識' : '串流辨識'}${remote.info.denoise ? '・有音樂時自動降噪' : ''}）・已記住，下次開網站會自動連線`
      : '';
    $('remoteState').textContent = `電腦運算：${msg}${extra}`;
    $('remoteState').className = st === 'error' ? 'hint warn' : 'hint';
    chooseEngine();
  };
  connectRemote();
  updateComputeBadge();
}

// ---------- 備份 / 還原 ----------
function wireBackup() {
  $('backup').onclick = async () => {
    if (!engine.profiles.length && !remoteSettings.url) return alert('目前沒有聲紋檔或設定可以備份');
    const r = await exportBackup(engine.profiles, { url: remoteSettings.url, key: remoteSettings.key, mode: remoteSettings.mode });
    $('backupMsg').textContent =
      r === 'shared' ? '✓ 已產生備份檔（請存到「檔案」或傳 LINE 給自己保存）'
      : r === 'downloaded' ? '✓ 備份檔已下載'
      : '已取消';
  };
  const input = $<HTMLInputElement>('restoreFile');
  $('restore').onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const { profiles: list, remote: rs } = await readBackup(f);
      if (rs) { // 備份檔裡有電腦運算設定：一起還原
        remoteSettings.url = rs.url;
        remoteSettings.key = rs.key;
        if (rs.mode === 'auto' || rs.mode === 'pc' || rs.mode === 'phone') remoteSettings.mode = rs.mode;
        computeMode = remoteSettings.mode;
        $<HTMLSelectElement>('computeMode').value = computeMode;
        $<HTMLInputElement>('remoteUrl').value = rs.url;
        $<HTMLInputElement>('remoteKey').value = rs.key;
        $('remoteFields').style.display = computeMode === 'phone' ? 'none' : '';
        connectRemote();
      }
      // 合併：同名同類型的以備份檔為準
      const key = (p: Profile) => `${p.kind}:${p.name}`;
      const incoming = new Set(list.map(key));
      engine.profiles = engine.profiles.filter((p) => !incoming.has(key(p))).concat(list);
      saveProfiles();
      void requestPersist();
      renderProfiles();
      render();
      $('backupMsg').textContent = `✓ 已還原 ${list.length} 個聲紋檔：${list.map((p) => p.name).join('、')}${rs ? '，以及電腦運算設定' : ''}`;
    } catch (e) {
      $('backupMsg').textContent = `還原失敗：${(e as Error).message}`;
    }
  };
  // 在 LINE / FB / IG 裡開啟：資料容易被清掉，提醒改用 Safari / Chrome
  const app = inAppBrowserName();
  if (app) $('inAppWarn').textContent = `你現在是在 ${app} 裡開啟，聲紋檔容易消失、麥克風也可能不能用。請點右上角選單，選「用 Safari（或預設瀏覽器）開啟」。`;
}

// ---------- 啟動 ----------
async function boot() {
  $('ver').textContent = `版本 ${__BUILD__}`;
  await requirePasscode(); // 通行碼正確才開始下載模型
  $('platform').textContent = '載入聲紋模型中…';
  // 優先用 CAM++ 深度模型；載入失敗（沒下載模型、舊瀏覽器）就改用 GMM 備援
  let modelError = '';
  try {
    engine = new VoiceIdEngine(new CamppBackend(await loadCamppEmbedder()));
  } catch (e) {
    modelError = (e as Error).message ?? String(e);
    console.warn('CAM++ 載入失敗，改用 GMM：', e);
    engine = new VoiceIdEngine(new GmmBackend());
  }
  wireEngine();
  // 環境聲音分類模型（失敗就只顯示吵雜程度）
  let tagErr = '';
  try {
    ambient = new AmbientMonitor(await loadCedTagger());
  } catch (e) {
    tagErr = (e as Error).message ?? String(e);
    console.warn('環境聲音模型載入失敗，只提供吵雜程度：', e);
  }
  wireAmbient(tagErr);
  await loadProfiles();
  wireBackup();
  renderProfiles(); // 聲紋檔清單先顯示，不用等其他模型載完
  platform = await detectPlatform('VoiceID 啟動中…');
  source = platform.sources[0];
  $('platform').textContent = (platform.kind === 'even' ? 'Even Hub 模式' : '瀏覽器模式') + ' · ' + engine.backend.label;
  await wireCompute();
  await setupCaptionEngine(); // 要在知道平台（手機 / 眼鏡 / 電腦）之後才能決定預設字幕引擎
  $('engineNote').textContent = modelError ? `CAM++ 模型沒有載入（${modelError}），目前用備援方法，準確度較低。請重新執行 install.bat。` : '';
  if (engine.profiles.some((p) => p.kind !== engine.backend.kind))
    $('enrollStatus').textContent = '辨識引擎已升級：標示「舊格式」的聲紋檔請刪除後重新建檔。';

  if (/iPhone|iPad|Android/i.test(navigator.userAgent)) SOURCE_LABEL.browser = '手機麥克風';
  const sel = $<HTMLSelectElement>('source');
  sel.innerHTML = platform.sources.map((s) => `<option value="${s}">${SOURCE_LABEL[s]}</option>`).join('');
  sel.onchange = () => {
    source = sel.value as MicSource;
    $('micRow').style.display = source === 'browser' ? '' : 'none';
    if (source === 'tab')
      $('enrollStatus').textContent =
        '提示：按下按鈕後，選「Chrome 分頁」→ 選播影片的那個分頁 → 勾選「同時分享分頁音訊」→ 分享';
  };

  const micSel = $<HTMLSelectElement>('mic');
  micSel.onchange = () => {
    micId = micSel.value;
    try { localStorage.setItem(MIC_KEY, micId); } catch { /* 略過 */ }
  };
  try { micId = localStorage.getItem(MIC_KEY) || ''; } catch { /* 略過 */ }
  await refreshMics();
  const langSel = $<HTMLSelectElement>('lang');
  langSel.onchange = () => { captions.lang = langSel.value; };
  $('clearCap').onclick = () => { captions.clear(); strangerClusters = []; }; // 清除字幕時，「說話者 1、2」也重新編號
  wireFixes();
  // 眼鏡字幕大小
  const gSize = $<HTMLSelectElement>('glassSize');
  try { gSize.value = localStorage.getItem('voiceid.glassSize.v2') || '14'; } catch { /* 略過 */ }
  const applyG = () => {
    setGlassSize(Number(gSize.value));
    try { localStorage.setItem('voiceid.glassSize.v2', gSize.value); } catch { /* 略過 */ }
    render();
  };
  gSize.onchange = applyG;
  applyG();
  // 字幕字體大小（記住設定）
  const capSize = $<HTMLInputElement>('capSize');
  try { capSize.value = localStorage.getItem('voiceid.capSize.v1') || '22'; } catch { /* 略過 */ }
  const applySize = () => {
    $('transcript').style.setProperty('--cap-size', `${capSize.value}px`);
    $('capSizeVal').textContent = `${capSize.value}px`;
    try { localStorage.setItem('voiceid.capSize.v1', capSize.value); } catch { /* 略過 */ }
  };
  capSize.oninput = applySize;
  applySize();
  const filt = $<HTMLInputElement>('filterStrangers');
  try { filterStrangers = localStorage.getItem(FILTER_KEY) !== '0'; } catch { /* 略過 */ }
  filt.checked = filterStrangers;
  filt.onchange = () => {
    filterStrangers = filt.checked;
    try { localStorage.setItem(FILTER_KEY, filterStrangers ? '1' : '0'); } catch { /* 略過 */ }
    render();
  };

  $('listen').onclick = () => toggleListening().catch((e) => alert(`無法啟動麥克風：${e.message ?? e}`));
  $('enroll').onclick = () => toggleEnroll().catch((e) => alert(`無法啟動麥克風：${e.message ?? e}`));
  $<HTMLInputElement>('name').oninput = () => updateButtons(); // 打了已建檔的名字 → 按鈕變「追加錄音」
  platform.onTap(async (kind) => {
    if (kind === 'double') {
      await stopMic();
      await platform.exit();
    } else {
      await toggleListening().catch((e) => console.warn(e));
    }
  });

  bindSliders();
  renderProfiles();
  updateButtons();
  render();
}

boot();
