@echo off
rem Автозапуск пилотного агента печати на Windows 7.
rem
rem Используется schtasks.exe, а не PowerShell-модуль ScheduledTasks: командлета
rem Register-ScheduledTask на Windows 7 (PowerShell 2.0) нет, он появился только
rem в Windows 8. schtasks есть на Windows 7 всегда.
setlocal
set "EXE=%~1"
if "%EXE%"=="" set "EXE=%~dp0flowers-print-agent-win7.exe"

if not exist "%EXE%" (
  echo Не найден файл агента: %EXE%
  echo Укажите путь: install-autostart-win7.cmd C:\FlowersPrint\flowers-print-agent-win7.exe
  exit /b 1
)

rem Права ограничены правами пользователя, который печатает: службе и
rem администратору здесь делать нечего.
schtasks /Create /TN "FlowersPrintAgentWin7" /TR "\"%EXE%\"" /SC ONLOGON /RL LIMITED /F
if errorlevel 1 (
  echo Не удалось создать задачу автозапуска.
  exit /b 1
)

echo.
echo Задача "FlowersPrintAgentWin7" создана: агент запустится при входе пользователя.
echo Запустить сейчас:  schtasks /Run /TN "FlowersPrintAgentWin7"
echo Удалить автозапуск: schtasks /Delete /TN "FlowersPrintAgentWin7" /F
endlocal
