# VoiceID：給 AI agent 的專案說明

> 這份文件是給 AI agent（Claude Code、Codex 等）接手開發用的。先讀完再動手。
> 人類版的使用說明在 `README.md` 和 `server/電腦運算使用說明.md`。

## 1. 專案一句話

VoiceID 是給**聽障者**用的對話輔助工具：
- 即時把身邊的對話轉成**中英夾雜字幕**
- 用**聲紋**標出每一句是誰說的，可以**過濾掉陌生人**的話（有開關）
- 偵測**環境吵雜程度**和**聲音種類**（音樂、車聲、人群、警報），提醒使用者
- 字幕可以顯示在手機畫面，也可以顯示在 **Even Realities G2 智慧眼鏡**上

- 擁有者：Wanda（台灣，繁體中文使用者）
- 目前使用者：她自己，加上一位聽障朋友
- 狀態：功能可用，正在評估產品化

## 2. 現況

| 項目 | 內容 |
|---|---|
| 網站 | https://haoyou-qi.github.io/voiceid/ （GitHub Pages，`haoyou-qi/voiceid` 的 `main` 分支 `/docs`） |
| 存取控制 | 網站有通行碼（PBKDF2 雜湊，存在 `src/passcode.ts`，本機 localhost 預設跳過，加 `?gate` 可測） |
| 原始碼 | 本資料夾（使用者電腦上在 `D:\Claud\g2-voiceid`，跟 GitHub repo 內容同步） |
| 電腦運算服務 | `server/`，跑在 Wanda 的 Windows 筆電（4 核心、偏弱），用 Tailscale Funnel 對外 |
| 主要平台 | iPhone Safari（網站／PWA）；Even Hub 外掛（眼鏡）在模擬器測過，還沒有實機 |
| 版本號 | 建置時產生「月日.時分」（台北時間），顯示在網站標題下方 |

## 3. 架構總覽

```
麥克風（16kHz 原始聲音，不開系統降噪）
 │   iPhone：getUserMedia + AudioWorklet 重新取樣
 │   G2 眼鏡：Even Hub SDK audioEvent.audioPcm（16kHz s16le）
 │
 ├─▶ 環境偵測（手機）  src/dsp/ambient.ts, melspec.ts
 │     64 維 mel → CED-tiny（AudioSet 527 類）→ 音樂／車聲／人群／說話／警報
 │     吵雜度 = 3 秒內音量的 30% 分位數（估計分貝 = dBFS + 120 + 校正）
 │     ★ 已建檔者說話的時段會排除（由聲紋時間軸提供 isKnown）
 │
 ├─▶ 聲紋辨識（手機）  src/dsp/engine.ts, campp.ts, fbank.ts
 │     VAD 挑人聲 → 80 維 Kaldi fbank + CMN → CAM++ → 192 維向量
 │     跟每個人的多段聲紋算 cosine，取最大值
 │     即時判斷：每 0.5 秒看最近 3 秒（至少 0.8 秒人聲），門檻 0.42、差距 0.05
 │     整句判斷：src/attribution.ts + main.ts captions.attribute
 │
 └─▶ 即時字幕（手機）  src/dsp/asr.ts, captions.ts
       80 維 fbank → Zipformer 串流 transducer（greedy）→ OpenCC 轉繁體
       停頓 1.0 秒斷句、0.5 秒換行
       │
       └─▶（選用）電腦逐句修正  src/remote.ts ⇄ server/voiceid_server.py
             聲音 μ-law 8 位元經 WebSocket 傳過去 → 每句說完手機送 segment 請求
             → SenseVoice 重新辨識（有音樂時先 DPDFNet 降噪，原始＋降噪各半混合）
             → 傳回 revise，替換那一句的文字

整合：captions.ts（字幕列 + 說話者 + 陌生人過濾）→ 手機畫面 + 眼鏡（main.ts glassesText）
```

**設計原則：字幕一律先由手機即時產生**，電腦只負責事後修正。這樣網路慢或電腦沒開時，字幕都不會中斷。

## 4. 檔案職責

| 檔案 | 職責 |
|---|---|
| `index.html` | 唯一頁面：眼鏡預覽、音源、環境、字幕、運算方式、建檔、分數與門檻 |
| `src/main.ts` | 啟動順序、所有 UI 接線、音訊分流（`feed()`）、眼鏡文字排版、說話者判斷（`captions.attribute`）、電腦運算切換 |
| `src/platform.ts` | 平台抽象：Even Hub bridge（眼鏡）或瀏覽器麥克風；`startMic()` |
| `src/captions.ts` | 字幕狀態：`localPartial/localFinal/remoteFinal/revise`、依序 commit、說話者歸屬、陌生人過濾 |
| `src/attribution.ts` | `fromSentence`（整句聲紋）與 `voteFrom`（即時判斷投票） |
| `src/remote.ts` | 電腦運算用戶端：連線、重連、μ-law 編碼、樣本↔時間對應、`segment()` 請求、`onRevise` |
| `src/store.ts` | 聲紋檔存 localStorage + IndexedDB 雙份、備份／還原 JSON、`idbGet/idbSet` |
| `src/passcode.ts` | 網站通行碼 |
| `src/dsp/engine.ts` | `VoiceIdEngine`：建檔（含追加錄音）、即時判斷、20 秒近期音訊、`identifyRange()` |
| `src/dsp/campp.ts` | CAM++ 後端（預設）：載入模型、`identify()`、`sentenceOffset` |
| `src/dsp/speaker.ts` | GMM/MFCC 備用後端（CAM++ 載入失敗時才用） |
| `src/dsp/fbank.ts` | Kaldi 相容 fbank（聲紋用 ×32768 + CMN；字幕用 `AsrFbankStream`） |
| `src/dsp/asr.ts` | 串流 Zipformer 解碼器（讀 `asr_config.json`）、斷句、OpenCC |
| `src/dsp/ambient.ts` | `AmbientMonitor`：吵雜度、場景標籤、警報、校正、`isKnown` 排除 |
| `src/dsp/melspec.ts` | CED 用的 64 維 mel（torchaudio 風格） |
| `src/dsp/ort.ts` | 取得全域 `ort`（onnxruntime-web 1.17.3，wasm、單執行緒）與 `runExclusive` 排隊 |
| `src/dsp/types.ts` | `Profile`（`campp` 有 `extra[]` 追加段）、`IdResult`、`Backend` |
| `server/voiceid_server.py` | 電腦運算服務：精簡 WebSocket（只用標準函式庫）、金鑰、秘密路徑、防猜、逐句修正、自動重啟 |
| `server/vcore.py` | numpy + onnxruntime 實作：Fbank、Denoiser（DPDFNet/GTCRN）、StreamingAsr、SenseVoice、CER |
| `server/*.bat` | Windows 安裝、啟動、開機自動啟動、Tailscale Funnel 開／關、私人模式 |
| `scripts/setup.mjs` | `npm install` 後自動執行：複製 ORT 到 `public/ort`，下載模型到 `public/models` |
| `scripts/build-pages.mjs` | 建置網站到 `docs/`（esbuild 打包 + 加上快取用的 hash） |
| `models-src/asr*/` | 字幕模型的 `asr_config.json`（狀態張量形狀）和 `s2t.json`（簡轉繁表） |
| `test/synth.test.ts` | 合成聲音的單元測試（`npm test`） |

## 5. 關鍵參數（改之前先看第 9 節的實測結論）

| 參數 | 值 | 位置 |
|---|---|---|
| 即時聲紋視窗 / 間隔 / 最少人聲 | 3 秒 / 0.5 秒 / 0.8 秒 | `engine.ts` settings |
| 陌生人門檻 / 第一二名最小差距 | 0.42 / 0.05 | `campp.ts` defaults（使用者可在頁面調，存 localStorage） |
| 整句門檻 | 門檻 − `sentenceOffset`（0.07）= 0.35 | `campp.ts` |
| 短句（人聲 < 1.5 秒） | 要 ≥ 整句門檻 + 0.1 才標名字；介於中間標「？」，不濾掉 | `main.ts` captions.attribute |
| 整句最少人聲 | 0.5 秒（不足就用即時判斷投票） | `engine.ts` identifyRange |
| 追加錄音 | 每人最多 6 段（1 主 + 5 追加），取最大相似度 | `engine.ts` finishEnrolling |
| 手機斷句 / 換行 | 停頓 1.0 秒 / 0.5 秒 | `asr.ts` |
| 電腦端斷句（舊串流模式） | 0.8 秒 | `vcore.py` |
| 吵雜度分級 | < 45 安靜、< 58 普通、< 68 吵、其餘很吵（估計分貝） | `ambient.ts` LEVEL_EDGES |
| 警報 | 同類 15 秒內不重複，顯示 5 秒 | `ambient.ts` |
| 眼鏡顯示 | 576×288 單色；每行字數 12/14/18/24 可選 | `main.ts` setGlassSize |

## 6. 模型

| 模型 | 用途 | 執行位置 | 大小 | 來源 |
|---|---|---|---|---|
| CAM++ zh-cn（`campplus_zh.onnx`） | 聲紋 192 維 | 手機 | 28MB | sherpa-onnx `speaker-recongition-models`（3D-Speaker） |
| CED-tiny int8 | 環境聲音分類 | 手機 | 6MB | sherpa-onnx `audio-tagging-models` |
| Zipformer 串流中英（small bilingual） | 字幕（預設） | 手機 | 約 70MB（encoder int8，decoder/joiner fp32） | sherpa-onnx `asr-models` |
| Zipformer 串流中文 14M int8 | 字幕（較小） | 手機 | 約 25MB | 同上 |
| SenseVoice int8（zh/en/ja/ko/yue） | 電腦逐句修正 | 電腦 | 約 230MB | sherpa-onnx `asr-models` |
| DPDFNet baseline | 電腦端降噪（只在有音樂時） | 電腦 | 9MB | sherpa-onnx `speech-enhancement-models` |

注意：
- Zipformer 中英版的 decoder 和 joiner **一定要用 fp32**，int8 版會漏掉中文字。
- 斷句時要重設 decoder 和 encoder 的狀態，不然中文句子之後的英文開頭會被吃掉。
- **商用授權還沒逐一確認**。產品化之前要先查清楚每個模型的授權條款。

## 7. 資料儲存（全部在使用者手機的瀏覽器裡）

- 聲紋檔：`voiceid.profiles.v1`（localStorage）＋ IndexedDB 一份；任何一份被清掉時，會用另一份補回
- 設定：`voiceid.settings.v2.<campp|gmm>`、`voiceid.filterStrangers.v1`、`voiceid.capEngine.v1`、`voiceid.asrModel.v1`、`voiceid.ambientCalib.v2`、`voiceid.ambientSens.v1`、`voiceid.glassSize.v2`、`voiceid.capSize.v1`、`voiceid.mic.v1`
- 電腦運算：`voiceid.remote.url.v1`、`voiceid.remote.key.v1`、`voiceid.compute.v1`（`auto`/`phone`），也同步存到 IndexedDB（key `remote`）
- 通行碼：`voiceid.pass.v1`
- 備份檔 JSON：`{ app:'voiceid', version:1, exportedAt, profiles[], remote?{url,key,mode} }`，只有聲紋向量，沒有錄音
- 分享連結 `?pc=<電腦網址含秘密路徑>&k=<金鑰>`：開啟後自動填好設定，再從網址列移除

## 8. 電腦運算協定（`remote.ts` ⇄ `voiceid_server.py`）

- 入口：`wss://<電腦>.ts.net/<秘密路徑>/ws`。其他路徑一律回 404，避免被看出是什麼服務
- 手機 → 電腦：
  - `{"type":"hello","key","model":"zhen|zh","denoise":"auto","mode":"segments","codec":"mulaw"}`
  - 二進位：μ-law 8 位元 16kHz 聲音（每塊約 100ms）
  - `{"type":"segment","id","start","end"}`：用樣本編號請電腦修正某一句
  - `{"type":"scene","scene":["music","crowd","traffic"]}`：環境資訊，電腦用來決定要不要降噪
  - `{"type":"ping","t","rtt"}`
- 電腦 → 手機：`ready`、`revise{id,text}`、`pong{t}`、`lag{sec}`、`error{code:key|busy}`
  - 舊的串流模式（hello 不帶 `mode`）還會送 `partial` 和 `final{id,text,start,end}`
- 每次重新連上，兩邊的樣本編號都從 0 開始算
- 安全機制：
  - 金鑰用 `secrets.compare_digest` 比對
  - 同一來源 10 分鐘內錯 5 次，封鎖 30 分鐘；錯越多次回應越慢
  - 連上後 10 秒內沒送金鑰就斷線；最多同時 4 人
  - 聲音只放記憶體，保留最近 30 秒
- `server/config.json`：`{key, path, port:8765, public_url}`。**含秘密，已列入 .gitignore，絕對不要提交或印出來**
- 程式檔更新後，服務會在沒人使用時自動重啟（`start_server.bat` 會再把它叫起來）
- 紀錄檔：`server/server.log`，只記連線和速度，不記聲音或字幕內容

## 9. 實測結論（重要：很多「直覺上該做」的事，實測反而變差）

測試集：15 句中英文 × {人群、音樂、車聲、咖啡廳} × SNR {10, 5, 0} dB（雜音是合成的）。

| 方案 | 吵雜環境平均錯字率 |
|---|---|
| 手機 Zipformer | 34.9% |
| 電腦 SenseVoice（原始聲音） | 20.0% |
| 電腦 SenseVoice + 有音樂才降噪（現行） | 約 16% |

- **AI 降噪會讓字幕變差**（DPDFNet、GTCRN 都一樣），只有「有音樂、沒有人群」時例外（37.6% → 22.8%）。人群吵雜時會變差（18.5% → 22.1%）
- 降噪時，原始和降噪後的聲音**各一半混合**，比只用降噪後的聲音好
- **聲紋用降噪後的聲音也比較差**（認對率 95.4% → 90.8～93.8%），所以聲紋和環境偵測都用原始聲音
- **iPhone 系統降噪**（`noiseSuppression`）會把音樂壓掉，害環境偵測判成「安靜」，所以已經拿掉，麥克風固定收原始聲音
- μ-law 8 位元傳輸：錯字率 17.8% → 18.2%，影響可忽略，流量減半
- 聲紋模型比較了 7 個（CAM++ zh／zh_en advanced、ERes2Net 系列、WeSpeaker ResNet34）：**現行 CAM++ zh 整體最好**，zh_en advanced 只在人群吵雜時好一點；ERes2NetV2 慢 5 倍。（測試資料只有約 7 人，僅供參考）
- 「每人自動門檻」實測無效，沒有採用
- 即時判斷視窗 3 秒比 2 秒準（吵雜時認對率 81% → 94%）
- 短句（約 1 秒）：整句門檻提高 0.1 後，本人 12/12 認對，陌生人誤認從約 80% 降到約 40%
  - 同一支手機、同一個房間收音時，不同人的相似度也會被拉高到 0.3～0.5，這是目前最大的限制

測試工具在使用者電腦上沒有保留。要重新量測時，可以參考 `server/vcore.py` 的 `cer()` 和 `Denoiser.process()` 重寫評估腳本。

## 10. 建置、測試、部署

```bash
npm install                      # 會自動跑 scripts/setup.mjs（複製 ORT、下載模型，約 200MB）
npm run dev                      # 本機開發 http://localhost:5173（localhost 跳過通行碼）
npx tsc --noEmit                 # 型別檢查（提交前必跑）
npm test                         # 合成聲音單元測試
node scripts/build-pages.mjs     # 建置網站到 docs/
git add -A && git commit && git push   # 推到 haoyou-qi/voiceid main，GitHub Pages 約 1 分鐘生效
```

- 電腦運算服務：`server/setup_pc.bat`（建立 `server/.venv`，裝 onnxruntime 和 numpy，下載模型）→ `server/start_server.bat`
- 端對端測試的做法：Playwright + Chromium 的 `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`，用假麥克風播放測試音檔。測字幕要把 `#capEngine` 設成 `local`，因為桌機預設是瀏覽器內建辨識
- 改完要確認手機上的版本號有更新。iPhone Safari 會快取，請使用者重新整理

## 11. 已知限制與待辦

- 陌生人說短句時，仍然常被誤認成建檔者（見第 9 節）
- 公開網址會先繞經 Tailscale 的國外轉接站，4G 下網路延遲常有 0.2～1.6 秒，偶爾更久
- 使用者的筆電運算力弱：SenseVoice 修正一句 3～11 秒的話要 1.5～6 秒
- iPhone 網站要保持在畫面最上層，鎖螢幕或切到別的 App 就會停止
- G2 實機尚未測試：不確定眼鏡麥克風本身有沒有降噪，延遲也還不知道
- 產品化考量：
  - 聲紋屬於生物特徵個資，需要同意流程和隱私權政策
  - 模型授權要逐一確認
  - 不要宣稱醫療效果
  - 多人使用時，電腦運算要改成雲端
- 考慮中的功能：聲紋檢查（找出混到別人聲音的段落、可以只刪其中一段）、iPhone App、Even Hub 上架

## 12. 給 agent 的工作規則

1. **用繁體中文**回覆使用者，程式碼註解也用繁體中文，延續現有風格。使用者是資料分析背景，不是前端工程師，說明要白話。
2. 新功能**先跟使用者確認方向**再做；確認後就一路做完，不要中途一直問。
3. **主動指出使用者沒想到的風險**，例如隱私、耗電、網路流量、會讓準確度變差的改動。
4. 改辨識相關的參數或流程前，**先用測試資料量測**，附上數字再決定，不要憑感覺調。
5. GitHub repo 是**公開的**：不能提交 `server/config.json`、金鑰、秘密路徑、使用者的 ts.net 網址、`server/net_check.*`、`server/tailscale_check.*`、`分享連結.txt`、`server.log`。
6. 字幕要維持「手機先出字、電腦再修正」：任何改動都不能讓字幕依賴網路才出得來。
7. 環境偵測和聲紋都要用**原始聲音**，降噪只能用在電腦端的字幕修正。
8. 改完要跑型別檢查和端對端測試，再建置、推送，最後告訴使用者新的版本號。
