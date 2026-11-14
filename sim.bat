@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VoiceID 眼鏡模擬器
if not exist node_modules (
  echo 還沒安裝，請先雙擊 install.bat
  pause
  exit /b 1
)
echo 啟動開發伺服器（另一個視窗）...
start "VoiceID 開發伺服器" cmd /c "npm run dev"
timeout /t 5 >nul
echo 啟動 Even Hub 模擬器...
call npx evenhub-simulator http://localhost:5173
pause
