@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 改成「私人模式」：關閉公開網址（Funnel），只讓登入你 Tailscale 或接受你分享的人（你和朋友）連得到
rem 網址不變：https://電腦名稱.xxx.ts.net
net session >nul 2>&1
if errorlevel 1 (
  echo 需要系統管理員權限：請在這個檔案上按右鍵，選「以系統管理員身分執行」
  pause
  exit /b 1
)
set "TS=tailscale"
where tailscale >nul 2>nul
if errorlevel 1 set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
echo [1/2] 關閉公開網址...
"%TS%" funnel reset
"%TS%" serve reset
echo [2/2] 開啟私人網址（只有你的 Tailscale 裝置和你分享的朋友連得到）...
"%TS%" serve --bg 8765
echo.
"%TS%" serve status
echo.
echo 完成！上面的 https://....ts.net 就是網址（跟原本一樣）。
echo 現在網路上的陌生人和掃描程式都連不到了；手機要先打開 Tailscale App 才連得到。
pause
