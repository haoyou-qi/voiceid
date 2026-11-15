@echo off
chcp 65001 >nul
rem 關閉對外網址（Funnel）：外面就完全連不到這台電腦的 VoiceID 服務。要再開啟就執行 tailscale_funnel.bat
net session >nul 2>&1
if errorlevel 1 (
  echo 需要系統管理員權限：請在這個檔案上按右鍵，選「以系統管理員身分執行」
  pause
  exit /b 1
)
set "TS=tailscale"
where tailscale >nul 2>nul
if errorlevel 1 set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
"%TS%" funnel reset
echo.
echo 已關閉對外網址。朋友會連不到電腦，網站會自動改用手機運算。
pause
