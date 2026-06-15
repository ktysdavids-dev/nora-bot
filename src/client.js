// client.js — Área privada del CLIENTE (dueño del negocio).
// Permisos LIMITADOS: su carta, sus reglas para Nora, destacados y cocina.
// Nunca: deploy, Glop on/off, pausa del bot, logs técnicos (eso es del panel maestro /admin).
//
// Variables de entorno:
//   CLIENT_TOKEN -> token del cliente (distinto del ADMIN_TOKEN del maestro)
//
// Endpoints (Authorization: Bearer <CLIENT_TOKEN>):
//   GET  /client/overview   -> métricas básicas + estado simple
//   GET  /client/config     -> carta completa (categorías, items, sizes, extras, featured, reglas, kitchen)
//   POST /client/item       -> crear/editar un plato { catId, item:{id?,name,priceEur,ingredients,allergens?} }
//   POST /client/item/del   -> borrar un plato { itemId }
//   POST /client/category   -> crear categoría { id?, name }
//   POST /client/featured   -> { featured:["diavola","prosciutto"] }  (pizzas/platos del día)
//   POST /client/rules      -> { rules:"texto" } reglas en lenguaje natural que Nora obedece
//   POST /client/kitchen    -> tiempos básicos { basePickupMin, baseDeliveryMin }
//
// PERSISTENCIA: los cambios se escriben en config/<id>.json del servidor.
// Sobreviven a reinicios del proceso. ¡OJO! En Render, un REDEPLOY restaura el
// config del repositorio: exporta (GET /client/config) y sincroniza al repo
// antes de redesplegar, o usa un disco persistente / Supabase (fase 2).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBusiness, clearCache } from "./menu.js";
import { getKitchen } from "./kitchen.js";
import { runtime, logEvent } from "./admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = (id) => path.join(__dirname, "..", "config", `${id}.json`);

function readCfg(id) { return JSON.parse(fs.readFileSync(cfgPath(id), "utf8")); }
function writeCfg(id, cfg) {
  fs.writeFileSync(cfgPath(id), JSON.stringify(cfg, null, 2));
  if (typeof clearCache === "function") clearCache();
}
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");

function authed(req) {
  const token = process.env.CLIENT_TOKEN || "";
  if (!token) return false;
  return (req.headers["authorization"] || "") === `Bearer ${token}`;
}

export function registerClient(app, businessId = "casa-nerea") {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/client")) return;
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return reply.code(204).send();
    if (!authed(req)) return reply.code(401).send({ ok: false, error: "token inválido o ausente" });
  });

  app.get("/client/overview", async () => {
    const cfg = loadBusiness(businessId);
    const k = getKitchen(cfg).status();
    return { ok: true,
      business: { name: cfg.business?.name, city: cfg.business?.city },
      online: !runtime.paused,
      counters: { calls: runtime.counters.calls, orders: runtime.counters.orders },
      kitchen: k };
  });

  app.get("/client/config", async () => {
    const cfg = readCfg(businessId);
    return { ok: true, config: {
      menu: cfg.menu, sizes: cfg.sizes || [], extras: cfg.extras || [],
      featured: cfg.featured || [], rules: cfg.clientRules || "",
      kitchen: { basePickupMin: cfg.kitchen?.basePickupMin, baseDeliveryMin: cfg.kitchen?.baseDeliveryMin } } };
  });

  app.post("/client/item", async (req) => {
    const { catId, item } = req.body || {};
    if (!catId || !item?.name || item.priceEur == null) return { ok: false, error: "Faltan datos: categoría, nombre y precio." };
    const cfg = readCfg(businessId);
    const cat = (cfg.menu || []).find((c) => c.id === catId);
    if (!cat) return { ok: false, error: "Categoría no encontrada." };
    const id = item.id || slug(item.name);
    const nu = { id, name: { es: item.name, default: item.name }, priceEur: Number(item.priceEur),
      glopProductId: item.glopProductId || "TODO_GLOP_ID",
      ingredients: item.ingredients || "", ...(item.allergens ? { allergens: item.allergens } : {}) };
    const ix = cat.items.findIndex((i) => i.id === id);
    if (ix >= 0) cat.items[ix] = { ...cat.items[ix], ...nu }; else cat.items.push(nu);
    writeCfg(businessId, cfg);
    logEvent("info", `Carta: ${ix >= 0 ? "editado" : "añadido"} «${item.name}» (${id}) por el cliente`);
    return { ok: true, item: nu, action: ix >= 0 ? "updated" : "created" };
  });

  app.post("/client/item/del", async (req) => {
    const { itemId } = req.body || {};
    const cfg = readCfg(businessId);
    let removed = false;
    for (const cat of cfg.menu || []) {
      const ix = cat.items.findIndex((i) => i.id === itemId);
      if (ix >= 0) { cat.items.splice(ix, 1); removed = true; }
    }
    cfg.featured = (cfg.featured || []).filter((f) => f !== itemId);
    if (removed) { writeCfg(businessId, cfg); logEvent("info", `Carta: eliminado «${itemId}» por el cliente`); }
    return removed ? { ok: true } : { ok: false, error: "Plato no encontrado." };
  });

  app.post("/client/category", async (req) => {
    const { name } = req.body || {};
    if (!name) return { ok: false, error: "Falta el nombre de la categoría." };
    const cfg = readCfg(businessId);
    const id = slug(name);
    if ((cfg.menu || []).some((c) => c.id === id)) return { ok: false, error: "Ya existe esa categoría." };
    cfg.menu.push({ id, name: { es: name, default: name }, items: [] });
    writeCfg(businessId, cfg);
    logEvent("info", `Carta: nueva categoría «${name}» por el cliente`);
    return { ok: true, id };
  });

  app.post("/client/featured", async (req) => {
    const featured = Array.isArray(req.body?.featured) ? req.body.featured.slice(0, 4) : [];
    const cfg = readCfg(businessId);
    cfg.featured = featured;
    writeCfg(businessId, cfg);
    logEvent("info", `Destacados del día: ${featured.join(", ") || "(auto: los de mayor precio)"} — por el cliente`);
    return { ok: true, featured };
  });

  app.post("/client/rules", async (req) => {
    const rules = String(req.body?.rules || "").slice(0, 2000);
    const cfg = readCfg(businessId);
    cfg.clientRules = rules;
    writeCfg(businessId, cfg);
    logEvent("info", "Reglas de Nora actualizadas por el cliente");
    return { ok: true };
  });

  app.post("/client/kitchen", async (req) => {
    const cfg = readCfg(businessId);
    cfg.kitchen = cfg.kitchen || {};
    const applied = {};
    for (const key of ["basePickupMin", "baseDeliveryMin"]) {
      if (req.body?.[key] != null) {
        const v = Math.max(5, Math.min(120, Number(req.body[key])));
        cfg.kitchen[key] = v; applied[key] = v;
        const k = getKitchen(loadBusiness(businessId)); k.k[key] = v; // en caliente
      }
    }
    writeCfg(businessId, cfg);
    logEvent("info", "Tiempos base de cocina ajustados por el cliente", applied);
    return { ok: true, applied };
  });

  logEvent("info", "Endpoints /client registrados (área privada del cliente)");
}
