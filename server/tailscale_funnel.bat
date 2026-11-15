@echo off
chcp 65001 >nul
rem 讓外面的手機透過固定網址（https://電腦名稱.xxx.ts.net）連到這台電腦的 VoiceID 服務
net session >nul 2>&1
if errorlevel 1 (
  echo 需要系統管理員權限：請在這個檔案上按右鍵 → 「以系統管理員身分執行」
  pause
  exit /b 1
)
where tailscale >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\Tailscale\tailscale.exe" (set "TS=%ProgramFiles%\Tailscale\tailscale.exe") else (
    echo 還沒安裝 Tailscale：請到 https://tailscale.com/download/windows 下載安裝並登入，再執行一次這個檔案。
    pause
    exit /b 1
  )
) else (set "TS=tailscale")
echo 開啟 Funnel（第一次會跳出網址，請用瀏覽器打開並按「允許」）...
"%TS%" funnel --bg 8765
echo.
"%TS%" funnel status
echo.
echo 上面 https://....ts.net 就是你的電腦網址，填到手機網站的「電腦網址」欄位。
pause
