// glop.js — Adaptador de integración con el TPV Glop (API Cloud).
//
// Documentación: https://apidoc.glop.es/  (interactiva, Stoplight).
// Endpoint de envío de pedidos: "Recibir pedidos"
//   https://apidoc.glop.es/docs/glop-api-rest/2c5aab48ef9dd-recibir-pedidos
//   - Soporta pedidos en mesa con el parámetro id_mesa (añade productos al ticket).
//
// CREDENCIALES (las entrega Glop; van SOLO en variables de entorno del servidor,
// nunca en el frontend ni en GitHub):
//   GLOP_CLIENT_ID  -> "id"
//   GLOP_SECRET     -> "secret"
//   GLOP_USER_ID    -> "user_id"
//   GLOP_API_BASE   -> base de la API (confirmar en apidoc.glop.es)
//
// PATRÓN DE SEGURIDAD:
//   GLOP_ENABLED=false -> NO envía nada; registra y devuelve un mock (para probar el flujo).
//   GLOP_ENABLED=true  -> Envía la comanda real a Glop.

const GLOP_ENABLED   = process.env.GLOP_ENABLED === "true";
const GLOP_API_BASE  = process.env.GLOP_API_BASE  || ""; // p.ej. https://api.glop.es  (CONFIRMAR en docs)
const GLOP_CLIENT_ID = process.env.GLOP_CLIENT_ID || "";
const GLOP_SECRET    = process.env.GLOP_SECRET    || "";
const GLOP_USER_ID   = process.env.GLOP_USER_ID   || "";

// --- Autenticación -----------------------------------------------------------
// Patrón habitual: intercambiar id + secret por un token de acceso temporal.
// CONFIRMAR en la doc la ruta y el formato exactos (campo "Autenticación").
let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 30_000) return _token; // cache con margen

  const url = `${GLOP_API_BASE}/auth/token`; // <-- CONFIRMAR ruta real en apidoc.glop.es
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: GLOP_CLIENT_ID,
      secret: GLOP_SECRET,
      user_id: Number(GLOP_USER_ID),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Glop auth ${res.status}: ${t}`);
  }
  const data = await res.json();
  _token = data.access_token ?? data.token ?? data.accessToken; // <-- CONFIRMAR nombre del campo
  const ttl = (data.expires_in ?? 3600) * 1000;
  _tokenExp = now + ttl;
  return _token;
}

// --- Crear comanda ("Recibir pedidos") --------------------------------------
export async function createComanda(comanda) {
  if (!GLOP_ENABLED) {
    console.log("[GLOP] (modo desactivado) comanda simulada:\n", JSON.stringify(comanda, null, 2));
    return { ok: true, simulated: true, glopOrderId: `MOCK-${Date.now()}` };
  }

  const token = await getAccessToken();
  const endpoint = `${GLOP_API_BASE}/orders`; // <-- CONFIRMAR ruta de "Recibir pedidos" en docs
  const payload = mapToGlopPayload(comanda);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`, // <-- CONFIRMAR esquema (Bearer / x-api-key…)
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Glop API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { ok: true, simulated: false, glopOrderId: data.id ?? data.orderId ?? null, raw: data };
}

// Traduce nuestra comanda neutra al cuerpo que espera Glop.
// NOTA: nombres de campos PROVISIONALES — ajustar al esquema real de "Recibir pedidos".
function mapToGlopPayload(c) {
  return {
    user_id: Number(GLOP_USER_ID),
    // id_mesa: c.tableId,            // <-- solo para pedidos en mesa (añade al ticket)
    type: c.type === "delivery" ? "DELIVERY" : "PICKUP",
    source: "nora-voice-ia",
    customer: {
      name: c.customer?.name || "",
      phone: c.customer?.phone || "",
      address: c.customer?.address || "",
    },
    notes: c.customer?.notes || "",
    lines: c.lines.map((l) => ({
      productId: l.glopProductId, // <-- requiere mapeo real de productos de Glop
      quantity: l.qty,
      modifiers: l.modifiers,
      notes: l.notes,
    })),
  };
}
