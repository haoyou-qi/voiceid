// 平台層：在 Even App / 模擬器裡用 SDK；在一般瀏覽器裡改用電腦麥克風。
// 兩種模式對上層提供一樣的介面，辨識引擎不用管自己跑在哪裡。

import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

export type MicSource = 'glasses' | 'phone' | 'browser' | 'tab';

export interface Platform {
  kind: 'even' | 'browser';
  /** 這個平台可選的音源 */
  sources: MicSource[];
  startMic(
    source: MicSource,
    onPcm16: (b: Uint8Array) => void,
    onFloat: (f: Float32Array) => void,
    deviceId?: string,
  ): Promise<void>;
  stopMic(): Promise<void>;
  /** 更新眼鏡畫面文字（瀏覽器模式只更新網頁上的預覽） */
  showOnGlasses(text: string): Promise<void>;
  /** 眼鏡上的單擊 / 雙擊 */
  onTap(cb: (kind: 'click' | 'double') => void): void;
  exit(): Promise<void>;
}

const GLASSES_CONTAINER = { id: 1, name: 'main' };

// ---------------- Even Hub（真機 / 模擬器） ----------------
async function createEvenPlatform(initialText: string): Promise<Platform> {
  const bridge = await waitForEvenAppBridge();

  // 先建立啟動頁：用眼鏡麥克風前一定要先做這步
  const main = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 8,
    containerID: GLASSES_CONTAINER.id,
    containerName: GLASSES_CONTAINER.name,
    content: initialText,
    isEventCapture: 1,
  });
  const res = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
  );
  // 一般瀏覽器裡 SDK 也會回傳 bridge，但建立頁面會失敗（回傳非 0）。
  // 這時代表沒有真的 Even App / 模擬器，改走瀏覽器模式。
  if (res !== 0) throw new Error(`createStartUpPageContainer 回傳 ${res}：不在 Even App / 模擬器裡`);

  let pcmCb: ((b: Uint8Array) => void) | null = null;
  let tapCb: ((k: 'click' | 'double') => void) | null = null;

  bridge.onEvenHubEvent((event: any) => {
    const audio = event.audioEvent;
    if (audio?.audioPcm && pcmCb) pcmCb(audio.audioPcm as Uint8Array);

    // 觸控事件：通常在 textEvent；部分版本走 sysEvent
    const te = event.textEvent;
    const se = event.sysEvent;
    const type = te?.eventType ?? se?.eventType;
    if (!te && !se) return;
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) tapCb?.('double');
    // 注意：CLICK_EVENT 的值是 0，序列化後可能被省略成 undefined，所以 textEvent 沒帶 type 也當單擊
    else if (type === OsEventTypeList.CLICK_EVENT || (te && type === undefined)) tapCb?.('click');
  });

  let lastText = '';
  return {
    kind: 'even',
    sources: ['glasses', 'phone'],
    async startMic(source, onPcm16) {
      pcmCb = onPcm16;
      await bridge.audioControl(true, source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses);
    },
    async stopMic() {
      pcmCb = null;
      await bridge.audioControl(false);
    },
    async showOnGlasses(text) {
      if (text === lastText) return; // 沒變就不送，省藍牙頻寬
      lastText = text;
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: GLASSES_CONTAINER.id, containerName: GLASSES_CONTAINER.name, content: text }),
      );
    },
    onTap(cb) {
      tapCb = cb;
    },
    async exit() {
      await bridge.shutDownPageContainer(1);
    },
  };
}

// ---------------- 一般瀏覽器（電腦麥克風） ----------------
// AudioWorklet：把麥克風音訊切成 100ms（1600 樣本）一包送回主執行緒
const WORKLET = `
// 把麥克風音訊重新取樣到 16kHz（iPhone 不一定接受 16kHz 的 AudioContext），每 100ms 送一包
class Chunker extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    this.ratio = (opt.processorOptions && opt.processorOptions.ratio) || 1; // 輸入取樣率 / 16000
    this.buf = new Float32Array(1600); this.n = 0; this.pos = 0; this.prev = 0;
    // 防混疊：降取樣前先做移動平均低通（寬度 ≈ 取樣率比例），避免 8kHz 以上的雜音折回人聲頻段
    this.k = Math.max(1, Math.round(this.ratio)); this.hist = new Float32Array(this.k); this.hi = 0; this.sum = 0;
  }
  lp(v) {
    this.sum += v - this.hist[this.hi]; this.hist[this.hi] = v; this.hi = (this.hi + 1) % this.k;
    return this.sum / this.k;
  }
  process(inputs) {
    let ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
    } else {
      const raw = ch; ch = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) ch[i] = this.lp(raw[i]);
      // 線性內插降取樣：pos 是下一個輸出樣本在輸入中的位置（相對於這一包的開頭，-1 代表上一包最後一個）
      while (this.pos < ch.length - 1) {
        const i = Math.floor(this.pos), f = this.pos - i;
        const a = i < 0 ? this.prev : ch[i], b = ch[i + 1];
        this.push(a + (b - a) * f);
        this.pos += this.ratio;
      }
      this.pos -= ch.length;
      this.prev = ch[ch.length - 1];
    }
    return true;
  }
  push(v) {
    this.buf[this.n++] = v;
    if (this.n === 1600) { this.port.postMessage(this.buf.slice()); this.n = 0; }
  }
}
registerProcessor('chunker', Chunker);`;

function createBrowserPlatform(): Platform {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  return {
    kind: 'browser',
    // iPhone / Android 瀏覽器不支援抓分頁聲音，只在電腦上提供
    sources: typeof navigator.mediaDevices?.getDisplayMedia === 'function' && !/iPhone|iPad|Android/i.test(navigator.userAgent)
      ? ['browser', 'tab']
      : ['browser'],
    async startMic(source, _onPcm16, onFloat, deviceId) {
      // iPhone：AudioContext 一定要在「使用者點擊」當下建立並喚醒，等完權限視窗再建會被靜音
      try {
        ctx = new AudioContext({ sampleRate: 16000 }); // 能直接 16kHz 最好，跟眼鏡一致
      } catch {
        ctx = new AudioContext(); // 不支援就用裝置預設取樣率，在 worklet 裡重新取樣
      }
      const resumed = ctx.resume().catch(() => undefined);
      if (source === 'tab') {
        // 抓「分頁 / 整個螢幕」的聲音：播影片測試時不用經過喇叭和麥克風
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, // 瀏覽器規定一定要選畫面，選了之後我們只用聲音
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        } as DisplayMediaStreamOptions);
        stream.getVideoTracks().forEach((t) => t.stop());
        if (!stream.getAudioTracks().length) {
          throw new Error('沒有抓到聲音：分享時請選「Chrome 分頁」，並勾選左下角的「同時分享分頁音訊」');
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          // 關掉瀏覽器的降噪 / 自動增益：它們會改變音色，影響聲紋
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
      }
      await resumed;
      if (ctx.state !== 'running') await ctx.resume();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'chunker', { processorOptions: { ratio: ctx.sampleRate / 16000 } });
      node.port.onmessage = (e) => onFloat(e.data as Float32Array);
      // 接一個靜音輸出到 destination，確保瀏覽器會持續處理這條音訊
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
    },
    async stopMic() {
      stream?.getTracks().forEach((t) => t.stop());
      await ctx?.close();
      ctx = null;
      stream = null;
    },
    async showOnGlasses() {
      /* 網頁上的預覽由 main.ts 直接畫 */
    },
    onTap() {},
    async exit() {},
  };
}

/** 2.5 秒內等不到 Even bridge，就當作在一般瀏覽器 */
export async function detectPlatform(initialText: string): Promise<Platform> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3000));
  try {
    const p = await Promise.race([createEvenPlatform(initialText), timeout]);
    if (p) return p;
  } catch (e) {
    console.warn('Even bridge 無法使用，改用瀏覽器模式', e);
  }
  return createBrowserPlatform();
}

/** 列出電腦上的麥克風（取得權限前，名稱可能是空的） */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `麥克風 ${i + 1}` }));
  } catch {
    return [];
  }
}
