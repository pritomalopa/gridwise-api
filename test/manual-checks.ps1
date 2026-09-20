# GridWise manual checks - copy-paste dorkar nai, sudhu number likho.
# Chalao:  powershell -ExecutionPolicy Bypass -File test\manual-checks.ps1
param([int]$Choice = 0)

$Local = "http://localhost:3000"
$Render = "https://gridwise-api-4hp0.onrender.com"
$Tmp = $env:TEMP
$S01 = Join-Path $Tmp "s01.json"
$Bad422 = Join-Path $Tmp "bad422.json"
$Pack = Join-Path (Split-Path $PSScriptRoot -Parent) "BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.md"

function Ensure-S01 {
  if (-not (Test-Path $S01)) {
    $p = Get-Content $Pack -Raw | ConvertFrom-Json
    $p.cases[0].input | ConvertTo-Json -Depth 10 | Out-File $S01 -Encoding utf8
    Write-Output "[built s01.json]"
  }
}

function Ensure-Bad422 {
  Ensure-S01
  $j = Get-Content $S01 -Raw | ConvertFrom-Json
  $j.scenario_id = "BAD-422"
  $j.hours[0].demand_kwh = -5
  $j | ConvertTo-Json -Depth 10 | Out-File $Bad422 -Encoding utf8
  Write-Output "[built bad422.json]"
}

function Ensure-Bad400 {
  $f = Join-Path $Tmp "bad400.json"
  '{"scenario_id":"","operator_notes":["x"],"hours":[],"battery":{}}' | Out-File $f -Encoding utf8 -NoNewline
  return $f
}

function Show-Menu {
  Write-Output ""
  Write-Output "=== GridWise manual checks ==="
  Write-Output " 1 = Local health"
  Write-Output " 2 = Local SAMPLE-01 (valid)"
  Write-Output " 3 = Local invalid 400"
  Write-Output " 4 = Local invalid 422"
  Write-Output " 5 = Local full test (10/10)"
  Write-Output " 6 = Render health"
  Write-Output " 7 = Render SAMPLE-01 (valid)"
  Write-Output " 8 = Render invalid 400 + 422"
  Write-Output " 9 = Render full test (10/10)"
  Write-Output " 0 = exit"
  Write-Output ""
}

if ($Choice -eq 0) { Show-Menu; $Choice = [int](Read-Host "number dao") }

switch ($Choice) {
  1 { curl.exe -s "$Local/health"; Write-Output "" }
  2 { Ensure-S01; curl.exe -s -X POST "$Local/optimize-energy" -H "Content-Type: application/json" --data "@$S01"; Write-Output "" }
  3 {
    $f = Ensure-Bad400
    curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$Local/optimize-energy" -H "Content-Type: application/json" --data "@$f"
  }
  4 {
    Ensure-Bad422
    curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$Local/optimize-energy" -H "Content-Type: application/json" --data "@$Bad422"
  }
  5 { Set-Location (Split-Path $PSScriptRoot -Parent); npm test }
  6 { curl.exe -s "$Render/health"; Write-Output "" }
  7 { Ensure-S01; curl.exe -s -X POST "$Render/optimize-energy" -H "Content-Type: application/json" --data "@$S01"; Write-Output "" }
  8 {
    $f = Ensure-Bad400
    Write-Output "--- 400 test ---"
    curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$Render/optimize-energy" -H "Content-Type: application/json" --data "@$f"
    Ensure-Bad422
    Write-Output "--- 422 test ---"
    curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$Render/optimize-energy" -H "Content-Type: application/json" --data "@$Bad422"
  }
  9 { Set-Location (Split-Path $PSScriptRoot -Parent); $env:BASE_URL = $Render; npm test }
  default { Write-Output "0-9 er moddhe number dao" }
}
