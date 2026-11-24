param([string]$OutputDir = ".\\backups")
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$file = Join-Path $OutputDir "aerobooking-$stamp.dump"
$full = (Resolve-Path $OutputDir).Path + "\\aerobooking-$stamp.dump"
cmd.exe /c "docker compose exec -T postgres pg_dump -U aerobooking -d booking_db -Fc > `"$full`""
if ($LASTEXITCODE -ne 0 -or !(Test-Path $file) -or (Get-Item $file).Length -lt 1024) { throw "Backup failed or is unexpectedly small: $file" }
Get-FileHash $file -Algorithm SHA256 | Format-List | Out-File "$file.sha256"
Write-Host "Backup created: $file"
