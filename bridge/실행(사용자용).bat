@echo off
title EIA Workbench Bridge
chcp 65001 >nul
cd /d "%~dp0"

rem Try py launcher first (most reliable on Windows), then python.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 bridge_server.py %*
  goto :done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python bridge_server.py %*
  goto :done
)

echo.
echo  [ERROR] Python not found.
echo  Install Python 3.10+ from https://www.python.org/downloads/
echo  (check "Add python.exe to PATH" during install)
echo.

:done
echo.
pause
