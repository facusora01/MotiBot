# start.ps1 — Levanta MotiBot en Docker para pruebas locales (pre-producción).
# Build + up en segundo plano y luego sigue los logs (ahí aparece el QR/pairing).
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# 1. Docker disponible?
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "X Docker no esta instalado o no esta en PATH." -ForegroundColor Red
  exit 1
}

# 2. Detectar 'docker compose' (v2) vs 'docker-compose' (v1).
$compose = "docker compose"
try { docker compose version *> $null } catch {}
if ($LASTEXITCODE -ne 0) {
  if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $compose = "docker-compose"
  } else {
    Write-Host "X No encontre 'docker compose' ni 'docker-compose'." -ForegroundColor Red
    exit 1
  }
}

# 3. .env presente? Si no, lo creamos desde el ejemplo y avisamos.
if (-not (Test-Path ".env")) {
  Write-Host "! No hay .env. Lo creo desde env.example -- completalo antes de vincular." -ForegroundColor Yellow
  Copy-Item "env.example" ".env"
}

# 4. Build + up en background.
Write-Host ">> Construyendo y levantando contenedor..." -ForegroundColor Cyan
Invoke-Expression "$compose up --build -d"
if ($LASTEXITCODE -ne 0) {
  Write-Host "X Fallo el build/up." -ForegroundColor Red
  exit 1
}

Write-Host "OK MotiBot arriba. Health: http://localhost:3001/health" -ForegroundColor Green
Write-Host "   Para re-vincular: http://localhost:3001/pair?key=TU_PAIR_TOKEN" -ForegroundColor Green
Write-Host ">> Siguiendo logs (Ctrl+C corta los logs; el bot sigue corriendo)." -ForegroundColor Cyan
Write-Host "   Detener todo:  $compose down" -ForegroundColor DarkGray
Write-Host ""

# 5. Logs en vivo: aca aparece el QR (qrcode-terminal) o el codigo de pairing.
Invoke-Expression "$compose logs -f"
