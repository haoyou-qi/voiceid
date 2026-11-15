@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 讓外面的手機透過固定網址（https://電腦名稱.xxx.ts.net）連到這台電腦的 VoiceID 服務
rem 執行結果也會存到 tailscale_report.txt，方便 Claude 幫忙檢查
set "R=%~dp0tailscale_report.txt"
net session >nul 2>&1
if errorlevel 1 (
  echo 需要系統管理員權限：請在這個檔案上按右鍵 → 「以系統管理員身分執行」
  echo not-admin > "%R%"
  pause
  exit /b 1
)
set "TS=tailscale"
where tailscale >nul 2>nul
if errorlevel 1 set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if not exist "%TS%" if not "%TS%"=="tailscale" (
  echo 還沒安裝 Tailscale：請到 https://tailscale.com/download/windows 下載安裝並登入，再執行一次這個檔案。
  echo not-installed > "%R%"
  pause
  exit /b 1
)
echo ===== status ===== > "%R%"
"%TS%" status >> "%R%" 2>&1
echo ===== dns ===== >> "%R%"
"%TS%" status --json 2>nul | findstr /i "DNSName BackendState AuthURL" >> "%R%"
echo.
echo 開啟對外網址（Funnel）...
echo 如果下面出現 https://login.tailscale.com/... 的網址：用瀏覽器打開它、按 Enable，回到這裡會自動繼續。
echo.
"%TS%" funnel --bg 8765
echo ===== funnel ===== >> "%R%"
"%TS%" funnel status >> "%R%" 2>&1
echo.
echo ========================================
type "%R%" | findstr /i "ts.net"
echo ========================================
echo 上面 https://....ts.net 開頭的就是你的電腦網址，填到手機網站的「電腦網址」欄位。
echo （結果也存到 tailscale_report.txt 了，告訴 Claude「跑完了」就能幫你檢查）
pause
