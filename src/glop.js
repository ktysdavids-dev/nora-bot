// glop.js — Adaptador de integración con el TPV Glop (API Cloud).
//
// VERIFICADO EN VIVO (18/06/2026) contra el TPV de Pizzería Casa Nerea:
//   - Token:        POST /api/v1/auth/oauth/token (grant_type=client_credentials) -> 200 OK
//   - Terminal:     GET  /api/v1/cloud/terminals -> terminal_id "1", warehouse_id "1"
//   - Envío pedido: POST /api/v1/delivery/orders con id_mesa "1" -> 200 OK (aceptado)
//
// Lee las variables de entorno con los nombres que YA hay en Railway (español)
// y también acepta los nombres en inglés, por compatibilidad:
//   GLOP_HABILITADO / GLOP_ENABLED   -> "true" o "verdadero" para enviar de verdad
//   BASE_API_GLOP   / GLOP_API_BASE  -> https://api.glop.es
//   ID_CLIENTE_GLOP / GLOP_CLIENT_ID -> client_id
//   GLOP_SECRETO    / GLOP_SECRET    -> client_secret  (FALTA en Railway: hay que añadirlo)
//   GLOP_MESA                        -> mesa donde aparcar el pedido (p.ej. "1")

const env = process.env;
const truthy = (v) => v === "true" || v === "verdadero" || v === "TRUE";

const GLOP_ENABLED   = truthy(env.GLOP_HABILITADO || env.GLOP_ENABLED);
const GLOP_API_BASE  = env.BASE_API_GLOP   || env.GLOP_API_BASE   || "https://api.glop.es";
const GLOP_CLIENT_ID = env.ID_CLIENTE_GLOP || env.GLOP_CLIENT_ID  || "";
const GLOP_SECRET    = env.GLOP_SECRETO    || env.GLOP_SECRET     || "";
const GLOP_MESA      = env.GLOP_MESA       || "1";

// --- Autenticación (VERIFICADA) ---------------------------------------------
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
      scope: "",
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

// Euros -> céntimos enteros. Pasa SIEMPRE euros (12.5 -> 1250).
function toCents(value) {
  if (value == null) return 0;
  return Math.round(Number(value) * 100);
}

// --- Crear comanda en Glop ("Recibir pedidos") ------------------------------
export async function createComanda(comanda) {
  const payload = mapToGlopPayload(comanda);

  if (!GLOP_ENABLED) {
    console.log("[GLOP] (desactivado) pedido simulado:\n", JSON.stringify(payload, null, 2));
    return { ok: true, simulated: true, glopOrderId: `MOCK-${Date.now()}` };
  }

  const token = await getAccessToken();
  const res = await fetch(`${GLOP_API_BASE}/api/v1/delivery/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Glop API ${res.status}: ${text}`);
  }
  const data = await res.json().catch(() => ([]));
  return { ok: true, simulated: false, raw: data };
}

// Traduce la comanda de Nora al cuerpo real que espera Glop.
// comanda.lines[]: { glopProductId, name, priceEuros, qty, extras:[{glopProductId,name,priceEuros,qty}] }
function mapToGlopPayload(c) {
  const items = (c.lines || []).map((l) => {
    const item = {
      plu: l.glopProductId,
      name: l.name || "",
      price: toCents(l.priceEuros),
      quantity: l.qty ?? 1,
      productType: 1,
    };
    if (l.extras && l.extras.length) {
      item.subItems = l.extras.map((e) => ({
        plu: e.glopProductId,
        name: e.name || "",
        price: toCents(e.priceEuros),
        quantity: e.qty ?? 1,
      }));
    }
    if (l.notes) item.observation = l.notes;
    return item;
  });

  const totalCents = items.reduce((sum, it) => {
    const subs = (it.subItems || []).reduce((s, x) => s + (x.price || 0) * (x.quantity || 1), 0);
    return sum + (it.price || 0) * (it.quantity || 1) + subs;
  }, 0);

  return {
    id_mesa: String(GLOP_MESA),
    orderType: 2,
    orderIsAlreadyPaid: false,
    discountTotal: 0,
    payment: { amount: totalCents },
    customer: {
      name: c.customer?.name || "Cliente",
      phoneNumber: c.customer?.phone || "",
    },
    clientComments: c.customer?.notes || "",
    items,
  };
}
