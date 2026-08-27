<#
.SYNOPSIS
  Ставит агента печати наклеек в автозапуск текущего пользователя.

.DESCRIPTION
  Служба Windows в первой версии намеренно не используется: службе нужны права
  администратора и отдельный сеанс, а агенту достаточно прав того человека,
  который работает за компьютером и печатает.

  Задача планировщика запускает агента при входе пользователя и перезапускает
  его, если он завершился.
#>

param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$TaskName = 'FlowersPrintAgent'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExePath)) {
  throw "Не найден файл агента: $ExePath"
}

$action = New-ScheduledTaskAction -Execute $ExePath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Печать наклеек заказов' -Force | Out-Null

Write-Host "Задача «$TaskName» создана. Агент запустится при следующем входе."
Write-Host "Запустить сейчас: Start-ScheduledTask -TaskName $TaskName"
