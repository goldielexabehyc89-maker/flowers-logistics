<#
.SYNOPSIS
    Удаление локального обработчика печати и отвязка рабочего места.

.DESCRIPTION
    Удаляет задачу автозапуска, файлы приложения и ХРАНИМЫЙ ТОКЕН УСТРОЙСТВА.

    Токен удаляется обязательно и первым по важности: компьютер, с которого
    сняли обработчик, чаще всего уезжает со склада или меняет владельца, а
    оставленный токен — это работающее право забирать чужие бланки с сервера.
    Сервер об этом не узнает: отзыв устройства — отдельное действие
    администратора в разделе «Настройки → Печать», и его стоит выполнить тоже.

    Журнал заданий удаляется вместе с каталогом. Это безопасно ровно потому,
    что рабочее место больше не будет привязано: без токена оно не получит
    ни одного задания, и печатать повторно нечего.
#>

[CmdletBinding()]
param(
    # Оставить настройку и журнал: обновление, а не снятие с эксплуатации.
    [switch] $KeepData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'FloristPrintAgent'
$InstallDir = Join-Path $env:LOCALAPPDATA 'FloristPrintAgent'
$AppDir = Join-Path $InstallDir 'app'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Write-Host 'Останавливаю задачу автозапуска...'
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Процесс мог быть запущен вручную, а не задачей: без этого файлы не удалить.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*FloristPrintAgent*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Test-Path $AppDir) {
    Remove-Item -Path $AppDir -Recurse -Force
}

if ($KeepData) {
    Write-Host 'Настройка и токен сохранены (-KeepData).'
} else {
    # Токен — отдельной строкой и до удаления каталога: если каталог занят
    # чужим процессом, секрет всё равно должен исчезнуть.
    foreach ($secret in @('device-token.dpapi', 'device-token.test-only')) {
        $path = Join-Path $InstallDir $secret
        if (Test-Path $path) {
            Remove-Item -Path $path -Force
        }
    }
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
    }
    Write-Host 'Рабочее место отвязано: токен удалён.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Обработчик удалён.' -ForegroundColor Green
Write-Host 'Не забудьте отозвать устройство в разделе «Настройки → Печать»:'
Write-Host 'удаление файлов на компьютере само по себе не отменяет его прав на сервере.'
