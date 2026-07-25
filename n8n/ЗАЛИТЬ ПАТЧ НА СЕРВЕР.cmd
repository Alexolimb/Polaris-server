@echo off
chcp 65001 >nul
title Polaris — залить патч бэкенда на сервер
cd /d "%~dp0"

echo ============================================================
echo  Polaris: заливка патча бэкенда (n8n) на боевой сервер
echo ============================================================
echo.
echo  Что будет сделано:
echo    1. Проверка патча локально (дивиденды / range / часы биржи)
echo    2. PUT воркфлоу polaris-api на сервер
echo    3. Проверка живых эндпоинтов после заливки
echo.
echo  Откат, если что-то не так:
echo    в этой же папке лежит polaris-api.CURRENT-2026-07-25.json —
echo    это состояние ДО патча, его можно залить обратно тем же способом.
echo.
pause

echo.
echo [1/3] Локальная проверка патча...
node check_patch.mjs "polaris-api.PATCHED-ready-to-deploy.json"
if errorlevel 1 (
  echo.
  echo ПРОВЕРКА НЕ ПРОШЛА — на сервер ничего не отправлено.
  pause
  exit /b 1
)

echo.
echo [2/3] Заливка на сервер...
powershell -NoProfile -ExecutionPolicy Bypass -File "deploy.ps1"
if errorlevel 1 (
  echo.
  echo ЗАЛИВКА НЕ УДАЛАСЬ. Ничего страшного: старая версия на сервере работает.
  pause
  exit /b 1
)

echo.
echo [3/3] Проверка живых эндпоинтов...
powershell -NoProfile -ExecutionPolicy Bypass -File "verify.ps1"

echo.
echo ГОТОВО.
pause
