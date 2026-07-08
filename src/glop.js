// glop.js — Enrutador de comandas + adaptador de la API directa de Glop.
//
// PRIORIDAD DE VÍAS en createComanda:
//   1. TPV Normobile (TPV_ENABLED=true)  -> tpv.js  [vía actual de Casa Nerea]
//   2. Plugin web WooCommerce (NEREA_WEB_ENABLED=true) -> web.js  [retirada]
//   3. API directa de Glop (GLOP_ENABLED=true)  [activo de empresa, otros clientes]
//   4. Nada activo -> pedido SIMULADO (solo log, no viaja a ninguna caja)
//
// Variables de entorno Glop (para la vía 3):
//   GLOP_HABILITADO / GLOP_ENABLED, BASE_API_GLOP / GLOP_API_BASE,
//   ID_CLIENTE_GLOP / GLOP_CLIENT_ID, GLOP_SECRETO / GLOP_SECRET,
//   GLOP_LOCATION, GLOP_ACCOUNT, GLOP_CHANNEL_SLUG, GLOP_MESA.

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

  // Doc oficial de Glop (jul 2026): scope "*" en /api/v1/auth/oauth/token.
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

function toCents(value) {
  if (value == null) return 0;
  return Math.round(Number(value) * 100);
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

  const
