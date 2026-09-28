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
#   6. Opcional: la generacion de imagenes (stable-diffusion.cpp + Z-Image),
#      con cada archivo verificado contra su huella SHA-256.
#   7. Crea el acceso directo "MotiBot LLM" en tu escritorio.
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
Paso "1/7  Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fallar "No encontre Node.js. Bajalo de https://nodejs.org (version 22 o mas nueva), instalalo y volve a correr este instalador."
}
$version = (& node --version).Trim().TrimStart("v")
if ([int]($version.Split(".")[0]) -lt 22) {
  Fallar "Tenes Node $version y hace falta la 22 o mas nueva. Actualizalo desde https://nodejs.org y volve a correr este instalador."
}
Ok "Node $version"

# --- 2. Ollama ----------------------------------------------------------------
Paso "2/7  Ollama"
$ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $ollamaExe)) {
  $c = Get-Command ollama -ErrorAction SilentlyContinue
  if ($c) { $ollamaExe = $c.Source }
  else { Fallar "No encontre Ollama. Bajalo de https://ollama.com/download, instalalo y volve a correr este instalador." }
}
Ok "Ollama instalado"

# --- 3. Archivos --------------------------------------------------------------
if ($Local) { Paso "3/7  Copiando el agente desde $Local" } else { Paso "3/7  Bajando el agente desde GitHub ($Repo)" }
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
Paso "4/7  Token de MotiBot"
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
Paso "5/7  Modelo de IA"
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

# --- 6. Imagenes (opcional) ---------------------------------------------------
# stable-diffusion.cpp + Z-Image-Turbo. Todo se baja de fuentes fijas y se
# compara contra su huella SHA-256: si algo no coincide, se borra y se corta.
Paso "6/7  Generacion de imagenes (opcional)"
$imgJson = Join-Path $Destino "imagenes.json"
if (Test-Path $imgJson) {
  Ok "Ya la tenes instalada. Se prende desde el menu de MotiBot LLM con [I]."
} else {
  $placas = (Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ", "
  $nvidia = $placas -match "NVIDIA"
  Write-Host "   MotiBot tambien puede dibujar imagenes con tu PC (Z-Image-Turbo). Baja unos 7.5 GB."
  Write-Host "   Tu placa de video: $placas"
  if (-not $nvidia) { Write-Host "   Sin placa NVIDIA va a andar, pero bastante mas lento." -ForegroundColor Yellow }
  $quiere = (Read-Host "   Instalarla? (s/N)").Trim()
  if ($quiere -match '^[sS]') {
    $porDefecto = Join-Path $Destino "imagenes"
    $dirImg = (Read-Host "   Carpeta donde guardarla (Enter = $porDefecto)").Trim().Trim('"')
    if (-not $dirImg) { $dirImg = $porDefecto }
    New-Item -ItemType Directory -Force (Join-Path $dirImg "bin"), (Join-Path $dirImg "models") | Out-Null

    $sd = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a"
    $hf = "https://huggingface.co"
    $bajadas = @()
    if ($nvidia) {
      $bajadas += ,@("$sd/sd-master-3f8527a-bin-win-cuda12-x64.zip", "bin\sd.zip", "217d6dead9abd3f827fc338268555cc179234e7e6330ef21ecb1c985e19d2dc7")
      $bajadas += ,@("$sd/cudart-sd-bin-win-cu12-x64.zip", "bin\cudart.zip", "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d")
    } else {
      $bajadas += ,@("$sd/sd-master-3f8527a-bin-win-vulkan-x64.zip", "bin\sd.zip", "60e6850d650417409f18c2170ab5e27335db96da70cd3d1ad1e930bcffc2fd35")
    }
    $bajadas += ,@("$hf/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf", "models\z_image_turbo-Q4_K.gguf", "14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd")
    $bajadas += ,@("$hf/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "models\Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597")
    $bajadas += ,@("$hf/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors", "models\ae.safetensors", "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38")

    foreach ($b in $bajadas) {
      $archivo = Join-Path $dirImg $b[1]
      $nombre = Split-Path $archivo -Leaf
      $yaEsta = (Test-Path $archivo) -and ((Get-FileHash $archivo -Algorithm SHA256).Hash.ToLower() -eq $b[2])
      if (-not $yaEsta) {
        Write-Host "   Bajando $nombre..." -ForegroundColor DarkGray
        & curl.exe -L --fail --retry 3 -o $archivo $b[0]
        if ($LASTEXITCODE -ne 0) { Fallar "No pude bajar $nombre." }
        if ((Get-FileHash $archivo -Algorithm SHA256).Hash.ToLower() -ne $b[2]) {
          Remove-Item $archivo -Force
          Fallar "La huella de $nombre no coincide con la esperada: lo borre por seguridad. Proba de nuevo mas tarde."
        }
      }
      Ok "$nombre (huella verificada)"
    }

    foreach ($zip in Get-ChildItem (Join-Path $dirImg "bin") -Filter *.zip) {
      Expand-Archive $zip.FullName (Join-Path $dirImg "bin") -Force
      Remove-Item $zip.FullName -Force
    }
    @{
      nombre    = "Z-Image-Turbo"
      dir       = $dirImg
      servidor  = "bin\sd-server.exe"
      diffusion = "models\z_image_turbo-Q4_K.gguf"
      vae       = "models\ae.safetensors"
      llm       = "models\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
    } | ConvertTo-Json | Set-Content $imgJson -Encoding ASCII
    Ok "Generacion de imagenes instalada en $dirImg. Se prende desde el menu con [I]."
  }
}

# --- 7. Acceso directo --------------------------------------------------------
Paso "7/7  Acceso directo en el escritorio"
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
