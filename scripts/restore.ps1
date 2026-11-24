param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = "Stop"
if (!(Test-Path $BackupFile)) { throw "Backup file not found: $BackupFile" }
Write-Warning "Restore overwrites objects in booking_db. Stop application services and confirm a disposable/local environment."
$confirm = Read-Host "Type RESTORE to continue"
if ($confirm -ne "RESTORE") { throw "Restore cancelled" }
docker compose stop auth-service search-service booking-service airline-connector audit-service kong frontend
$full = (Resolve-Path $BackupFile).Path
cmd.exe /c "docker compose exec -T postgres pg_restore -U aerobooking -d booking_db --clean --if-exists < `"$full`""
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
docker compose up -d
Write-Host "Restore completed; verify docker compose ps and application health."
