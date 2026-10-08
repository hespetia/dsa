'use strict';

/* =====================================================================
   POI 2026 · Seguimiento presupuestal
   Aplicación local: HTML + CSS + JS (sin servidor, sin CDN)
   ===================================================================== */

/* ------------------------- Constantes ------------------------- */
const LS_DATA = 'poi.app.v1.data';
const LS_META = 'poi.app.v1.meta';
const DB_NAME = 'poi-escaneos';
const DB_NAME_STORE = 'archivos';
const DB_VERSION = 1;

const SEMAFORO = {
  rojo: { label: 'No ejecutado', css: 'rojo' },
  amarillo: { label: 'En proceso', css: 'amarillo' },
  verde: { label: 'Ejecutado', css: 'verde' },
  noejecuta: { label: 'No se ejecuta', css: 'gris' }
};

/* ------------------------- Utilidades ------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function normalizeText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toNum(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  if (value == null) return 0;
  let s = String(value).trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const parts = s.split(',');
    s = parts.length > 2 ? s.replace(/,/g, '') : `${parts[0]}.${parts[1]}`;
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return negative ? -n : n;
}

function fmtNum(value) {
  const v = Math.round((Number(value) || 0) * 100) / 100;
  const abs = Math.abs(v).toFixed(2);
  const parts = abs.split('.');
  const miles = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${v < 0 ? '-' : ''}${miles},${parts[1]}`;
}
const fmtPct = (n) => `${Math.round(Number(n) || 0)}%`;
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function toast(message, type = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
}

/* ------------------------- Estado ------------------------- */
const state = {
  fileName: '',
  importedAt: null,
  activities: [],
  byId: new Map(),
  sheets: 0,
  warnings: [],
  overrides: {},
  attachments: {},
  selectedId: null,
  depSearch: '',
  idbOk: true,
  idbWarned: false,
  filters: {
    texto: '',
    hoja: '',
    tipo: '',
    trimestre: '',
    estado: '',
    fuente: '',
    presupuesto: '',
    adicional: '',
    orden: 'nro'
  }
};

/* ------------------------- Persistencia localStorage ------------------------- */
const LS = (() => {
  const memoria = {
    available: false,
    store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; }
  };
  try {
    const probe = '__poi_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch (err) {
    return memoria;
  }
})();

function saveData() {
  try {
    LS.setItem(LS_DATA, JSON.stringify({
      fileName: state.fileName,
      importedAt: state.importedAt,
      sheets: state.sheets,
      warnings: state.warnings,
      activities: state.activities
    }));
  } catch (err) {
    toast('No se pudo guardar la copia local de los datos.', 'warn');
  }
}

function saveOverrides() {
  try {
    LS.setItem(LS_META, JSON.stringify({
      overrides: state.overrides,
      updatedAt: new Date().toISOString()
    }));
  } catch (err) {
    /* sin espacio en el navegador: se ignora */
  }
}

function loadStored() {
  try {
    const raw = LS.getItem(LS_META);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.overrides && typeof parsed.overrides === 'object') {
        state.overrides = parsed.overrides;
      }
    }
  } catch (err) { /* datos corruptos: se ignoran */ }

  try {
    const raw = LS.getItem(LS_DATA);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.activities) || !parsed.activities.length) return false;
    state.fileName = parsed.fileName || '';
    state.importedAt = parsed.importedAt || null;
    state.sheets = parsed.sheets || 0;
    state.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    setActivities(parsed.activities);
    return true;
  } catch (err) {
    return false;
  }
}

/* ------------------------- IndexedDB (adjuntos) ------------------------- */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Este navegador no permiteIndexedDB.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_NAME_STORE)) {
        const store = db.createObjectStore(DB_NAME_STORE, { keyPath: 'key' });
        store.createIndex('activityId', 'activityId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueada por otra pestaña.'));
  }).catch((err) => {
    state.idbOk = false;
    throw err;
  });
  return dbPromise;
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_NAME_STORE, 'readonly');
    const req = tx.objectStore(DB_NAME_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_NAME_STORE, 'readwrite');
    tx.objectStore(DB_NAME_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_NAME_STORE, 'readwrite');
    tx.objectStore(DB_NAME_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_NAME_STORE, 'readwrite');
    tx.objectStore(DB_NAME_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function refreshAttachments() {
  state.attachments = {};
  try {
    const records = await dbAll();
    records.forEach((r) => {
      if (!state.attachments[r.activityId]) state.attachments[r.activityId] = [];
      state.attachments[r.activityId].push({
        key: r.key,
        fileId: r.fileId,
        name: r.name,
        type: r.type,
        size: r.size,
        addedAt: r.addedAt
      });
    });
  } catch (err) {
    state.idbOk = false;
    if (!state.idbWarned) {
      state.idbWarned = true;
      toast('Este navegador no permite guardar documentos al abrir el archivo directamente. Usa http://localhost para activarlo; el resto de la app funciona igual.', 'warn');
    }
  }
}

function filesOf(activityId) {
  return state.attachments[activityId] || [];
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

/* ------------------------- Lectura del Excel ------------------------- */
const HEADER_RULES = [
  ['nro', (v) => v === 'nro' || v === 'n' || v === 'numero' || v.startsWith('nro') || v.startsWith('numero')],
  ['codigo', (v) => v.startsWith('codigo') || v === 'cod' || v === 'c o digo' || v.startsWith('cod act')],
  ['detalle', (v) => v.includes('detalle') || v === 'actividad'],
  ['tipo', (v) => v.includes('tipo')],
  ['unidad', (v) => v === 'um' || v === 'u m' || v === 'u medida' || v.startsWith('u medida') || v.includes('unidad de medida') || v.startsWith('unidad medida')],
  ['meta', (v) => v === 'meta' || v.startsWith('meta anual') || v.startsWith('meta total')],
  ['q1', (v) => /^1(er|ro|o)/.test(v) || /trimestre\s*1/.test(v)],
  ['q2', (v) => /^2(do|o)/.test(v) || /trimestre\s*2/.test(v)],
  ['q3', (v) => /^3(er|ro)/.test(v) || /trimestre\s*3/.test(v)],
  ['q4', (v) => /^4(to|o)/.test(v) || /trimestre\s*4/.test(v)],
  ['fuente', (v) => v.includes('fuente') || v.includes('financiamiento')],
  ['presupuesto', (v) => v.includes('presupuesto') || v.includes('ppto')],
  ['entregable', (v) => v.includes('entregable') || v.includes('producto obtenido')],
  ['sustento', (v) => v.includes('sustento') || v.includes('regristo') || v.includes('expediente') || v.includes('registro')],
  ['indicador', (v) => v.includes('indicador') || v.includes('medicion')],
  ['observacion', (v) => v.includes('observacion')]
];

function mapHeader(cell) {
  const v = normalizeText(cell);
  if (!v) return null;
  for (const [field, test] of HEADER_RULES) {
    if (test(v)) return field;
  }
  return null;
}

const FALLBACK_MAP = {
  nro: 0, codigo: 1, detalle: 3, tipo: 4, unidad: 5, meta: 6,
  q1: 7, q2: 8, q3: 9, q4: 10, fuente: 11, presupuesto: 12,
  entregable: 13, sustento: 14, indicador: 15, observacion: 16
};

function detectHeaderRow(rows) {
  const limit = Math.min(rows.length, 25);
  const width = (r) => {
    let w = 0;
    [r, r - 1, r - 2].forEach((i) => {
      if (i >= 0 && rows[i] && rows[i].length > w) w = rows[i].length;
    });
    return w;
  };

  let best = null;
  let bestScore = 0;
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r] || [];
    const map = {};
    let count = 0;
    const w = width(r);
    for (let c = 0; c < w; c += 1) {
      const parts = [row, rows[r - 1], rows[r - 2]]
        .map((rr) => (rr && rr[c] != null ? String(rr[c]).trim() : ''))
        .filter(Boolean);
      if (!parts.length) continue;
      const joined = parts.join(' ');
      const field = mapHeader(parts[0]) || mapHeader(joined) || (parts[1] ? mapHeader(parts[1]) : null);
      if (field && map[field] === undefined) {
        map[field] = c;
        count += 1;
      }
    }
    if (map.detalle === undefined) continue;
    let score = count;
    if (map.presupuesto !== undefined) score += 2;
    if (map.nro !== undefined) score += 1;
    if (map.codigo !== undefined) score += 1;
    if (score >= 6 && score >= bestScore) {
      best = { row: r, map };
      bestScore = score;
    }
  }
  return best;
}

const META_LABELS = [
  ['unidad', (v) => v.startsWith('unidad operativa') || v === 'unidad' || v.startsWith('unidad responsable') || v.startsWith('area')],
  ['eje', (v) => v === 'eje' || v.startsWith('eje estrategico') || v.startsWith('eje ')],
  ['objetivo', (v) => v.startsWith('objetivo')],
  ['accion', (v) => v.startsWith('accion estrategica') || v === 'accion' || v.startsWith('accion ')]
];

function extractSheetMeta(rows, upto) {
  const out = { titulo: '', unidad: '', eje: '', objetivo: '', accion: '' };
  const limit = Math.min(upto, rows.length);
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      const raw = String(row[c] == null ? '' : row[c]).trim();
      if (!raw) continue;
      if (r === 0 && !out.titulo) out.titulo = raw;
      const norm = normalizeText(raw);
      for (const [key, test] of META_LABELS) {
        if (out[key] || !test(norm)) continue;
        for (let k = c + 1; k < row.length; k += 1) {
          const raw2 = row[k];
          if (raw2 == null || String(raw2).trim() === '') continue;
          let value = String(raw2).trim();
          const colon = value.indexOf(':');
          if (colon > -1 && colon < 60 && normalizeText(value.slice(0, colon)).startsWith(norm.replace(/:$/, ''))) {
            value = value.slice(colon + 1).trim();
          }
          if (value) out[key] = value;
          break;
        }
      }
    }
  }
  return out;
}

function cleanCode(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const digits = s.replace(/[.,\s]/g, '');
  if (/^\d+$/.test(digits)) return digits;
  return s;
}

function sheetKeyOf(name) {
  const m = String(name).match(/(\d{3,5})/);
  return m ? m[1] : normalizeText(name).replace(/\s+/g, '-');
}

function parseSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], header: null };
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
    raw: false
  });
  return { rows, header: detectHeaderRow(rows) };
}

function parseWorkbook(workbook) {
  const activities = [];
  const warnings = [];
  const seen = new Map();

  workbook.SheetNames.forEach((sheetName) => {
    const { rows, header } = parseSheet(workbook, sheetName);
    if (!header) {
      warnings.push(`Hoja "${sheetName}" sin encabezados reconocibles: se aplicó la estructura de columnas esperada (A a Q).`);
    }
    const map = header ? header.map : { ...FALLBACK_MAP };
    const headerRow = header ? header.row : 0;
    const meta = extractSheetMeta(rows, headerRow);
    const key = sheetKeyOf(sheetName);
    const cell = (row, field) => (map[field] === undefined ? '' : (row[map[field]] == null ? '' : row[map[field]]));
    const text = (row, field) => String(cell(row, field)).trim();
    let sinCodigo = 0;

    for (let r = headerRow + 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const flat = row.map((v) => String(v == null ? '' : v).trim());
      if (flat.every((v) => v === '')) continue;
      if (flat.some((v) => /^sub\s*total/i.test(v))) break;

      const detalle = text(row, 'detalle');
      const codigo = cleanCode(text(row, 'codigo'));
      if (!detalle && !codigo) continue;
      if (!codigo) sinCodigo += 1;

      let id = `${key}::${codigo || `F${r + 1}`}`;
      if (seen.has(id)) {
        warnings.push(`Código duplicado ${codigo} en la hoja "${sheetName}"; se identificó por código y fila.`);
        id = `${id}::F${r + 1}`;
      }
      seen.set(id, true);

      activities.push({
        id,
        hoja: sheetName,
        hojaKey: key,
        celda: `Fila ${r + 1}`,
        titulo: meta.titulo,
        unidadOperativa: meta.unidad,
        eje: meta.eje,
        objetivo: meta.objetivo,
        accion: meta.accion,
        nro: toNum(text(row, 'nro')),
        codigo,
        detalle,
        tipo: text(row, 'tipo'),
        unidadMedida: text(row, 'unidad'),
        meta: toNum(text(row, 'meta')),
        metas: [toNum(text(row, 'q1')), toNum(text(row, 'q2')), toNum(text(row, 'q3')), toNum(text(row, 'q4'))],
        fuente: text(row, 'fuente'),
        presupuesto: toNum(text(row, 'presupuesto')),
        entregable: text(row, 'entregable'),
        sustento: text(row, 'sustento'),
        indicador: text(row, 'indicador'),
        observacionExcel: text(row, 'observacion')
      });
    }

    if (sinCodigo) warnings.push(`${sinCodigo} actividad(es) de "${sheetName}" llegaron sin código y se identificaron por fila.`);
  });

  const sinFuente = activities.filter((a) => a.presupuesto > 0 && !a.fuente).length;
  if (sinFuente) warnings.push(`${sinFuente} actividad(es) con presupuesto no consignan fuente de financiamiento.`);
  const sinMeta = activities.filter((a) => !(a.meta > 0)).length;
  if (sinMeta) warnings.push(`${sinMeta} actividad(es) no consignan meta; revisa el Excel de origen.`);
  const sinPresupuesto = activities.filter((a) => !(a.presupuesto > 0)).length;
  if (sinPresupuesto) warnings.push(`${sinPresupuesto} actividad(es) tienen presupuesto 0.00.`);
  const descuadre = activities.filter((a) => Math.abs(sumaTrimestres(a) - (a.meta || 0)) > 0.0001);
  if (descuadre.length) {
    warnings.push(`${descuadre.length} actividad(es) tienen metas trimestrales que no suman la meta total; revisa el Excel de origen.`);
  }
  const sinTrimestre = activities.filter((a) => sumaTrimestres(a) === 0).length;
  if (sinTrimestre) warnings.push(`${sinTrimestre} actividad(es) no tienen meta por trimestre.`);
  if (!activities.length) warnings.push('No se detectó ninguna fila de actividad.');

  return { activities, warnings };
}

function setActivities(list) {
  state.activities = list || [];
  state.byId = new Map(state.activities.map((a) => [a.id, a]));
  state.sheets = new Set(state.activities.map((a) => a.hoja)).size;
}

/* ------------------------- Datos derivados ------------------------- */
function overrideOf(activity) {
  const raw = state.overrides[activity.id] || {};
  return {
    avance: clamp(raw.avance, 0, 100),
    monto: raw.monto == null ? null : Number(raw.monto),
    noEjecuta: !!raw.noEjecuta,
    dependencias: Array.isArray(raw.dependencias) ? raw.dependencias : [],
    observaciones: typeof raw.observaciones === 'string' ? raw.observaciones : ''
  };
}

function patchOverride(activityId, patch) {
  const prev = state.overrides[activityId] || { avance: 0, monto: null, noEjecuta: false, dependencias: [], observaciones: '' };
  const next = { ...prev, ...patch };
  const touchedAvance = Object.prototype.hasOwnProperty.call(patch, 'avance');
  const touchedMonto = Object.prototype.hasOwnProperty.call(patch, 'monto');
  const a = state.byId.get(activityId);

  if (a) {
    if (a.presupuesto > 0) {
      if (touchedMonto) {
        next.monto = clamp(patch.monto, 0, a.presupuesto);
        next.avance = clamp((next.monto / a.presupuesto) * 100, 0, 100);
      } else if (touchedAvance) {
        next.avance = clamp(patch.avance, 0, 100);
        next.monto = Math.round(a.presupuesto * next.avance) / 100;
      } else if (typeof next.monto !== 'number' || !isFinite(next.monto)) {
        next.monto = Math.round(a.presupuesto * next.avance) / 100;
      } else {
        next.avance = clamp((next.monto / a.presupuesto) * 100, 0, 100);
      }
    } else {
      next.avance = clamp(touchedAvance ? patch.avance : next.avance, 0, 100);
      next.monto = 0;
    }
    next.dependencias = Array.from(new Set(
      (Array.isArray(next.dependencias) ? next.dependencias : [])
        .filter((id) => id !== activityId && state.byId.has(id))
    ));
    if (typeof next.observaciones !== 'string') next.observaciones = '';
  }

  state.overrides[activityId] = next;
  saveOverrides();
  return next;
}

function avanceOf(activity) {
  return overrideOf(activity).avance;
}

function montoOf(activity) {
  const ov = overrideOf(activity);
  if (activity.presupuesto > 0 && ov.monto != null) return clamp(ov.monto, 0, activity.presupuesto);
  return Math.round(activity.presupuesto * ov.avance) / 100;
}

function noEjecutaOf(activity) {
  return overrideOf(activity).noEjecuta;
}

function estadoOf(activity) {
  const av = avanceOf(activity);
  if (av >= 100) return 'verde';
  if (av > 0) return 'amarillo';
  return 'rojo';
}

function categoriaOf(activity) {
  return noEjecutaOf(activity) ? 'noejecuta' : estadoOf(activity);
}

function semaforoClass(activity) {
  return noEjecutaOf(activity) ? 'gris' : estadoOf(activity);
}

function depsOf(activity) {
  return overrideOf(activity).dependencias;
}

function obsOf(activity) {
  return overrideOf(activity).observaciones || activity.observacionExcel || '';
}

function tieneAlerta(activity) {
  return !filesOf(activity.id).length && !overrideOf(activity).observaciones.trim() && estadoOf(activity) !== 'verde';
}

const TRIMESTRES = ['1er trimestre', '2do trimestre', '3er trimestre', '4to trimestre'];

function fmtQ(value) {
  const v = Number(value) || 0;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 10) / 10);
}

function trimestreActivo(a, indice) {
  return Array.isArray(a.metas) && Number(a.metas[indice]) > 0;
}

function sumaTrimestres(a) {
  return (a.metas || []).reduce((s, m) => s + (Number(m) || 0), 0);
}

/* ------------------------- Filtrado y KPIs ------------------------- */
function getFiltered() {
  const f = state.filters;
  const q = normalizeText(f.texto);
  const trimestre = f.trimestre;
  const list = state.activities.filter((a) => {
    if (f.hoja && a.hojaKey !== f.hoja) return false;
    if (f.tipo && a.tipo !== f.tipo) return false;
    if (trimestre === 'ninguno') {
      if ((a.metas || []).some((m) => Number(m) > 0)) return false;
    } else if (trimestre) {
      if (!trimestreActivo(a, Number(trimestre) - 1)) return false;
    }
    if (f.estado && categoriaOf(a) !== f.estado) return false;
    if (f.fuente) {
      if (f.fuente === '__vacio') {
        if (String(a.fuente || '').trim()) return false;
      } else if (a.fuente !== f.fuente) return false;
    }
    if (f.presupuesto === 'con' && !(a.presupuesto > 0)) return false;
    if (f.presupuesto === 'sin' && !(a.presupuesto <= 0)) return false;
    const files = filesOf(a.id).length;
    const obs = overrideOf(a).observaciones.trim();
    if (f.adicional === 'adj' && !files) return false;
    if (f.adicional === 'obs' && !obs) return false;
    if (f.adicional === 'dep' && !depsOf(a).length) return false;
    if (f.adicional === 'alerta' && !tieneAlerta(a)) return false;
    if (q) {
      const haystack = normalizeText([
        a.codigo, a.detalle, a.tipo, a.hoja, a.eje, obs,
        (a.metas || []).map((m, i) => (Number(m) > 0 ? TRIMESTRES[i] : '')).join(' ')
      ].join(' '));
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const dir = f.orden;
  list.sort((x, y) => {
    if (dir === 'presupuesto') return y.presupuesto - x.presupuesto;
    if (dir === 'avance') return avanceOf(x) - avanceOf(y) || y.presupuesto - x.presupuesto;
    if (dir === 'avance_desc') return avanceOf(y) - avanceOf(x) || y.presupuesto - x.presupuesto;
    if (dir === 'detalle') return String(x.detalle).localeCompare(String(y.detalle), 'es');
    return x.hojaKey.localeCompare(y.hojaKey) || (x.nro - y.nro) || String(x.codigo).localeCompare(String(y.codigo), 'es', { numeric: true });
  });
  return list;
}

function resumen(list) {
  const r = {
    total: list.length,
    presupuesto: 0,
    ejecutado: 0,
    rojo: { n: 0, monto: 0, pendiente: 0 },
    amarillo: { n: 0, monto: 0, pendiente: 0 },
    verde: { n: 0, monto: 0, pendiente: 0 },
    noejecuta: { n: 0, monto: 0 },
    conObs: 0,
    conDep: 0,
    conArchivos: 0,
    archivos: 0
  };
  list.forEach((a) => {
    const p = a.presupuesto || 0;
    const m = montoOf(a);
    const cat = categoriaOf(a);
    r.presupuesto += p;
    r.ejecutado += m;
    if (r[cat]) {
      r[cat].n += 1;
      r[cat].monto += p;
      r[cat].pendiente = (r[cat].pendiente || 0) + (p - m);
    }
    if (overrideOf(a).observaciones.trim()) r.conObs += 1;
    if (depsOf(a).length) r.conDep += 1;
    const f = filesOf(a).length;
    if (f) { r.conArchivos += 1; r.archivos += f; }
  });
  r.avanceGlobal = r.presupuesto > 0 ? (r.ejecutado / r.presupuesto) * 100 : 0;
  return r;
}

/* ------------------------- Render: KPIs y filtros ------------------------- */
function renderKpis() {
  const r = resumen(state.activities);
  const kpis = [
    {
      key: '', cls: 'azul', label: 'Actividades', value: r.total,
      extra: `Presupuesto total ${fmtNum(r.presupuesto)}`
    },
    {
      key: 'rojo', cls: 'rojo', label: 'No ejecutado', value: r.rojo.n,
      extra: `Pendiente ${fmtNum(r.rojo.pendiente)}`
    },
    {
      key: 'amarillo', cls: 'amarillo', label: 'En proceso', value: r.amarillo.n,
      extra: `${fmtNum(r.amarillo.monto)} en juego`
    },
    {
      key: 'verde', cls: 'verde', label: 'Ejecutado', value: r.verde.n,
      extra: `${fmtNum(r.verde.monto)} ejecutados`
    },
    {
      key: '', cls: '', label: 'Avance global', value: fmtPct(r.avanceGlobal),
      extra: `${fmtNum(r.ejecutado)} de ${fmtNum(r.presupuesto)}`
    },
    {
      key: 'noejecuta', cls: '', label: 'No se ejecuta', value: r.noejecuta.n,
      extra: `${fmtNum(r.noejecuta.monto)} excluidos`
    },
    {
      key: '', cls: '', label: 'Respaldo documental', value: r.archivos,
      extra: `${r.conArchivos} actividad(es) · ${r.conObs} con obs. · ${r.conDep} con deps.`
    }
  ];

  $('#kpis').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls}" data-filter="${k.key}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${esc(k.value)}</div>
      <div class="kpi-extra">${k.extra}</div>
    </div>
  `).join('');

  $$('#kpis .kpi').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.filter;
      if (!key) return;
      const select = $('#fEstado');
      select.value = select.value === key ? '' : key;
      state.filters.estado = select.value;
      render();
    });
  });
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter((v) => v != null && String(v).trim() !== '')))
    .sort((a, b) => String(a).localeCompare(String(b), 'es', { numeric: true }));
}

function fillSelect(select, values, todosLabel) {
  const current = select.value;
  select.innerHTML = `<option value="">${todosLabel}</option>${values
    .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  select.value = values.includes(current) ? current : '';
}

function populateFilters() {
  const hojas = uniqueSorted(state.activities.map((a) => a.hoja));
  const selHoja = $('#fHoja');
  selHoja.innerHTML = '<option value="">Todas las hojas</option>'
    + hojas.map((h) => `<option value="${esc(sheetKeyOf(h))}">${esc(h)}</option>`).join('');
  selHoja.value = hojas.some((h) => sheetKeyOf(h) === state.filters.hoja) ? state.filters.hoja : '';

  fillSelect($('#fTipo'), uniqueSorted(state.activities.map((a) => a.tipo)), 'Todos los tipos');

  const fuentes = uniqueSorted(state.activities.map((a) => a.fuente));
  const selFuente = $('#fFuente');
  selFuente.innerHTML = '<option value="">Todos</option><option value="__vacio">Sin financiamiento</option>'
    + fuentes.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  selFuente.value = (fuentes.includes(state.filters.fuente) || state.filters.fuente === '__vacio') ? state.filters.fuente : '';
}

function syncFilterInputs() {
  $('#fText').value = state.filters.texto;
  $('#fHoja').value = state.filters.hoja;
  $('#fTipo').value = state.filters.tipo;
  $('#fTrimestre').value = state.filters.trimestre;
  $('#fEstado').value = state.filters.estado;
  $('#fPresupuesto').value = state.filters.presupuesto;
  $('#fAdicional').value = state.filters.adicional;
  $('#fOrden').value = state.filters.orden;
}

/* ------------------------- Render: tabla ------------------------- */
function rowHtml(a) {
  const av = avanceOf(a);
  const est = estadoOf(a);
  const sem = semaforoClass(a);
  const cat = categoriaOf(a);
  const files = filesOf(a);
  const obs = overrideOf(a).observaciones.trim();
  const deps = depsOf(a);
  const filtroT = state.filters.trimestre;
  const badges = [];
  if (files.length) badges.push(`<span class="badge" title="Documentos de respaldo">${files.length} doc.</span>`);
  if (obs) badges.push(`<span class="badge" title="Con observación">obs.</span>`);
  if (deps.length) badges.push(`<span class="badge" title="Dependencias">${deps.length} dep.</span>`);
  if (noEjecutaOf(a)) badges.push('<span class="badge" title="Marcada como no se ejecuta">no se ejecuta</span>');

  const celdasT = (a.metas || []).map((m, i) => {
    const hit = filtroT && String(i + 1) === filtroT;
    return `<td class="col-q ${Number(m) > 0 ? 'q-ok' : 'q-zero'}${hit ? ' q-hit' : ''}" title="${TRIMESTRES[i]}: ${fmtQ(m)} ${esc(a.unidadMedida || '')}">${fmtQ(m)}</td>`;
  }).join('');

  return `
    <tr data-id="${esc(a.id)}" class="${cat === 'noejecuta' ? 'no-ejecuta' : ''} ${state.selectedId === a.id ? 'sel' : ''}">
      <td class="col-dot" title="${SEMAFORO[cat].label}"><span class="semaforo ${sem}"></span></td>
      <td class="col-nro">${esc(a.nro || '')}</td>
      <td class="col-cod">${esc(a.codigo)}</td>
      <td class="detalle">${esc(a.detalle)}</td>
      <td class="col-tipo">${a.tipo ? `<span class="chip info">${esc(a.tipo)}</span>` : ''}</td>
      <td class="col-meta" title="Meta anual">${fmtNum(a.meta)}<div class="muted">${esc(a.unidadMedida)}</div></td>
      ${celdasT}
      <td class="col-monto">${fmtNum(a.presupuesto)}${a.presupuesto > 0 ? `<div class="muted">ejec. ${fmtNum(montoOf(a))}</div>` : ''}</td>
      <td class="col-avance">
        <div class="bar-wrap">
          <span class="bar"><i class="${sem}" style="width:${clamp(av, 0, 100)}%"></i></span>
          <span>${fmtPct(av)}</span>
        </div>
      </td>
      <td class="col-estado"><span class="chip ${sem}">${SEMAFORO[cat].label}</span></td>
      <td class="col-docs">${badges.join(' ') || '<span class="muted">—</span>'}</td>
    </tr>
  `;
}

function renderTable() {
  const list = getFiltered();
  const r = resumen(list);
  const body = $('#rows');
  if (!list.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="14">No hay actividades que coincidan con los filtros aplicados.</td></tr>`;
  } else {
    body.innerHTML = list.map(rowHtml).join('');
  }
  const etiquetas = [];
  if (state.filters.trimestre && state.filters.trimestre !== 'ninguno') etiquetas.push(TRIMESTRES[Number(state.filters.trimestre) - 1]);
  if (state.filters.estado) etiquetas.push(SEMAFORO[state.filters.estado].label);
  $('#tableTitle').textContent = `Actividades${etiquetas.length ? ` · ${etiquetas.join(' · ')}` : ''}`;
  $('#countInfo').textContent = `Mostrando ${list.length} de ${state.activities.length} actividades`;
  $('#sumInfo').textContent = `Presupuesto ${fmtNum(r.presupuesto)} · Ejecutado ${fmtNum(r.ejecutado)} · Avance ${fmtPct(r.avanceGlobal)}`;
}

function renderWarnings() {
  const card = $('#warningsCard');
  if (!state.warnings.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#warningsList').innerHTML = state.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
}

function renderSource() {
  $('#sourceInfo').textContent = state.fileName
    ? `${state.fileName} · ${state.activities.length} actividades · ${state.sheets} hojas · cargado el ${fechaCorta(state.importedAt)}`
    : 'Sin archivo cargado';
}

function render() {
  renderSource();
  renderKpis();
  renderTable();
  renderWarnings();
  $('#intro').hidden = state.activities.length > 0;
  $('#workspace').hidden = state.activities.length === 0;
  $$('.actions .btn, .actions label.btn').forEach((el) => {
    const off = state.activities.length === 0;
    el.style.opacity = off ? '.5' : '';
    el.style.pointerEvents = off ? 'none' : '';
  });
}

/* ------------------------- Panel de detalle ------------------------- */
function statusBoxHtml(a) {
  const av = avanceOf(a);
  const est = estadoOf(a);
  const cat = categoriaOf(a);
  const m = montoOf(a);
  const p = a.presupuesto || 0;
  return `
    <span class="chip ${semaforoClass(a)}">${SEMAFORO[cat].label}</span>
    <span class="chip ${est}">${est === 'verde' ? 'Presupuesto ejecutado' : est === 'amarillo' ? 'En proceso' : 'Presupuesto no ejecutado'}</span>
    <span class="chip gris">Avance ${fmtPct(av)}</span>
    <span class="chip gris">Ejecutado ${fmtNum(m)}</span>
    <span class="chip gris">Pendiente ${fmtNum(Math.max(0, p - m))}</span>
  `;
}

function filesHtml(a) {
  const files = filesOf(a.id);
  if (!files.length) return '<p class="muted">Sin documentos de respaldo.</p>';
  return `<ul class="files">${files.map((f) => `
    <li class="file" data-key="${esc(f.key)}">
      <span class="f-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="f-meta">${humanSize(f.size)} · ${esc(fechaCorta(f.addedAt))}</span>
      <span class="file-actions">
        <button type="button" class="btn btn-ghost btn-icon" data-file-action="open" title="Abrir">Abrir</button>
        <button type="button" class="btn btn-ghost btn-icon" data-file-action="download" title="Descargar">Bajar</button>
        <button type="button" class="btn btn-danger btn-icon" data-file-action="delete" title="Eliminar">Quitar</button>
      </span>
    </li>`).join('')}</ul>`;
}

function depChipsHtml(a) {
  const deps = depsOf(a);
  if (!deps.length) return '<p class="muted">Esta actividad no depende de otras.</p>';
  return `<div class="chips">${deps.map((id) => {
    const d = state.byId.get(id);
    return `<span class="chip info" title="${esc(d ? d.detalle : id)}">${esc(d ? `${d.hojaKey}-${d.codigo}` : id)}<span class="chip-remove" data-dep-remove="${esc(id)}">x</span></span>`;
  }).join('')}</div>`;
}

function depListHtml(a) {
  const q = normalizeText(state.depSearch);
  const selected = new Set(depsOf(a));
  return state.activities
    .filter((o) => o.id !== a.id)
    .filter((o) => !q || normalizeText(`${o.hojaKey} ${o.codigo} ${o.detalle} ${o.tipo}`).includes(q))
    .map((o) => `
      <label class="dep-item">
        <input type="checkbox" data-dep="${esc(o.id)}" ${selected.has(o.id) ? 'checked' : ''}>
        <span>
          <strong>${esc(o.hojaKey)}-${esc(o.codigo)}</strong> ${esc(o.detalle)}
          <span class="dep-meta">${esc(o.tipo)} · ${SEMAFORO[categoriaOf(o)].label}</span>
        </span>
      </label>`).join('') || '<p class="muted" style="padding:10px">Sin coincidencias.</p>';
}

function tablaTrimestresHtml(a) {
  const total = sumaTrimestres(a);
  const anual = a.meta || 0;
  const cuadra = Math.abs(total - anual) < 0.0001;
  const filas = (a.metas || []).map((m, i) => {
    const valor = Number(m) || 0;
    const pct = anual > 0 ? (valor / anual) * 100 : 0;
    return `
      <tr class="${valor > 0 ? 'q-ok' : 'q-zero'}">
        <td>${TRIMESTRES[i]}</td>
        <td class="num">${fmtQ(valor)}</td>
        <td class="num">${anual > 0 ? fmtPct(pct) : '—'}</td>
        <td>${valor > 0 ? '<span class="chip info">programada</span>' : '<span class="muted">sin meta</span>'}</td>
      </tr>`;
  }).join('');
  return `
    <table class="q-table">
      <thead><tr><th>Trimestre</th><th class="num">Meta programada</th><th class="num">% del total</th><th>Situación en el POI</th></tr></thead>
      <tbody>
        ${filas}
        <tr class="q-total">
          <td>Suma de trimestres</td>
          <td class="num">${fmtQ(total)}</td>
          <td class="num">${anual > 0 ? fmtPct((total / anual) * 100) : '—'}</td>
          <td>${cuadra ? '<span class="chip verde">coincide con la meta</span>' : '<span class="chip rojo">revisar en el Excel</span>'}</td>
        </tr>
      </tbody>
    </table>
    <p class="hint">Metas trimestrales tomadas del Excel (columnas 1er, 2do, 3er y 4to). Meta anual: ${fmtQ(anual)} ${esc(a.unidadMedida || '')}.</p>
  `;
}

function drawerHtml(a) {
  const ov = overrideOf(a);
  const conMeta = (a.metas || []).map((m, i) => (Number(m) > 0 ? TRIMESTRES[i].slice(0, 2) : '')).filter(Boolean);
  const chipsT = conMeta.length
    ? conMeta.map((t) => `<span class="chip info">meta ${t}</span>`).join(' ')
    : '<span class="chip gris">sin meta por trimestre</span>';
  return `
    <div class="section">
      <h3>Semáforo de ejecución</h3>
      <div class="card-in">
        <div class="chips" id="dStatusBox">${statusBoxHtml(a)}</div>
        <div class="row">
          <label class="field" style="flex:2 1 240px">
            <span>Avance presupuestal</span>
            <input type="range" id="dAvanceRange" min="0" max="100" step="1" value="${Math.round(ov.avance)}">
          </label>
          <label class="field" style="flex:0 1 90px">
            <span>Avance %</span>
            <input type="number" id="dAvanceNum" min="0" max="100" step="1" value="${Math.round(ov.avance)}">
          </label>
          <label class="field" style="flex:0 1 150px">
            <span>Monto ejecutado</span>
            <input type="number" id="dMonto" min="0" max="${a.presupuesto || 0}" step="0.01" value="${montoOf(a).toFixed(2)}" ${a.presupuesto > 0 ? '' : 'disabled'}>
          </label>
        </div>
        <p class="hint">El semáforo es automático: 0% rojo (no ejecutado), 1–99% amarillo (en proceso), 100% verde (ejecutado).</p>
        <label style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <input type="checkbox" id="dNoEjecuta" ${ov.noEjecuta ? 'checked' : ''}>
          <span>Marcar como "no se ejecuta" (queda fuera de los tres semáforo)</span>
        </label>
      </div>
    </div>

    <div class="section">
      <h3>Dependencias</h3>
      <div class="card-in">
        <div id="dDepChips">${depChipsHtml(a)}</div>
        <input type="search" id="dDepSearch" class="dep-search" placeholder="Buscar actividad para agregar como dependencia…" value="${esc(state.depSearch)}">
        <div class="dep-list" id="dDepList">${depListHtml(a)}</div>
        <p class="hint">Marca las actividades que deben ejecutarse antes que esta.</p>
      </div>
    </div>

    <div class="section">
      <h3>Documentos de respaldo</h3>
      <div class="card-in">
        <div class="drop" id="dDrop">Arrastra oficios, documentos o archivos aquí, o haz clic para elegir</div>
        <input type="file" id="dFiles" multiple hidden>
        <div id="dFilesList">${filesHtml(a)}</div>
        <p class="hint">Se guardan en este navegador (IndexedDB). Formatos habituales: PDF, Word, Excel, imágenes.</p>
      </div>
    </div>

    <div class="section">
      <h3>Observaciones</h3>
      <textarea id="dObs" placeholder="Registra aquí el seguimiento de la actividad, reuniones, impedimentos o acuerdos tomados…">${esc(ov.observaciones)}</textarea>
      ${a.observacionExcel ? `<p class="hint">Observación que venía en el Excel: ${esc(a.observacionExcel)}</p>` : ''}
    </div>

    <div class="section">
      <h3>Metas por trimestre (según el Excel)</h3>
      <div class="card-in">
        <div class="chips">${chipsT}</div>
        ${tablaTrimestresHtml(a)}
      </div>
    </div>

    <div class="section">
      <h3>Datos del Excel (referencia)</h3>
      <div class="card-in">
        <dl class="kv">
          <dt>Hoja</dt><dd>${esc(a.hoja)} (${esc(a.celda)})</dd>
          <dt>Código</dt><dd>${esc(a.codigo)}</dd>
          <dt>Detalle</dt><dd>${esc(a.detalle)}</dd>
          <dt>Tipo</dt><dd>${esc(a.tipo || '—')}</dd>
          <dt>Unidad de medida</dt><dd>${esc(a.unidadMedida || '—')}</dd>
          <dt>Meta total</dt><dd>${fmtNum(a.meta)} ${esc(a.unidadMedida || '')}</dd>
          <dt>Fuente de financiamiento</dt><dd>${esc(a.fuente || '—')}</dd>
          <dt>Presupuesto solicitado</dt><dd>${fmtNum(a.presupuesto)}</dd>
          <dt>Entregable</dt><dd>${esc(a.entregable || '—')}</dd>
          <dt>Sustento / expediente</dt><dd>${esc(a.sustento || '—')}</dd>
          <dt>Indicador de desempeño</dt><dd>${esc(a.indicador || '—')}</dd>
          ${a.eje ? `<dt>Eje</dt><dd>${esc(a.eje)}</dd>` : ''}
          ${a.objetivo ? `<dt>Objetivo</dt><dd>${esc(a.objetivo)}</dd>` : ''}
          ${a.accion ? `<dt>Acción estratégica</dt><dd>${esc(a.accion)}</dd>` : ''}
        </dl>
      </div>
    </div>

    <div class="drawer-actions">
      <span class="hint" style="flex:1;align-self:center">Los cambios se guardan automáticamente en este equipo.</span>
      <button type="button" class="btn btn-primary" id="dDone">Listo</button>
    </div>
  `;
}

function bindDrop() {
  const drop = $('#dDrop');
  if (!drop) return;
  ['dragenter', 'dragover'].forEach((evt) => {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });
}

function openDrawer(activityId) {
  const a = state.byId.get(activityId);
  if (!a) return;
  state.selectedId = activityId;
  $('#dTitle').textContent = a.detalle || a.codigo || 'Actividad';
  $('#dSubtitle').textContent = `${a.hoja} · N° ${a.nro || '—'} · Código ${a.codigo || '—'} · ${a.tipo || ''}`;  $('#dBody').innerHTML = drawerHtml(a);
  bindDrop();
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  renderTable();
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  state.selectedId = null;
  state.depSearch = '';
  renderTable();
}

function currentActivity() {
  return state.selectedId ? state.byId.get(state.selectedId) : null;
}

function updateLive() {
  renderKpis();
  renderTable();
  const a = currentActivity();
  if (!a) return;
  const box = $('#dStatusBox');
  if (box) box.innerHTML = statusBoxHtml(a);
  const list = $('#dFilesList');
  if (list) list.innerHTML = filesHtml(a);
  const chips = $('#dDepChips');
  if (chips) chips.innerHTML = depChipsHtml(a);
}

/* ------------------------- Adjuntos ------------------------- */
async function addFiles(fileList) {
  const a = currentActivity();
  if (!a || !fileList || !fileList.length) return;
  if (!state.idbOk) {
    toast('Este navegador bloquea el guardado de archivos al abrir el POI con doble clic. Abre la app desde http://localhost para poder adjuntar documentos.', 'warn');
    return;
  }
  let guard = 0;
  for (const file of Array.from(fileList)) {
    if (guard >= 25) {
      toast('Se adjuntaron 25 archivos por vez; agrega el resto en otra carga.', 'warn');
      break;
    }
    guard += 1;
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const key = `${a.id}::${fileId}`;
    try {
      await dbPut({
        key,
        activityId: a.id,
        fileId,
        name: file.name,
        type: file.type,
        size: file.size,
        addedAt: new Date().toISOString(),
        blob: file
      });
      await refreshAttachments();
      toast(`Se adjuntó "${file.name}".`, 'ok');
    } catch (err) {
      console.error(err);
      toast(`No se pudo guardar "${file.name}".`, 'err');
    }
  }
  updateLive();
}

async function getFileRecord(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_NAME_STORE, 'readonly');
    const req = tx.objectStore(DB_NAME_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function openOrDownload(key, download) {
  const rec = await getFileRecord(key);
  if (!rec || !rec.blob) {
    toast('El archivo no se encontró en este equipo.', 'err');
    return;
  }
  const url = URL.createObjectURL(rec.blob);
  if (download) {
    const link = document.createElement('a');
    link.href = url;
    link.download = rec.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return;
  }
  const win = window.open(url, '_blank');
  if (!win) {
    const link = document.createElement('a');
    link.href = url;
    link.download = rec.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ------------------------- Exportaciones ------------------------- */
function exportExcel() {
  if (!state.activities.length) {
    toast('Primero carga el archivo Excel.', 'warn');
    return;
  }
  const header = [
    'Hoja', 'Nro', 'Codigo', 'Detalle de Actividad', 'Tipo de Actividad', 'U.Medida', 'Meta',
    '1er', '2do', '3er', '4to', 'Trimestres con meta', 'Fuente de Financiamiento', 'Presupuesto Solicitado',
    'Presupuesto Ejecutado', 'Presupuesto Pendiente', 'Avance %', 'Semoforo', 'No se Ejecuta',
    'Dependencias', 'Entregable', 'Sustento', 'Indicador', 'Observacion Excel', 'Observacion App', 'N° Documentos'
  ];
  const rows = state.activities.map((a) => {
    const m = montoOf(a);
    const av = avanceOf(a);
    const deps = depsOf(a)
      .map((id) => {
        const d = state.byId.get(id);
        return d ? `${d.hojaKey}-${d.codigo}` : id;
      })
      .join(' | ');
    return [
      a.hoja, a.nro, a.codigo, a.detalle, a.tipo, a.unidadMedida, a.meta,
      a.metas[0], a.metas[1], a.metas[2], a.metas[3],
      (a.metas || []).map((q, i) => (Number(q) > 0 ? `${i + 1}` : '')).filter(Boolean).join(', '),
      a.fuente, a.presupuesto,
      m, Math.max(0, a.presupuesto - m), Math.round(av * 100) / 100,
      noEjecutaOf(a) ? SEMAFORO.noejecuta.label : SEMAFORO[estadoOf(a)].label,
      noEjecutaOf(a) ? 'SI' : 'NO',
      deps, a.entregable, a.sustento, a.indicador, a.observacionExcel,
      overrideOf(a).observaciones, filesOf(a.id).length
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [
    { wch: 26 }, { wch: 6 }, { wch: 10 }, { wch: 58 }, { wch: 15 }, { wch: 13 }, { wch: 9 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 18 }, { wch: 24 }, { wch: 16 }, { wch: 16 },
    { wch: 16 }, { wch: 9 }, { wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 24 }, { wch: 24 },
    { wch: 20 }, { wch: 30 }, { wch: 40 }, { wch: 12 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Seguimiento');
  XLSX.writeFile(wb, `POI_seguimiento_${stamp()}.xlsx`);
  toast('Excel de seguimiento generado.', 'ok');
}

async function exportBackup() {
  if (!state.activities.length) {
    toast('Primero carga el archivo Excel.', 'warn');
    return;
  }
  try {
    const records = await dbAll();
    const attachments = [];
    for (const r of records) {
      // eslint-disable-next-line no-await-in-loop
      const data = r.blob ? await blobToBase64(r.blob) : '';
      attachments.push({
        activityId: r.activityId,
        fileId: r.fileId,
        name: r.name,
        type: r.type,
        size: r.size,
        addedAt: r.addedAt,
        data
      });
    }
    const payload = {
      app: 'POI 2026 Seguimiento',
      version: 1,
      exportedAt: new Date().toISOString(),
      source: { fileName: state.fileName, importedAt: state.importedAt, sheets: state.sheets },
      activities: state.activities,
      warnings: state.warnings,
      overrides: state.overrides,
      attachments
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `POI_respaldo_${stamp()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Respaldo generado con ${attachments.length} documento(s).`, 'ok');
  } catch (err) {
    console.error(err);
    toast('No se pudo generar el respaldo.', 'err');
  }
}

async function restoreBackup(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || !payload.overrides) {
      throw new Error('El archivo no tiene el formato de respaldo esperado.');
    }
    const ok = window.confirm('Se reemplazarán avances, observaciones, dependencias y documentos guardados. ¿Continuar?');
    if (!ok) return;

    state.overrides = payload.overrides || {};
    saveOverrides();

    await dbClear();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const att of attachments) {
      if (!att || !att.activityId) continue;
      const fileId = att.fileId || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      // eslint-disable-next-line no-await-in-loop
      await dbPut({
        key: `${att.activityId}::${fileId}`,
        activityId: att.activityId,
        fileId,
        name: att.name || 'documento',
        type: att.type || 'application/octet-stream',
        size: att.size || 0,
        addedAt: att.addedAt || new Date().toISOString(),
        blob: base64ToBlob(att.data, att.type)
      });
    }
    await refreshAttachments();

    if (Array.isArray(payload.activities) && payload.activities.length) {
      setActivities(payload.activities);
      state.fileName = payload.source ? payload.source.fileName : state.fileName;
      state.importedAt = payload.source ? payload.source.importedAt : state.importedAt;
      if (Array.isArray(payload.warnings)) state.warnings = payload.warnings;
      saveData();
      populateFilters();
    }
    render();
    if (state.selectedId) openDrawer(state.selectedId);
    toast(`Respaldo restaurado (${attachments.length} documento(s)).`, 'ok');
  } catch (err) {
    console.error(err);
    toast(err.message || 'No se pudo restaurar el respaldo.', 'err');
  }
}

async function resetAll() {
  const ok = window.confirm('Se borrarán avances, observaciones, dependencias y documentos de este navegador. El Excel original no se toca. ¿Continuar?');
  if (!ok) return;
  LS.removeItem(LS_META);
  LS.removeItem(LS_DATA);
  state.overrides = {};
  state.activities = [];
  state.byId = new Map();
  state.attachments = {};
  state.warnings = [];
  state.selectedId = null;
  try { await dbClear(); } catch (err) { console.warn(err); }
  closeDrawer();
  render();
  toast('Datos del seguimiento reiniciados.', 'warn');
}

/* ------------------------- Carga del Excel ------------------------- */
async function handleFile(file) {
  if (!file) return;
  try {
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      throw new Error('Selecciona un archivo .xlsx, .xls o .csv.');
    }
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: false });
    const { activities, warnings } = parseWorkbook(workbook);
    if (!activities.length) {
      throw new Error('No se encontraron filas de actividad en el archivo.');
    }
    setActivities(activities);
    state.fileName = file.name;
    state.importedAt = new Date().toISOString();
    state.warnings = warnings;
    saveData();
    await refreshAttachments();
    populateFilters();
    render();
    closeDrawer();
    const total = activities.reduce((s, a) => s + (a.presupuesto || 0), 0);
    toast(`${activities.length} actividades cargadas · presupuesto ${fmtNum(total)}`, 'ok');
  } catch (err) {
    console.error(err);
    toast(err.message || 'No se pudo leer el archivo.', 'err');
  }
}

/* ------------------------- Eventos ------------------------- */
function bindEvents() {
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    handleFile(file);
  });

  $('#btnExportExcel').addEventListener('click', exportExcel);
  $('#btnBackup').addEventListener('click', exportBackup);
  $('#btnReset').addEventListener('click', resetAll);
  $('#restoreInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) restoreBackup(file);
  });

  const filterBindings = [
    ['#fText', 'texto', 'input'],
    ['#fHoja', 'hoja', 'change'],
    ['#fTipo', 'tipo', 'change'],
    ['#fTrimestre', 'trimestre', 'change'],
    ['#fEstado', 'estado', 'change'],
    ['#fFuente', 'fuente', 'change'],
    ['#fPresupuesto', 'presupuesto', 'change'],
    ['#fAdicional', 'adicional', 'change'],
    ['#fOrden', 'orden', 'change']
  ];
  filterBindings.forEach(([sel, key, evt]) => {
    const el = $(sel);
    const handler = () => {
      state.filters[key] = el.value;
      renderTable();
    };
    el.addEventListener(evt, key === 'texto' ? debounce(handler, 180) : handler);
  });

  $('#btnClearFilters').addEventListener('click', () => {
    state.filters = { texto: '', hoja: '', tipo: '', trimestre: '', estado: '', fuente: '', presupuesto: '', adicional: '', orden: 'nro' };
    syncFilterInputs();
    renderTable();
  });

  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    openDrawer(tr.dataset.id);
  });

  $('#dClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  });

  const body = $('#dBody');

  body.addEventListener('input', (e) => {
    const a = currentActivity();
    if (!a) return;
    const t = e.target;
    if (t.id === 'dAvanceRange') {
      const v = clamp(t.value, 0, 100);
      $('#dAvanceNum').value = Math.round(v);
      patchOverride(a.id, { avance: v });
      $('#dMonto').value = montoOf(a).toFixed(2);
      updateLive();
    } else if (t.id === 'dAvanceNum') {
      const v = clamp(t.value, 0, 100);
      $('#dAvanceRange').value = Math.round(v);
      patchOverride(a.id, { avance: v });
      $('#dMonto').value = montoOf(a).toFixed(2);
      updateLive();
    } else if (t.id === 'dMonto') {
      const v = clamp(t.value, 0, a.presupuesto || 0);
      patchOverride(a.id, { monto: v });
      $('#dAvanceRange').value = Math.round(avanceOf(a));
      $('#dAvanceNum').value = Math.round(avanceOf(a));
      updateLive();
    } else if (t.id === 'dObs') {
      patchOverride(a.id, { observaciones: t.value });
    } else if (t.id === 'dDepSearch') {
      state.depSearch = t.value;
      const list = $('#dDepList');
      if (list) list.innerHTML = depListHtml(a);
    }
  });

  body.addEventListener('change', (e) => {
    const a = currentActivity();
    if (!a) return;
    const t = e.target;
    if (t.id === 'dAvanceRange' || t.id === 'dAvanceNum') {
      const v = clamp(t.value, 0, 100);
      patchOverride(a.id, { avance: v });
      $('#dAvanceRange').value = Math.round(v);
      $('#dAvanceNum').value = Math.round(v);
      $('#dMonto').value = montoOf(a).toFixed(2);
      updateLive();
    } else if (t.id === 'dMonto') {
      const v = clamp(t.value, 0, a.presupuesto || 0);
      patchOverride(a.id, { monto: v });
      $('#dAvanceRange').value = Math.round(avanceOf(a));
      $('#dAvanceNum').value = Math.round(avanceOf(a));
      updateLive();
    } else if (t.id === 'dNoEjecuta') {
      patchOverride(a.id, { noEjecuta: t.checked });
      updateLive();
    } else if (t.dataset && t.dataset.dep) {
      const deps = new Set(depsOf(a));
      if (t.checked) deps.add(t.dataset.dep);
      else deps.delete(t.dataset.dep);
      patchOverride(a.id, { dependencias: Array.from(deps) });
      updateLive();
    } else if (t.id === 'dFiles') {
      addFiles(t.files);
    }
  });

  body.addEventListener('click', (e) => {
    const a = currentActivity();
    if (e.target.closest('#dDone')) {
      closeDrawer();
      return;
    }
    if (!a) return;
    const drop = e.target.closest('#dDrop');
    if (drop) {
      $('#dFiles').click();
      return;
    }
    const remove = e.target.closest('[data-dep-remove]');
    if (remove) {
      const deps = depsOf(a).filter((id) => id !== remove.dataset.depRemove);
      patchOverride(a.id, { dependencias: deps });
      const box = $('#dDepList');
      if (box) {
        const cb = box.querySelector(`input[data-dep="${CSS.escape(remove.dataset.depRemove)}"]`);
        if (cb) cb.checked = false;
        box.innerHTML = depListHtml(a);
      }
      updateLive();
      return;
    }
    const btn = e.target.closest('[data-file-action]');
    if (btn) {
      const key = btn.closest('.file').dataset.key;
      if (btn.dataset.fileAction === 'delete') {
        dbDelete(key)
          .then(async () => {
            await refreshAttachments();
            updateLive();
            toast('Documento eliminado.', 'warn');
          })
          .catch(() => toast('No se pudo eliminar el documento.', 'err'));
      } else {
        openOrDownload(key, btn.dataset.fileAction === 'download');
      }
    }
  });
}

/* ------------------------- Arranque ------------------------- */
async function init() {
  bindEvents();
  if (!LS.available) {
    toast('Este navegador no permite guardar datos locales: los cambios no se conservarán al cerrar. Prueba con Chrome o Edge.', 'warn');
  }
  const restored = loadStored();
  if (restored) {
    await refreshAttachments();
    populateFilters();
    syncFilterInputs();
    render();
    toast(`Sesión restaurada: ${state.activities.length} actividades.`, 'ok');
  } else {
    render();
  }
}

document.addEventListener('DOMContentLoaded', init);
