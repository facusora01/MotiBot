# El agente de MotiBot, explicado simple

`motibot-agent.js` es un programa chico (menos de 300 líneas, comentadas en
español) que conecta el modelo de inteligencia artificial de tu PC (Ollama)
con MotiBot. Así, en los grupos de WhatsApp donde estés, el bot puede
contestar usando tu modelo.

Esta página explica qué hace, qué no puede hacer y cómo comprobarlo vos
mismo, sin tener que confiar en nadie.

---

## Qué hace

1. Se conecta a MotiBot por internet, con una conexión cifrada (`wss://`).
   La conexión sale de tu PC: **no abrís ningún puerto** ni tocás el router.
2. Espera preguntas. Cada pregunta es **solo texto**: el mensaje que alguien
   le escribió al bot y, a veces, lo que se venía charlando.
3. Le pasa ese texto a tu Ollama, en tu misma PC, y le devuelve a MotiBot
   la respuesta, **también solo texto**.

Eso es todo.

## Qué NO puede hacer

- **No puede leer ni modificar tus archivos.**
- **No puede abrir programas** ni ejecutar comandos.
- **No le da "herramientas" al modelo**: el modelo solo puede escribir
  texto, no hacer cosas en tu PC.
- **No manda tus chats a ningún otro lado**: solo habla con MotiBot y con
  el Ollama de tu propia PC (tiene que estar en `127.0.0.1`).

## No tenés que confiar en el archivo: te protege Node

La protección no la pone MotiBot, la pone **Node.js**, el programa oficial
con el que corrés el agente y que usan millones de personas.

Cuando lo lanzás con `--permission`:

```
node --permission motibot-agent.js ...
```

Node lo encierra y **le bloquea** leer y escribir archivos, abrir programas,
crear procesos y cargar extensiones. Aunque el archivo tuviera algo malo,
Node no lo dejaría hacerlo. Y si alguien intenta correrlo sin ese encierro,
el propio agente se niega a arrancar.

**Probalo vos.** Este comando intenta listar los archivos de la carpeta
donde estás:

```
node --permission -e "require('fs').readdirSync('.')"
```

Node tiene que contestar con un error `ERR_ACCESS_DENIED`: ni siquiera
deja *ver* qué archivos hay. Sin `--permission`, el mismo comando funciona.

**La única excepción es la red.** Node no encierra las conexiones a
internet. Por eso importa lo que dice el código: el agente solo se conecta
a MotiBot y a tu Ollama. Podés comprobarlo buscando `fetch(` y
`WebSocket(` en el archivo: son las únicas conexiones que abre.

## Cómo comprobar que es el archivo original

### 1. Bajalo de GitHub

El link que te manda MotiBot apunta a este repositorio público, a una
versión fija. Cualquiera puede ver el código y cada cambio que se le hizo.

### 2. Compará la huella

Cada archivo tiene una "huella digital" (SHA-256): un código que cambia por
completo si se le modifica aunque sea una letra. MotiBot te manda la huella
correcta junto con las instrucciones. Calculá la del archivo que bajaste:

- **Windows:** `certutil -hashfile motibot-agent.js SHA256`
- **Mac / Linux:** `shasum -a 256 motibot-agent.js`

Si coincide con la que te mandó MotiBot, es exactamente el original.

## Qué ven los demás

- **Vos** ves en tu PC los mensajes que le escriben al bot en los grupos
  donde se usa tu modelo.
- **MotiBot** solo ve las respuestas que genera tu modelo. No ve nada de tu
  PC.
- **Tu token** es como una contraseña: no lo compartas. Si se filtra,
  mandale `/mbot llm add` a MotiBot por privado y el viejo deja de servir.

## Cómo apagarlo

Cerrá la ventana (o `Ctrl+C`). El agente le pide a Ollama que saque el
modelo de la memoria antes de cerrarse. Para darlo de baja del todo:
`/mbot llm remove` por privado.
