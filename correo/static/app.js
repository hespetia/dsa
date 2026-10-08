(async function init() {
  const contentEl = document.getElementById("content");
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const authBtn = document.getElementById("authBtn");
  const refreshBtn = document.getElementById("refreshBtn");

  // Check auth status
  try {
    const st = await fetch("/api/status").then(r => r.json());
    if (st.authenticated) {
      authBtn.href = "/logout";
      authBtn.textContent = "Cerrar sesion";
      refreshBtn.style.display = "";
      await loadMail();
    } else {
      contentEl.innerHTML = `
        <div class="empty-state">
          <h2>No has conectado tu correo</h2>
          <p>Haz clic en "Conectar Gmail" para autorizar el acceso a hespetia@uandina.edu.pe</p>
        </div>`;
    }
  } catch (e) {
    showError("No se pudo verificar el estado de autenticacion: " + e.message);
  }

  async function loadMail() {
    loadingEl.style.display = "";
    errorEl.style.display = "none";
    contentEl.innerHTML = "";
    try {
      const data = await fetch("/api/mail").then(r => r.json());
      if (data.error) {
        showError(data.error);
        loadingEl.style.display = "none";
        return;
      }
      renderMail(data);
    } catch (e) {
      showError("Error al cargar correos: " + e.message);
    } finally {
      loadingEl.style.display = "none";
    }
  }

  // Expose for refresh button
  window.loadMail = loadMail;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "";
  }

  function renderMail(data) {
    const urgent = data.urgente || [];
    const byLabel = data.por_etiqueta || {};

    let html = "";

    // Urgent section
    html += renderSection(true, "Urgentes", urgent);

    // Other labels
    const labels = Object.keys(byLabel).sort();
    for (const label of labels) {
      const msgs = byLabel[label];
      html += renderSection(false, label, msgs);
    }

    if (!html) {
      html = `
        <div class="empty-state">
          <h2>Sin correos de hoy</h2>
          <p>No se encontraron correos para hoy en tu bandeja.</p>
        </div>`;
    }

    contentEl.innerHTML = html;
    bindExpand();
  }

  function renderSection(isUrgent, title, msgs) {
    if (!msgs.length) return "";
    const cls = isUrgent ? "section urgent" : "section";
    const badgeClass = isUrgent ? "urgent-label" : "";
    return `
      <div class="${cls}">
        <div class="section-title">
          ${isUrgent ? '<span style="font-size:1.1rem">&#9888;</span>' : ""}
          ${title}
          <span class="badge">${msgs.length}</span>
        </div>
        ${msgs.map(m => renderCard(m, badgeClass)).join("")}
      </div>`;
  }

  function renderCard(m, urgentBadgeClass) {
    const initials = getInitials(m.from);
    const dateStr = formatDate(m.date);
    const unreadClass = m.unread ? "unread" : "";
    const unreadDot = m.unread ? '<div class="unread-dot"></div>' : "";
    const labelsHtml = (m.labels || [])
      .map(l => `<span class="label-tag ${urgentBadgeClass}">${escHtml(l)}</span>`)
      .join("");
    return `
      <div class="email-card ${unreadClass}" data-id="${m.id}">
        ${unreadDot}
        <div class="email-avatar">${initials}</div>
        <div class="email-body">
          <div class="email-top">
            <span class="email-from">${escHtml(m.from)}</span>
            <span class="email-date">${dateStr}</span>
          </div>
          <div class="email-subject">${escHtml(m.subject)}</div>
          <div class="email-snippet">${escHtml(m.snippet)}</div>
          <div class="email-labels">${labelsHtml}</div>
        </div>
      </div>`;
  }

  function getInitials(from) {
    const match = from.match(/^"?([^"<]+)"?\s*</);
    const name = match ? match[1].trim() : from;
    const parts = name.split(/\s+/).slice(0, 2);
    return parts.map(p => p.charAt(0).toUpperCase()).join("") || "?";
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      const today = new Date();
      const isToday = d.toDateString() === today.toDateString();
      if (isToday) {
        return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
    } catch {
      return dateStr;
    }
  }

  function escHtml(str) {
    const el = document.createElement("span");
    el.textContent = str || "";
    return el.innerHTML;
  }

  function bindExpand() {
    document.querySelectorAll(".email-card").forEach(card => {
      card.addEventListener("click", async () => {
        const id = card.dataset.id;
        const snippetEl = card.querySelector(".email-snippet");
        if (snippetEl.dataset.loaded) return;
        try {
          const resp = await fetch(`/api/mail/${id}/preview`).then(r => r.json());
          if (resp.preview) {
            snippetEl.textContent = resp.preview;
            snippetEl.dataset.loaded = "1";
          }
        } catch {}
      });
    });
  }
})();
