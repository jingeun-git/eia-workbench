@echo off
title EIA Workbench Bridge - Verify
chcp 65001 >nul
cd /d "%~dp0"

echo ==============================================================
echo   EIA Workbench Bridge - Verify built exe
echo ==============================================================
echo.
echo  Checks that the built exe has the SAME features as the source.
echo  Building is not enough - some features drop out silently.
echo.

set PYCMD=
where py >nul 2>nul && set PYCMD=py -3
if not defined PYCMD ( where python >nul 2>nul && set PYCMD=python )
if not defined PYCMD goto NOPY

set EXE=dist\EIAWorkbenchBridge.exe
set ARGS=
if /i "%1"=="full" set EXE=dist\EIAWorkbenchBridge-full.exe
if /i "%1"=="full" set ARGS=--expect-ocr

if not exist "%EXE%" goto NOEXE

echo  Target: %EXE%
echo.
%PYCMD% verify_bundle.py "%EXE%" %ARGS%
if errorlevel 2 goto BLOCKED
if errorlevel 1 goto MISMATCH
goto DONE

:NOPY
echo.
echo  [ERROR] Python not found. Install Python 3.10 or newer.
goto END

:NOEXE
echo.
echo  [ERROR] Not found: %EXE%
echo  Run build_bridge.bat first.
goto END

:BLOCKED
echo.
echo  [BLOCKED] Windows refused to run the exe - could NOT verify.
echo.
echo  This is usually TEMPORARY right after a build:
echo  Defender/SmartScreen holds a brand-new unsigned file while it
echo  checks cloud reputation. Wait a few minutes and run THIS file
echo  again - no rebuild needed.
echo.
echo  If it keeps happening it is a policy block (Smart App Control,
echo  WDAC, AppLocker). Target PCs will likely block it too.
goto END

:MISMATCH
echo.
echo  [WARN] Features differ from the source run.
echo  Do NOT distribute this exe. Send the table above for diagnosis.
goto END

:DONE
echo.
echo  [OK] Verified. Safe to distribute:
echo       %EXE%
echo.
echo  Send ONLY that exe file.
echo  Do NOT send bridge_config.json - it is this PC's token.

:END
echo.
pause
