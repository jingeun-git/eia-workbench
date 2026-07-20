@echo off
title EIA Workbench Bridge
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] Checking Python...
set PYCMD=
where py >nul 2>nul && set PYCMD=py -3
if not defined PYCMD ( where python >nul 2>nul && set PYCMD=python )
if not defined PYCMD (
  echo.
  echo  [ERROR] Python not found.
  echo  Install Python 3.10+ from https://www.python.org/downloads/
  echo  IMPORTANT: check "Add python.exe to PATH" during install.
  echo.
  pause
  exit /b 1
)

echo [2/3] Python version:
%PYCMD% -V
if errorlevel 1 (
  echo.
  echo  [ERROR] Python launcher failed. If Microsoft Store opened,
  echo  disable App Execution Aliases: Settings ^> Apps ^> App execution aliases
  echo  then turn OFF python.exe / python3.exe entries.
  echo.
  pause
  exit /b 1
)

echo [3/3] Starting bridge server...
echo.
%PYCMD% bridge_server.py %*
echo.
echo Bridge stopped. (exit code %errorlevel%)
pause
