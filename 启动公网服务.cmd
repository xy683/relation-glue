@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\public.ps1"
start "" "%~dp0公网地址.txt"
