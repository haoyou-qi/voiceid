@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VoiceID 開發伺服器（關掉這個視窗就會停止）
if not exist node_modules (
  echo 還沒安裝，請先雙擊 install.bat
  pause
  exit /b 1
)
echo 啟動中，幾秒後會自動用瀏覽器開啟 http://localhost:5173
start "" cmd /c "timeout /t 4 >nul && start http://localhost:5173"
call npm run dev
pause
