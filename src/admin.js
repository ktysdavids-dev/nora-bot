// admin.js — Soporte remoto de Ktys & Davids.
// Cada bot vendido expone estos endpoints protegidos por ADMIN_TOKEN para que
// el Panel de Control (Nora Control) pueda verlo y repararlo a distancia.
//
// Variables de entorno:
//   ADMIN_TOKEN  -> token secreto del panel (obligatorio para habilitarlo)
//
// Endpoints (todos requieren cabecera  Authorization: Bearer <ADMIN_TOKEN>):
//   GET  /admin/status      -> estado general (uptime, negocio, glop, cocina, contadores)
//   GET  /admin/logs?n=200  -> últimos logs (ring buffer en memoria)
//   POST /admin/glop        -> { "enabled": true|false }  activa/desactiva envío a Glop en caliente
//   POST /admin/pause       -> { "paused": true|false }   pausa el bot (no atiende pedidos)
//   POST /admin/test        -> lanza una comanda de prueba (respeta GLOP_ENABLED)
//   POST /admin/kitchen     -> { "basePickupMin": 20, ... } ajusta tiempos de cocina en caliente

import { loadBusiness } from "./menu.js";
import { getKitchen } from "./kitchen.js";
import { createComanda } from "./glop.js";

const START = Date.now();

// ---- estado mutable en caliente (overrides de runtime) ----
export const runtime = {
  paused: false,
  glopEnabled: process.env.GLOP_ENABLED === "true",
  counters: { calls: 0, orders: 0, errors: 0, lastOrderAt: null, lastErrorAt: null },
};

// ---- logger con ring buffer (en memoria) ----
const RING_MAX = 500;
const ring = [];
export function logEvent(level, msg, extra = null) {
  const e = { t: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
  ring.push(e);
  if (ring.length > RING_MAX) ring.shift();
  const line = `[${e.t}] ${level.toUpperCase()} ${msg}`;
  if (level === "error") console.error(line); else console.log(line);
  if (level === "error") { runtime.counters.errors++; runtime.counters.lastErrorAt = e.t; }
}

export function countCall()  { runtime.counters.calls++; }
export function countOrder() { runtime.counters.orders++; runtime.counters.lastOrderAt = new Date().toISOString(); }

// ---- auth ----
function authed(req) {
  const token = process.env.ADMIN_TOKEN || "";
  if (!token) return false; // sin token configurado, admin deshabilitado
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${token}`;
}

export function registerAdmin(app, businessId = "casa-nerea") {
  // CORS para el panel (solo rutas /admin)
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return reply.code(204).send();
    if (!authed(req)) return reply.code(401).send({ ok: false, error: "token inválido o ausente" });
  });

  app.get("/admin/status", async () => {
    const cfg = loadBusiness(businessId);
    const k = getKitchen(cfg).status();
    return {
      ok: true,
      bot: "nora",
      version: process.env.BOT_VERSION || "1.0.0",
      business: { id: businessId, name: cfg.business?.name, city: cfg.business?.city },
      uptimeSec: Math.floor((Date.now() - START) / 1000),
      paused: runtime.paused,
      glop: { enabled: runtime.glopEnabled, configured: Boolean(process.env.GLOP_CLIENT_ID) },
      kitchen: k,
      counters: runtime.counters,
      env: { node: process.version },
    };
  });

  app.get("/admin/logs", async (req) => {
    const n = Math.min(Number(req.query?.n) || 200, RING_MAX);
    return { ok: true, logs: ring.slice(-n) };
  });

  app.post("/admin/glop", async (req) => {
    const enabled = Boolean(req.body?.enabled);
    runtime.glopEnabled = enabled;
    process.env.GLOP_ENABLED = enabled ? "true" : "false";
    logEvent("info", `GLOP ${enabled ? "ACTIVADO" : "DESACTIVADO (modo seguro)"} desde el panel`);
    return { ok: true, glopEnabled: enabled };
  });

  app.post("/admin/pause", async (req) => {
    runtime.paused = Boolean(req.body?.paused);
    logEvent("warn", runtime.paused ? "BOT PAUSADO desde el panel" : "BOT REANUDADO desde el panel");
    return { ok: true, paused: runtime.paused };
  });

  app.post("/admin/test", async () => {
    const cfg = loadBusiness(businessId);
    const test = {
      type: "pickup",
      customer: { name: "PRUEBA PANEL", phone: "000000000" },
      lines: [{ glopProductId: "TEST", qty: 1, modifiers: [], notes: "comanda de prueba (soporte)" }],
    };
    try {
      const res = await createComanda(test);
      logEvent("info", "Comanda de PRUEBA lanzada desde el panel", { simulated: res.simulated });
      return { ok: true, result: res };
    } catch (e) {
      logEvent("error", "Fallo en comanda de prueba: " + e.message);
      return { ok: false, error: e.message };
    }
  });

  app.post("/admin/kitchen", async (req) => {
    const cfg = loadBusiness(businessId);
    const k = getKitchen(cfg);
    const allowed = ["basePickupMin","baseDeliveryMin","windowMin","capacityPerWindow","minutesPerExtraUnit","stepMin","maxPickupMin","maxDeliveryMin"];
    const applied = {};
    for (const key of allowed) {
      if (req.body && req.body[key] != null) { k.k[key] = Number(req.body[key]); applied[key] = k.k[key]; }
    }
    logEvent("info", "Parámetros de cocina ajustados desde el panel", applied);
    return { ok: true, applied, kitchen: k.status() };
  });

  logEvent("info", "Endpoints /admin registrados (soporte remoto Ktys & Davids)");
}
