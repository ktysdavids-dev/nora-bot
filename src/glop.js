// glop.js — Enrutador de comandas + adaptador de la API directa de Glop.
//
// PRIORIDAD DE VÍAS en createComanda:
//   1. TPV Normobile (TPV_ENABLED=true)  -> tpv.js
//   2. Plugin web WooCommerce (NEREA_WEB_ENABLED=true) -> web.js  [retirada]
//   3. API directa de Glop (GLOP_ENABLED=true)  [vía de producción de Casa Nerea]
//   4. Nada activo -> pedido SIMULADO (solo log, no viaja a ninguna caja)
//
// Variables de entorno Glop (vía 3):
//   GLOP_HABILITADO / GLOP_ENABLED, BASE_API_GLOP / GLOP_API_BASE,
//   ID_CLIENTE_GLOP / GLOP_CLIENT_ID, GLOP_SECRETO / GLOP_SECRET,
//   GLOP_LOCATION (id EXACTO del catálogo, p.ej. CASA-NEREA-GANDIA),
//   GLOP_ACCOUNT (no se usa: vacío), GLOP_CHANNEL_SLUG, GLOP_MESA.
//
// FORMATO (verificado 9 jul con curl):
//   - El cuerpo del POST /delivery/orders es un ARRAY de pedidos: [ {...} ].
//     Con objeto suelto, el servidor devuelve 200 con error interno
//     "Undefined array key 1". Con array, procesa sin error.
//   - Precios en EUROS con decimales (9.50), según manual agnóstico jul 2026.
//   - Glop puede devolver HTTP 200 con {"error":...} dentro: se trata como fallo.

import { WEB_ENABLED, createComandaWeb } from "./web.js";
import { TPV_ENABLED, createComandaTpv } from "./tpv.js";

const env = process.env;
const truthy = (v) => v === "true" || v === "verdadero" || v === "TRUE";

const GLOP_ENABLED      = truthy(env.GLOP_HABILITADO || env.GLOP_ENABLED);
const GLOP_API_BASE     = env.BASE_API_GLOP   || env.GLOP_API_BASE   || "https://api.glop.es";
const GLOP_CLIENT_ID    = env.ID_CLIENTE_GLOP || env.GLOP_CLIENT_ID  || "";
const GLOP_SECRET       = env.GLOP_SECRETO    || env.GLOP_SECRET     || "";
const GLOP_LOCATION     = (env.GLOP_LOCATION || "").trim();
const GLOP_ACCOUNT      = (env.GLOP_ACCOUNT  || "").trim();
const GLOP_CHANNEL_SLUG = (env.GLOP_CHANNEL_SLUG || "nora").trim();
const GLOP_MESA         = (env.GLOP_MESA ?? "1").trim();
const USAR_MESA         = GLOP_MESA !== "" && GLOP_MESA.toLowerCase() !== "delivery" && GLOP_MESA !== "0";

// --- Autenticación Glop --------------------------------------------------------
let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 30000) return _token;

  const res = await fetch(`${GLOP_API_BASE}/api/v1/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: GLOP_CLIENT_ID,
      client_secret: GLOP_SECRET,
      scope: "*",
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Glop auth ${res.status}: ${t}`);
  }
  const data = await res.json();
  _token = data.access_token;
  _tokenExp = now + (data.expires_in ?? 3600) * 1000;
  return _token;
}

// Precio en EUROS con 2 decimales (número).
function toEuros(value) {
  if (value == null) return 0;
  return Math.round(Number(value) * 100) / 100;
}

// --- Crear comanda: ENRUTADOR ---------------------------------------------------
export async function createComanda(comanda) {
  if (TPV_ENABLED) {
    console.log("[GLOP] enrutando pedido por el TPV NORMOBILE.");
    return createComandaTpv(comanda);
  }

  if (WEB_ENABLED) {
    console.log("[GLOP] enrutando pedido por la VÍA WEB (plugin WooCommerce).");
    return createComandaWeb(comanda);
  }

  const payload = mapToGlopPayload(comanda);

  if (!GLOP_ENABLED) {
    console.log("[GLOP] (desactivado) pedido simulado:", JSON.stringify(payload));
    return { ok: true, simulated: true, glopOrderId: `MOCK-${Date.now()}` };
  }

  if (!GLOP_LOCATION) {
    throw new Error("[GLOP] Falta GLOP_LOCATION (id exacto de la localización, p.ej. CASA-NEREA-GANDIA).");
  }

  console.log("[GLOP] enviando pedido ->", JSON.stringify(payload));
  const token = await getAccessToken();
  const res = await fetch(`${GLOP_API_BASE}/api/v1/delivery/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    // El cuerpo va como ARRAY de pedidos (verificado 9 jul).
    body: JSON.stringify([payload]),
  });
  const text = await res.text().catch(() => "");
  console.log("[GLOP] respuesta", res.status, text);
  if (!res.ok) throw new Error(`Glop API ${res.status}: ${text}`);

  // Glop puede devolver 200 con un error interno dentro del cuerpo.
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const errInterno =
    (parsed && !Array.isArray(parsed) && parsed.error) ||
    (Array.isArray(parsed) && parsed.find((x) => x && x.error)?.error);
  if (errInterno) {
    throw new Error(`Glop API error interno: ${JSON.stringify(errInterno).slice(0, 300)}`);
  }

  return { ok: true, simulated: false, status: res.status, glopOrderId: payload.orderId, raw: text };
}

// Traduce la comanda de Nora al cuerpo de la API directa de Glop.
function mapToGlopPayload(c) {
  const lines = c.lines || [];

  const items = lines.map((l) => {
    const precio = l.priceEuros ?? l.unitPriceEur ?? l.priceEur ?? 0;
    const nombre = l.name || l.description || "";
    const item = {
      plu: l.glopProductId || l.plu || "",
      name: nombre,
      price: toEuros(precio),
      quantity: l.qty ?? l.quantity ?? 1,
    };

    if (Array.isArray(l.extras) && l.extras.length && l.extras[0]?.glopProductId) {
      item.subItems = l.extras.map((e) => ({
        plu: e.glopProductId,
        name: e.name || "",
        price: toEuros(e.priceEuros ?? e.unitPriceEur ?? 0),
        quantity: e.qty ?? 1,
      }));
    } else if (Array.isArray(l.modifiers) && l.modifiers.length) {
      const n = l.modifiers.reduce((s, m) => s + (m.qty || 1), 0);
      item.remark = `${l.notes ? l.notes + " · " : ""}+${n} ingrediente(s) extra`;
    } else if (l.notes) {
      item.remark = l.notes;
    }
    return item;
  });

  const totalEuros = toEuros(items.reduce((sum, it) => {
    const subs = (it.subItems || []).reduce((s, x) => s + (x.price || 0) * (x.quantity || 1), 0);
    return sum + (it.price || 0) * (it.quantity || 1) + subs;
  }, 0));

  const cust = c.customer || {};
  const now = new Date().toISOString();
  const tieneDireccion = !USAR_MESA && !!cust.address;

  const payload = {
    orderId: c.orderId || `NORA-${Date.now()}`,
    deliveryTime: now,
    _created: now,
    _updated: now,
    location: GLOP_LOCATION,
    orderIsAlreadyPaid: false,
    discountTotal: 0,
    channel: { slug: GLOP_CHANNEL_SLUG },
    payment: { amount: totalEuros },
    customer: {
      name: cust.name || "Cliente",
      phoneNumber: cust.phone || cust.phoneNumber || "",
      phoneAccessCode: cust.phoneAccessCode || "-",
      email: cust.email || "-",
    },
    deliveryAddress: tieneDireccion
      ? {
          street: String(cust.address),
          streetNumber: String(cust.streetNumber || ""),
          postalCode: String(cust.postalCode || ""),
          city: String(cust.city || "Gandia"),
        }
      : {},
    note: cust.notes || "Pedido telefónico (Nora)",
    orderType: tieneDireccion ? 2 : 1,
    deliveryCost: 0,
    serviceCharge: 0,
    deliveryTip: 0,
    account: GLOP_ACCOUNT,
    items,
  };

  if (USAR_MESA) {
    payload.id_mesa = String(GLOP_MESA);
  }

  return payload;
}
