// tpv.js — Conector de Nora al TPV Normobile (API Voice AI de Noro).
// Flujo oficial (confirmado por Noro 8 jul): catalog -> orders/validate -> drafts -> drafts/{id}/confirm.
// Precios autoritativos: los pone el TPV desde su catálogo.
//
// Autenticación: API Key + HMAC SHA256.
//   Firma: HMAC_SHA256(timestamp + "." + rawBody, VOICE_AI_HMAC_SECRET)
//   GET sin body: HMAC_SHA256(timestamp + ".", secret)
//   Cabeceras: X-Voice-AI-Key, X-Voice-AI-Timestamp, X-Voice-AI-Signature, X-Idempotency-Key
//
// Variables de entorno (Railway):
//   TPV_ENABLED            -> "true" para enviar pedidos al TPV Normobile
//   VOICE_AI_API_KEY       -> API key (vask_...)
//   VOICE_AI_HMAC_SECRET   -> secreto HMAC
//   TPV_BASE               -> https://tpv.normobile.es (por defecto)
//   TPV_TS_MODE            -> "s" (segundos, por defecto) | "ms" (milisegundos)
//   TPV_SIG_ENCODING       -> "hex" (por defecto) | "base64"
//   TPV_SEND_TO_KITCHEN    -> "true" solo cuando Noro confirme el pedido en su panel (por defecto false)
//   TPV_PRINT_TICKET       -> "true" solo cuando Noro dé luz verde (por defecto false)

import { createHmac, randomUUID } from "node:crypto";

const env = process.env;
const truthy = (v) => v === "true" || v === "verdadero" || v === "TRUE";

export const TPV_ENABLED = truthy(env.TPV_ENABLED);
const TPV_BASE     = (env.TPV_BASE || "https://tpv.normobile.es").replace(/\/$/, "");
const API_KEY      = (env.VOICE_AI_API_KEY || "").trim();
const HMAC_SECRET  = (env.VOICE_AI_HMAC_SECRET || "").trim();
const TS_MODE      = (env.TPV_TS_MODE || "s").toLowerCase();          // "s" | "ms"
const SIG_ENCODING = (env.TPV_SIG_ENCODING || "hex").toLowerCase();   // "hex" | "base64"
const SEND_KITCHEN = truthy(env.TPV_SEND_TO_KITCHEN);
const PRINT_TICKET = truthy(env.TPV_PRINT_TICKET);

// --- Firma y petición ---------------------------------------------------------
function sign(rawBody) {
  const ts = TS_MODE === "ms" ? String(Date.now()) : String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", HMAC_SECRET)
    .update(`${ts}.${rawBody}`)
    .digest(SIG_ENCODING === "base64" ? "base64" : "hex");
  return { ts, sig };
}

async function tpvFetch(method, path, bodyObj) {
  if (!API_KEY || !HMAC_SECRET) {
    throw new Error("[TPV] Faltan VOICE_AI_API_KEY o VOICE_AI_HMAC_SECRET en Railway.");
  }
  const rawBody = bodyObj != null ? JSON.stringify(bodyObj) : "";
  const { ts, sig } = sign(rawBody);
  const headers = {
    "X-Voice-AI-Key": API_KEY,
    "X-Voice-AI-Timestamp": ts,
    "X-Voice-AI-Signature": sig,
    "X-Idempotency-Key": randomUUID(),
  };
  if (rawBody) headers["Content-Type"] = "application/json";

  const res = await fetch(`${TPV_BASE}${path}`, {
    method,
    headers,
    body: rawBody || undefined,
  });
  const text = await res.text().catch(() => "");
  console.log(`[TPV] ${method} ${path} -> ${res.status} ${text.slice(0, 800)}`);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`[TPV] ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json ?? {};
}

// --- Catálogo (cache 10 min) ----------------------------------------------------
let _cat = null;
let _catExp = 0;

export async function loadTpvCatalog() {
  const now = Date.now();
  if (_cat && now < _catExp) return _cat;
  const data = await tpvFetch("GET", "/api/voice-ai/catalog");
  const c = data.catalog || data;
  _cat = c;
  _catExp = now + 10 * 60 * 1000;
  const nPizzas = (c.pizzas || []).length;
  console.log(`[TPV] catálogo cargado: ${nPizzas} pizzas, ${(c.supplements||[]).length} suplementos, ${(c.drinks||[]).length} bebidas.`);
  return c;
}

function norm(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(pizza|pizzas)\b/g, "")
    .replace(/[^a-z0-9ñ ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function findByName(list, name) {
  const t = norm(name);
  if (!t) return null;
  let hit = (list || []).find((p) => norm(p.name) === t);
  if (!hit) hit = (list || []).find((p) => norm(p.name).includes(t) && t.length >= 4);
  if (!hit) hit = (list || []).find((p) => t.includes(norm(p.name)) && norm(p.name).length >= 4);
  return hit || null;
}

// Resuelve una línea de Nora contra el catálogo del TPV.
function resolveLine(cat, l) {
  const name = l.name || l.description || "";
  const qty = l.qty ?? l.quantity ?? 1;
  const notes = l.notes || "";

  // 1) pizza
  const pizza = findByName(cat.pizzas, name);
  if (pizza) {
    const sizeRaw = norm(l.sizeName || l.size || l.sizeId || "familiar");
    const sizeId = sizeRaw.includes("median") ? "mediana" : "familiar";
    const supplements = [];
    const extraNotes = [];
    for (const e of [...(l.extras || []), ...(l.modifiers || [])]) {
      const sup = findByName(cat.supplements, e?.name || e?.nombre || "");
      if (sup) supplements.push({ productId: Number(sup.id), quantity: e.qty ?? 1 });
      else if (e?.name || e?.nombre) extraNotes.push(`extra: ${e.name || e.nombre}`);
    }
    return {
      item: {
        type: "pizza",
        productId: Number(pizza.id),
        sizeId,
        quantity: qty,
        supplements,
        notes: [notes, ...extraNotes].filter(Boolean).join(" · "),
      },
    };
  }

  // 2) bebidas / cervezas / entrantes / otros
  const pools = [
    ["drink", cat.drinks], ["beer", cat.beers],
    ["starter", cat.starters], ["other", cat.others],
  ];
  for (const [type, pool] of pools) {
    const hit = findByName(pool, name);
    if (hit) {
      return { item: { type, productId: Number(hit.id), quantity: qty, notes } };
    }
  }

  // 3) sin mapeo -> error claro con candidatos en el log
  const all = [
    ...(cat.pizzas || []).map((p) => `pizza:${p.id}=${p.name}`),
    ...(cat.drinks || []).map((p) => `drink:${p.id}=${p.name}`),
    ...(cat.beers || []).map((p) => `beer:${p.id}=${p.name}`),
    ...(cat.starters || []).map((p) => `starter:${p.id}=${p.name}`),
  ].join(" | ");
  console.error(`[TPV] SIN MAPEO para "${name}". Catálogo: ${all}`);
  throw new Error(`[TPV] No encuentro en el catálogo del TPV: "${name}".`);
}

function resolveZone(cat, city, address) {
  const t = norm(`${city || ""} ${address || ""}`);
  const zones = cat.deliveryZones || [];
  const grau = zones.find((z) => norm(z.name).includes("grau") || norm(z.name).includes("playa"));
  if (grau && (t.includes("grau") || t.includes("playa"))) return grau;
  const gandia = zones.find((z) => norm(z.name).includes("gandia"));
  return gandia || zones[0] || null;
}

// --- Flujo validate -> draft -> confirm ------------------------------------------
// Acepta la misma comanda que glop.createComanda (salida de order.toComanda()).
export async function createComandaTpv(comanda) {
  const c = comanda || {};
  const cust = c.customer || {};
  const cat = await loadTpvCatalog();

  const items = [];
  for (const l of (c.lines || [])) {
    const { item } = resolveLine(cat, l);
    items.push(item);
  }

  const esDomicilio =
    String(cust.type || "").toLowerCase().includes("domicil") || !!cust.address;
  const zone = esDomicilio ? resolveZone(cat, cust.city, cust.address) : null;
  const paymentMethod = esDomicilio ? "cash_delivery" : "cash_local";

  // Identificador de sesión externo requerido por el TPV.
  const externalSessionId = `nora-${c.orderId || c.id || randomUUID()}`;

  const orderBody = {
    channel: "voice_ai",
    externalSessionId,
    deliveryType: esDomicilio ? "delivery" : "pickup",
    customer: {
      name: cust.name || "Cliente",
      phone: cust.phone || cust.phoneNumber || "",
      address: esDomicilio
        ? {
            street: String(cust.address || ""),
            city: String(cust.city || "Gandía"),
            zoneId: zone ? zone.id : undefined,
          }
        : undefined,
    },
    items,
    notes: cust.notes || "Pedido telefónico (Nora)",
    paymentMethod,
  };

  // 1) VALIDATE — ruta oficial confirmada por Noro
  const validate = await tpvFetch("POST", "/api/voice-ai/orders/validate", orderBody);

  // 2) DRAFT
  const draft = await tpvFetch("POST", "/api/voice-ai/drafts", orderBody);
  const draftId =
    draft.draftId ?? draft.id ?? draft.draft?.id ?? draft.data?.draftId ?? null;
  if (!draftId) {
    throw new Error(`[TPV] El draft no devolvió draftId. Respuesta: ${JSON.stringify(draft).slice(0, 400)}`);
  }

  // 3) CONFIRM — payload oficial de Noro. sendToKitchen queda en false hasta
  // que Noro confirme el pedido en su panel; luego TPV_SEND_TO_KITCHEN=true.
  const confirm = await tpvFetch("POST", `/api/voice-ai/drafts/${draftId}/confirm`, {
    confirmedBy: "nora",
    humanConfirmed: true,
    sendToKitchen: SEND_KITCHEN,
    printTicket: PRINT_TICKET,
    paymentStatus: "pending",
    paymentMethod,
  });

  const total =
    validate.total ?? validate.totalEur ?? validate.amount ?? confirm.total ?? null;

  return {
    ok: true,
    simulated: false,
    via: "tpv",
    glopOrderId: String(draftId),
    total,
    raw: JSON.stringify(confirm).slice(0, 500),
  };
}
