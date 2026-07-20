@echo off
rem EIA Workbench Local Bridge launcher (SYS-29)
rem Korean text is NOT used here on purpose - CP949/UTF-8 conflict.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install Windows Python 3.9+ first.
  pause
  exit /b 1
)
python bridge_server.py
pause
