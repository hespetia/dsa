(function () {
  "use strict";

  var DATA = window.MOF_DATA;
  var CLAVE = "mof_dsa_state_v1";
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function base() {
    var fichas = {};
    DATA.mof.fichas.forEach(function (f) { fichas[f.pid] = JSON.parse(JSON.stringify(f)); });
    var nodos = {};
    DATA.organigrama.nodos.forEach(function (n) {
      nodos[n.id] = { titulo: n.titulo, titular: n.titular || "" };
    });
    return { nodos: nodos, fichas: fichas, cop: JSON.parse(JSON.stringify(DATA.mof.cop)) };
  }

  var memoria = null;
  function leerStorage() {
    try {
      var raw = window.localStorage.getItem(CLAVE);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { memoria = memoria || null; return null; }
  }
  function escribirStorage(obj) {
    try { window.localStorage.setItem(CLAVE, JSON.stringify(obj)); return true; }
    catch (e) { memoria = obj; return false; }
  }

  function mezclar(b, s) {
    var out = { nodos: {}, fichas: {}, cop: [] };
    Object.keys(b.nodos).forEach(function (id) {
      out.nodos[id] = Object.assign({}, b.nodos[id], (s.nodos && s.nodos[id]) || {});
    });
    Object.keys(b.fichas).forEach(function (pid) {
      var f = Object.assign({}, b.fichas[pid]);
      var g = (s.fichas && s.fichas[pid]) || {};
      if (g.titulo !== undefined) f.titulo = g.titulo;
      ["depende", "supervisa", "proposito"].forEach(function (k) { if (g[k] !== undefined) f[k] = g[k]; });
      if (Array.isArray(g.funciones)) f.funciones = g.funciones;
      if (Array.isArray(g.estudios)) f.estudios = g.estudios;
      if (Array.isArray(g.experiencia)) f.experiencia = g.experiencia;
      out.fichas[pid] = f;
    });
    out.cop = (s.cop && s.cop.length) ? s.cop : JSON.parse(JSON.stringify(b.cop));
    return out;
  }

  var BASE = base();
  var guardado = leerStorage();
  var ESTADO = mezclar(BASE, guardado || {});
  var vistaActual = "org";

  function ficha(pid) { return ESTADO.fichas[pid] || null; }
  function kpi(pid) { return DATA.kpi.filter(function (k) { return k.pid === pid; })[0] || null; }
  function nodo(id) { return ESTADO.nodos[id] || null; }
  function nodosBase() { return DATA.organigrama.nodos; }
  function copDe(pid) {
    var f = ficha(pid);
    if (!f) return null;
    return ESTADO.cop.filter(function (c) { return norm(c.puesto) === norm(f.titulo); })[0] || null;
  }

  function norm(s) {
    return (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  function quitarLetra(s) { return (s || "").replace(/^[.\s\-]*([a-z])\)\s*/i, "").replace(/^[.\s]+/, "").trim(); }
  function letraDe(s) { var m = /^[.\s\-]*([a-z])\)/i.exec(s || ""); return m ? m[1].toLowerCase() : null; }
  function similitud(a, b) {
    var A = norm(a).split(" ").filter(Boolean), B = norm(b).split(" ").filter(Boolean);
    if (!A.length || !B.length) return 0;
    var setB = {}, i = 0;
    B.forEach(function (t) { setB[t] = 1; });
    A.forEach(function (t) { if (setB[t]) i++; });
    return i / Math.min(A.length, B.length);
  }
  function letrasDeNota(nota) {
    if (!nota) return [];
    var m = nota.match(/letras?\s+((?:\b[a-z]\b\s*(?:,|y)\s*)*\b[a-z]\b)/i);
    if (!m) return [];
    return m[1].toLowerCase().replace(/\by\b/g, ",").split(/[\s,]+/)
      .filter(function (t) { return /^[a-z]$/.test(t); });
  }
  function sigLetra(ultima) {
    if (!ultima) return "a";
    if (ultima.length === 1) return ultima === "z" ? "aa" : String.fromCharCode(ultima.charCodeAt(0) + 1);
    var d = ultima.charCodeAt(1);
    if (d < 122) return ultima[0] + String.fromCharCode(d + 1);
    return String.fromCharCode(ultima.charCodeAt(0) + 1) + "a";
  }

  function buscarFuncion(filas, item) {
    var letra = letraDe(item);
    var txt = norm(quitarLetra(item));
    if (!txt) return -1;
    if (letra) {
      for (var i = 0; i < filas.length; i++) {
        if ((filas[i].letra || "").toLowerCase() === letra && filas[i].estado !== "eliminada") return i;
      }
    }
    var mejor = -1, score = 0;
    filas.forEach(function (f, i) {
      if (f.estado === "eliminada") return;
      var nf = norm(f.texto), s = similitud(f.texto, txt);
      if (nf === txt) s = 1;
      else if (txt.length > 40 && (nf.indexOf(txt) >= 0 || txt.indexOf(nf) >= 0)) s = Math.max(s, 0.92);
      else if (nf.slice(0, 60) && nf.slice(0, 60) === txt.slice(0, 60)) s = Math.max(s, 0.8);
      if (s > score) { score = s; mejor = i; }
    });
    return score >= 0.55 ? mejor : -1;
  }

  function consolidar(pid) {
    var f = ficha(pid), k = kpi(pid);
    var filas = (f.funciones || []).map(function (x) {
      return { letra: x.letra, texto: x.texto, estado: "base", origen: "MOF", cambio: "" };
    });
    var disc = [], notas = [], ops = [], indicadores = k ? [] : [];
    if (k) {
      k.operaciones.forEach(function (o) {
        if (o.operacion === "indicadores") indicadores = o.items.slice();
        else ops.push(o);
      });
      ["depende", "supervisa"].forEach(function (campo) {
        var a = norm(f[campo]), b = norm(k[campo]);
        if (a && b && a !== b) {
          disc.push({ rotulo: campo === "depende" ? "Depende de" : "Supervisa a", mof: f[campo], kpi: k[campo] });
        }
      });
    } else {
      disc.push({ rotulo: "Formato KPI", mof: "Puesto con ficha MOF", kpi: "No se encontró archivo de indicadores" });
    }
    ops.forEach(function (o) {
      var letras = letrasDeNota(o.nota);
      if (o.nota) notas.push(o.nota);
      o.items.forEach(function (item, pos) {
        var tipo = o.operacion, idx = -1;
        if (letras.length && letras.length === o.items.length) {
          var L = letras[pos].toLowerCase();
          for (var j = 0; j < filas.length; j++) {
            if ((filas[j].letra || "").toLowerCase() === L) { idx = j; break; }
          }
        }
        if (idx < 0) idx = buscarFuncion(filas, item);
        var limpio = quitarLetra(item);
        if (tipo === "eliminar") {
          if (idx >= 0) {
            filas[idx].estado = "eliminada";
            filas[idx].origen = "KPI · eliminar";
            filas[idx].cambio = item;
          } else {
            disc.push({ rotulo: "Eliminar (sin correspondencia)", mof: "—", kpi: item });
          }
        } else if (tipo === "modificar" || tipo === "reemplazar") {
          if (idx >= 0) {
            filas[idx].estado = "modificada";
            filas[idx].origen = "KPI · " + tipo;
            filas[idx].texto = limpio;
            filas[idx].cambio = item;
          } else {
            disc.push({ rotulo: "Modificar (sin correspondencia)", mof: "—", kpi: item });
          }
        } else {
          var dup = -1;
          filas.forEach(function (r, i) {
            if (dup < 0 && r.estado !== "eliminada" && norm(r.texto) === norm(limpio)) dup = i;
          });
          if (dup >= 0) {
            filas[dup].origen = "KPI · " + tipo + " (ya existía)";
          } else {
            var ultima = filas.length ? filas[filas.length - 1].letra : null;
            filas.push({ letra: sigLetra(ultima), texto: limpio, estado: "nueva", origen: "KPI · " + tipo, cambio: item });
          }
        }
      });
    });
    if (f && ESTADO.cop.length && !copDe(pid) && pid !== "unidad-registro") {
      disc.push({ rotulo: "COP", mof: "Ficha MOF sin fila en el cuadro de puestos", kpi: "—" });
    }
    var cont = { nueva: 0, modificada: 0, eliminada: 0 };
    filas.forEach(function (r) { if (cont[r.estado] !== undefined) cont[r.estado]++; });
    return { filas: filas, disc: disc, notas: notas, ops: ops, indicadores: indicadores, kpi: k, ficha: f, cont: cont };
  }

  function puestos() {
    var lista = ESTADO.cop.map(function (c) {
      var pid = Object.keys(ESTADO.fichas).filter(function (p) {
        return norm(ESTADO.fichas[p].titulo) === norm(c.puesto);
      })[0] || null;
      return { pid: pid, titulo: c.puesto, n: c.n, plazas: c.plazas, unidad: false };
    });
    Object.keys(ESTADO.fichas).forEach(function (pid) {
      if (lista.some(function (x) { return x.pid === pid; })) return;
      lista.push({ pid: pid, titulo: ESTADO.fichas[pid].titulo, n: null, plazas: null, unidad: false });
    });
    var idsConFila = lista.map(function (x) { return x.pid; });
    nodosBase().forEach(function (n) {
      if (idsConFila.indexOf(n.id) >= 0) return;
      var nn = nodo(n.id);
      lista.push({ pid: null, titulo: (nn && nn.titulo) || n.titulo, n: null, plazas: null, unidad: true, id: n.id });
    });
    return lista;
  }

  function esc(s) {
    return (s === null || s === undefined ? "" : String(s))
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function wrap(txt, max) {
    var palabras = String(txt || "").split(/\s+/), lineas = [], actual = "";
    palabras.forEach(function (p) {
      if (!actual) actual = p;
      else if ((actual + " " + p).length <= max) actual += " " + p;
      else { lineas.push(actual); actual = p; }
    });
    if (actual) lineas.push(actual);
    return lineas.slice(0, 4);
  }

  function renderOrg() {
    var W = DATA.organigrama.page[0], H = DATA.organigrama.page[1];
    var pos = {};
    nodosBase().forEach(function (n) {
      pos[n.id] = { x: n.x, y: H - (n.y + n.h), w: n.w, h: n.h, base: n };
    });
    var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    Object.keys(pos).forEach(function (id) {
      var p = pos[id];
      minx = Math.min(minx, p.x); miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x + p.w); maxy = Math.max(maxy, p.y + p.h);
    });
    var pad = 8;
    var vb = [minx - pad, miny - pad, (maxx - minx) + pad * 2, (maxy - miny) + pad * 2];
    var svg = [];
    svg.push('<svg viewBox="' + vb.join(" ") + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Organigrama">');
    svg.push('<rect x="' + vb[0] + '" y="' + vb[1] + '" width="' + vb[2] + '" height="' + vb[3] + '" fill="#ffffff"/>');
    DATA.organigrama.aristas.forEach(function (e) {
      var p = pos[e.de], c = pos[e.a];
      if (!p || !c) return;
      var x1 = p.x + p.w, y1 = p.y + p.h / 2, x2 = c.x, y2 = c.y + c.h / 2;
      var mid = (x1 + x2) / 2;
      var d = "M " + x1 + " " + y1 + " H " + mid + " V " + y2 + " H " + x2;
      svg.push('<path class="arista" data-de="' + e.de + '" data-a="' + e.a + '" d="' + d + '"/>');
    });
    nodosBase().forEach(function (n) {
      var p = pos[n.id], nn = nodo(n.id) || { titulo: n.titulo, titular: "" };
      var tipo = n.tipo;
      var fill = tipo === "area" ? "#0d3b5f" : tipo === "unidad" ? "#cfe3f2" : "#ffffff";
      var stroke = tipo === "area" ? "#0d3b5f" : "#12507f";
      var tColor = tipo === "area" ? "#ffffff" : "#0d3b5f";
      var esVacante = norm(nn.titular).indexOf("plaza disponible") >= 0;
      var cuerpo;
      if (n.w < 80) {
        cuerpo = '<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + p.h / 2) +
          '" transform="rotate(-90 ' + (p.x + p.w / 2) + " " + (p.y + p.h / 2) + ')" text-anchor="middle" font-size="15" font-weight="700" fill="' + tColor + '">' + esc(nn.titulo) + "</text>";
      } else {
        var lineas = wrap(nn.titulo, 34);
        var alto = lineas.length * 10 + (nn.titular ? 12 : 0);
        var y0 = p.y + p.h / 2 - alto / 2 + 8;
        cuerpo = lineas.map(function (l, i) {
          return '<text x="' + (p.x + p.w / 2) + '" y="' + (y0 + i * 10) + '" text-anchor="middle" font-size="9.2" font-weight="600" fill="' + tColor + '">' + esc(l) + "</text>";
        }).join("");
        if (nn.titular) {
          cuerpo += '<text x="' + (p.x + p.w / 2) + '" y="' + (y0 + lineas.length * 10 + 3) + '" text-anchor="middle" font-size="8.6" font-weight="700" fill="' + (esVacante ? "#e74c3c" : "#c0392b") + '">' + esc(nn.titular) + "</text>";
        }
      }
      svg.push('<g class="nodo" data-id="' + n.id + '" tabindex="0">' +
        '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="7" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.4"/>' + cuerpo + "</g>");
    });
    svg.push("</svg>");
    $("#org-canvas").innerHTML = svg.join("");

    $$("#org-canvas .nodo").forEach(function (g) {
      g.addEventListener("click", function () { abrirDrawer(g.getAttribute("data-id")); });
      g.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); abrirDrawer(g.getAttribute("data-id")); }
      });
    });
    renderLado();
  }

  function resumenFicha(pid) {
    var k = kpi(pid), f = ficha(pid);
    var c = consolidar(pid);
    var chips = [];
    if (f) chips.push('<span class="chip">' + (f.funciones || []).length + " funciones MOF</span>");
    if (k) chips.push('<span class="chip kpi">' + c.indicadores.length + " indicadores</span>");
    if (c.cont.nueva) chips.push('<span class="chip kpi">+' + c.cont.nueva + " nuevas</span>");
    if (c.cont.modificada) chips.push('<span class="chip kpi">' + c.cont.modificada + " modificadas</span>");
    if (c.cont.eliminada) chips.push('<span class="chip kpi">− ' + c.cont.eliminada + " eliminadas</span>");
    if (c.disc.length) chips.push('<span class="chip" style="background:#fdecea;color:#96281b;border-color:#f6cdc7">' + c.disc.length + " discrepancias</span>");
    return chips.join("");
  }

  function renderLado() {
    var lado = $("#org-side");
    if (!seleccionado) { lado.innerHTML = '<p class="muted">Sin puesto seleccionado. Haga clic en una caja del organigrama.</p>'; return; }
    var n = nodosBase().filter(function (x) { return x.id === seleccionado; })[0];
    var nn = nodo(seleccionado) || {};
    var f = ficha(seleccionado), k = kpi(seleccionado), cop = copDe(seleccionado);
    var html = "";
    html += '<div class="side-titulo">' + esc(nn.titulo || n.titulo) + "</div>";
    html += '<div class="side-sub">' + (nn.titular ? "Titular: " + esc(nn.titular) : "Sin titular asignado") +
      (cop ? " · COP n° " + cop.n + " · " + cop.plazas + " plaza(s)" : "") + "</div>";
    html += '<div class="chips">' + resumenFicha(seleccionado) + "</div>";
    if (f) {
      html += '<div class="bloque"><h4>Dependencia</h4><div class="origen">Depende de: ' + esc(f.depende || "—") +
        "<br>Supervisa a: " + esc(f.supervisa || "—") + "</div></div>";
      if (f.proposito) html += '<div class="bloque"><h4>Propósito principal</h4><p class="proposito">' + esc(f.proposito) + "</p></div>";
      html += '<div class="bloque"><h4>Funciones (' + (f.funciones || []).length + ")</h4><ol class=\"funciones\">";
      (f.funciones || []).slice(0, 8).forEach(function (x) {
        html += "<li>" + esc(x.texto) + "</li>";
      });
      html += "</ol>" + ((f.funciones || []).length > 8 ? '<p class="muted">… y ' + ((f.funciones.length - 8)) + " más</p>" : "") + "</div>";
      if (k) {
        html += '<div class="bloque"><h4>Formato KPI</h4><div class="origen">' + esc(k.archivo) + "</div>";
        html += '<div class="chips">' + k.operaciones.map(function (o) {
          return '<span class="chip kpi">' + esc(o.operacion) + " (" + o.items.length + ")</span>";
        }).join("") + "</div></div>";
      } else {
        html += '<div class="bloque"><h4>Formato KPI</h4><div class="origen">Sin archivo de indicadores</div></div>';
      }
      html += '<div class="bloque"><button class="btn btn-sec" data-ir="alineacion">Ver alineación completa</button></div>';
    } else {
      html += '<div class="bloque"><p class="muted">Unidad sin ficha MOF individual.</p></div>';
    }
    lado.innerHTML = html;
    var btn = lado.querySelector("[data-ir]");
    if (btn) btn.addEventListener("click", function () { cambiarVista("alineacion"); });
  }

  var seleccionado = null;
  function abrirDrawer(id) {
    seleccionado = id;
    $$("#org-canvas .nodo").forEach(function (g) {
      g.classList.toggle("seleccionado", g.getAttribute("data-id") === id);
      $$("#org-canvas .arista").forEach(function (a) {
        a.classList.toggle("activo", a.getAttribute("data-de") === id || a.getAttribute("data-a") === id);
      });
    });
    renderLado();
    var n = nodosBase().filter(function (x) { return x.id === id; })[0];
    var nn = nodo(id) || {}, f = ficha(id), k = kpi(id);
    var body = "";
    body += '<h2>' + esc(nn.titulo || (n && n.titulo)) + "</h2>";
    body += '<p class="muted">' + (nn.titular ? "Titular: " + esc(nn.titular) : "Sin titular asignado") + "</p>";
    body += '<div class="chips">' + resumenFicha(id) + "</div>";
    if (f) {
      body += '<div class="bloque"><h4>Ficha MOF (pág. ' + f.pagina + ")</h4>";
      body += '<p class="origen">Depende de: ' + esc(f.depende || "—") + "<br>Supervisa a: " + esc(f.supervisa || "—") + "</p>";
      if (f.proposito) body += '<p class="proposito">' + esc(f.proposito) + "</p></div>";
      body += '<div class="bloque"><h4>Funciones específicas (' + f.funciones.length + ")</h4><ol class=\"funciones\">";
      f.funciones.forEach(function (x) { body += "<li>" + esc(x.texto) + "</li>"; });
      body += "</ol></div>";
      if ((f.estudios || []).length) body += '<div class="bloque"><h4>Estudios</h4><ul class="funciones">' + f.estudios.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div>";
      if ((f.experiencia || []).length) body += '<div class="bloque"><h4>Experiencia</h4><ul class="funciones">' + f.experiencia.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div>";
    }
    if (k) {
      var c = consolidar(id);
      body += '<div class="bloque"><h4>Indicadores KPI (' + c.indicadores.length + ")</h4><ol class=\"lista-kpi\">";
      c.indicadores.forEach(function (i) { body += "<li>" + esc(i) + "</li>"; });
      body += "</ol>";
      c.notas.forEach(function (n2) { body += '<p class="nota-kpi">' + esc(n2) + "</p>"; });
      body += '<div class="chips">' + c.ops.map(function (o) {
        return '<span class="chip kpi">' + esc(o.operacion) + " (" + o.items.length + ")</span>";
      }).join("") + "</div></div>";
    }
    $("#drawer-body").innerHTML = body;
    $("#drawer").hidden = false;
  }

  function badge(estado) {
    var mapa = { nueva: "Nueva", modificada: "Modificada", eliminada: "Eliminada", base: "MOF" };
    return '<span class="estado e-' + estado + '">' + mapa[estado] + "</span>";
  }

  function renderAlineacion() {
    var q = norm($("#f-buscar").value);
    var filtro = $("#f-estado").value;
    var lista = puestos().filter(function (p) { return p.pid || !p.unidad; });
    var html = [], stats = { puestos: 0, funciones: 0, nueva: 0, modificada: 0, eliminada: 0, disc: 0 };

    lista.forEach(function (p) {
      if (!p.pid) return;
      var c = consolidar(p.pid);
      var k = c.kpi, f = c.ficha;
      stats.puestos++;
      stats.funciones += (f.funciones || []).length;
      stats.nueva += c.cont.nueva; stats.modificada += c.cont.modificada;
      stats.eliminada += c.cont.eliminada; stats.disc += c.disc.length;
      var conCambios = c.cont.nueva || c.cont.modificada || c.cont.eliminada;
      if (filtro === "cambios" && !conCambios) return;
      if (filtro === "discrepancia" && !c.disc.length) return;
      var textoBuscado = norm(p.titulo + " " + (f.funciones || []).map(function (x) { return x.texto; }).join(" "));
      if (q && textoBuscado.indexOf(q) < 0) return;

      var badges = [];
      if (c.cont.nueva) badges.push('<span class="badge b-nuevas">+' + c.cont.nueva + " nuevas</span>");
      if (c.cont.modificada) badges.push('<span class="badge b-mod">' + c.cont.modificada + " modificadas</span>");
      if (c.cont.eliminada) badges.push('<span class="badge b-elim">− ' + c.cont.eliminada + " eliminadas</span>");
      if (c.disc.length) badges.push('<span class="badge b-disc">' + c.disc.length + " discrepancias</span>");
      if (!badges.length) badges.push('<span class="badge b-sinc">Sin cambios</span>');

      var h = '<article class="puesto-card" data-pid="' + p.pid + '">';
      h += '<div class="puesto-head"><div><h3>' + esc(p.titulo) + "</h3>";
      h += '<div class="meta">' + (p.n ? "COP n° " + p.n + " · " + p.plazas + " plaza(s) · " : "") +
        (f ? "MOF pág. " + f.pagina + " · " + f.funciones.length + " funciones" : "sin ficha MOF") +
        (k ? " · KPI: " + esc(k.archivo) : " · sin formato KPI") + "</div></div>";
      h += '<div class="badges">' + badges.join("") + "</div></div>";
      h += '<div class="puesto-cuerpo" hidden>';

      if (c.notas.length) c.notas.forEach(function (n2) { h += '<p class="nota-kpi">' + esc(n2) + "</p>"; });

      h += '<div class="tabla-scroll"><table><thead><tr><th>Let.</th><th>Función (consolidado)</th><th>Estado</th><th>Origen del cambio</th></tr></thead><tbody>';
      c.filas.forEach(function (r) {
        h += '<tr class="f-' + r.estado + '"><td class="letra">' + esc(r.letra) + "</td>" +
          '<td class="txt">' + esc(r.texto) + "</td>" +
          "<td>" + badge(r.estado) + "</td>" +
          '<td class="origen">' + esc(r.origen) + "</td></tr>";
      });
      h += "</tbody></table></div>";

      if (c.indicadores.length) {
        h += '<div class="subtitulo">Indicadores propuestos (formato KPI)</div><ol class="lista-kpi">';
        c.indicadores.forEach(function (i) { h += "<li>" + esc(i) + "</li>"; });
        h += "</ol>";
      }
      if (c.ops.length) {
        h += '<div class="subtitulo">Operaciones aplicadas</div>';
        c.ops.forEach(function (o) {
          h += "<p class=\"origen\"><b>" + esc(o.operacion) + "</b> (" + o.items.length + " ítem(s))</p>";
          h += '<ul class="lista-kpi">' + o.items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
        });
      }
      if (c.disc.length) {
        h += '<div class="subtitulo">Discrepancias detectadas</div><ul class="disc-lista">';
        c.disc.forEach(function (d) {
          h += "<li><b>" + esc(d.rotulo) + "</b><br>MOF: " + esc(d.mof) + "<br>KPI: " + esc(d.kpi) + "</li>";
        });
        h += "</ul>";
      } else {
        h += '<div class="subtitulo">Discrepancias detectadas</div><p class="ok-verde">Sin diferencias entre la cabecera del MOF y el formato KPI.</p>';
      }
      h += "</div></article>";
      html.push(h);
    });

    $("#resumen").innerHTML =
      '<div class="stat"><b>' + stats.puestos + "</b><span>Puestos</span></div>" +
      '<div class="stat"><b>' + stats.funciones + "</b><span>Funciones MOF</span></div>" +
      '<div class="stat"><b>+' + stats.nueva + "</b><span>Nuevas</span></div>" +
      '<div class="stat"><b>' + stats.modificada + "</b><span>Modificadas</span></div>" +
      '<div class="stat"><b>− ' + stats.eliminada + "</b><span>Eliminadas</span></div>" +
      '<div class="stat"><b>' + stats.disc + "</b><span>Discrepancias</span></div>";
    $("#alineacion-lista").innerHTML = html.length ? html.join("") :
      '<p class="ok-verde">Ningún puesto coincide con el filtro actual.</p>';

    $$(".puesto-head").forEach(function (hd) {
      hd.addEventListener("click", function () {
        var cuerpo = hd.parentElement.querySelector(".puesto-cuerpo");
        cuerpo.hidden = !cuerpo.hidden;
      });
    });
    var primero = $(".puesto-card .puesto-cuerpo");
    if (primero && window.innerWidth > 900) primero.hidden = false;
  }

  function renderPanel() {
    var hn = nodosBase().map(function (n) {
      var nn = nodo(n.id) || {};
      return '<div class="fila-edit" data-nodo="' + n.id + '">' +
        '<div class="et">' + esc(nn.titulo || n.titulo) + " <small>" + esc(n.id) + "</small></div>" +
        '<label class="campo"><span>Título</span><input type="text" data-n="titulo" value="' + esc(nn.titulo) + '"></label>' +
        '<label class="campo"><span>Titular</span><input type="text" data-n="titular" value="' + esc(nn.titular || "") + '"></label>' +
        "</div>";
    }).join("");
    $("#panel-nodos").innerHTML = hn;

    var hf = Object.keys(ESTADO.fichas).map(function (pid) {
      var f = ficha(pid);
      var funcs = (f.funciones || []).map(function (x, i) {
        return '<div class="func-edit" data-i="' + i + '"><div class="num">' + esc(x.letra) + "</div>" +
          '<textarea data-f="' + i + '">' + esc(x.texto) + "</textarea>" +
          '<button class="mini rojo" data-del="' + i + '" title="Eliminar">✕</button></div>';
      }).join("");
      return '<div class="fila-edit" data-ficha="' + pid + '">' +
        '<div class="et">' + esc(f.titulo) + " <small>pág. " + f.pagina + "</small></div>" +
        '<label class="campo"><span>Título del puesto</span><input type="text" data-c="titulo" value="' + esc(f.titulo) + '"></label>' +
        '<label class="campo"><span>Depende de</span><input type="text" data-c="depende" value="' + esc(f.depende) + '"></label>' +
        '<label class="campo"><span>Supervisa a</span><input type="text" data-c="supervisa" value="' + esc(f.supervisa) + '"></label>' +
        '<label class="campo"><span>Propósito principal</span><textarea data-c="proposito">' + esc(f.proposito) + "</textarea></label>" +
        '<div class="et" style="margin-top:.5rem">Funciones <small><button class="mini" data-add="1">+ añadir</button></small></div>' +
        '<div class="funcs">' + funcs + "</div>" +
        '<details style="margin-top:.5rem"><summary class="mini" style="display:inline-block">Estudios y experiencia</summary>' +
        '<label class="campo"><span>Estudios (uno por línea)</span><textarea data-c="estudios">' + esc((f.estudios || []).join("\n")) + "</textarea></label>" +
        '<label class="campo"><span>Experiencia (una por línea)</span><textarea data-c="experiencia">' + esc((f.experiencia || []).join("\n")) + "</textarea></label>" +
        "</details></div>";
    }).join("");
    $("#panel-fichas").innerHTML = hf;

    var hc = ESTADO.cop.map(function (c, i) {
      return '<div class="fila-edit" data-cop="' + i + '">' +
        '<div class="et">' + c.n + ". " + esc(c.puesto) + "</div>" +
        '<label class="campo"><span>Puesto</span><input type="text" data-p="puesto" value="' + esc(c.puesto) + '"></label>' +
        '<label class="campo"><span>Plazas</span><input type="number" min="0" data-p="plazas" value="' + c.plazas + '"></label>' +
        "</div>";
    }).join("");
    $("#panel-cop").innerHTML = hc;

    bindPanel();
    $$("#vista-panel textarea").forEach(crecer);
  }

  function crecer(el) {
    el.style.height = "auto";
    el.style.height = (el.scrollHeight + 2) + "px";
  }

  function bindPanel() {
    $$("#panel-nodos .fila-edit").forEach(function (fila) {
      var id = fila.getAttribute("data-nodo");
      fila.querySelectorAll("input").forEach(function (inp) {
        inp.addEventListener("input", function () {
          ESTADO.nodos[id][inp.getAttribute("data-n")] = inp.value;
          guardar("Cambios pendientes…", true);
        });
      });
    });
    $$("#panel-fichas .fila-edit").forEach(function (fila) {
      var pid = fila.getAttribute("data-ficha");
      fila.querySelectorAll("[data-c]").forEach(function (inp) {
        inp.addEventListener("input", function () {
          var k = inp.getAttribute("data-c");
          if (k === "estudios" || k === "experiencia") ESTADO.fichas[pid][k] = inp.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
          else ESTADO.fichas[pid][k] = inp.value;
          if (inp.tagName === "TEXTAREA") crecer(inp);
          guardar("Cambios pendientes…", true);
        });
      });
      fila.querySelectorAll("textarea[data-f]").forEach(function (ta) {
        ta.addEventListener("input", function () {
          ESTADO.fichas[pid].funciones[+ta.getAttribute("data-f")].texto = ta.value;
          crecer(ta);
          guardar("Cambios pendientes…", true);
        });
      });
      fila.querySelectorAll("[data-del]").forEach(function (b) {
        b.addEventListener("click", function () {
          ESTADO.fichas[pid].funciones.splice(+b.getAttribute("data-del"), 1);
          guardar("Función eliminada."); renderPanel();
        });
      });
      var add = fila.querySelector("[data-add]");
      if (add) add.addEventListener("click", function () {
        var fs = ESTADO.fichas[pid].funciones;
        var ultima = fs.length ? fs[fs.length - 1].letra : null;
        fs.push({ letra: sigLetra(ultima), texto: "Nueva función" });
        guardar("Función añadida."); renderPanel();
      });
    });
    $$("#panel-cop .fila-edit").forEach(function (fila) {
      var i = +fila.getAttribute("data-cop");
      fila.querySelectorAll("input").forEach(function (inp) {
        inp.addEventListener("input", function () {
          var k = inp.getAttribute("data-p");
          ESTADO.cop[i][k] = k === "plazas" ? (parseInt(inp.value, 10) || 0) : inp.value;
          guardar("Cambios pendientes…", true);
        });
      });
    });
  }

  function guardar(msg, suave) {
    var ok = escribirStorage(ESTADO);
    var el = $("#estado-guardado");
    el.textContent = (ok ? "Guardado en este navegador" : "Memoria temporal (localStorage no disponible)") +
      (msg ? " · " + msg : "");
    el.className = "estado-guardado " + (ok ? "ok" : "err");
    if (!suave) { renderAlineacion(); renderOrg(); }
  }

  function exportar() {
    var blob = new Blob([JSON.stringify(ESTADO, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mof-dsa-estado.json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importar(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var obj = JSON.parse(fr.result);
        if (!obj || !obj.fichas || !obj.nodos) throw new Error("estructura no válida");
        ESTADO = mezclar(BASE, obj);
        guardar("Importación correcta.");
        renderPanel(); renderOrg(); renderAlineacion();
      } catch (e) { alert("No se pudo importar el archivo: " + e.message); }
    };
    fr.readAsText(file);
  }

  function restaurar() {
    if (!confirm("¿Restaurar los datos originales extraídos de los PDF/DOCX? Se perderán los cambios guardados.")) return;
    ESTADO = base();
    guardar("Datos originales restaurados.");
    renderPanel(); renderOrg(); renderAlineacion();
  }

  function cambiarVista(v) {
    vistaActual = v;
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-vista") === v); });
    $$(".vista").forEach(function (s) { s.classList.toggle("active", s.id === "vista-" + v); });
    if (v === "alineacion") renderAlineacion();
    if (v === "org") renderOrg();
    if (v === "panel") renderPanel();
  }

  function init() {
    $("#pie-meta").textContent = "Fuentes: " + DATA.meta.fuentes.join(" · ") + " · Generado: " + DATA.meta.generado;
    $$(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        var v = t.getAttribute("data-vista");
        cambiarVista(v);
        if (history.replaceState) history.replaceState(null, "", "#" + v);
      });
    });
    $("#f-buscar").addEventListener("input", renderAlineacion);
    $("#f-estado").addEventListener("change", renderAlineacion);
    $("#btn-guardar").addEventListener("click", function () { guardar("Estado guardado manualmente."); });
    $("#btn-exportar").addEventListener("click", exportar);
    $("#btn-importar").addEventListener("click", function () { $("#input-importar").click(); });
    $("#input-importar").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importar(e.target.files[0]);
      e.target.value = "";
    });
    $("#btn-restaurar").addEventListener("click", restaurar);
    $("#drawer-cerrar").addEventListener("click", function () { $("#drawer").hidden = true; });
    $("#drawer").addEventListener("click", function (e) { if (e.target.id === "drawer") $("#drawer").hidden = true; });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("#drawer").hidden = true; });
    renderOrg();
    renderAlineacion();
    renderPanel();
    var h = (window.location.hash || "").replace("#", "");
    if (h === "alineacion" || h === "panel") cambiarVista(h);
    else if (h.indexOf("ficha-") === 0) { cambiarVista("org"); abrirDrawer(h.slice(6)); }
    guardar(guardado ? "Datos cargados del navegador." : "Primera ejecución: datos originales.", true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
