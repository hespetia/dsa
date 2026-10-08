# AGENTS.md — Plan de Trabajo DSA

## Qué es este repositorio

No es un proyecto de software con build. Son **dos archivos** y nada más:

- `Plan de Trabajo.html` — la aplicación. Un solo archivo, en español, sin servidor, sin CDN, sin dependencias externas (todo el CSS y el JS están embebidos, incluido el escritor/lector de XLSX). **Este es el entregable.**
- `Plan de trabajo DSA 19 Agosto 2026.xlsx` — la fuente institucional de verdad. Hoja `Monitoreo`, 27 actividades, periodo `2026 - II`, fecha de corte `2026-08-19`, meses Agosto–Diciembre, 4 semanas por mes.

No hay `package.json`, lockfile, linter, CI, git ni carpeta de tests dentro de la carpeta de trabajo. **No los busques: no existen.** Todo es edición directa del HTML.

Hay un tercer archivo, `AGENTS.md` (este), que no forma parte de la entrega.

## Identidad visual UAC

La app se presenta como plan de trabajo de la **Universidad Andina del Cusco (UAC)**, Dirección de Servicios Académicos. La paleta y el emblema se tomaron del sitio oficial y están **embebidos**, nunca enlazados:

- Emblema: `<symbol id="uac-emb">`, vectorizado de `https://www.uandina.edu.pe/assets/logo-uandina-icono.svg` (`viewBox="0 0 6.76 6.37"`, trazo con `fill="currentColor"`). Se usa en tres sitios: login, barra lateral (`#uac-emb` del encabezado) y encabezado del reporte imprimible. `check_emb.py` compara la secuencia de coordenadas con el SVG oficial.
- Paleta: `--brand` `#132E66`, `--brand-2` `#1C4578`, `--brand-3` `#3A93D0`, `--brand-cian` `#00CDFF`, `--brand-oro` `#F0B443`.
- En el sitio oficial solo ese emblema es válido: `logo.png`, `logo-uandina.svg` y `logo-uandina-text.webp` devuelven un 404 en HTML. No existe un logotipo separado de la Dirección; la identificación se hace con el emblema más texto.
- `DB.meta.unidad` alimenta el subtítulo de la barra lateral; no repitas "Dirección de Servicios Académicos" en ese campo porque ya aparece en el encabezado.

## Verificación (las herramientas viven FUERA de la carpeta)

El arnés de pruebas está en `C:\Users\hespetia\AppData\Local\Temp\opencode\`, que es un directorio temporal: **puede desaparecer**. Si pasa, hay que reconstruirlo (ver abajo). Define `$T = "C:\Users\hespetia\AppData\Local\Temp\opencode"`.

Requisitos: Node (v24) y Python 3.12 con `openpyxl` (este último solo para `gen_seed.py`).

El orden importa. `test.js` y `smoke.js` ejecutan `app.js`, que es un **extracto generado**: si no reextraes después de editar el HTML, estás probando código viejo.

```powershell
python "$T\extract.py"                                  # HTML -> app.js + valida estructura
node --check "$T\app.js"                                # sintaxis
node "$T\test.js"                                       # 96 pruebas unitarias (funciones puras, XLSX ida y vuelta)
node "$T\smoke.js"                                      # 41 pruebas con DOM simulado (renderizadores, editor, CRUD)
python "$T\check_estatico.py"                           # IDs inexistentes, clases CSS huerfanas
```

Resultado esperado al final: `96 pruebas OK, 0 fallos`, `41 smoke OK, 0 fallos`, `node --check` sin salida, y en `check_estatico.py` solo los falsos positivos conocidos (`f_` viene de `$('#f_' + id)`; los "funciones no definidas" son palabras en español dentro de cadenas y comentarios, más globales reales como `setTimeout`/`clearTimeout`/`open`).

Si hay que reconstruir el arnés: `extract.py` (22 líneas) extrae el `<script>`; `test.js` debe definir un `DOMParser` mínimo **solo para Node** (el browser lo trae) y un `document` stub; `smoke.js` necesita el stub de DOM con `querySelector` memoizado por selector —sin memoizar, cada `$('#x')` devuelve un objeto nuevo y los manejadores `onclick` de los modales son inaccesibles—; `gen_seed.py` regenera la semilla con `openpyxl` desde la hoja `Monitoreo`.

## Verificación visual (headless)

Las pruebas no miran píxeles, así que la marca UAC se comprueba aparte con Chrome headless + Pillow (`verifica_marca.py`, `verifica_vistas.py`, `auto.py`, `capturar_todas.ps1`):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-sandbox `
   --hide-scrollbars --window-size=1400,1000 --virtual-time-budget=9000 `
   --screenshot="$T\shot_panel.png" --user-data-dir="$T\cr_panel" "file:///<ruta>/app_auto_panel.html"
python "$T\verifica_vistas.py"     # por vista: % de blanco, fondo y px de cada color de marca
```

`auto.py` copia el HTML a un temporal e inyecta un `<script>` con auto-login para poder capturar vistas que exigen sesión. Cuatro trampas que costaron tiempo:

- El `<script>` inyectado va **antes de `</body>`**. Anclarlo en `document.addEventListener('DOMContentLoaded', boot);` lo mete *dentro* del `<script>` de la app y rompe el arranque entero: la página se ve bien (HTML/CSS estáticos) pero **ninguna función corre**.
- Nada de literales partidos en varias líneas al generar el JS: dos cadenas de Python concatenadas sin espacio producen un `SyntaxError` silencioso y el script nunca se ejecuta. Sale como un `| login oculto=` colgando en el volcado del DOM.
- Una suelta expresión (`panel`) en el JS inyectado aborta el script con `ReferenceError` **antes** de programar el `setTimeout`.
- El diagnóstico se lee del `<title>` con `--dump-dom --virtual-time-budget`; sin `--virtual-time-budget` solo se ejecuta lo síncrono. En PowerShell **no** uses `$t` como variable: pisa a `$T` (los nombres no distinguen mayúsculas).

## Reglas de dominio que no son obvias

- **Semanas**: S1 = días 1–7, S2 = 8–14, S3 = 15–21, S4 = 22–fin de mes. Está en `semRango()`. Cualquier fecha derivada de la matriz semanal depende de esto.
- **`fechaCorte`** (`2026-08-19`) es la fecha de referencia para riesgos, semáforo, curva de avance y semáforo de rezago. No la reemplaces por la fecha real del sistema sin avisar: el archivo se llama "19 Agosto 2026" por ese motivo.
- El plan vive en `DB.actividades[i].plan` como matriz `[mes][semana]` de 0/1 (5 × 4 = 20 celdas). Las **fechas se derivan de la matriz**; al escribir fechas a mano, la matriz se regenera con `planDeFechas()`.
- Los estados son exactamente `No iniciado`, `En proceso`, `Completado`, `Retrasado`; el rol `Consulta` no puede editar.
- N°4 del Excel tiene X en Agosto S1–S4 y Setiembre S1–S2 → `2026-08-01` a `2026-09-14`. Es el caso de prueba de referencia para la conversión de la matriz a fechas.
- Credenciales iniciales embebidas: `admin / admin123` (Administrador) y `lector / lector123` (Consulta). Login solo local, sin hash.

## Cómo editar sin romper nada

- Edita **el HTML directamente**, no `app.js`. Los scripts `fix1.py`…`fix9.py` son parches de una sola vez: restauran una copia del HTML, aplican un reemplazo exacto y **abortan si el texto no coincide una única vez**. Ese es el patrón a imitar; no los reejecutes (ya consumieron su reemplazo y fallarían).
- **`fmtjs.py` y `reformat.py` están rotos y no deben ejecutarse.** El formateador colapsó statements de una línea y convirtió código posterior en un comentario `//`, silenciando secciones 8–22 de la app. Si necesitas formatear, arregla el formateador primero.
- Todos los `fix*.py` escriben el archivo con `io.open(..., 'w', encoding='utf-8', newline='')`. Respétalo: sin `newline=''` Windows introduce CRLF y duplica los finales de línea.
- El archivo es UTF-8 con acentos literales. Al leerlo desde Node usa `utf8`; desde Python `encoding='utf-8'`.

## La clase de bug que más costó encontrar

Dos bugs rompían funcionalidades enteras y **ambos eran de alcance léxico, no de lógica**:

1. `let DB = null, U = { }` — `U` solo se completaba si existía UI guardada, así que en la **primera visita** (localStorage vacío) el Cronograma, Kanban, tabla y reporte fallaban con `Cannot read properties of undefined`. Ahora `U = U_DEF()` y `boot()` fusiona lo guardado sobre los defaults.
2. `editarAct` usaba `plan` (declarado 60 líneas más abajo) → `Cannot access 'plan' before initialization`: **el editor de actividades no abría nunca**.

Lección: ejecuta el código, no solo lo leas. `test.js` cubría funciones puras y no vio ninguno de los dos; los encontró `smoke.js`, que **arranca `boot()` de verdad y llama a cada renderizador y manejador de modal**. `node --check` y el análisis estático no los ven. Si añades una vista, un modal o un flujo de escritura, añádelo también a `smoke.js`.
