# MotiBot LLM: elige un modelo de Ollama y lo conecta a MotiBot.
#
# Lo instala instalar-motibot.ps1 en %LOCALAPPDATA%\MotiBotLLM, junto al
# agente (motibot-agent.js) y a config.json (la direccion del servidor).
# Al cerrar esta ventana se apaga lo que se abrio desde aca y el modelo sale
# de la memoria.

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "MotiBot LLM"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Carpeta = $PSScriptRoot
$UltimoArchivo = Join-Path $Carpeta "ultimo-modelo.txt"
$OllamaUrl = "http://127.0.0.1:11434"

$Servidor = "wss://sora-srv.tail97131d.ts.net/motibot-llm/agent"
$config = Join-Path $Carpeta "config.json"
if (Test-Path $config) {
  $leido = (Get-Content $config -Raw | ConvertFrom-Json).servidor
  if ($leido) { $Servidor = $leido }
}

$OllamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $OllamaExe)) {
  $c = Get-Command ollama -ErrorAction SilentlyContinue
  if ($c) { $OllamaExe = $c.Source }
}

function Ollama-Responde {
  try { Invoke-RestMethod "$OllamaUrl/api/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

function Salir-ConPausa($mensaje) {
  Write-Host ""
  Write-Host $mensaje -ForegroundColor Red
  Read-Host "Enter para cerrar" | Out-Null
  exit 1
}

# El token vive en la variable de usuario MOTIBOT_TOKEN, no en un archivo.
# Pide uno nuevo, lo valida y lo guarda. Devuelve $false si se deja vacio.
function Pedir-Token($motivo) {
  Write-Host ""
  if ($motivo) { Write-Host $motivo -ForegroundColor Yellow }
  Write-Host "Pedile uno a MotiBot por privado con /mbot llm add y pegalo aca." -ForegroundColor DarkGray
  while ($true) {
    $nuevo = (Read-Host "  Token (Enter para cancelar)").Trim()
    if (-not $nuevo) { return $false }
    if ($nuevo -match '^mbk_[A-Za-z0-9_-]{43}$') {
      [Environment]::SetEnvironmentVariable("MOTIBOT_TOKEN", $nuevo, "User")
      $env:MOTIBOT_TOKEN = $nuevo
      Write-Host "  Token guardado." -ForegroundColor Green
      return $true
    }
    Write-Host "  Eso no parece un token (empieza con mbk_ y tiene 47 caracteres)." -ForegroundColor Red
  }
}

if (-not $env:MOTIBOT_TOKEN) { $env:MOTIBOT_TOKEN = [Environment]::GetEnvironmentVariable("MOTIBOT_TOKEN", "User") }
if (-not $env:MOTIBOT_TOKEN) {
  if (-not (Pedir-Token "Todavia no tenes un token guardado.")) { exit 0 }
}
# Si los modelos se guardan en otra carpeta (variable OLLAMA_MODELS), el
# Ollama que se levante desde aca los tiene que encontrar.
$modelosDir = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")
if ($modelosDir) { $env:OLLAMA_MODELS = $modelosDir }

# --- Ollama -------------------------------------------------------------------
# Si no esta corriendo, se levanta DENTRO de esta ventana (sin ventana propia):
# asi, al cerrarla, Windows lo apaga junto con todo lo demas.
$ollamaPropio = $null
if (-not (Ollama-Responde)) {
  if (-not (Test-Path $OllamaExe)) { Salir-ConPausa "No encontre Ollama. Instalalo desde https://ollama.com/download" }
  Write-Host "Iniciando Ollama..." -ForegroundColor DarkGray
  $log = Join-Path $Carpeta "ollama.log"
  $ollamaPropio = Start-Process -FilePath $OllamaExe -ArgumentList "serve" -NoNewWindow -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  for ($i = 0; $i -lt 30 -and -not (Ollama-Responde); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Ollama-Responde)) { Salir-ConPausa "Ollama no arranco. Mira $log.err" }
}

# --- Elegir modelo ------------------------------------------------------------
$modelos = @((Invoke-RestMethod "$OllamaUrl/api/tags").models | Sort-Object name)
if ($modelos.Count -eq 0) { Salir-ConPausa "No tenes modelos en Ollama. Baja uno con: ollama pull qwen3.5:9b" }

$ultimo = if (Test-Path $UltimoArchivo) { (Get-Content $UltimoArchivo -Raw).Trim() } else { "" }
$porDefecto = [Math]::Max(0, [Array]::FindIndex([object[]]$modelos, [Predicate[object]]{ param($m) $m.name -eq $ultimo }))

# MOTIBOT_MODELO salta el menu (para abrirlo sin preguntar).
if ($env:MOTIBOT_MODELO) {
  $modelo = $env:MOTIBOT_MODELO
} else {
  while ($true) {
    Write-Host ""
    Write-Host "  MotiBot LLM - elegi el modelo" -ForegroundColor Cyan
    Write-Host ""
    for ($i = 0; $i -lt $modelos.Count; $i++) {
      $m = $modelos[$i]
      $gb = "{0:N1} GB" -f ($m.size / 1GB)
      $marca = if ($i -eq $porDefecto) { "  <- ultimo usado" } else { "" }
      Write-Host ("  [{0}] {1,-28} {2,8}{3}" -f ($i + 1), $m.name, $gb, $marca)
    }
    Write-Host ""
    Write-Host "  [T] cambiar el token" -ForegroundColor DarkGray
    Write-Host ""
    $eleccion = (Read-Host "  Numero (Enter = $($porDefecto + 1))").Trim()

    if ($eleccion -match '^[tT]$') { Pedir-Token | Out-Null; continue }
    if (-not $eleccion) { $indice = $porDefecto; break }
    if ($eleccion -match '^\d+$' -and [int]$eleccion -ge 1 -and [int]$eleccion -le $modelos.Count) { $indice = [int]$eleccion - 1; break }
    Write-Host "  Opcion invalida." -ForegroundColor Red
  }
  $modelo = $modelos[$indice].name
}
Set-Content -Path $UltimoArchivo -Value $modelo -Encoding ASCII

# --- Agente -------------------------------------------------------------------
try {
  Set-Location $Carpeta
  while ($true) {
    Write-Host ""
    Write-Host "Conectando $modelo a MotiBot. Deja esta ventana abierta mientras quieras que este disponible." -ForegroundColor Green
    Write-Host "Para apagar: cerra la ventana o Ctrl+C." -ForegroundColor DarkGray
    Write-Host ""

    # --permission: Node encierra al agente (sin acceso a archivos ni a
    # programas). Sin ese encierro, el agente se niega a arrancar.
    & node --permission motibot-agent.js --server $Servidor --model $modelo

    # Salio con error (token rechazado, sesion reemplazada...): se puede
    # cargar un token nuevo y reintentar sin cerrar la ventana.
    if ($LASTEXITCODE -eq 0) { break }
    if (-not (Pedir-Token "El agente se cerro con un error. Si MotiBot rechazo el token, pega uno nuevo para reintentar.")) { break }
  }
}
finally {
  # Si el agente termino solo, tambien se libera todo.
  try {
    Invoke-RestMethod "$OllamaUrl/api/chat" -Method Post -TimeoutSec 4 -ContentType "application/json" `
      -Body (@{ model = $modelo; messages = @(); keep_alive = 0 } | ConvertTo-Json) | Out-Null
  } catch {}
  # El Ollama que levantamos aca se apaga con sus procesos hijos (el que tiene
  # el modelo cargado). Uno que ya estaba abierto antes no se toca.
  if ($ollamaPropio -and -not $ollamaPropio.HasExited) {
    & taskkill.exe /PID $ollamaPropio.Id /T /F 2>&1 | Out-Null
  }
}

Write-Host ""
Read-Host "El agente se cerro. Enter para salir" | Out-Null
