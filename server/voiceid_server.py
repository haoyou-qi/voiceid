# VoiceID 電腦運算服務
#   手機（網站）把麥克風聲音即時傳過來 → 這台電腦做 AI 降噪 + 字幕辨識 → 把字幕傳回手機。
#   - 串流字幕：zipformer（跟手機同一個模型，邊說邊出字）
#   - 一句話說完：用 SenseVoice（較大、較準、有標點）整句重新辨識，取代原本的字
#   - 聲音只在記憶體裡處理，不存檔；連線需要通行金鑰
# 只需要 Python + numpy + onnxruntime（不需要其他套件）。
import asyncio
import base64
import concurrent.futures as cf
import hashlib
import json
import os
import queue
import secrets
import struct
import sys
import threading
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vcore as V  # noqa: E402

VERSION = '1.0'
CONFIG = os.path.join(HERE, 'config.json')
MODELS = os.path.join(HERE, 'models')
ASR_BASES = {
    'zhen': [os.path.join(HERE, '..', 'public', 'models', 'asr-zhen'), os.path.join(MODELS, 'asr-zhen')],
    'zh': [os.path.join(HERE, '..', 'public', 'models', 'asr'), os.path.join(MODELS, 'asr')],
}
MAX_SESSIONS = 4
SR = 16000


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def load_config():
    cfg = {}
    if os.path.exists(CONFIG):
        try:
            cfg = json.load(open(CONFIG, encoding='utf-8'))
        except Exception:
            cfg = {}
    changed = False
    if not cfg.get('key'):
        cfg['key'] = secrets.token_urlsafe(9)  # 12 個字元
        changed = True
    cfg.setdefault('port', 8765)
    if changed:
        json.dump(cfg, open(CONFIG, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    return cfg


def find(paths, must):
    for p in paths:
        if os.path.exists(os.path.join(p, must)):
            return os.path.abspath(p)
    return None


# ---------------------------------------------------------------- 模型（所有連線共用）
class Models:
    def __init__(self):
        cpu = os.cpu_count() or 4
        self.threads = max(1, min(4, cpu // 2))
        self.asr = {}
        for k, paths in ASR_BASES.items():
            p = find(paths, 'asr_config.json')
            if p:
                self.asr[k] = V.StreamingAsr(p, threads=2)
                log(f'字幕模型 {k}：{p}')
        if not self.asr:
            raise SystemExit('找不到字幕模型：請先在 g2-voiceid 資料夾執行 install.bat')
        s2t = next(os.path.join(p, 's2t.json') for ps in ASR_BASES.values() for p in ps if os.path.exists(os.path.join(p, 's2t.json')))
        sv = find([os.path.join(MODELS, 'sensevoice')], 'model.int8.onnx')
        self.sv = V.SenseVoice(sv, s2t, threads=self.threads) if sv else None
        log('整句重新辨識（SenseVoice）：' + ('已載入' if self.sv else '沒有找到，只用串流字幕'))
        dn = os.path.join(MODELS, 'dpdfnet_baseline.onnx')
        self.dn = V.Denoiser(dn) if os.path.exists(dn) else None
        log('AI 降噪（DPDFNet）：' + ('已載入' if self.dn else '沒有找到'))
        self.sv_lock = threading.Lock()


# ---------------------------------------------------------------- 一個手機連線
class Session:
    def __init__(self, models: Models, send, hello):
        self.m = models
        self.send = send  # 執行緒安全的傳送函式（json dict）
        model = hello.get('model') if hello.get('model') in models.asr else next(iter(models.asr))
        self.lang = 'zh' if model == 'zh' else 'auto'
        self.asr = V.StreamingAsr(share=models.asr[model])
        self.asr.on_partial = lambda t: self.send({'type': 'partial', 'text': t})
        self.asr.on_final = self._on_final
        self.denoise_mode = hello.get('denoise', 'auto')  # auto / on / off
        self.scene = set()
        self.dn = V.Denoiser(share=models.dn) if models.dn else None
        self.q = queue.Queue()
        self.raw = np.zeros(0, np.float32)  # 最近 30 秒原始聲音（整句重新辨識用），只在記憶體
        self.enh = np.zeros(0, np.float32)
        self.base = 0  # self.raw[0] 是第幾個樣本
        self.received = 0
        self.sv_pool = cf.ThreadPoolExecutor(max_workers=1)  # 一個人的字幕依序完成
        self.alive = True
        self.th = threading.Thread(target=self._loop, daemon=True)
        self.th.start()

    def denoise_on(self):
        if not self.dn or self.denoise_mode == 'off':
            return False
        if self.denoise_mode == 'on':
            return True
        # 自動：實測只有「有音樂、沒有人群吵雜」時降噪有幫助（錯字率 37.6% → 22.8%）；
        # 人群吵雜（別人在說話）時降噪反而變差（18.5% → 22.1%），車聲則沒有差別，所以只在有音樂時開
        return 'music' in self.scene and 'crowd' not in self.scene

    def push(self, pcm16: bytes):
        self.q.put(pcm16)

    def control(self, msg):
        if msg.get('type') == 'scene':
            self.scene = set(msg.get('scene') or [])
        elif msg.get('type') == 'flush':
            self.q.put('flush')
        elif msg.get('type') == 'reset':
            self.q.put('reset')

    def close(self):
        self.alive = False
        self.q.put(None)
        self.sv_pool.shutdown(wait=False, cancel_futures=True)

    def _loop(self):
        last_lag = 0.0
        while True:
            item = self.q.get()
            if item is None:
                return
            try:
                if item == 'flush':
                    self.asr.flush()
                    continue
                if item == 'reset':
                    self.asr.reset()
                    if self.dn:
                        self.dn.reset()
                    continue
                x = np.frombuffer(item, np.int16).astype(np.float32) / 32768
                self.received += len(x)
                y = self.dn.push(x) if self.dn else x  # 一直跑降噪，切換時才不會有斷點
                if len(y) < len(x):
                    y = np.concatenate([np.zeros(len(x) - len(y), np.float32), y])
                self.raw = np.concatenate([self.raw, x])
                self.enh = np.concatenate([self.enh, y[: len(x)]])
                if len(self.raw) > 30 * SR:
                    cut = len(self.raw) - 30 * SR
                    self.raw, self.enh, self.base = self.raw[cut:], self.enh[cut:], self.base + cut
                self.asr.push(x)  # 串流字幕一律用原始聲音（實測降噪後的聲音會讓串流模型錯更多）
                lag = self.q.qsize() * len(x) / SR
                if lag > 2 and time.time() - last_lag > 3:
                    last_lag = time.time()
                    self.send({'type': 'lag', 'sec': round(lag, 1)})
            except Exception as e:  # 單一錯誤不要讓整個連線掛掉
                log('處理錯誤：', e)

    def _on_final(self, text, start, end):
        end = min(end, self.received)
        s, e = max(0, start - self.base), max(0, end - self.base)
        dn = self.denoise_on()
        # 降噪時把「原始 + 降噪後」各一半混合再辨識：比只用降噪後的聲音少很多失真造成的錯字
        seg = (0.5 * self.raw[s:e] + 0.5 * self.enh[s:e]) if dn else self.raw[s:e].copy()

        def job():
            best = text
            if self.m.sv is not None and len(seg) > 0.4 * SR:
                try:
                    with self.m.sv_lock:
                        t = self.m.sv(seg, self.lang)
                    if has_words(t):  # 只有標點（雜音被當成一句話）就不採用
                        best = split_lines(t)
                except Exception as ex:
                    log('整句辨識錯誤：', ex)
            if self.alive and has_words(best):
                self.send({'type': 'final', 'text': best, 'stream': text, 'start': start, 'end': end, 'denoise': dn})

        self.sv_pool.submit(job)


def has_words(t):
    return any(c.isalnum() for c in t)


def split_lines(t):
    """整句結果依句號 / 問號換行（眼鏡上比較好讀）"""
    out = ''
    for i, c in enumerate(t):
        out += c
        if c in '。？！?!' and i < len(t) - 1:
            out += '\n'
    return out.strip()


# ---------------------------------------------------------------- 最精簡的 WebSocket（不用安裝其他套件）
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


async def read_frame(r):
    h = await r.readexactly(2)
    fin, op = h[0] & 0x80, h[0] & 0x0F
    masked, n = h[1] & 0x80, h[1] & 0x7F
    if n == 126:
        n = struct.unpack('>H', await r.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack('>Q', await r.readexactly(8))[0]
    if n > 1 << 20:
        raise ValueError('訊息太大')
    mask = await r.readexactly(4) if masked else b''
    data = await r.readexactly(n)
    if masked:
        a = np.frombuffer(data, np.uint8)
        m = np.frombuffer((mask * (n // 4 + 1))[:n], np.uint8)
        data = (a ^ m).tobytes()
    return fin, op, data


def frame(op, data: bytes):
    n = len(data)
    if n < 126:
        h = struct.pack('>BB', 0x80 | op, n)
    elif n < 1 << 16:
        h = struct.pack('>BBH', 0x80 | op, 126, n)
    else:
        h = struct.pack('>BBQ', 0x80 | op, 127, n)
    return h + data


class Server:
    def __init__(self, cfg):
        self.cfg = cfg
        self.models = Models()
        self.sessions = set()

    async def handle(self, r, w):
        peer = 'tunnel'
        try:
            req = await asyncio.wait_for(r.readuntil(b'\r\n\r\n'), 10)
        except Exception:
            w.close()
            return
        lines = req.decode('latin1').split('\r\n')
        path = lines[0].split(' ')[1] if len(lines[0].split(' ')) > 1 else '/'
        hdr = {}
        for ln in lines[1:]:
            if ':' in ln:
                k, v = ln.split(':', 1)
                hdr[k.strip().lower()] = v.strip()
        if hdr.get('upgrade', '').lower() != 'websocket':
            body = json.dumps({'ok': True, 'service': 'VoiceID', 'version': VERSION, 'sessions': len(self.sessions)}).encode()
            if path.startswith('/health'):
                ctype = 'application/json'
            else:
                ctype = 'text/html; charset=utf-8'
                body = ('<meta charset=utf-8><h2>VoiceID 電腦運算服務運作中</h2>'
                        f'<p>目前連線人數：{len(self.sessions)}</p>').encode()
            w.write(b'HTTP/1.1 200 OK\r\nContent-Type: ' + ctype.encode() + b'\r\nAccess-Control-Allow-Origin: *\r\n'
                    b'Content-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
            await w.drain()
            w.close()
            return
        acc = base64.b64encode(hashlib.sha1((hdr.get('sec-websocket-key', '') + GUID).encode()).digest()).decode()
        w.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                 f'Sec-WebSocket-Accept: {acc}\r\n\r\n').encode())
        await w.drain()
        loop = asyncio.get_running_loop()
        out_q: asyncio.Queue = asyncio.Queue()

        def send(obj):  # 可以從任何執行緒呼叫
            loop.call_soon_threadsafe(out_q.put_nowait, json.dumps(obj, ensure_ascii=False))

        async def writer():
            while True:
                m = await out_q.get()
                if m is None:
                    return
                w.write(frame(1, m.encode()) if isinstance(m, str) else m)
                await w.drain()

        wt = asyncio.create_task(writer())
        sess = None
        buf, buf_op = b'', 0
        try:
            while True:
                fin, op, data = await asyncio.wait_for(read_frame(r), 60)
                if op == 0:
                    buf += data
                    if not fin:
                        continue
                    op, data, buf = buf_op, buf, b''
                elif not fin:
                    buf, buf_op = data, op
                    continue
                if op == 8:
                    break
                if op == 9:
                    out_q.put_nowait(frame(10, data))
                    continue
                if op == 10:
                    continue
                if op == 1:
                    msg = json.loads(data.decode('utf-8'))
                    t = msg.get('type')
                    if t == 'ping':
                        send({'type': 'pong', 't': msg.get('t')})
                    elif t == 'hello':
                        if not secrets.compare_digest(str(msg.get('key', '')), self.cfg['key']):
                            send({'type': 'error', 'code': 'key', 'message': '通行金鑰不正確'})
                            await asyncio.sleep(0.2)
                            break
                        if len(self.sessions) >= MAX_SESSIONS:
                            send({'type': 'error', 'code': 'busy', 'message': '電腦目前連線人數已滿'})
                            await asyncio.sleep(0.2)
                            break
                        if sess:
                            sess.close()
                            self.sessions.discard(sess)
                        sess = Session(self.models, send, msg)
                        self.sessions.add(sess)
                        log(f'手機連線（{len(self.sessions)} 人）')
                        send({'type': 'ready', 'version': VERSION, 'sensevoice': self.models.sv is not None,
                              'denoise': self.models.dn is not None})
                    elif sess:
                        sess.control(msg)
                elif op == 2 and sess:
                    sess.push(data)
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.TimeoutError):
            pass
        except Exception as e:
            log('連線錯誤：', e)
        finally:
            if sess:
                sess.close()
                self.sessions.discard(sess)
                log(f'手機離線（{len(self.sessions)} 人）')
            out_q.put_nowait(None)
            try:
                await asyncio.wait_for(wt, 2)
            except Exception:
                pass
            w.close()

    async def run(self):
        port = int(self.cfg['port'])
        srv = await asyncio.start_server(self.handle, '127.0.0.1', port)
        log(f'VoiceID 電腦運算服務已啟動：http://localhost:{port}')
        log(f'通行金鑰：{self.cfg["key"]}（在手機網站的「電腦運算」設定填入）')
        async with srv:
            await srv.serve_forever()


if __name__ == '__main__':
    cfg = load_config()
    if '--port' in sys.argv:
        cfg['port'] = int(sys.argv[sys.argv.index('--port') + 1])
    if '--check' in sys.argv:  # 安裝時檢查：模型都載得起來就結束
        Models()
        log(f'檢查完成。通行金鑰：{cfg["key"]}')
        sys.exit(0)
    try:
        asyncio.run(Server(cfg).run())
    except KeyboardInterrupt:
        pass
