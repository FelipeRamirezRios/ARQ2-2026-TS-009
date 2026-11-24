$ErrorActionPreference = "Stop"
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker Desktop is not running. Start Docker Desktop with WSL2 and retry." }
docker compose config --quiet
if ($LASTEXITCODE -ne 0) { throw "Docker Compose configuration is invalid." }
docker compose up --build -d
if ($LASTEXITCODE -ne 0) { throw "AeroBooking failed to start. Run: docker compose logs --tail=200" }
Write-Host "Waiting 30 seconds for services and health checks..."
Start-Sleep -Seconds 30
docker compose ps
Write-Host "Frontend:    http://localhost:8080"
Write-Host "Kong API:    http://localhost:8000"
Write-Host "Grafana:     http://localhost:3000 (admin / admin)"
Write-Host "Prometheus:  http://localhost:9090"
Write-Host "Jaeger:      http://localhost:16686"
Write-Host "RabbitMQ:    http://localhost:15672 (aerobooking / aerobooking_dev)"
Write-Host "If any service is unhealthy, inspect: docker compose logs --tail=200 <service>"
