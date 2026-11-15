# VoiceID 電腦運算服務
#   手機（網站）把麥克風聲音即時傳過來 → 這台電腦做 AI 降噪 + 字幕辨識 → 把字幕傳回手機。
#   - 串流字幕：zipformer（跟手機同一個模型，邊說邊出字）
#   - 一句話說完：用 SenseVoice（較大、較準、有標點）整句重新辨識，取代原本的字
#   - 聲音只在記憶體裡處理，不存檔；連線需要通行金鑰
# 只需要 Python + numpy + onnxruntime（不需要其他套件）。
import asyncio
import base64
import collections
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


LOGFILE = os.path.join(HERE, 'server.log')


def log(*a):
    line = ' '.join([time.strftime('%m-%d %H:%M:%S')] + [str(x) for x in a])
    print(line, flush=True)
    try:  # 也寫到 server.log（只記連線狀態，不記聲音或字幕內容），方便檢查問題
        if os.path.exists(LOGFILE) and os.path.getsize(LOGFILE) > 1_000_000:
            os.replace(LOGFILE, LOGFILE + '.old')
        with open(LOGFILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


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
    if not cfg.get('path'):  # 秘密路徑：只有 /秘密路徑/ws 才是真正的入口，其他網址一律「找不到」
        cfg['path'] = secrets.token_urlsafe(12)
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
        self.threads = max(2, min(8, cpu - 1))  # 整句辨識一陣一陣的，多用幾個核心等待比較短
        self.asr = {}
        for k, paths in ASR_BASES.items():
            p = find(paths, 'asr_config.json')
            if p:
                self.asr[k] = V.StreamingAsr(p, threads=1)  # 實測 1 和 2 個執行緒一樣快
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
        self.asr_base = 0  # 串流字幕模型的第 0 個樣本 = 全部收到的第幾個樣本
        self.chunks = collections.deque()  # 最近 30 秒原始聲音 [(起始樣本, 聲音)]（整句重新辨識用），只在記憶體
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

    def _reset_asr(self):
        # 串流字幕模型重新開始時，它的時間從 0 算起：記住對應到第幾個樣本，字幕時間才對得上
        self.asr.reset()
        self.asr_base = self.received

    def close(self):
        self.alive = False
        # 手機斷線：還沒處理的聲音直接丟掉，不要在背景繼續佔用電腦
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass
        self.q.put(None)
        self.sv_pool.shutdown(wait=False, cancel_futures=True)

    def _loop(self):
        last_lag = 0.0
        while True:
            item = self.q.get()
            if item is None or not self.alive:
                return
            # 電腦跟不上（落後超過 4 秒）：丟掉積壓的舊聲音，直接跳到最新的，字幕才不會越來越慢
            if isinstance(item, bytes) and self.q.qsize() > 40:
                dropped = 0
                while self.q.qsize() > 5:
                    nxt = self.q.get_nowait()
                    if not isinstance(nxt, bytes):
                        if nxt is None:
                            return
                        continue
                    dropped += len(nxt) // 2
                    self.chunks.append((self.received, np.frombuffer(nxt, np.int16).astype(np.float32) / 32768))
                    self.received += len(nxt) // 2
                self.asr.flush()
                self._reset_asr()
                log(f'⚠ 電腦處理跟不上，略過 {dropped / SR:.1f} 秒的聲音以追上即時')
                self.send({'type': 'lag', 'sec': round(dropped / SR, 1)})
            try:
                if item == 'flush':
                    self.asr.flush()
                    continue
                if item == 'reset':
                    self._reset_asr()
                    continue
                x = np.frombuffer(item, np.int16).astype(np.float32) / 32768
                self.chunks.append((self.received, x))
                self.received += len(x)
                while self.chunks and self.chunks[0][0] < self.received - 30 * SR:
                    self.chunks.popleft()
                self.asr.push(x)  # 串流字幕一律用原始聲音（實測降噪後的聲音會讓串流模型錯更多）
                lag = self.q.qsize() * len(x) / SR
                if lag > 2 and time.time() - last_lag > 3:
                    last_lag = time.time()
                    self.send({'type': 'lag', 'sec': round(lag, 1)})
                    log(f'⚠ 電腦處理跟不上，落後 {lag:.1f} 秒')
            except Exception as e:  # 單一錯誤不要讓整個連線掛掉
                log('處理錯誤：', e)

    def _on_final(self, text, start, end):
        start, end = start + self.asr_base, end + self.asr_base
        end = min(end, self.received)
        parts = [c[max(0, start - n):max(0, end - n)] for n, c in self.chunks if n + len(c) > start and n < end]
        seg = np.concatenate(parts) if parts else np.zeros(0, np.float32)
        dn = self.denoise_on()
        t_final = time.time()

        def job():
            nonlocal seg
            best = text
            t0 = time.time()
            if self.m.sv is not None and len(seg) > 0.4 * SR:
                try:
                    if dn and self.dn:
                        # 只在需要時才降噪（只處理這一句），平常不浪費電腦資源；
                        # 「原始 + 降噪後」各一半混合再辨識，比只用降噪後的聲音少很多失真造成的錯字
                        seg = 0.5 * seg + 0.5 * self.dn.process(seg)
                    with self.m.sv_lock:
                        t = self.m.sv(seg, self.lang)
                    if has_words(t):  # 只有標點（雜音被當成一句話）就不採用
                        best = split_lines(t)
                except Exception as ex:
                    log('整句辨識錯誤：', ex)
            took = time.time() - t0
            if took > 1.5 or time.time() - t_final > 3:
                log(f'⚠ 整句辨識較慢：句長 {len(seg) / SR:.1f} 秒、辨識 {took:.1f} 秒、等待 {t0 - t_final:.1f} 秒')
            if not self.alive:
                return
            if has_words(best):
                self.send({'type': 'final', 'text': best, 'stream': text, 'start': start, 'end': end, 'denoise': dn})

        if self.alive:
            try:
                self.sv_pool.submit(job)
            except RuntimeError:  # 連線剛好關閉
                pass


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


# ---------------------------------------------------------------- 防止有人一直猜金鑰
class Guard:
    """同一個來源 10 分鐘內錯 5 次 → 封鎖 30 分鐘；全部來源加起來錯很多次 → 每次錯誤都要等比較久。
    金鑰正確的人（你和朋友）不受影響。"""

    WINDOW, LIMIT, BLOCK = 600, 5, 1800

    def __init__(self):
        self.fails = {}  # 來源 → [時間…]
        self.block_until = {}
        self.all_fails = []

    def blocked(self, src):
        t = self.block_until.get(src)
        if t and t > time.time():
            return True
        self.block_until.pop(src, None)
        return False

    def fail(self, src):
        now = time.time()
        self.all_fails = [t for t in self.all_fails if now - t < self.WINDOW] + [now]
        lst = [t for t in self.fails.get(src, []) if now - t < self.WINDOW] + [now]
        self.fails[src] = lst
        if len(self.fails) > 1000:  # 避免記憶體被塞爆
            self.fails = {src: lst}
        if len(lst) >= self.LIMIT and src not in ('127.0.0.1', '::1'):
            self.block_until[src] = now + self.BLOCK
            log(f'⚠ 有人連續輸入錯誤金鑰，已封鎖 30 分鐘（來源 {src}）')
        else:
            log(f'⚠ 有人用錯誤的金鑰嘗試連線（10 分鐘內共 {len(self.all_fails)} 次）')
        # 錯誤次數越多，回應越慢（最多 10 秒）；正確金鑰不會等
        return min(10.0, 1.0 + 0.5 * len(self.all_fails))


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


def write_share_link(cfg):
    """把「給朋友的連結」寫到 分享連結.txt（含金鑰，請只私下傳給朋友）"""
    base = (cfg.get('public_url') or '').rstrip('/')
    if not base:
        log('（提示：在 config.json 加上 "public_url": "https://你的網址.ts.net"，就會自動產生分享連結）')
        return
    import urllib.parse
    pc = f"{base}/{cfg['path']}"
    link = 'https://haoyou-qi.github.io/voiceid/?' + urllib.parse.urlencode({'pc': pc, 'k': cfg['key']})
    txt = (f'電腦網址：{pc}\n通行金鑰：{cfg["key"]}\n\n給朋友的連結（點開會自動設定好，請只私下傳給朋友本人）：\n{link}\n')
    open(os.path.join(HERE, '分享連結.txt'), 'w', encoding='utf-8').write(txt)
    log(f'分享連結已更新：{os.path.join(HERE, "分享連結.txt")}')


class Server:
    def __init__(self, cfg):
        self.cfg = cfg
        self.models = Models()
        self.sessions = set()
        self.guard = Guard()

    async def handle(self, r, w):
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
        # 經過 Tailscale 時，真正的來源 IP 在 X-Forwarded-For；沒有的話就當作同一個來源
        src = (hdr.get('x-forwarded-for', '').split(',')[0].strip()
               or (w.get_extra_info('peername') or ('?',))[0])
        shown = '（正確入口）' if path.split('?')[0] == f"/{self.cfg['path']}/ws" else path.split('?')[0][:40]
        log(f'請求 {shown} 來源 {src} {"websocket" if hdr.get("upgrade", "").lower() == "websocket" else "網頁"}')
        ok_path = path.split('?')[0] == f"/{self.cfg['path']}/ws"
        if hdr.get('upgrade', '').lower() != 'websocket' or not ok_path or self.guard.blocked(src):
            # 一般網頁請求、其他路徑、被封鎖的來源：一律回「找不到」，不透露這是什麼服務
            w.write(b'HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found')
            try:
                await w.drain()
            finally:
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
                # 連上後 10 秒內要送出金鑰，之後 60 秒沒有任何訊息就斷線
                fin, op, data = await asyncio.wait_for(read_frame(r), 60 if sess else 10)
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
                            await asyncio.sleep(self.guard.fail(src))  # 錯越多次等越久，讓人沒辦法一直試
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
        write_share_link(self.cfg)
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
