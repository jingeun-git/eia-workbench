@echo off
title EIA Workbench Bridge - Build
chcp 65001 >nul
cd /d "%~dp0"

echo ==============================================================
echo   EIA Workbench Bridge - Standalone Build
echo ==============================================================
echo.

set PYCMD=
where py >nul 2>nul && set PYCMD=py -3
if not defined PYCMD ( where python >nul 2>nul && set PYCMD=python )
if not defined PYCMD goto NOPY

%PYCMD% -c "import PyInstaller" >nul 2>nul
if errorlevel 1 goto NOPYI

set MODE=%1
if /i "%MODE%"=="full" goto FULL

echo [1/2] Building lite - OCR excluded
%PYCMD% build_bridge.py
if errorlevel 1 goto FAIL
echo.
echo [2/2] Verifying feature parity
%PYCMD% verify_bundle.py dist\EIAWorkbenchBridge.exe
if errorlevel 2 goto BLOCKED
if errorlevel 1 goto MISMATCH
goto DONE

:FULL
echo [1/2] Building full - OCR included, 1GB+
%PYCMD% build_bridge.py --full
if errorlevel 1 goto FAIL
echo.
echo [2/2] Verifying feature parity
%PYCMD% verify_bundle.py dist\EIAWorkbenchBridge-full.exe --expect-ocr
if errorlevel 2 goto BLOCKED
if errorlevel 1 goto MISMATCH
goto DONE

:NOPY
echo  [ERROR] Python not found.
echo  Install Python 3.10+ and check "Add python.exe to PATH".
goto END

:NOPYI
echo  [ERROR] PyInstaller not installed.
echo  Run: pip install pyinstaller
goto END

:FAIL
echo.
echo  [ERROR] Build failed. See messages above.
goto END

:BLOCKED
echo.
echo  [BLOCKED] Could not verify - Windows refused to run the exe.
echo  This is an application control policy (Smart App Control / WDAC / AppLocker),
echo  not a build error. The exe file itself was created.
echo.
echo  See the message above for how to check.
echo  If this PC blocks it, target PCs will likely block it too.
echo  Consider distributing Python + run_bridge.bat instead.
goto END

:MISMATCH
echo.
echo  [WARN] Build finished but features differ from the source run.
echo  Do NOT distribute this exe. Send the table above for diagnosis.
goto END

:DONE
echo.
echo  [OK] Build and verification passed. See the dist folder.

:END
echo.
pause
