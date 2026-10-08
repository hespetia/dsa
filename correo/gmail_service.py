from __future__ import annotations

import datetime as _dt
from typing import Any, Optional

from googleapiclient.discovery import build

from auth import load_saved_token, refresh_if_needed


def _service():
    creds = load_saved_token()
    if not creds:
        raise RuntimeError("No autenticado. Inicia sesión primero.")
    creds = refresh_if_needed(creds)
    return build("gmail", "v1", credentials=creds)


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

def list_labels() -> list[dict]:
    svc = _service()
    result = svc.users().labels().list(userId="me").execute()
    return [
        {"id": lb["id"], "name": lb["name"], "type": lb.get("type", "")}
        for lb in result.get("labels", [])
    ]


def _label_name_map() -> dict[str, str]:
    return {lb["id"]: lb["name"] for lb in list_labels()}


# ---------------------------------------------------------------------------
# Today's messages
# ---------------------------------------------------------------------------

def _today_after_epoch() -> int:
    """Epoch (seconds) of today at midnight local time."""
    now = _dt.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp())


def list_today_messages(label_id: Optional[str] = None) -> list[dict]:
    svc = _service()
    after_ts = _today_after_epoch()
    query = f"after:{after_ts}"
    if label_id:
        query += f" label:{label_id}"

    messages: list[dict] = []
    page_token: Optional[str] = None

    while True:
        resp = (
            svc.users()
            .messages()
            .list(
                userId="me",
                q=query,
                maxResults=200,
                pageToken=page_token,
            )
            .execute()
        )
        messages.extend(resp.get("messages", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return messages


def get_message_meta(msg_id: str) -> dict:
    svc = _service()
    msg = (
        svc.users()
        .messages()
        .get(userId="me", id=msg_id, format="metadata")
        .execute()
    )
    headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
    return {
        "id": msg_id,
        "from": headers.get("from", ""),
        "to": headers.get("to", ""),
        "subject": headers.get("subject", "(sin asunto)"),
        "date": headers.get("date", ""),
        "snippet": msg.get("snippet", ""),
        "labels": msg.get("labelIds", []),
        "unread": "UNREAD" in msg.get("labelIds", []),
    }


def get_today_grouped_by_label(
    target_label_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return today's messages grouped by label, with URGENT first."""
    label_map = _label_name_map()
    raw_msgs = list_today_messages(target_label_id)

    # Fetch metadata for each message (sequential, acceptable for < 500 msgs)
    full_msgs = [get_message_meta(m["id"]) for m in raw_msgs]

    # Build grouped structure
    by_label: dict[str, list[dict]] = {}
    urgent_label_id = _find_urgent_label_id(label_map)

    seen_ids: set[str] = set()
    for msg in full_msgs:
        mid = msg["id"]
        if mid in seen_ids:
            continue
        seen_ids.add(mid)

        for lbl_id in msg["labels"]:
            if lbl_id in ("CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"):
                continue  # skip generic Gmail categories
            lbl_name = label_map.get(lbl_id, lbl_id)
            by_label.setdefault(lbl_name, []).append(msg)

    # Separate urgent
    urgent = []
    if urgent_label_id:
        urgent_name = label_map.get(urgent_label_id, "URGENTE")
        urgent = by_label.pop(urgent_name, [])

    return {
        "urgente": urgent,
        "por_etiqueta": by_label,
    }


def _find_urgent_label_id(label_map: dict[str, str]) -> Optional[str]:
    """Find the Gmail label id for URGENTE (case-insensitive match)."""
    for lid, name in label_map.items():
        if name.upper() in ("URGENTE", "URGENT"):
            return lid
    return None


def fetch_message_body_preview(msg_id: str, max_len: int = 300) -> str:
    """Get a short text preview from the message body (optional enhancement)."""
    svc = _service()
    msg = (
        svc.users()
        .messages()
        .get(userId="me", id=msg_id, format="full")
        .execute()
    )
    payload = msg.get("payload", {})
    return _extract_text(payload, max_len)


def _extract_text(payload: dict, max_len: int) -> str:
    parts = payload.get("parts", [])
    if parts:
        texts = []
        for part in parts:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    import base64
                    texts.append(base64.urlsafe_b64decode(data).decode("utf-8", errors="replace"))
        return (" ".join(texts))[:max_len] if texts else ""
    else:
        mime = payload.get("mimeType", "")
        if mime == "text/plain":
            data = payload.get("body", {}).get("data", "")
            if data:
                import base64
                return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")[:max_len]
    return ""
