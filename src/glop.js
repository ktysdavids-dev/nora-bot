// glop.js — Adaptador de integración con el TPV Glop (API Cloud).
//
// Payload ALINEADO con la documentación oficial de Glop (apidoc.glop.es):
//   - Token:        POST /api/v1/auth/oauth/token  (OJO: la doc lista /api/v1/oauth/token; ver nota abajo)
//   - Envío pedido: POST /api/v1/delivery/orders
//
// Variables de entorno (acepta nombres en español -de Railway- y en inglés):
//   GLOP_HABILITADO / GLOP_ENABLED   -> "true"/"verdadero" para enviar de verdad
//   BASE_API_GLOP   / GLOP_API_BASE  -> https://api.glop.es
//   ID_CLIENTE_GLOP / GLOP_CLIENT_ID -> client_id
//   GLOP_SECRETO    / GLOP_SECRET    -> client_secret
//   GLOP_LOCATION    -> Identificador de localización. LO DA GLOP. Obligatorio para envío real.
//   GLOP_ACCOUNT     -> Campo "account" del pedido. Confirmar valor con Glop. Obligatorio para envío real.
//   GLOP_CHANNEL_SLUG-> Nombre único del canal (por defecto "nora").
//   GLOP_MESA        -> mesa donde aparcar el pedido (p.ej. "1"). Vacío/"delivery"/"0" = reparto sin id_mesa.

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

// --- Autenticación ----------------------------------------------------------
let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 30000) return _token;

  // NOTA: la doc oficial lista el token en /api/v1/oauth/token (sin "auth").
  // Mantengo /api/v1/auth/oauth/token porque venía marcado como verificado.
  // Si el login falla con 404 en la prueba, cambiar a /api/v1/oauth/token.
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

function toCents(value) {
  if (value == null) return 0;
  return Math.round(Number(value) * 100);
}

// --- Crear comanda en Glop ("Recibir pedidos") ------------------------------
// Acepta directamente la salida de order.toComanda().
export async function createComanda(comanda) {
  const payload = mapToGlopPayload(comanda);

  if (!GLOP_ENABLED) {
    console.log("[GLOP] (desactivado) pedido simulado:", JSON.stringify(payload));
    return { ok: true, simulated: true, glopOrderId: `MOCK-${Date.now()}` };
  }

  if (!GLOP_LOCATION) {
    throw new Error("[GLOP] Falta GLOP_LOCATION (identificador de localización que da Glop).");
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
    // La doc titula el cuerpo "Array de pedido de delivery", pero el ejemplo cURL
    // envía un objeto suelto. Enviamos objeto (como el ejemplo). Si Glop pide array,
    // cambiar a: JSON.stringify([payload]).
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  console.log("[GLOP] respuesta", res.status, text);
  if (!res.ok) throw new Error(`Glop API ${res.status}: ${text}`);
  return { ok: true, simulated: false, status: res.status, raw: text };
}

// Traduce la comanda de Nora (formato order.toComanda()) al cuerpo de Glop.
// Tolera ambos juegos de nombres: name|description, priceEuros|unitPriceEur.
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

    // Extras: si vienen como subItems con código (PLU), se mandan; si son
    // "modifiers" genéricos (sin PLU), se reflejan en remark para no romper el pedido.
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

  const totalCents = items.reduce((sum, it) => {
    const subs = (it.subItems || []).reduce((s, x) => s + (x.price || 0) * (x.quantity || 1), 0);
    return sum + (it.price || 0) * (it.quantity || 1) + subs;
  }, 0);

  const cust = c.customer || {};
  const now = new Date().toISOString();
  const tieneDireccion = !USAR_MESA && !!cust.address;

  const payload = {
    orderId: `NORA-${Date.now()}`,
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
