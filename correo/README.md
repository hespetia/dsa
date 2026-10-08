# Correo Uandina - Dashboard

Aplicacion web que conecta a **hespetia@uandina.edu.pe** (Google Workspace) y muestra los correos de hoy organizados por etiquetas, con la seccion **URGENTE** destacada.

---

## Requisitos previos

### 1. Configurar Google Cloud Console (una sola vez)

1. Ir a [Google Cloud Console](https://console.cloud.google.com/)
2. Crear un nuevo proyecto (ej. `correo-uandina`)
3. En el menu lateral, ir a **APIs & Services > Library**
4. Buscar y habilitar **Gmail API**
5. Ir a **APIs & Services > OAuth consent screen**:
   - Seleccionar tipo **External**
   - Llenar nombre de la app: `Correo Uandina`
   - Agregar email de soporte
   - En **Scopes**, agregar: `https://www.googleapis.com/auth/gmail.readonly`
   - En **Test users**, agregar: `hespetia@uandina.edu.pe`
   - Guardar
6. Ir a **APIs & Services > Credentials**:
   - Click **Create Credentials > OAuth client ID**
   - Tipo: **Desktop app**
   - Nombre: `Correo Uandina Desktop`
   - Click **Create**
   - Descargar el JSON (credentials.json)
7. Colocar `credentials.json` en la raiz de este proyecto

---

## Instalacion

```bash
# Crear entorno virtual
python -m venv venv
venv\Scripts\activate      # Windows
# source venv/bin/activate   # Linux/Mac

# Instalar dependencias
pip install -r requirements.txt
```

---

## Ejecutar

```bash
python main.py
```

O con uvicorn directamente:

```bash
uvicorn main:app --reload --port 8000
```

Abrir en el navegador: **http://127.0.0.1:8000**

---

## Uso

1. Hacer clic en **Conectar Gmail**
2. Se abrira el navegador con la pantalla de consentimiento de Google
3. Autorizar el acceso a `hespetia@uandina.edu.pe`
4. El dashboard mostrara los correos de hoy organizados por etiquetas
5. La seccion **Urgentes** aparecera arriba con borde rojo (correos con etiqueta `URGENTE`)
6. Hacer clic en un correo para expandir su contenido
7. Usar **Actualizar** para recargar los correos
8. **Cerrar sesion** para limpiar las credenciales guardadas

---

## Estructura

```
correo/
├── main.py              # App FastAPI (rutas + endpoints)
├── auth.py              # Flujo OAuth2 con Google
├── gmail_service.py     # Acceso a Gmail API (etiquetas, mensajes)
├── requirements.txt     # Dependencias Python
├── credentials.json     # [PASO USUARIO] descargado de Google Cloud
├── token.json           # Se genera tras el primer login
├── static/
│   ├── app.js           # Logica frontend
│   └── style.css        # Estilos
└── templates/
    └── index.html       # Dashboard HTML
```

---

## Notas

- Solo se accede en modo **lectura** (`gmail.readonly`).
- Los correos URGENTES se identifican por la etiqueta `URGENTE` en Gmail.
- El `token.json` se renueva automaticamente cuando expira.
- La app busca correos desde medianoche del dia actual en zona horaria local.
