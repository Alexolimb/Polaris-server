# Проверка живых эндпоинтов Polaris ПОСЛЕ заливки патча.
# Печатает «ок»/«ПЛОХО» по каждому пункту — читать не нужно, достаточно итога.
$ErrorActionPreference = 'Continue'
$B = 'https://178-105-123-85.nip.io/webhook/polaris'
$bad = 0

function Get-Json($url) {
  try { return (Invoke-WebRequest -Uri $url -TimeoutSec 40 -UseBasicParsing).Content | ConvertFrom-Json }
  catch { Write-Host ("  ЗАПРОС НЕ УДАЛСЯ: {0}" -f $url); return $null }
}

Write-Host '--- health ---'
$h = Get-Json "$B/health"
if ($h -and $h.ok) { Write-Host ("  ок  ai={0} market={1}" -f $h.ai, $h.market) }
else { Write-Host '  ПЛОХО: health не ok'; $bad++ }

Write-Host '--- дивиденды: должна быть ПРОШЕДШАЯ выплата ---'
$now = Get-Date
foreach ($sym in @('AAPL', 'MSFT', 'KO')) {
  $d = Get-Json "$B/v1/dividends?symbol=$sym"
  if (-not $d) { $bad++; continue }
  $dates = @($d.dividends | ForEach-Object { $_.exDate })
  $past = @($dates | Where-Object { [datetime]$_ -le $now })
  if ($past.Count -ge 1) { Write-Host ("  ок  {0}: {1}" -f $sym, ($dates -join ' ')) }
  else { Write-Host ("  ПЛОХО {0}: ни одной прошедшей отсечки ({1})" -f $sym, ($dates -join ' ')); $bad++ }
}

Write-Host '--- свечи: range должен различаться ---'
$counts = @{}
foreach ($r in @('1d', '1w', '1m', '1y', '1M')) {
  $c = Get-Json "$B/v1/candles?symbol=AAPL&range=$r"
  $counts[$r] = if ($c) { @($c.candles).Count } else { 0 }
}
Write-Host ('  ' + (($counts.Keys | Sort-Object | ForEach-Object { "$_`:$($counts[$_])" }) -join '  '))
if ($counts['1d'] -eq 24 -and $counts['1w'] -eq 28 -and $counts['1m'] -eq 30 -and $counts['1y'] -eq 52) {
  Write-Host '  ок  диапазоны различаются'
} else { Write-Host '  ПЛОХО: диапазоны не различаются'; $bad++ }
if ($counts['1M'] -eq $counts['1m']) { Write-Host '  ок  регистр range не важен' }
else { Write-Host '  ПЛОХО: 1M != 1m'; $bad++ }

Write-Host '--- котировки ---'
$q = Get-Json "$B/v1/quotes?symbols=AAPL,BTC"
if ($q -and @($q.quotes).Count -eq 2) { Write-Host '  ок' } else { Write-Host '  ПЛОХО'; $bad++ }

Write-Host ''
if ($bad -eq 0) { Write-Host 'ИТОГ: бэкенд здоров, патч подействовал' }
else {
  Write-Host ("ИТОГ: ПРОБЛЕМ {0}. Откат: залей polaris-api.rollback-*.json тем же deploy.ps1," -f $bad)
  Write-Host '      подменив в нём имя файла payload (или скажи мне — откачу).'
}
