# Instalador de MotiBot LLM para Windows.
#
# Deja tu LLM local (Ollama) listo para usar con MotiBot y crea el acceso
# directo "MotiBot LLM" en el escritorio. Se puede volver a correr para
# actualizar: pisa los archivos con la ultima version.
#
# Como correrlo: clic derecho en este archivo -> "Ejecutar con PowerShell".
#
# Que hace, paso a paso (y nada mas):
#   1. Revisa que tengas Node.js 22 o mas nuevo.
#   2. Revisa que tengas Ollama.
#   3. Baja de GitHub el agente, el lanzador y el icono a
#      %LOCALAPPDATA%\MotiBotLLM, y te muestra la huella del agente.
#   4. Te pide el token de MotiBot y lo guarda en tu usuario de Windows
#      (variable MOTIBOT_TOKEN), no en un archivo.
#   5. Si no tenes ningun modelo, te ofrece bajar uno.
#   6. Crea el acceso directo "MotiBot LLM" en tu escritorio.
#
# No necesita permisos de administrador y no toca nada fuera de esa carpeta,
# tu escritorio y la variable MOTIBOT_TOKEN.

param(
  [string]$Servidor = "wss://sora-srv.tail97131d.ts.net/motibot-llm/agent",
  [string]$Repo = "facusora01/MotiBot",
  [string]$Rama = "main",
  # Carpeta de un clon del repo: copia los archivos de ahi en vez de bajarlos.
  [string]$Local = ""
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Instalador de MotiBot LLM"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Destino = Join-Path $env:LOCALAPPDATA "MotiBotLLM"
$Base = "https://raw.githubusercontent.com/$Repo/$Rama"
$OllamaUrl = "http://127.0.0.1:11434"

function Paso($texto) { Write-Host ""; Write-Host "== $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "   OK  $texto" -ForegroundColor Green }
function Fallar($texto) {
  Write-Host ""
  Write-Host $texto -ForegroundColor Red
  Read-Host "Enter para cerrar" | Out-Null
  exit 1
}
function Ollama-Responde {
  try { Invoke-RestMethod "$OllamaUrl/api/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

Write-Host ""
Write-Host "  Instalador de MotiBot LLM" -ForegroundColor Cyan
Write-Host "  Conecta el modelo de IA de tu PC (Ollama) con MotiBot." -ForegroundColor DarkGray

# --- 1. Node ------------------------------------------------------------------
Paso "1/6  Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fallar "No encontre Node.js. Bajalo de https://nodejs.org (version 22 o mas nueva), instalalo y volve a correr este instalador."
}
$version = (& node --version).Trim().TrimStart("v")
if ([int]($version.Split(".")[0]) -lt 22) {
  Fallar "Tenes Node $version y hace falta la 22 o mas nueva. Actualizalo desde https://nodejs.org y volve a correr este instalador."
}
Ok "Node $version"

# --- 2. Ollama ----------------------------------------------------------------
Paso "2/6  Ollama"
$ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $ollamaExe)) {
  $c = Get-Command ollama -ErrorAction SilentlyContinue
  if ($c) { $ollamaExe = $c.Source }
  else { Fallar "No encontre Ollama. Bajalo de https://ollama.com/download, instalalo y volve a correr este instalador." }
}
Ok "Ollama instalado"

# --- 3. Archivos --------------------------------------------------------------
if ($Local) { Paso "3/6  Copiando el agente desde $Local" } else { Paso "3/6  Bajando el agente desde GitHub ($Repo)" }
New-Item -ItemType Directory -Force $Destino | Out-Null
$archivos = @(
  @("motibot-agent.js", "motibot-agent.js"),
  @("instalador/motibot-llm.ps1", "motibot-llm.ps1"),
  @("instalador/motibot.ico", "motibot.ico")
)
foreach ($a in $archivos) {
  $salida = Join-Path $Destino $a[1]
  try {
    if ($Local) { Copy-Item (Join-Path $Local $a[0]) $salida -Force }
    else { Invoke-WebRequest "$Base/$($a[0])" -OutFile $salida -UseBasicParsing }
  }
  catch { Fallar "No pude conseguir $($a[0]): $($_.Exception.Message)" }
  Unblock-File $salida
}
@{ servidor = $Servidor } | ConvertTo-Json | Set-Content (Join-Path $Destino "config.json") -Encoding ASCII

$huella = (Get-FileHash (Join-Path $Destino "motibot-agent.js") -Algorithm SHA256).Hash.ToLower()
Ok "Archivos en $Destino"
Write-Host "       Huella del agente (SHA-256):"
Write-Host "       $huella" -ForegroundColor White
Write-Host "       Tiene que ser la misma que te mando MotiBot con /mbot llm add." -ForegroundColor DarkGray

# --- 4. Token -----------------------------------------------------------------
Paso "4/6  Token de MotiBot"
$actual = [Environment]::GetEnvironmentVariable("MOTIBOT_TOKEN", "User")
if ($actual) {
  Write-Host "   Ya tenes un token guardado. Enter para mantenerlo, o pega uno nuevo."
} else {
  Write-Host "   Pedile uno a MotiBot por privado con /mbot llm add (llega en el ultimo mensaje)."
}
while ($true) {
  $token = (Read-Host "   Token").Trim()
  if (-not $token -and $actual) { Ok "Mantengo el token que ya tenias"; break }
  if ($token -match '^mbk_[A-Za-z0-9_-]{43}$') {
    [Environment]::SetEnvironmentVariable("MOTIBOT_TOKEN", $token, "User")
    Ok "Token guardado en tu usuario de Windows"
    break
  }
  Write-Host "   Eso no parece un token (empieza con mbk_ y tiene 47 caracteres). Proba de nuevo." -ForegroundColor Red
}

# --- 5. Modelo ----------------------------------------------------------------
Paso "5/6  Modelo de IA"
$modelosDir = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")
if ($modelosDir) { $env:OLLAMA_MODELS = $modelosDir }
$ollamaTemporal = $null
if (-not (Ollama-Responde)) {
  $ollamaTemporal = Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 30 -and -not (Ollama-Responde); $i++) { Start-Sleep -Milliseconds 500 }
}
try {
  $modelos = @((Invoke-RestMethod "$OllamaUrl/api/tags").models)
  if ($modelos.Count -gt 0) {
    Ok "Ya tenes $($modelos.Count) modelo(s): $(($modelos | ForEach-Object { $_.name }) -join ', ')"
  } else {
    Write-Host "   No tenes ningun modelo todavia. Cual bajo?"
    Write-Host "   [1] qwen3.5:9b   6.6 GB  recomendado (placa de video de 8 GB o mas)"
    Write-Host "   [2] llama3.2:3b  2.0 GB  liviano (PCs sin placa de video o con poca memoria)"
    Write-Host "   [3] ninguno, lo bajo despues"
    $opcion = (Read-Host "   Opcion (Enter = 1)").Trim()
    $elegido = @{ "" = "qwen3.5:9b"; "1" = "qwen3.5:9b"; "2" = "llama3.2:3b" }[$opcion]
    if ($elegido) {
      Write-Host "   Bajando $elegido, puede tardar unos minutos..." -ForegroundColor DarkGray
      & $ollamaExe pull $elegido
      if ($LASTEXITCODE -eq 0) { Ok "$elegido listo" } else { Write-Host "   No se pudo bajar. Probalo despues con: ollama pull $elegido" -ForegroundColor Yellow }
    }
  }
} catch {
  Write-Host "   No pude hablar con Ollama ($($_.Exception.Message)). Bajate un modelo despues con: ollama pull qwen3.5:9b" -ForegroundColor Yellow
} finally {
  if ($ollamaTemporal -and -not $ollamaTemporal.HasExited) { & taskkill.exe /PID $ollamaTemporal.Id /T /F 2>&1 | Out-Null }
}

# --- 6. Acceso directo --------------------------------------------------------
Paso "6/6  Acceso directo en el escritorio"
$escritorio = [Environment]::GetFolderPath("Desktop")
$acceso = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $escritorio "MotiBot LLM.lnk"))
$acceso.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$acceso.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Destino 'motibot-llm.ps1')`""
$acceso.WorkingDirectory = $Destino
$acceso.IconLocation = "$(Join-Path $Destino 'motibot.ico'),0"
$acceso.Description = "Conecta tu LLM local (Ollama) a MotiBot"
$acceso.Save()
Ok "Creado 'MotiBot LLM' en $escritorio"

Write-Host ""
Write-Host "  Listo. Abri 'MotiBot LLM' desde el escritorio, elegi el modelo y deja la ventana abierta" -ForegroundColor Green
Write-Host "  mientras quieras que MotiBot pueda usarlo. En un grupo, un admin lo prende con /mbot live." -ForegroundColor Green
Write-Host "  Para actualizar, volve a correr este instalador." -ForegroundColor DarkGray
Write-Host ""
Read-Host "Enter para cerrar" | Out-Null
