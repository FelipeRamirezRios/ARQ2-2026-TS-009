param([int]$Seconds = 20)
$ErrorActionPreference = "Stop"
Write-Host "Injecting controlled airline-connector failure for $Seconds seconds..."
docker compose stop airline-connector
try { Start-Sleep -Seconds $Seconds }
finally { docker compose start airline-connector; Write-Host "Airline connector recovery requested." }
Write-Host "Inspect Circuit Breaker, Saga recovery, Outbox and Jaeger in Grafana."
