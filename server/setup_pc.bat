@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VoiceID 電腦運算 - 安裝
echo ========================================
echo   VoiceID 電腦運算服務 - 一鍵安裝
echo ========================================
echo.
call "%~dp0findpy.bat"
if not defined PY (
  echo 找不到 Python。請到 https://www.python.org 下載安裝（勾選 Add to PATH），再雙擊一次這個檔案。
  pause
  exit /b 1
)
echo [1/3] 使用 Python：%PY%
echo.
echo [2/3] 安裝 onnxruntime、numpy...
"%PY%" -m pip install --upgrade onnxruntime numpy
if errorlevel 1 (
  echo.
  echo 套件安裝失敗，請把上面的錯誤訊息截圖給 Claude。
  pause
  exit /b 1
)
echo.
echo [3/3] 下載模型（約 240MB，第一次需要幾分鐘）...
"%PY%" download_models.py
if errorlevel 1 (
  echo 模型下載失敗，請確認網路後再試一次。
  pause
  exit /b 1
)
echo.
"%PY%" voiceid_server.py --check
if errorlevel 1 (
  echo 模型載入失敗，請把上面的訊息截圖給 Claude。
  pause
  exit /b 1
)
echo.
echo ========================================
echo   安裝完成！
echo   1. 雙擊 start_server.bat 啟動服務（視窗會顯示「通行金鑰」）
echo   2. 照「電腦運算使用說明.md」設定 Tailscale，讓手機從外面連進來
echo   3. 想開機自動啟動：雙擊 autostart_on.bat
echo ========================================
pause
