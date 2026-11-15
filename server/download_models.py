# 下載電腦運算用的模型（只需要第一次）：
#   SenseVoice（整句重新辨識，約 230MB）、DPDFNet（AI 降噪，約 9MB）
# 串流字幕模型直接用網站資料夾裡的那一份（public/models/asr-zhen），不用重複下載。
import os
import shutil
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(HERE, 'models')
REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/'
SV_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'


def fetch(url, dst):
    tmp = dst + '.part'

    def hook(n, bs, total):
        if total > 0:
            p = min(100, n * bs * 100 // total)
            sys.stdout.write(f'\r  {os.path.basename(dst)}  {p}%  ({total // 1048576} MB)')
            sys.stdout.flush()

    urllib.request.urlretrieve(url, tmp, hook)
    os.replace(tmp, dst)
    print()


def main():
    os.makedirs(M, exist_ok=True)
    dn = os.path.join(M, 'dpdfnet_baseline.onnx')
    if not os.path.exists(dn):
        print('下載 AI 降噪模型（DPDFNet）…')
        fetch(REL + 'speech-enhancement-models/dpdfnet_baseline.onnx', dn)
    sv = os.path.join(M, 'sensevoice')
    if not os.path.exists(os.path.join(sv, 'model.int8.onnx')):
        print('下載整句辨識模型（SenseVoice，壓縮檔約 160MB，請稍候）…')
        arc = os.path.join(M, 'sv.tar.bz2')
        if not os.path.exists(arc):
            fetch(REL + f'asr-models/{SV_NAME}.tar.bz2', arc)
        print('  解壓縮中…')
        os.makedirs(sv, exist_ok=True)
        with tarfile.open(arc, 'r:bz2') as t:
            for m in t.getmembers():
                base = os.path.basename(m.name)
                if base in ('model.int8.onnx', 'tokens.txt', 'LICENSE') and m.isfile():
                    with t.extractfile(m) as src, open(os.path.join(sv, base), 'wb') as dst:
                        shutil.copyfileobj(src, dst)
        os.remove(arc)
    print('模型都準備好了。')


if __name__ == '__main__':
    main()
