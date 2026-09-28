@echo off
REM Muse <-> Cline bridge: Windows setup helper.
REM Run this once from the bridge repo root on your PC.

echo === Muse-Cline bridge setup ===
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found on PATH. Install Python 3.10+ from python.org
    echo         and re-run this script.
    exit /b 1
)
python --version

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] git not found on PATH. Install Git for Windows and re-run.
    exit /b 1
)
git --version

where cline >nul 2>nul
if errorlevel 1 (
    echo [WARN] 'cline' CLI not found on PATH.
    echo        Install the Cline CLI and run 'cline auth' (or configure your
    echo        DeepSeek API key in Cline) before starting the watcher.
    echo        Your key stays in Cline's local config -- never in this repo.
) else (
    echo [OK] cline CLI found.
)

if not exist "pc\config.json" (
    echo.
    echo Creating pc\config.json from the example -- EDIT IT before running.
    copy "pc\config.example.json" "pc\config.json" >nul
    echo [ACTION] Open pc\config.json in Notepad and set repo_dir and
    echo          default_project_dir to your real paths.
) else (
    echo [OK] pc\config.json already exists.
)

echo.
echo Setup check done. Start the watcher with:
echo     python pc\watcher.py
echo.
echo Keep that window open while you want the loop active.
echo Logs: .watcher-logs\watcher.log inside the repo.
