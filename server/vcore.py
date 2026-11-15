# VoiceID 電腦運算核心：AI 降噪（DPDFNet / GTCRN）、串流字幕（zipformer）、整句重新辨識（SenseVoice）
# 只用 numpy + onnxruntime，跟網站用的是同一系列模型（sherpa-onnx）。
import json
import os

import numpy as np
import onnxruntime as ort

SR = 16000


def make_session(path, threads=2):
    o = ort.SessionOptions()
    o.intra_op_num_threads = threads
    o.inter_op_num_threads = 1
    o.log_severity_level = 3
    return ort.InferenceSession(path, o, providers=['CPUExecutionProvider'])


# ---------------------------------------------------------------- fbank（Kaldi 相容）
class Fbank:
    """80 維 log-mel。window='povey'（zipformer）或 'hamming'（SenseVoice）"""

    def __init__(self, window='povey', high=7600.0, low=20.0, scale=1.0, n_mels=80):
        self.win, self.hop, self.nfft = 400, 160, 512
        n = np.arange(self.win)
        h = 0.5 - 0.5 * np.cos(2 * np.pi * n / (self.win - 1))
        self.window = (h ** 0.85 if window == 'povey' else 0.54 - 0.46 * np.cos(2 * np.pi * n / (self.win - 1))).astype(np.float64)
        self.scale = scale
        mel = lambda f: 1127.0 * np.log(1 + f / 700.0)
        lo, hi = mel(low), mel(high)
        d = (hi - lo) / (n_mels + 1)
        m = mel(np.arange(self.nfft // 2) * SR / self.nfft)
        W = np.zeros((self.nfft // 2, n_mels))
        for b in range(n_mels):
            l, c, r = lo + b * d, lo + (b + 1) * d, lo + (b + 2) * d
            up = (m > l) & (m <= c)
            dn = (m > c) & (m < r)
            W[up, b] = (m[up] - l) / (c - l)
            W[dn, b] = (r - m[dn]) / (r - c)
        self.W = W
        self.buf = np.zeros(0, np.float64)

    def frames(self, x):
        """整段（snip edges）"""
        x = np.asarray(x, np.float64) * self.scale
        T = 0 if len(x) < self.win else 1 + (len(x) - self.win) // self.hop
        if T == 0:
            return np.zeros((0, self.W.shape[1]), np.float32)
        idx = np.arange(self.win)[None] + self.hop * np.arange(T)[:, None]
        f = x[idx]
        f = f - f.mean(1, keepdims=True)
        f[:, 1:] = f[:, 1:] - 0.97 * f[:, :-1]
        f[:, 0] *= 0.03
        f = f * self.window
        spec = np.fft.rfft(f, self.nfft)[:, : self.nfft // 2]
        p = spec.real ** 2 + spec.imag ** 2
        return np.log(np.maximum(p @ self.W, 1.1920928955078125e-7)).astype(np.float32)

    def push(self, x):
        """串流：回傳新產生的 frames"""
        self.buf = np.concatenate([self.buf, np.asarray(x, np.float64)])
        T = 0 if len(self.buf) < self.win else 1 + (len(self.buf) - self.win) // self.hop
        out = self.frames(self.buf[: (T - 1) * self.hop + self.win] / self.scale) if T else np.zeros((0, 80), np.float32)
        self.buf = self.buf[T * self.hop:]
        return out

    def reset(self):
        self.buf = np.zeros(0, np.float64)


# ---------------------------------------------------------------- 簡轉繁、token 接字
def make_converter(s2t_path):
    d = json.load(open(s2t_path, encoding='utf-8'))
    chars, phrases, maxlen = d['chars'], d['phrases'], d['maxLen']

    def conv(text):
        out, i = [], 0
        while i < len(text):
            for L in range(min(maxlen, len(text) - i), 1, -1):
                t = phrases.get(text[i:i + L])
                if t:
                    out.append(t)
                    i += L
                    break
            else:
                out.append(chars.get(text[i], text[i]))
                i += 1
        return ''.join(out)

    return conv


def load_tokens(path):
    tok = {}
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        i = line.rfind(' ')
        if i > 0:
            tok[int(line[i + 1:])] = line[:i]
    return tok


def join_tokens(pieces):
    """中文直接接；英文 ▁ 開頭是新單字；中英之間加空格；英文一律小寫"""
    out = ''
    for t in pieces:
        if not t or t.startswith('<'):
            continue
        if t == '\n':
            out = out.rstrip() + '\n'
            continue
        if t.startswith('▁'):
            t = t[1:].lower()
            if not t:
                continue
            out += (' ' if out and not out.endswith((' ', '\n')) else '') + t
        elif t.isascii():
            out += t.lower()
        else:
            if out and out[-1].isascii() and out[-1].isalnum():
                out += ' '
            out += t
    return out.strip()


# ---------------------------------------------------------------- AI 降噪
class Denoiser:
    """串流降噪：16kHz 進、16kHz 出（延遲一個 window）。kind = dpdfnet / gtcrn"""

    def __init__(self, path=None, threads=1, share=None):
        self.sess = share.sess if share is not None else make_session(path, threads)
        m = self.sess.get_modelmeta().custom_metadata_map
        self.kind = m.get('model_type', 'dpdfnet')
        self.meta = m
        self.n_fft = int(m['n_fft'])
        self.hop = int(m['hop_length'])
        self.wl = int(m['window_length'])
        n = np.arange(self.wl)
        if m['window_type'] == 'vorbis':
            s = np.sin(0.5 * np.pi * (n + 0.5) / (self.wl / 2))
            self.w = np.sin(0.5 * np.pi * s * s)
        else:  # hann_sqrt（periodic hann，同 kaldi-native-fbank 的 hann）
            self.w = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * n / (self.wl - 1)))
        self.reset()

    def reset(self):
        self.ana = np.zeros(self.wl)
        self.ola = np.zeros(self.wl)
        self.pending = np.zeros(0)
        self.started = False
        if self.kind == 'dpdfnet':
            m = self.meta
            st = np.zeros(int(m['state_size']), np.float32)
            erb = np.array([float(v) for v in m['erb_norm_init'].split(',')], np.float32)
            spec = np.array([float(v) for v in m['spec_norm_init'].split(',')], np.float32)
            st[: len(erb)] = erb
            st[len(erb): len(erb) + len(spec)] = spec
            self.state = st
        else:
            shp = lambda k: [int(v) for v in self.meta[k].split(',')]
            self.state = {
                'conv_cache': np.zeros(shp('conv_cache_shape'), np.float32),
                'tra_cache': np.zeros(shp('tra_cache_shape'), np.float32),
                'inter_cache': np.zeros(shp('inter_cache_shape'), np.float32),
            }

    def _frame(self, spec):
        if self.kind == 'dpdfnet':
            x = spec.astype(np.float32).reshape(1, 1, -1, 2)
            e, self.state = self.sess.run(None, {'spec': x, 'state_in': self.state})
            return e.reshape(-1, 2)
        x = spec.astype(np.float32).reshape(1, -1, 1, 2)
        e, c, t, i = self.sess.run(None, {'mix': x, **self.state})
        self.state = {'conv_cache': c, 'tra_cache': t, 'inter_cache': i}
        return e.reshape(-1, 2)

    def push(self, x):
        self.pending = np.concatenate([self.pending, np.asarray(x, np.float64)])
        out = []
        while len(self.pending) >= self.hop:
            hop, self.pending = self.pending[: self.hop], self.pending[self.hop:]
            self.ana = np.concatenate([self.ana[self.hop:], hop])
            X = np.fft.rfft(self.ana * self.w, self.n_fft)
            e = self._frame(np.stack([X.real, X.imag], -1))
            y = np.fft.irfft(e[:, 0] + 1j * e[:, 1], self.n_fft)[: self.wl]
            self.ola = np.concatenate([self.ola[self.hop:], np.zeros(self.hop)])
            self.ola += y * self.w
            if self.started:
                out.append(self.ola[: self.hop].copy())
            self.started = True
        return np.concatenate(out).astype(np.float32) if out else np.zeros(0, np.float32)

    def process(self, x):
        self.reset()
        y = self.push(np.concatenate([x, np.zeros(self.wl)]))
        return y[: len(x)]


# ---------------------------------------------------------------- 串流字幕（zipformer transducer）
class StreamingAsr:
    """跟網站的 asr.ts 行為一樣：停頓 1 秒斷句、0.5 秒換行。事件：on_partial(text)、on_final(text, start_sample, end_sample)"""

    def __init__(self, base=None, threads=2, share=None):
        if share is not None:  # 多人同時連線：共用模型，各自保留辨識狀態
            for k in ('cfg', 'enc', 'dec', 'joi', 'tok', 'to_tw', 'enc_out_names'):
                setattr(self, k, getattr(share, k))
        else:
            self.cfg = json.load(open(os.path.join(base, 'asr_config.json')))
            f = self.cfg.get('files', {'encoder': 'encoder.int8.onnx', 'decoder': 'decoder.int8.onnx', 'joiner': 'joiner.int8.onnx'})
            self.enc = make_session(os.path.join(base, f['encoder']), threads)
            self.dec = make_session(os.path.join(base, f['decoder']), 1)
            self.joi = make_session(os.path.join(base, f['joiner']), 1)
            self.tok = load_tokens(os.path.join(base, 'tokens.txt'))
            self.to_tw = make_converter(os.path.join(base, 's2t.json'))
            self.enc_out_names = [o.name for o in self.enc.get_outputs()]
        self.endpoint_sec, self.soft_break_sec, self.max_sentence_sec = 0.8, 0.5, 12.0
        self.on_partial = lambda t: None
        self.on_final = lambda t, s, e: None
        self.fb = Fbank('povey', 7600.0, 20.0, 1.0)
        self.reset()

    def reset(self):
        self.fb.reset()
        self.feats = np.zeros((0, 80), np.float32)
        self.frame_pos = 0  # 已送進編碼器的 frame（10ms）數
        self.prev_last = -10 * SR  # 上一句最後一個字的位置
        self._reset_states()
        self._reset_sentence()

    def _reset_states(self):
        tm = {'float32': np.float32, 'int64': np.int64}
        self.states = {s['name']: np.zeros(s['shape'], tm[s['type']]) for s in self.cfg['states']}

    def _reset_sentence(self):
        self.hyp = [self.cfg['blank']] * self.cfg['contextSize']
        self.seg, self.seg_t = [], []
        self.breaks = set()
        self.pending_break = False
        self.trailing = 0.0
        self.seg_sec = 0.0
        self.dec_out = None

    def _decoder(self):
        y = np.array([self.hyp[-self.cfg['contextSize']:]], np.int64)
        self.dec_out = self.dec.run(None, {'y': y})[0]

    def push(self, x):
        self.feats = np.concatenate([self.feats, self.fb.push(x)])
        T, S = self.cfg['T'], self.cfg['chunk']
        while len(self.feats) >= T:
            self._chunk(self.feats[:T])
            self.feats = self.feats[S:]
            self.frame_pos += S

    def _chunk(self, x):
        res = self.enc.run(None, {'x': x[None], **self.states})
        for name, v in zip(self.enc_out_names[1:], res[1:]):
            self.states[name[4:]] = v
        eo = res[0][0]
        F = eo.shape[0]
        fsec = self.cfg['chunk'] / 100 / F
        if self.dec_out is None:
            self._decoder()
        changed = False
        for i in range(F):
            logit = self.joi.run(None, {'encoder_out': eo[i:i + 1], 'decoder_out': self.dec_out})[0][0]
            k = int(logit.argmax())
            self.seg_sec += fsec
            t = (self.frame_pos + (i + 0.5) * self.cfg['chunk'] / F) * 160  # 這個字大約出現在第幾個樣本
            if k != self.cfg['blank']:
                last = max(self.breaks) if self.breaks else 0
                if self.pending_break and len(self.seg) - last >= 3:
                    self.breaks.add(len(self.seg))
                self.pending_break = False
                self.hyp.append(k)
                self.seg.append(k)
                self.seg_t.append(t)
                self.trailing = 0.0
                changed = True
                self._decoder()
            else:
                self.trailing += fsec
                if self.seg and self.trailing >= self.soft_break_sec:
                    self.pending_break = True
        if changed:
            self.on_partial(self.text())
        if self.seg and (self.trailing >= self.endpoint_sec or self.seg_sec >= self.max_sentence_sec):
            self.end_sentence()
        elif not self.seg:
            self.seg_sec = 0.0

    def text(self):
        pieces = []
        for i, k in enumerate(self.seg):
            if i in self.breaks:
                pieces.append('\n')
            pieces.append(self.tok.get(k, ''))
        return self.to_tw(join_tokens(pieces))

    def end_sentence(self):
        if not self.seg:
            return
        t = self.text()
        # 往前多抓 1.2 秒（串流模型常漏掉開頭一兩個字），但不跨進上一句
        start = int(max(0, self.prev_last + 0.25 * SR, self.seg_t[0] - 1.2 * SR))
        end = int(self.seg_t[-1] + 0.4 * SR)
        self.prev_last = self.seg_t[-1]
        self._reset_sentence()
        self._reset_states()
        self.on_final(t, start, end)

    def flush(self):
        self.end_sentence()


# ---------------------------------------------------------------- 整句重新辨識（SenseVoice，中英粵日韓）
class SenseVoice:
    def __init__(self, base, s2t_path, threads=4):
        self.sess = make_session(os.path.join(base, 'model.int8.onnx'), threads)
        m = self.sess.get_modelmeta().custom_metadata_map
        self.neg_mean = np.array([float(v) for v in m['neg_mean'].split(',')], np.float32)
        self.inv_std = np.array([float(v) for v in m['inv_stddev'].split(',')], np.float32)
        self.lfr_w, self.lfr_s = int(m['lfr_window_size']), int(m['lfr_window_shift'])
        self.lang = {'auto': int(m['lang_auto']), 'zh': int(m['lang_zh']), 'en': int(m['lang_en']), 'yue': int(m['lang_yue'])}
        self.itn = int(m['with_itn'])
        self.tok = load_tokens(os.path.join(base, 'tokens.txt'))
        self.to_tw = make_converter(s2t_path)
        self.fb = Fbank('hamming', 8000.0, 20.0, 32768.0)

    def lfr(self, f):
        T, D = f.shape
        if T == 0:
            return np.zeros((0, D * self.lfr_w), np.float32)
        out_T = 1 + (T - 1) // self.lfr_s
        left = (self.lfr_w - 1) // 2
        idx = np.arange(out_T)[:, None] * self.lfr_s - left + np.arange(self.lfr_w)[None]
        idx = np.clip(idx, 0, T - 1)
        return f[idx].reshape(out_T, -1)

    def __call__(self, x, lang='auto'):
        f = self.fb.frames(x)
        if len(f) < 10:
            return ''
        f = (self.lfr(f) + self.neg_mean) * self.inv_std
        logits = self.sess.run(None, {
            'x': f[None].astype(np.float32),
            'x_length': np.array([len(f)], np.int32),
            'language': np.array([self.lang.get(lang, 0)], np.int32),
            'text_norm': np.array([self.itn], np.int32),
        })[0][0][4:]
        ids = logits.argmax(-1)
        out, prev = [], -1
        for k in ids:
            k = int(k)
            if k != prev and k != 0:
                out.append(self.tok.get(k, ''))
            prev = k
        t = ''.join(out).replace('▁', ' ').strip()
        return self.to_tw(t)


# ---------------------------------------------------------------- 錯字率
def cer(ref, hyp):
    norm = lambda s: [c for c in s.lower() if c.isalnum()]
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return d[len(h)] / len(r)
