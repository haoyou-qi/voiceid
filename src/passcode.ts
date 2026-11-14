// 通行碼：沒輸入正確通行碼前，不載入模型、不顯示功能
// 注意：網站是公開的靜態網頁，這只能擋一般人，懂程式的人仍可繞過。
// 網頁裡只存「加鹽、反覆雜湊 200,000 次」的結果，看不到明碼，也讓暴力破解變慢。

const PASS = { salt: 'uWDxfN7Y338++dJssIYfIQ==', iter: 200000, hash: 's2KgTRtiefrVdaw5aygAUHRUNA7JXCDcZOMuuc6LX2Q=' };
const KEY = 'voiceid.pass.v1';

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hashOf(code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(PASS.salt), iterations: PASS.iter }, key, 256);
  return b64(bits);
}

/** 等使用者輸入正確通行碼（這支手機輸入過一次就記住；換通行碼後要重新輸入） */
export async function requirePasscode(): Promise<void> {
  // 自己電腦上的開發版不用輸入
  if (['localhost', '127.0.0.1'].includes(location.hostname) && !location.search.includes('gate')) return;
  try {
    if (localStorage.getItem(KEY) === PASS.hash) return;
  } catch { /* 無法讀取就每次都問 */ }

  const box = document.createElement('div');
  box.className = 'gate';
  box.innerHTML = `
    <div class="gate-card">
      <h2>VoiceID</h2>
      <p class="hint">請輸入通行碼</p>
      <input id="gateInput" type="password" autocomplete="current-password" inputmode="text" placeholder="通行碼" />
      <button id="gateBtn" class="primary">進入</button>
      <div id="gateMsg" class="hint warn"></div>
    </div>`;
  document.body.append(box);
  const input = box.querySelector('#gateInput') as HTMLInputElement;
  const btn = box.querySelector('#gateBtn') as HTMLButtonElement;
  const msg = box.querySelector('#gateMsg') as HTMLElement;
  input.focus();

  await new Promise<void>((resolve) => {
    const tryIt = async () => {
      const code = input.value.trim();
      if (!code) return;
      btn.disabled = true;
      msg.textContent = '確認中…';
      const ok = (await hashOf(code)) === PASS.hash;
      btn.disabled = false;
      if (!ok) {
        msg.textContent = '通行碼不正確';
        input.select();
        return;
      }
      try { localStorage.setItem(KEY, PASS.hash); } catch { /* 略過 */ }
      box.remove();
      resolve();
    };
    btn.onclick = () => void tryIt();
    input.onkeydown = (e) => { if (e.key === 'Enter') void tryIt(); };
  });
}
