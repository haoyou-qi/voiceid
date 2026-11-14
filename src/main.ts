import './style.css';
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ENROLL_SEC = 15;
const MIN_ENROLL_SEC = 5;
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
let filterStrangers = true; // 只顯示認識的人（濾掉陌生人）
let lastStranger = false; // 最近一次判斷是不是陌生人
/** 聲紋辨識的時間軸：給字幕「整句投票」用 */
const timeline: TimelineItem[] = [];
captions.liveAttribute = (start: number, end: number): Attribution => voteFrom(timeline, start, end, filterStrangers);
captions.attribute = async (start: number, end: number): Promise<Attribution> => {
  // 整句聲紋判斷；句子太短（人聲不到 0.8 秒）才退回投票
  const r = await engine.identifyRange(start, end);
  if (r?.best) {
    const th = engine.backend instanceof CamppBackend ? engine.settings.threshold - engine.backend.sentenceOffset : null;
    return fromSentence(r, th, filterStrangers);
  }
  return voteFrom(timeline, start, end, filterStrangers);
};

const whoLabel = (speaker: string | null, stranger: boolean) => (capOnlyOn ? '' : stranger ? '陌生人' : speaker ?? '？');

// ---------- 儲存（localStorage 在少數環境會丟錯，所以全部包 try） ----------
function loadProfiles() {
  try {
    // 舊版檔案沒有 kind 欄位，都是 GMM 建的
    engine.profiles = (JSON.parse(localStorage.getItem(STORE_KEY) || '[]') as Profile[]).map((p) => ({ ...p, kind: p.kind ?? 'gmm' }) as Profile);
    Object.assign(engine.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY + engine.backend.kind) || '{}'));
  } catch { /* 第一次使用或無法讀取 */ }
}
function saveProfiles() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(engine.profiles));
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
const GLASS_COLS = 24;
const GLASS_ROWS = 7;

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
    // 標題列：精簡成一行（聆聽狀態 + 現在說話的人 + 信心條）
    const who = !engine.usable().length || quiet ? '' : ` > ${current ?? '辨識中'} ${bar(lastConf, 5)}`;
    lines[0] = clip(`聆聽中${filterStrangers ? '[濾]' : ''}${who}`);
    lines[1] = clip(ambientLine());
    lines.push(...captionLines(GLASS_ROWS - 2));
  }
  return lines.join('\n');
}
function captionSupported() {
  // 本機辨識：任何音源都能用（眼鏡、手機、電腦、分頁）；瀏覽器內建：只能用瀏覽器自己的麥克風
  if (captionEngine === 'local') return !!asr;
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
function feed(f: Float32Array) {
  engine.pushFloat(f);
  if (engine.mode === 'listening') ambient.push(f);
  if (asrOn) asr?.push(f); // 本機字幕跟聲紋、環境偵測共用同一份音訊
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
  await platform.startMic(
    source,
    (b) => feed(pcm16ToFloat(b)),
    (f) => feed(f),
    micId || undefined,
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
      if (captionEngine === 'local' && asr) {
        asr.reset();
        asrOn = true;
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
      const p = await engine.finishEnrolling(name, source);
      saveProfiles();
      $('enrollStatus').textContent = `✓ 已建立「${p.name}」，有效語音 ${p.seconds.toFixed(1)} 秒`;
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

// ---------- 畫面 ----------
function renderProfiles() {
  const ul = $('profiles');
  ul.innerHTML = '';
  for (const p of engine.profiles) {
    const li = document.createElement('li');
    const old = p.kind !== engine.backend.kind ? ' · <b class="warn">舊格式，請重新建檔</b>' : '';
    li.innerHTML = `<span>${escapeHtml(p.name)} <small>· ${SOURCE_LABEL[p.source]} · ${p.seconds.toFixed(0)} 秒${old}</small></span>`;
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
  enroll.textContent = enrolling ? '結束建檔' : '錄音建檔';
  enroll.className = enrolling ? 'rec' : '';
  $<HTMLSelectElement>('source').disabled = micOn || capOnlyOn;
  $<HTMLInputElement>('capOnly').disabled = micOn || capOnlyOn;
  $<HTMLSelectElement>('capEngine').disabled = micOn || capOnlyOn;
  $<HTMLSelectElement>('asrModel').disabled = micOn || capOnlyOn;
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
    ? '相似度：1 = 完全一樣，0.42 以上通常是同一人。陌生人常被認成某人（或沒被濾掉）→ 門檻調高；本人常被判未知（或被濾掉）→ 門檻調低。字幕整句判斷的門檻會自動比這個低 0.12。'
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
      ? `<div class="hint">${escapeHtml(whoLabel(ia.speaker, ia.stranger))}：${escapeHtml(captions.interim).replace(/\n/g, '<br>')}…</div>`
      : '');
  box.scrollTop = box.scrollHeight;
  render();
};
captions.onError = (m) => { $('capStatus').textContent = m; };
captions.onStatus = (m) => { $('capState').textContent = m; };
engine.onResult = (r) => {
  quiet = !r.best;
  if (r.best) {
    lastConf = r.conf;
    lastStranger = r.stranger;
    timeline.push({ t: Date.now(), name: r.name ?? (r.stranger ? null : r.best.name), stranger: r.stranger });
    while (timeline.length && timeline[0].t < Date.now() - 120_000) timeline.shift();
    const label = r.stable ?? (lastStranger ? (filterStrangers ? '—（陌生人，已過濾）' : '陌生人') : '不確定');
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
  $('ambNote').textContent = tagErr
    ? `聲音分類模型沒有載入（${tagErr}），目前只顯示吵雜程度。請重新執行 install.bat。`
    : '';
  ambient.onUpdate = (st) => {
    amb = st;
    $('ambStatus').textContent = st.alert ? `⚠ ${st.alert}！注意周圍` : `${st.levelLabel}${st.scene.length ? '・' + st.scene.join('、') : ''}`;
    $('ambStatus').className = 'amb-status' + (st.alert ? ' alert' : ` lv${st.level}`);
    $('ambAdvice').textContent = st.alert ? '' : `建議：${st.advice}`;
    const p = st.probs;
    $('ambDetail').textContent =
      `環境音量約 ${st.floorDb.toFixed(0)} 分貝（估計）・音量起伏 ${st.fluct.toFixed(0)} dB` +
      (p ? `・說話 ${(p.speech * 100).toFixed(0)}%・人群 ${(p.crowd * 100).toFixed(0)}%・音樂 ${(p.music * 100).toFixed(0)}%・車聲 ${(p.traffic * 100).toFixed(0)}%` : '');
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
    next.onFinal = (t) => captions.localFinal(t);
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
  if (captionEngine === 'local' && !asr) captionEngine = 'browser';
  sel.value = captionEngine;
  (sel.querySelector('option[value="local"]') as HTMLOptionElement).disabled = !asr;
  const browserOpt = sel.querySelector('option[value="browser"]') as HTMLOptionElement;
  browserOpt.disabled = !Captions.supported() || platform.kind === 'even' || isApple;
  if (isApple) browserOpt.textContent = '瀏覽器內建（iPhone 不支援）';
  if (asrErr) $('capStatus').textContent = `本機辨識模型沒有載入（${asrErr}）`;
  sel.onchange = () => {
    captionEngine = sel.value as 'local' | 'browser';
    try { localStorage.setItem(CAP_ENGINE_KEY, captionEngine); } catch { /* 略過 */ }
  };
}

// ---------- 啟動 ----------
async function boot() {
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
  loadProfiles();
  platform = await detectPlatform('VoiceID 啟動中…');
  source = platform.sources[0];
  $('platform').textContent = (platform.kind === 'even' ? 'Even Hub 模式' : '瀏覽器模式') + ' · ' + engine.backend.label;
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
  $('clearCap').onclick = () => captions.clear();
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
