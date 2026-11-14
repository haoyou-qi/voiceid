@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VoiceID 安裝
echo ========================================
echo   VoiceID 聲紋辨識 - 一鍵安裝
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] 找不到 Node.js，嘗試用 winget 安裝 Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo 自動安裝 Node.js 失敗。請到 https://nodejs.org 下載 LTS 版安裝，
    echo 裝好後再雙擊一次 install.bat。
    pause
    exit /b 1
  )
  echo.
  echo Node.js 安裝完成。請關掉這個視窗，再雙擊一次 install.bat 繼續。
  pause
  exit /b 0
)
for /f "delims=" %%v in ('node -v') do echo [1/3] Node.js 已安裝：%%v

echo.
echo [2/3] 安裝專案套件 + 下載 CAM++ 聲紋模型（約 28MB，第一次約 2~5 分鐘）...
call npm install
if errorlevel 1 (
  echo.
  echo 套件安裝失敗，請把上面的錯誤訊息截圖給 Claude。
  pause
  exit /b 1
)

echo.
echo [3/3] 跑合成人聲測試...
call npm test

echo.
echo ========================================
echo   安裝完成！
echo   之後雙擊 start.bat  ：瀏覽器模式（電腦麥克風）
echo   之後雙擊 sim.bat    ：Even Hub 眼鏡模擬器
echo ========================================
pause
