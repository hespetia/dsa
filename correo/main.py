from __future__ import annotations

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import auth
import gmail_service

app = FastAPI(title="Correo Uandina Dashboard")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={"authenticated": auth.is_authenticated()})


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.get("/login")
async def login(request: Request):
    base = _base_url(request)
    try:
        url = auth.get_auth_url(base)
    except FileNotFoundError as exc:
        return HTMLResponse(
            f"""<h2>Falta credentials.json</h2>
            <p style="font-family:system-ui;max-width:640px;line-height:1.5;">
            {exc}<br><br>
            Guía rápida:
            <ol>
              <li><a href="https://console.cloud.google.com/">Google Cloud Console</a> → crear proyecto</li>
              <li>Habilitar <b>Gmail API</b> (APIs y servicios → Biblioteca)</li>
              <li>Pantalla de consentimiento OAuth (tipo Externo) con scope
                  <code>gmail.readonly</code> y tu correo como usuario de prueba</li>
              <li>Credenciales → OAuth client ID → tipo <b>App de escritorio</b> → descargar JSON</li>
              <li>Guardar el archivo como <code>credentials.json</code> en la raíz del proyecto</li>
            </ol>
            Detalle completo en README.md.</p>""",
            status_code=400,
        )
    return RedirectResponse(url)


@app.get("/oauth2callback")
async def oauth2callback(request: Request):
    base = _base_url(request)
    callback_url = str(request.url)
    try:
        auth.handle_oauth_callback(base, callback_url)
    except Exception as exc:
        return HTMLResponse(f"<h2>Error en autenticación</h2><p>{exc}</p>", status_code=400)
    return RedirectResponse("/")


@app.get("/logout")
async def logout():
    auth.TOKEN_PATH.unlink(missing_ok=True)
    return RedirectResponse("/")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/status")
async def status():
    return {"authenticated": auth.is_authenticated()}


@app.get("/api/labels")
async def api_labels():
    if not auth.is_authenticated():
        return JSONResponse({"error": "No autenticado"}, status_code=401)
    try:
        labels = gmail_service.list_labels()
        return {"labels": labels}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/mail")
async def api_mail(label: str | None = Query(default=None, description="Label id para filtrar")):
    if not auth.is_authenticated():
        return JSONResponse({"error": "No autenticado"}, status_code=401)
    try:
        data = gmail_service.get_today_grouped_by_label(label)
        return {
            "total": len(data["urgente"]) + sum(len(m) for m in data["por_etiqueta"].values()),
            "urgente": data["urgente"],
            "por_etiqueta": data["por_etiqueta"],
        }
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/mail/{msg_id}/preview")
async def api_mail_preview(msg_id: str):
    if not auth.is_authenticated():
        return JSONResponse({"error": "No autenticado"}, status_code=401)
    try:
        preview = gmail_service.fetch_message_body_preview(msg_id)
        return {"preview": preview}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
