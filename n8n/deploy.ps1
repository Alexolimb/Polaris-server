# Заливка пропатченного воркфлоу polaris-api на боевой n8n.
# Ключ НЕ хранится в этом файле и не должен попадать в репозиторий.
# Берём из переменной окружения N8N_API_KEY. Если ключ лежит в локальном
# файле — задай путь к нему в переменной N8N_KEY_FILE.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$WF_ID = '60BnnCKAdgfY3jUE'
$BASE = 'https://178-105-123-85.nip.io'
$PAYLOAD = Join-Path $PSScriptRoot 'polaris-api.PUT-payload.json'

function Get-ApiKey {
  if ($env:N8N_API_KEY) { return $env:N8N_API_KEY }
  if ($env:N8N_KEY_FILE -and (Test-Path $env:N8N_KEY_FILE)) {
    $key = (Get-Content $env:N8N_KEY_FILE -Encoding UTF8 -Raw).Trim()
    if ($key) { return $key }
  }
  throw 'не нашёл ключ n8n: задай $env:N8N_API_KEY или $env:N8N_KEY_FILE с путём к файлу ключа'
}

if (-not (Test-Path $PAYLOAD)) { throw "нет файла payload: $PAYLOAD" }

$key = Get-ApiKey
Write-Host ("payload: {0} байт" -f (Get-Item $PAYLOAD).Length)

# Страховка: перед заливкой ещё раз снимаем текущее состояние с сервера.
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$before = Invoke-WebRequest -Uri "$BASE/api/v1/workflows/$WF_ID" `
  -Headers @{ 'X-N8N-API-KEY' = $key } -TimeoutSec 60 -UseBasicParsing
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "polaris-api.rollback-$stamp.json"),
  $before.Content, [Text.Encoding]::UTF8)
Write-Host "снимок ДО заливки сохранён: polaris-api.rollback-$stamp.json"

$body = [IO.File]::ReadAllBytes($PAYLOAD)
$r = Invoke-WebRequest -Uri "$BASE/api/v1/workflows/$WF_ID" -Method PUT `
  -Headers @{ 'X-N8N-API-KEY' = $key } `
  -ContentType 'application/json; charset=utf-8' `
  -Body $body -TimeoutSec 90 -UseBasicParsing

$j = $r.Content | ConvertFrom-Json
Write-Host ("PUT -> {0} | active={1} | updatedAt={2}" -f $r.StatusCode, $j.active, $j.updatedAt)
if (-not $j.active) {
  Write-Host 'ВНИМАНИЕ: воркфлоу неактивен — включи его в n8n или дёрни /activate.'
}
