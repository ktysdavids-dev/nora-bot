// glop.js — Enrutador de comandas + adaptador de la API directa de Glop.
//
// PRIORIDAD DE VÍAS en createComanda:
//   1. TPV Normobile (TPV_ENABLED=true)  -> tpv.js
//   2. Plugin web WooCommerce (NEREA_WEB_ENABLED=true) -> web.js  [retirada]
//   3. API directa de Glop (GLOP_ENABLED=true)  [vía de producción de Casa Nerea]
//   4. Nada activo -> pedido SIMULADO (solo log, no viaja a ninguna caja)
//
// REGISTRO: cada pedido (éxito, fallo o simulado) se guarda en Supabase vía
// store.js para el panel de Ktys & Davids. El registro nunca bloquea la venta.
//
// DINERO (16 jul): payment.amount usa el totalEur de la comanda (incluye el
// gasto de envío por zona calculado en order.js) y deliveryCost viaja con la
// tarifa real de la zona. Ya no se recalcula ignorando el envío.
//
// FORMATO (confirmado por Glop/Daniel Ruiz 16 jul):
//   - El cuerpo del POST /delivery/orders es un OBJETO {...}, NO un array.
//   - No enviar email ni phoneAccessCode con "-": si faltan, se OMITEN.
//   - Precios en CÉNTIMOS enteros (14€ -> 1400). Confirmado con pedidos reales.
//   - Glop puede devolver HTTP 200 con {"error":...} dentro: se trata como fallo.

import { WEB_ENABLED, createComandaWeb } from "./web.js";
import { TPV_ENABLED, createComandaTpv } from "./tpv.js";
import { recordOrder } from "./store.js";

const env = process.env;
const truthy = (v) => v === "true" || v === "verdadero" || v === "TRUE";

const GLOP_ENABLED      = truthy(env.GLOP_HABILITADO || env.GLOP_ENABLED);
const GLOP_API_BASE     = env.BASE_API_GLOP   || env.GLOP_API_BASE   || "https://api.glop.es";
const GLOP_CLIENT_ID    = env.ID_CLIENTE_GLOP || env.GLOP_CLIENT_ID  || "";
const GLOP_SECRET       = env.GLOP_SECRETO    || env.GLOP_SECRET     || "";
const GLOP_LOCATION     = (env.GLOP_LOCATION || "").trim();
const GLOP_ACCOUNT      = (env.GLOP_ACCOUNT  || "").trim();
const GLOP_CHANNEL_SLUG = (env.GLOP_CHANNEL_SLUG || "nora").trim();
const GLOP_MESA         = (env.GLOP_MESA ?? "0").trim();
const USAR_MESA         = GLOP_MESA !== "" && GLOP_MESA.toLowerCase() !== "entrega" && GLOP_MESA.toLowerCase() !== "delivery" && GLOP_MESA !== "0";

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

// Precio en CÉNTIMOS enteros (confirmado por Glop/Daniel Ruiz 16 jul con
// pedidos reales: 14€ -> 1400, 1.50€ -> 150). El manual mostraba euros, pero
// la API real usa enteros en céntimos.
function toCents(value) {
  if (value == null) return 0;
  return Math.round(Number(value) * 100);
}

// Extrae los datos comunes de la comanda para el registro en Supabase.
function summarize(comanda, payload) {
  const c = comanda || {};
  const cust = c.customer || {};
  const esDomicilio =
    String(c.type || cust.type || "").toLowerCase().includes("deliv") ||
    String(cust.type || "").toLowerCase().includes("domicil") || !!cust.address;
  return {
    deliveryType: esDomicilio ? "domicilio" : "recogida",
    customerName: cust.name || null,
    customerPhone: cust.phone || cust.phoneNumber || null,
    poblacion: cust.poblacion || cust.city || c.deliveryZoneName || null,
    totalEur: c.totalEur ?? payload?.payment?.amount ?? null,
    items: payload?.items ?? (c.lines || null),
  };
}

// --- Crear comanda: ENRUTADOR ---------------------------------------------------
export async function createComanda(comanda) {
  // ---- Vía 1: TPV Normobile ----
  if (TPV_ENABLED) {
    console.log("[GLOP] enrutando pedido por el TPV NORMOBILE.");
    try {
      const result = await createComandaTpv(comanda);
      const s = summarize(comanda, null);
      recordOrder({
        orderId: result.glopOrderId, via: "tpv", status: "ok",
        deliveryType: s.deliveryType, customerName: s.customerName,
        customerPhone: s.customerPhone, poblacion: s.poblacion,
        totalEur: result.total ?? s.totalEur, items: s.items,
        raw: { raw: result.raw ?? null },
      });
      return result;
    } catch (err) {
      const s = summarize(comanda, null);
      recordOrder({
        orderId: comanda?.orderId, via: "tpv", status: "error",
        deliveryType: s.deliveryType, customerName: s.customerName,
        customerPhone: s.customerPhone, poblacion: s.poblacion,
        totalEur: s.totalEur, items: s.items,
        raw: { error: String(err?.message || err).slice(0, 500) },
      });
      throw err;
    }
  }

  // ---- Vía 2: plugin web (retirada, se conserva como respaldo) ----
  if (WEB_ENABLED) {
    console.log("[GLOP] enrutando pedido por la VÍA WEB (plugin WooCommerce).");
    try {
      const result = await createComandaWeb(comanda);
      const s = summarize(comanda, null);
      recordOrder({
        orderId: result.glopOrderId, via: "web", status: "ok",
        deliveryType: s.deliveryType, customerName: s.customerName,
        customerPhone: s.customerPhone, poblacion: s.poblacion,
        totalEur: s.totalEur, items: s.items, raw: { raw: result.raw ?? null },
      });
      return result;
    } catch (err) {
      const s = summarize(comanda, null);
      recordOrder({
        orderId: comanda?.orderId, via: "web", status: "error",
        deliveryType: s.deliveryType, customerName: s.customerName,
        customerPhone: s.customerPhone, poblacion: s.poblacion,
        totalEur: s.totalEur, items: s.items,
        raw: { error: String(err?.message || err).slice(0, 500) },
      });
      throw err;
    }
  }

  // ---- Vías 3 y 4: Glop directo o simulado ----
  const payload = mapToGlopPayload(comanda);
  const s = summarize(comanda, payload);

  if (!GLOP_ENABLED) {
    console.log("[GLOP] (desactivado) pedido simulado:", JSON.stringify(payload));
    recordOrder({
      orderId: payload.orderId, via: "simulado", status: "ok",
      deliveryType: s.deliveryType, customerName: s.customerName,
      customerPhone: s.customerPhone, poblacion: s.poblacion,
      totalEur: s.totalEur, items: s.items, raw: null,
    });
    return { ok: true, simulated: true, glopOrderId: `MOCK-${Date.now()}` };
  }

  if (!GLOP_LOCATION) {
    throw new Error("[GLOP] Falta GLOP_LOCATION (id exacto de la localización, p.ej. CASA-NEREA-GANDIA).");
  }

  try {
    console.log("[GLOP] enviando pedido ->", JSON.stringify(payload));
    const token = await getAccessToken();
    const res = await fetch(`${GLOP_API_BASE}/api/v1/delivery/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      // El cuerpo va como OBJETO (confirmado por Glop/Daniel Ruiz 16 jul:
      // con array descartaban el pedido al no encontrar la location).
      body: JSON.stringify(payload),
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

    recordOrder({
      orderId: payload.orderId, via: "glop", status: "ok",
      deliveryType: s.deliveryType, customerName: s.customerName,
      customerPhone: s.customerPhone, poblacion: s.poblacion,
      totalEur: s.totalEur, items: s.items,
      raw: { response: text.slice(0, 500) },
    });

    return { ok: true, simulated: false, status: res.status, glopOrderId: payload.orderId, raw: text };
  } catch (err) {
    recordOrder({
      orderId: payload.orderId, via: "glop", status: "error",
      deliveryType: s.deliveryType, customerName: s.customerName,
      customerPhone: s.customerPhone, poblacion: s.poblacion,
      totalEur: s.totalEur, items: s.items,
      raw: { error: String(err?.message || err).slice(0, 500) },
    });
    throw err;
  }
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
      price: toCents(precio),
      quantity: l.qty ?? l.quantity ?? 1,
    };

    if (Array.isArray(l.extras) && l.extras.length && l.extras[0]?.glopProductId) {
      item.subItems = l.extras.map((e) => ({
        plu: e.glopProductId,
        name: e.name || "",
        price: toCents(e.priceEuros ?? e.unitPriceEur ?? 0),
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

  // Total de artículos en CÉNTIMOS (las líneas ya van en céntimos).
  const itemsTotalCents = items.reduce((sum, it) => {
    const subs = (it.subItems || []).reduce((s, x) => s + (x.price || 0) * (x.quantity || 1), 0);
    return sum + (it.price || 0) * (it.quantity || 1) + subs;
  }, 0);

  // Envío real de la zona y total autoritativo de la comanda, en CÉNTIMOS.
  const deliveryFeeCents = toCents(c.deliveryFeeEur ?? 0);
  const totalCents = c.totalEur != null ? toCents(c.totalEur) : (itemsTotalCents + deliveryFeeCents);

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
    payment: { amount: totalCents },
    customer: {
      name: cust.name || "Cliente",
      phoneNumber: cust.phone || cust.phoneNumber || "",
      // email y phoneAccessCode SOLO si existen: enviarlos con "-" provocaba
      // el error interno de Glop (Daniel Ruiz, 16 jul). Si faltan, se omiten.
      ...(cust.phoneAccessCode ? { phoneAccessCode: cust.phoneAccessCode } : {}),
      ...(cust.email ? { email: cust.email } : {}),
    },
    deliveryAddress: tieneDireccion
      ? {
          street: String(cust.address),
          streetNumber: String(cust.streetNumber || ""),
          postalCode: String(cust.postalCode || ""),
          city: String(cust.poblacion || cust.city || "Gandia"),
        }
      : {},
    note: cust.notes || "Pedido telefónico (Nora)",
    orderType: tieneDireccion ? 2 : 1,
    deliveryCost: deliveryFeeCents,
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
