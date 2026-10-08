from __future__ import annotations

import json
import base64
import urllib.parse
from pathlib import Path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

BASE_DIR = Path(__file__).resolve().parent
CREDENTIALS_PATH = BASE_DIR / "credentials.json"
TOKEN_PATH = BASE_DIR / "token.json"

_client_id: Optional[str] = None
_client_secret: Optional[str] = None


def _load_oauth_client_config() -> dict:
    """Load OAuth client config from credentials.json."""
    global _client_id, _client_secret
    if CREDENTIALS_PATH.exists():
        raw = json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))
        installed = raw.get("installed") or raw.get("web") or {}
        _client_id = installed.get("client_id", "")
        _client_secret = installed.get("client_secret", "")
        return installed
    return {}


def _build_flow(redirect_uri: str) -> Flow:
    config = _load_oauth_client_config()
    if not config:
        raise FileNotFoundError(
            "credentials.json no encontrado. Descárgalo desde Google Cloud Console "
            "y colócalo en la raíz del proyecto."
        )
    return Flow.from_client_config(
        client_config={"installed": config},
        scopes=SCOPES,
        redirect_uri=redirect_uri,
    )


def get_auth_url(base_url: str) -> str:
    redirect_uri = base_url.rstrip("/") + "/oauth2callback"
    flow = _build_flow(redirect_uri)
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return auth_url


def handle_oauth_callback(base_url: str, callback_url: str) -> Credentials:
    redirect_uri = base_url.rstrip("/") + "/oauth2callback"
    flow = _build_flow(redirect_uri)
    flow.fetch_token(authorization_response=callback_url)
    creds = flow.credentials
    save_token(creds)
    return creds


def load_saved_token() -> Optional[Credentials]:
    if not TOKEN_PATH.exists():
        return None
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    return creds


def refresh_if_needed(creds: Credentials) -> Credentials:
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save_token(creds)
    return creds


def save_token(creds: Credentials) -> None:
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")


def is_authenticated() -> bool:
    creds = load_saved_token()
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                refresh_if_needed(creds)
                return True
            except Exception:
                return False
        return False
    return True
