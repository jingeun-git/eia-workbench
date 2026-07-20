@echo off
title SYS-31 HWP PageNum Probe
chcp 65001 >nul
cd /d "%~dp0"

if "%~1"=="" (
  echo.
  echo  Drag ^& drop a folder (or .hwp file) onto this .bat file.
  echo  Read-only probe - your files are NOT modified.
  echo.
  pause
  exit /b 1
)

set PYCMD=
where py >nul 2>nul && set PYCMD=py -3
if not defined PYCMD ( where python >nul 2>nul && set PYCMD=python )
if not defined PYCMD (
  echo  [ERROR] Python not found.
  pause
  exit /b 1
)

%PYCMD% probe_hwp_pagenum.py "%~1"
echo.
pause
