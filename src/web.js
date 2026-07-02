// web.js — Conector de Nora al plugin web de Casa Nerea (WooCommerce → Glop).
// Ruta TEMPORAL mientras Glop no entrega location/account de la API directa.
//
// Flujo: Nora -> POST /wp-json/nerea-voice/v1/crear-pedido -> WooCommerce -> Glop TPV.
// El plugin identifica productos por product_id de WooCommerce y pone SU precio.
// Este módulo descarga /menu del plugin y traduce los platos de Nora por nombre.
//
// Variables de entorno (Railway):
//   NEREA_WEB_ENABLED  -> "true" para enviar por la web
//   NEREA_WEB_BASE     -> https://lacasadenerea.es (por defecto)
//   NEREA_WEB_TOKEN    -> Token API del plugin (cabecera X-Nerea-Voice-Token)
//   NEREA_WEB_OVERRIDES-> Opcional. JSON {"nombre normalizado":product_id} para
//                         forzar mapeos que no casen solos.
//                         Ej: {"cuatro quesos familiar": 512}

const env = process.env;
const truthy = (v) => v === "true" || v === "verdadero" || v === "TRUE";

export const WEB_ENABLED = truthy(env.NEREA_WEB_ENABLED);
const WEB_BASE  = (env.NEREA_WEB_BASE || "https://lacasadenerea.es").replace(/\/$/, "");
const WEB_TOKEN = (env.NEREA_WEB_TOKEN || "").trim();

let OVERRIDES = {};
try { OVERRIDES = env.NEREA_WEB_OVERRIDES ? JSON.parse(env.NEREA_WEB_OVERRIDES) : {}; }
catch { console.error("[WEB] NEREA_WEB_OVERRIDES no es JSON válido; se ignora."); }

// --- Normalización de nombres para el mapeo ---------------------------------
// "Pizza Cuatro Quesos (Familiar)" -> "cuatro quesos familiar"
export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // sin acentos
    .replace(/[()\[\].,;:!¡¿?"']/g, " ")
    .replace(/\b(pizza|pizzas|media luna|medialuna)\b/g, (m) => m === "media luna" || m === "medialuna" ? "mediana" : "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Menú del plugin (cache 10 min) -----------------------------------------
let _menuMap = null;   // { nombreNormalizado: product_id }
let _menuRaw = [];     // por si hay que loguear candidatos
let _menuExp = 0;

async function loadWebMenu() {
  const now = Date.now();
  if (_menuMap && now < _menuExp) return _menuMap;

  const res = await fetch(`${WEB_BASE}/wp-json/nerea-voice/v1/menu`, {
    headers: WEB_TOKEN ? { "X-Nerea-Voice-Token": WEB_TOKEN } : {},
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`[WEB] /menu ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();

  // Tolerante con la forma: puede ser array plano o {products:[...]}/{items:[...]}/{menu:[...]}
  const list = Array.isArray(data) ? data
             : Array.isArray(data.products) ? data.products
             : Array.isArray(data.items)    ? data.items
             : Array.isArray(data.menu)     ? data.menu
             : [];

  const map = {};
  const raw = [];
  for (const p of list) {
    const id   = p.product_id ?? p.id ?? p.ID;
    const name = p.name ?? p.title ?? p.nombre ?? "";
    if (!id || !name) continue;
    map[normalizeName(name)] = Number(id);
    raw.push({ id: Number(id), name });
    // Variaciones (tamaños) si el plugin las expone
    const vars = p.variations || p.variantes || [];
    for (const v of vars) {
      const vid = v.product_id ?? v.id ?? v.variation_id;
      const vname = `${name} ${v.name ?? v.attributes ?? v.size ?? ""}`;
      if (vid) { map[normalizeName(vname)] = Number(vid); raw.push({ id: Number(vid), name: vname }); }
    }
  }

  if (!raw.length) throw new Error("[WEB] /menu respondió sin productos reconocibles.");
  _menuMap = map; _menuRaw = raw; _menuExp = now + 10 * 60 * 1000;
  console.log(`[WEB] menú cargado: ${raw.length} productos.`);
  return map;
}

// Resuelve el product_id de una línea de Nora por nombre (+ tamaño si existe).
async function resolveProductId(line) {
  const map = await loadWebMenu();
  const base = line.name || line.description || "";
  const size = line.sizeName || line.size || line.sizeId || "";
  const candidates = [
    normalizeName(`${base} ${size}`),
    normalizeName(base),
  ];
  for (const key of candidates) {
    if (OVERRIDES[key]) return Number(OVERRIDES[key]);
    if (map[key]) return map[key];
  }
  // Búsqueda laxa: el nombre de Nora contenido en un nombre del menú web
  const target = normalizeName(base);
  const hit = _menuRaw.find((p) => normalizeName(p.name).includes(target) && target.length >= 4);
  if (hit) return hit.id;

  console.error(`[WEB] SIN MAPEO para "${base}" (tamaño "${size}"). Productos web disponibles:`,
    _menuRaw.map((p) => `${p.id}=${p.name}`).join(" | "));
  throw new Error(`[WEB] No encuentro product_id para "${base}${size ? " " + size : ""}". Añádelo en NEREA_WEB_OVERRIDES.`);
}

// --- Crear pedido vía plugin web ---------------------------------------------
// Acepta la misma comanda que glop.createComanda (salida de order.toComanda()).
export async function createComandaWeb(comanda) {
  if (!WEB_TOKEN) throw new Error("[WEB] Falta NEREA_WEB_TOKEN en Railway.");

  const c = comanda || {};
  const cust = c.customer || {};
  const lines = c.lines || [];

  const items = [];
  for (const l of lines) {
    const product_id = await resolveProductId(l);
    const noteBits = [];
    if (l.notes) noteBits.push(l.notes);
    const extras = Array.isArray(l.extras) ? l.extras : [];
    const mods   = Array.isArray(l.modifiers) ? l.modifiers : [];
    for (const e of [...extras, ...mods]) {
      const n = e?.name || e?.nombre;
      if (n) noteBits.push(`extra: ${n}${(e.qty ?? 1) > 1 ? ` x${e.qty}` : ""}`);
    }
    items.push({
      product_id,
      quantity: l.qty ?? l.quantity ?? 1,
      extras: [],                       // formato del plugin sin documentar: van en notes
      notes: noteBits.join(" · "),
    });
  }

  const esDomicilio = String(cust.type || "").toLowerCase().includes("domicil") || !!cust.address;
  const payload = {
    confirmed_by_customer: true,
    customer_name: cust.name || "Cliente",
    phone: cust.phone || cust.phoneNumber || "",
    email: cust.email || "",
    type: esDomicilio ? "domicilio" : "recogida",
    address: esDomicilio ? String(cust.address || "") : "",
    items,
    notes: cust.notes || "Pedido telefónico (Nora)",
  };

  console.log("[WEB] enviando pedido ->", JSON.stringify(payload));
  const res = await fetch(`${WEB_BASE}/wp-json/nerea-voice/v1/crear-pedido`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Nerea-Voice-Token": WEB_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  console.log("[WEB] respuesta", res.status, text.slice(0, 500));
  if (!res.ok) throw new Error(`[WEB] crear-pedido ${res.status}: ${text.slice(0, 300)}`);

  let orderId = null;
  try { const j = JSON.parse(text); orderId = j.order_id ?? j.id ?? j.pedido_id ?? null; } catch {}
  return { ok: true, simulated: false, via: "web", status: res.status, glopOrderId: orderId, raw: text };
}
