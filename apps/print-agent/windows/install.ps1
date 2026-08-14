<#
.SYNOPSIS
    Установка локального обработчика печати на рабочее место.

.DESCRIPTION
    ПРАВА АДМИНИСТРАТОРА НЕ НУЖНЫ, и это осознанное ограничение. Служба Windows
    потребовала бы их и при установке, и при каждом обновлении, а на складе
    администратор появляется не каждый день. Задача планировщика с триггером
    «вход пользователя» ставится от имени самого пользователя, запускается
    вместе с ним и переживает перезагрузку — этого достаточно.

    Из того же соображения обработчик работает В СЕАНСЕ ПОЛЬЗОВАТЕЛЯ: принтер
    по умолчанию — свойство пользователя, а не машины, и служба под системной
    учётной записью видела бы совсем другой принтер, чем человек за этим
    компьютером.

    Токен устройства здесь не создаётся и не трогается: привязку выполняет сам
    обработчик, обменяв одноразовый код на токен и положив его под DPAPI.
#>

[CmdletBinding()]
param(
    # Каталог со сборкой: содержимое apps/print-agent/dist.
    [Parameter(Mandatory = $true)]
    [string] $SourceDir,

    # Адрес сервера. Записывается в настройку, чтобы человеку осталось ввести
    # только код привязки.
    [Parameter(Mandatory = $false)]
    [string] $ServerUrl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'FloristPrintAgent'
$InstallDir = Join-Path $env:LOCALAPPDATA 'FloristPrintAgent'
$AppDir = Join-Path $InstallDir 'app'

function Fail([string] $Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

# --- Node ---------------------------------------------------------------------
# Проверяется ДО копирования файлов: половина установки хуже её отсутствия.
# Собственного исполняемого файла у этого среза нет (см. README, раздел
# «Честные ограничения»), поэтому Node обязан быть на машине.

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Fail @"
Не найден Node.js.

Установите Node.js версии 24 LTS с https://nodejs.org (пакет .msi для Windows),
затем запустите этот сценарий заново.
"@
}

$versionText = (& $node.Source --version) -replace '^v', ''
$major = [int]($versionText.Split('.')[0])
if ($major -lt 20) {
    Fail @"
Установлен Node.js $versionText, а нужен не ниже 20 (рекомендуется 24 LTS).

Обновите Node.js с https://nodejs.org и запустите этот сценарий заново.
"@
}

if (-not (Test-Path (Join-Path $SourceDir 'main.js'))) {
    Fail "В каталоге $SourceDir нет main.js. Укажите каталог сборки apps/print-agent/dist."
}

# --- Файлы --------------------------------------------------------------------

Write-Host 'Останавливаю прежнюю версию, если она запущена...'
Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# Каталог приложения пересоздаётся целиком: файл, оставшийся от прежней версии,
# однажды окажется тем, что Node загрузит вместо нового.
if (Test-Path $AppDir) {
    Remove-Item -Path $AppDir -Recurse -Force
}
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
Copy-Item -Path (Join-Path $SourceDir '*') -Destination $AppDir -Recurse -Force

# Настройка и токен лежат рядом, в $InstallDir, и при обновлении НЕ трогаются:
# иначе каждое обновление требовало бы новой привязки.
$configPath = Join-Path $InstallDir 'config.json'
if ($PSBoundParameters.ContainsKey('ServerUrl') -and -not [string]::IsNullOrWhiteSpace($ServerUrl)) {
    $deviceName = $env:COMPUTERNAME
    $existingId = $null
    if (Test-Path $configPath) {
        $existingId = (Get-Content -Path $configPath -Raw | ConvertFrom-Json).deviceId
    }
    [ordered]@{
        serverUrl  = $ServerUrl.TrimEnd('/')
        deviceId   = $existingId
        deviceName = $deviceName
    } | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
}

# --- Автозапуск ---------------------------------------------------------------

$mainJs = Join-Path $AppDir 'main.js'
$action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$mainJs`" run" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Перезапуск при сбое обязателен: обработчик, тихо умерший ночью, означает
# утро без бланков и без единого сообщения о причине.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Печать бланков заказов на локальный принтер' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host 'Обработчик установлен и запущен.' -ForegroundColor Green
Write-Host ''
Write-Host 'Что дальше:'
Write-Host '  1. В системе откройте «Настройки → Печать» и получите код привязки.'
Write-Host '  2. Выполните в этом окне:'
Write-Host "       node `"$mainJs`" pair"
Write-Host '  3. Проверьте связь:'
Write-Host "       node `"$mainJs`" status"
Write-Host ''
Write-Host 'Для бездиалоговой печати PDF нужен SumatraPDF: https://www.sumatrapdfreader.org'
