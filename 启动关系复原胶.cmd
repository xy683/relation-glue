@echo off
cd /d "%~dp0"
netstat -ano | findstr /R /C:":5178 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  start "relationship-glue" /min "C:\Users\Administrator\OpenFilm\runtime\node\node.exe" "%~dp0server.mjs"
  timeout /t 2 >nul
)
start "" http://127.0.0.1:5178/