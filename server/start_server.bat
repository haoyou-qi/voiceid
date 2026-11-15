@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VoiceID 電腦運算服務（關掉這個視窗就會停止）
call "%~dp0findpy.bat"
if not defined PY (
  echo 找不到 Python，請先雙擊 setup_pc.bat
  pause
  exit /b 1
)
:loop
"%PY%" voiceid_server.py
echo.
echo 服務停止了，5 秒後自動重新啟動（要結束請直接關掉視窗）...
timeout /t 5 >nul
goto loop
