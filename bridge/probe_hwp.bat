@echo off
title SYS-31 HWP PageNum Probe
chcp 65001 >nul
cd /d "%~dp0"

set TARGET=%~1
if not "%TARGET%"=="" goto haveTarget

echo.
echo  == SYS-31 HWP PageNum Probe ==
echo.
echo  Read-only check. Your files are NOT modified.
echo.
echo  Tip: you can also drag a folder onto this .bat file.
echo.
set /p TARGET=Enter folder path [or .hwp file path]: 
if "%TARGET%"=="" goto noTarget

:haveTarget
set PYCMD=
where py >nul 2>nul
if not errorlevel 1 set PYCMD=py -3
if defined PYCMD goto runIt
where python >nul 2>nul
if not errorlevel 1 set PYCMD=python
if defined PYCMD goto runIt
goto noPython

:runIt
echo.
echo  Running probe...
echo.
%PYCMD% probe_hwp_pagenum.py "%TARGET%"
echo.
echo  Done. Send the output above to Claude.
goto end

:noPython
echo.
echo  [ERROR] Python not found.
echo  Install Python 3.10+ from https://www.python.org/downloads/
echo  During install, check "Add python.exe to PATH".
goto end

:noTarget
echo.
echo  [ERROR] No path entered.
goto end

:end
echo.
pause
