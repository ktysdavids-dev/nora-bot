// store.js — Registro persistente de pedidos en Supabase (panel Ktys & Davids).
// Diseño: NUNCA rompe un pedido. Si Supabase falla o no está configurado,
// se loguea y la vida sigue — guardar métricas jamás debe tumbar una venta.
//
// Variables de entorno (Railway):
//   SUPABASE_URL          -> https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  -> service_role key (secreta, solo servidor)
//   NORA_CLIENT_ID        -> identificador del cliente de Ktys & Davids ('casa-nerea')

const env = process.env;
const SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = (env.SUPABASE_SERVICE_KEY || "").trim();
const CLIENT_ID    = (env.NORA_CLIENT_ID || "casa-nerea").trim();

const ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
if (!ENABLED) {
  console.log("[STORE] Supabase no configurado: los pedidos no se registrarán (solo logs).");
}

// Registra un pedido (éxito o fallo). Nunca lanza errores hacia fuera.
export async function recordOrder({
  orderId, via, status = "ok", deliveryType = null,
  customerName = null, customerPhone = null, poblacion = null,
  totalEur = null, items = null, raw = null,
}) {
  if (!ENABLED) return;
  try {
    const row = {
      client_id: CLIENT_ID,
      order_id: String(orderId || `SIN-ID-${Date.now()}`),
      via: String(via || "desconocida"),
      status: String(status),
      delivery_type: deliveryType,
      customer_name: customerName,
      customer_phone: customerPhone,
      poblacion,
      total_eur: totalEur != null ? Number(totalEur) : null,
      items: items ?? null,
      raw: raw ?? null,
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(`[STORE] Supabase ${res.status}: ${t.slice(0, 300)}`);
    } else {
      console.log(`[STORE] pedido registrado: ${row.order_id} (${row.via}/${row.status})`);
    }
  } catch (err) {
    console.error("[STORE] error registrando pedido:", err?.message || err);
  }
}

// Consulta pedidos del cliente actual (para el panel /admin de la ronda 2).
export async function listOrders({ limit = 50, sinceIso = null } = {}) {
  if (!ENABLED) return [];
  try {
    let url = `${SUPABASE_URL}/rest/v1/orders?client_id=eq.${encodeURIComponent(CLIENT_ID)}` +
              `&order=created_at.desc&limit=${Math.min(Number(limit) || 50, 200)}`;
    if (sinceIso) url += `&created_at=gte.${encodeURIComponent(sinceIso)}`;
    const res = await fetch(url, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}
