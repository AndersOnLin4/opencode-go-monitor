# OpenCode Go 用量监控台 - 一键刷新
# 用法: .\refresh.ps1 [-NoOpen]
param([switch]$NoOpen)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "[1/3] 提取本地历史用量..." -ForegroundColor Cyan
node extract.js
if (-not $?) { throw "extract 失败" }

Write-Host "[2/3] 拉取实时配额..." -ForegroundColor Cyan
node fetch-quota.js
if (-not $?) { Write-Warning "配额拉取失败（不影响本地数据）" }

Write-Host "[3/3] 完成。" -ForegroundColor Green
if (-not $NoOpen) { Invoke-Item (Join-Path $PSScriptRoot "dashboard.html") }
