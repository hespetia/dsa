#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extrae los datos del proyecto MOF DSA a app/js/data.js.

Fuentes:
  - ../../Organigrama DSA.pdf  -> grafo del organigrama (cajas, rótulos, conectores)
  - ../../MOF dsa.pdf          -> cuadro organico (COP) y fichas por puesto
  - ../../KPI/*.docx           -> formato de indicadores (cambios por puesto)

Uso:  python extraer_datos.py
Salida: ../js/data.js  (window.MOF_DATA = {...})
"""

import glob
import json
import os
import re
import sys
import unicodedata
import zlib
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
ROOT = os.path.dirname(APP)
PDF_ORG = os.path.join(ROOT, "Organigrama DSA.pdf")
PDF_MOF = os.path.join(ROOT, "MOF dsa.pdf")
DIR_KPI = os.path.join(ROOT, "KPI")
OUT = os.path.join(APP, "js", "data.js")

PAGE_W, PAGE_H = 841.9, 595.3


# ---------------------------------------------------------------- utilidades
def norm(s):
    """minúsculas + sin acentos + espacios colapsados"""
    s = s or ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("\u00a0", " ")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def unescape_pdf(raw):
    out = bytearray()
    i = 0
    n = len(raw)
    while i < n:
        ch = raw[i]
        if ch == 0x5C and i + 1 < n:  # backslash
            nxt = raw[i + 1]
            mapping = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}
            if nxt in mapping:
                out.append(mapping[nxt])
                i += 2
            elif nxt in (0x28, 0x29, 0x5C):
                out.append(nxt)
                i += 2
            elif 0x30 <= nxt <= 0x37:
                j = i + 1
                octs = b""
                while j < n and len(octs) < 3 and 0x30 <= raw[j] <= 0x37:
                    octs += bytes([raw[j]])
                    j += 1
                out.append(int(octs, 8) & 0xFF)
                i = j
            else:
                out.append(nxt)
                i += 2
        else:
            out.append(ch)
            i += 1
    return bytes(out)


def pdf_streams(path):
    data = open(path, "rb").read()
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", data, re.S):
        try:
            out.append(zlib.decompress(m.group(1)))
        except Exception:
            continue
    return out


RE_BT = re.compile(rb"BT(.*?)ET", re.S)
RE_TJM = re.compile(
    rb"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm"
)
RE_TF = re.compile(rb"/\w+\s+([\d.]+)\s+Tf")
RE_RG = re.compile(rb"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+rg")
RE_SHOW = re.compile(
    rb"\[((?:[^\[\]]|\\.)*)\]\s*TJ"  # arreglo de textos
    rb"|\(((?:\\.|[^()\\])*)\)\s*Tj"  # texto suelto
    rb"|<([0-9A-Fa-f\s]+)>\s*Tj"  # hexadecimal
)
RE_PAREN = re.compile(rb"\(((?:\\.|[^()\\])*)\)")


def text_runs(stream):
    """devuelve [{x,y,size,color,text}] por cada bloque de texto"""
    runs = []
    for m in RE_BT.finditer(stream):
        blk = m.group(1)
        mt = RE_TJM.search(blk)
        if not mt:
            continue
        g = [float(v) for v in mt.groups()]
        a, b, c, d, e, f = g
        ms = RE_TF.search(blk)
        size = float(ms.group(1)) if ms else 12.0
        mc = RE_RG.search(blk)
        color = [round(float(mc.group(1)), 3), round(float(mc.group(2)), 3),
                 round(float(mc.group(3)), 3)] if mc else None
        parts = []
        for sm in RE_SHOW.finditer(blk):
            if sm.group(1) is not None:
                parts.append(b"".join(RE_PAREN.findall(sm.group(1))))
            elif sm.group(2) is not None:
                parts.append(sm.group(2))
            else:
                hx = re.sub(rb"\s", b"", sm.group(3))
                try:
                    parts.append(bytes.fromhex(hx.decode()))
                except Exception:
                    pass
        txt = unescape_pdf(b"".join(parts)).decode("latin-1", "replace")
        txt = txt.replace("\r", " ").replace("\n", " ")
        # NO se recortan espacios: los runs ' ' son los separadores de palabra
        # reales del PDF y hacen falta al agrupar la linea.
        if not txt:
            continue
        runs.append({
            "x": round(e, 2), "y": round(f, 2), "size": size, "color": color,
            "rot": abs(b) > 0.5 or abs(c) > 0.5,
            "text": txt,
        })
    return runs


# ------------------------------------------------------- 1) organigrama PDF
def extraer_organigrama(path):
    streams = [s for s in pdf_streams(path) if b"TJ" in s and b"Image" in s]
    if not streams:
        raise SystemExit("No se encontro el content stream del organigrama")
    main = streams[0]

    # cajas (imagenes con transformacion de escala real)
    boxes = []
    for m in re.finditer(
        rb"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"
        rb"\s+cm\s*/(Image\d+)\s+Do", main):
        a, bb, cc, dd, e, f = [float(v) for v in m.groups()[:6]]
        if a > 20 and dd > 20:
            boxes.append({"x": e, "y": f, "w": round(a, 2), "h": round(dd, 2),
                          "img": m.group(7).decode()})

    # conectores: polilineas m/l ... S con color RG
    edges_raw = []
    color = None
    cur = []
    for line in main.decode("latin-1", "replace").splitlines():
        line = line.strip()
        mr = re.match(r"^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+RG$", line)
        if mr:
            color = [round(float(mr.group(1)), 3), round(float(mr.group(2)), 3),
                     round(float(mr.group(3)), 3)]
            continue
        mm = re.match(r"^([-\d.]+)\s+([-\d.]+)\s+m$", line)
        if mm:
            if len(cur) > 1:
                edges_raw.append((color, cur))
            cur = [(float(mm.group(1)), float(mm.group(2)))]
            continue
        ml = re.match(r"^([-\d.]+)\s+([-\d.]+)\s+l$", line)
        if ml and cur:
            cur.append((float(ml.group(1)), float(ml.group(2))))
            continue
        if line in ("S", "s") and len(cur) > 1:
            edges_raw.append((color, cur))
            cur = []
    if len(cur) > 1:
        edges_raw.append((color, cur))

    def which_box(pt):
        x, y = pt
        for i, b in enumerate(boxes):
            if b["x"] - 3 <= x <= b["x"] + b["w"] + 3 and \
               b["y"] - 3 <= y <= b["y"] + b["h"] + 3:
                return i
        return None

    def edge_side(pt, bi):
        x, y = pt
        b = boxes[bi]
        if abs(x - (b["x"] + b["w"])) <= 4:
            return "right"
        if abs(x - b["x"]) <= 4:
            return "left"
        return None

    conectores = []
    for color, pts in edges_raw:
        i = which_box(pts[0])
        j = which_box(pts[-1])
        if i is None or j is None or i == j:
            continue
        if edge_side(pts[0], i) == "right" and edge_side(pts[-1], j) == "left":
            conectores.append((i, j))
        elif edge_side(pts[0], i) == "left" and edge_side(pts[-1], j) == "right":
            conectores.append((j, i))

    # rotulos por caja
    for b in boxes:
        b["titulo"] = []
        b["titular"] = None
    for r in text_runs(main):
        if r["text"] in ("(", ")"):
            continue
        for b in boxes:
            if b["x"] - 2 <= r["x"] <= b["x"] + b["w"] + 2 and \
               b["y"] - 2 <= r["y"] <= b["y"] + b["h"] + 2:
                rojo = r["color"] and r["color"][0] > 0.8 and r["color"][1] < 0.2
                if rojo:
                    b["titular"] = r["text"]
                else:
                    b["titulo"].append((r["y"], r["text"]))
                break
    for b in boxes:
        b["titulo"].sort(key=lambda t: -t[0])
        b["titulo"] = re.sub(r"\s+", " ", " ".join(t for _, t in b["titulo"])).strip()

    # ids + tipos
    ALIAS = [
        ("direcc", "director", "area"),
        ("secretaria", "secretaria", "puesto"),
        ("procesos tecnicos", "jefe-procesos", "puesto"),
        ("soporte academico", "tec-soporte", "puesto"),
        ("soporte de matriculas", "esp-matriculas", "puesto"),
        ("homologacion", "esp-homologacion", "puesto"),
        ("emision y soporte", "esp-emision", "puesto"),
        ("emision de documentos", "tec-emision", "puesto"),
        ("unidad de registro central", "unidad-registro", "unidad"),
        ("registro y estadistica", "esp-registro", "puesto"),
        ("registro central", "tec-registro", "puesto"),
    ]

    def key(t):
        return norm(t)

    nodos = []
    for i, b in enumerate(boxes):
        t = key(b["titulo"])
        pid, tipo = None, "puesto"
        if b["img"] == "Image11" or "direcc" in t:
            pid, tipo = "director", "area"
        else:
            for frag, ident, tp in ALIAS:
                if frag in t:
                    pid, tipo = ident, tp
                    break
        nodos.append({
            "id": pid or "nodo-%d" % i,
            "tipo": tipo,
            "titulo": b["titulo"] or ("Dirección de Servicios Académicos"
                                      if pid == "director" else ""),
            "titular": b["titular"],
            "x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"],
            "img": b["img"],
        })

    aristas = [{"de": nodos[i]["id"], "a": nodos[j]["id"]} for i, j in conectores]
    # el banner "Direccion" es la raiz
    return {"page": [PAGE_W, PAGE_H], "nodos": nodos, "aristas": aristas}


# ------------------------------------------------------------- 2) MOF PDF
SECCIONES = [
    ("1. TITULO DEL PUESTO", "titulo"),
    ("2. AUTORIDAD Y DEPENDENCIA", "autoridad"),
    ("2.1 DEPENDE DE", "depende"),
    ("2.2 SUPERVISA A", "supervisa"),
    ("3. PROPOSITO PRINCIPAL DEL PUESTO", "proposito"),
    ("4. FUNCIONES ESPECIFICAS", "funciones"),
    ("5. PERFIL DEL PUESTO", "perfil"),
    ("5.1 ESTUDIOS", "estudios"),
    ("5.2 EXPERIENCIA", "experiencia"),
]

# nombre + n + plazas  (el orden de los runs varia segun la celda)
RE_COP_ROW_A = re.compile(r"^(.*\D)\s+(\d{1,2})\s+(\d+)\s*$")
RE_COP_ROW_B = re.compile(r"^(\d{1,2})\s+(.+?)\s+(\d+)\s*$")
RE_ITEM = re.compile(r"^([a-z]{1,2})\)\s*(.*)$", re.I)


def paginas_mof(path):
    paginas = []
    for s in pdf_streams(path):
        if b"BT" not in s:
            continue
        runs = text_runs(s)
        if not runs:
            continue
        # agrupa por linea (misma coordenada y)
        runs.sort(key=lambda r: (-r["y"], r["x"]))
        lineas = []
        for r in runs:
            if lineas and abs(lineas[-1]["y"] - r["y"]) <= 3:
                lineas[-1]["text"] += r["text"]
                lineas[-1]["x"] = min(lineas[-1]["x"], r["x"])
            else:
                lineas.append({"y": r["y"], "x": r["x"], "text": r["text"],
                               "size": r["size"]})
        for ln in lineas:
            ln["text"] = re.sub(r"\s+", " ", ln["text"]).strip()
        # limpia encabezado / pie
        cuerpo = []
        pnum = None
        for ln in lineas:
            t = ln["text"]
            if "MANUAL DE ORGANIZ" in norm(t).upper():
                continue
            if ln["y"] < 60:
                digits = re.sub(r"\D", "", t)
                if digits:
                    pnum = int(digits)
                continue
            cuerpo.append(ln)
        paginas.append({"num": pnum, "lineas": cuerpo})
    return paginas


def extraer_mof(path):
    paginas = paginas_mof(path)

    # --- cuadro organico de puestos
    cop = []
    for p in paginas:
        textos = [l["text"] for l in p["lineas"]]
        if not any(norm(t).upper().startswith("II. CUADRO ORG") for t in textos):
            continue
        for l in p["lineas"]:
            t = l["text"]
            if re.match(r"^\d{1,2}\s", t):
                mb = RE_COP_ROW_B.match(t)
                ma = None
            else:
                mb = None
                ma = RE_COP_ROW_A.match(t)
            if ma:
                puesto, n, plazas = ma.groups()
            elif mb:
                n, puesto, plazas = mb.groups()
            else:
                continue
            n, plazas = int(n), int(plazas)
            if 1 <= n <= 20 and plazas <= 20:
                cop.append({"n": n, "puesto": re.sub(r"\s+", " ", puesto).strip(),
                            "plazas": plazas})
        break
    cop.sort(key=lambda r: r["n"])

    # --- fichas
    fichas = []
    cur = None
    sec = None

    def nuevo():
        return {"titulo": "", "depende": "", "supervisa": "", "proposito": [],
                "funciones": [], "estudios": [], "experiencia": [], "pagina": None}

    def cerrar():
        nonlocal cur
        if cur:
            cur["proposito"] = " ".join(cur["proposito"]).strip()
            fichas.append(cur)
            cur = None

    for p in paginas:
        for l in p["lineas"]:
            t = re.sub(r"\s+", " ", l["text"]).strip()
            if not t:
                continue
            up = re.sub(r"[\s.]+", "", norm(t).upper())
            match_sec = None
            for frag, name in SECCIONES:
                if up.startswith(re.sub(r"[\s.]+", "", frag)):
                    match_sec = name
                    break
            if match_sec == "titulo":
                if cur and cur["titulo"]:
                    cerrar()
                if cur is None:
                    cur = nuevo()
                    cur["pagina"] = p["num"]
                sec = "titulo"
                continue
            if match_sec:
                sec = match_sec
                continue
            if cur is None:
                continue

            x = l["x"]
            if sec == "titulo" and not cur["titulo"] and x < 130:
                cur["titulo"] = t
            elif sec == "depende":
                if not cur["depende"]:
                    cur["depende"] = t
                else:
                    cur["depende"] += " " + t
            elif sec == "supervisa":
                if not cur["supervisa"]:
                    cur["supervisa"] = t
                else:
                    cur["supervisa"] += " " + t
            elif sec == "proposito":
                cur["proposito"].append(t)
            elif sec == "funciones":
                m = RE_ITEM.match(t) if x < 130 else None
                if m and x < 130:
                    cur["funciones"].append({"letra": m.group(1).lower(),
                                             "texto": m.group(2).strip()})
                elif cur["funciones"]:
                    cur["funciones"][-1]["texto"] = (
                        cur["funciones"][-1]["texto"] + " " + t).strip()
                else:
                    cur["funciones"].append({"letra": "a", "texto": t})
            elif sec in ("estudios", "experiencia"):
                if t.lower().startswith("x ") or t.startswith("•"):
                    cur[sec].append(re.sub(r"^[x•]\s*", "", t).strip())
                elif cur[sec] and not re.search(r"[.:;!?]\s*$", cur[sec][-1]):
                    cur[sec][-1] = (cur[sec][-1] + " " + t).strip()
                else:
                    cur[sec].append(t)
    cerrar()

    for f in fichas:
        f["depende"] = re.sub(r"\s+", " ", f["depende"]).strip()
        f["supervisa"] = re.sub(r"\s+", " ", f["supervisa"]).strip()
        f["titulo"] = re.sub(r"\s+", " ", f["titulo"]).strip()

    return {"cop": cop, "fichas": fichas,
            "paginas": [p["num"] for p in paginas if p["num"]]}


# ------------------------------------------------------------- 3) KPI DOCX
try:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn
except Exception:  # pragma: no cover
    docx = None

OPS = {
    "indicadores": "indicadores",
    "modificar": "modificar",
    "modificaciones": "modificar",
    "anadir": "anadir",
    "agregar": "agregar",
    "reemplazar": "reemplazar",
    "eliminar": "eliminar",
}


def op_label(texto):
    t = norm(texto).rstrip(":")
    t = re.sub(r"^ademas\s+", "", t)
    if t in OPS:
        return OPS[t]
    return None


def bloques(doc):
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            yield Table(child, doc)


def extraer_kpi(dirpath):
    archivos = []
    for f in sorted(glob.glob(os.path.join(dirpath, "*.docx"))):
        doc = docx.Document(f)
        reg = {
            "archivo": os.path.basename(f),
            "cargo": "", "area": "", "depende": "", "supervisa": "",
            "operaciones": [],
        }
        op_actual = None
        cabecera = True
        for b in bloques(doc):
            if isinstance(b, Table):
                if cabecera and len(b.columns) == 4:
                    celdas = [c.text.strip() for c in b.rows[0].cells]
                    for c in celdas:
                        if ":" not in c:
                            continue
                        label, val = c.split(":", 1)
                        val = re.sub(r"\s+", " ", val).strip()
                        ln = norm(label)
                        if ln.startswith("cargo"):
                            reg["cargo"] = val
                        elif ln.startswith("area"):
                            reg["area"] = val
                        elif ln.startswith("depende"):
                            reg["depende"] = val
                        elif ln.startswith("supervisa"):
                            reg["supervisa"] = val
                    cabecera = False
                    continue
                # tabla de items
                if op_actual is None:
                    op_actual = {"operacion": "indicadores", "nota": None, "items": []}
                for row in b.rows:
                    for cell in row.cells:
                        parte = re.sub(r"\s+", " ", cell.text).strip()
                        if parte:
                            op_actual["items"].append(parte)
                continue
            # párrafo
            t = re.sub(r"\s+", " ", b.text).strip()
            if not t:
                continue
            if t.upper().startswith("FORMATO DE INDICADORES"):
                continue
            lab = op_label(t)
            if lab:
                op_actual = {"operacion": lab, "nota": None, "items": []}
                reg["operaciones"].append(op_actual)
            elif t.endswith(":") and len(t) > 40:
                # instruccion larga ("...el siguiente texto:"): nota de la op
                op_actual = {"operacion": "modificar", "nota": t, "items": []}
                reg["operaciones"].append(op_actual)
            elif op_actual is not None and op_actual["operacion"] != "indicadores":
                op_actual["items"].append(t)
            elif op_actual is None:
                op_actual = {"operacion": "indicadores", "nota": None, "items": [t]}
                reg["operaciones"].append(op_actual)
        if reg["cargo"]:
            reg["pid"] = id_de(reg["cargo"])
            archivos.append(reg)
    return archivos


# ------------------------------------------------------------- ids y cruce
ALIAS_ID = [
    ("director de servicios academicos", "director"),
    ("direccion de servicios academicos", "director"),
    ("direccion", "director"),
    ("secretaria", "secretaria"),
    ("jefe de la unidad de procesos tecnicos", "jefe-procesos"),
    ("unidad de procesos tecnicos", "jefe-procesos"),
    ("tecnico en soporte academico", "tec-soporte"),
    ("especialista en soporte de matriculas", "esp-matriculas"),
    ("especialista en homologacion", "esp-homologacion"),
    ("especialista en emision y soporte", "esp-emision"),
    ("tecnico en emision de documentos", "tec-emision"),
    ("tecnico de emision de documentos", "tec-emision"),
    ("unidad de registro central", "unidad-registro"),
    ("especialista en registro y estadistica", "esp-registro"),
    ("tecnico de registro central", "tec-registro"),
    ("tecnico de registro", "tec-registro"),
]


def id_de(texto):
    t = norm(texto)
    if not t:
        return None
    for frag, ident in ALIAS_ID:
        if frag in t:
            return ident
    return None


def main():
    for p in (PDF_ORG, PDF_MOF, DIR_KPI):
        if not os.path.exists(p):
            raise SystemExit("No existe: %s" % p)

    org = extraer_organigrama(PDF_ORG)
    mof = extraer_mof(PDF_MOF)
    paginas = mof.pop("paginas")
    kpi = extraer_kpi(DIR_KPI)

    for n in org["nodos"]:
        n["pid"] = id_de(n["titulo"]) or n["id"]
    for f in mof["fichas"]:
        f["pid"] = id_de(f["titulo"])
    for k in kpi:
        k["pid"] = id_de(k["cargo"])

    data = {
        "meta": {
            "titulo": "MOF - Direccion de Servicios Academicos",
            "fuentes": ["Organigrama DSA.pdf", "MOF dsa.pdf", "KPI/*.docx"],
            "generado": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "paginas_mof": paginas,
        },
        "organigrama": org,
        "mof": mof,
        "kpi": kpi,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// Generado por tools/extraer_datos.py - no editar a mano\n")
        fh.write("window.MOF_DATA = ")
        json.dump(data, fh, ensure_ascii=False, indent=1)
        fh.write(";\n")

    print("OK -> %s" % OUT)
    print("  nodos organigrama : %d" % len(org["nodos"]))
    print("  aristas           : %d" % len(org["aristas"]))
    print("  filas COP         : %d" % len(mof["cop"]))
    print("  fichas MOF        : %d" % len(mof["fichas"]))
    for f in mof["fichas"]:
        print("     - %-58s (p.%s, %d funciones)" %
              (f["titulo"], f["pagina"], len(f["funciones"])))
    print("  archivos KPI      : %d" % len(kpi))
    for k in kpi:
        ops = ",".join(o["operacion"] for o in k["operaciones"])
        print("     - %-58s [%s]" % (k["cargo"], ops))


if __name__ == "__main__":
    sys.exit(main())
