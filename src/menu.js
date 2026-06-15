// menu.js — carga de la configuración del negocio y utilidades de carta.
// Es "niche-agnóstico": el mismo motor sirve para pizzería, chino, kebab, etc.
// Solo cambia el fichero config/<id>.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadBusiness(businessId = process.env.BUSINESS_ID || "casa-nerea") {
  const file = path.join(__dirname, "..", "config", `${businessId}.json`);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg._index = indexItems(cfg);
  return cfg;
}

// Indexa todos los items por id para búsquedas O(1)
function indexItems(cfg) {
  const idx = {};
  for (const cat of cfg.menu) for (const it of cat.items) idx[it.id] = { ...it, categoryId: cat.id };
  return idx;
}

export function localized(nameObj, lang) {
  if (!nameObj) return "";
  if (typeof nameObj === "string") return nameObj;
  return nameObj[lang] || nameObj.es || nameObj.default || Object.values(nameObj)[0];
}

// Devuelve la carta en texto compacto para inyectar en el prompt del modelo.
export function menuForPrompt(cfg, lang = "es") {
  const lines = [];
  for (const cat of cfg.menu) {
    lines.push(`# ${localized(cat.name, lang)}`);
    for (const it of cat.items) {
      lines.push(`- [${it.id}] ${localized(it.name, lang)} — ${it.priceEur.toFixed(2)} €${it.ingredients ? ` (${it.ingredients})` : ""}`);
    }
  }
  const sizes = (cfg.sizes || []).map((s) => `${localized(s.name, lang)} x${s.priceFactor}`).join(", ");
  if (sizes) lines.push(`\nTamaños: ${sizes}`);
  if (cfg.extras?.length) lines.push(`Extras: ${cfg.extras.map((e) => `${localized(e.name, lang)} +${e.priceEur} €`).join(", ")}`);
  return lines.join("\n");
}

export function findItem(cfg, itemId) {
  return cfg._index[itemId] || null;
}

export function findSize(cfg, sizeId) {
  return (cfg.sizes || []).find((s) => s.id === sizeId) || null;
}

// Pizzas del día que Nora recomienda al inicio.
// Usa cfg.featured si está definido; si no, las n más caras de la 1ª categoría (pizzas).
export function recommendations(cfg, n = 2, lang = "es") {
  let items = [];
  if (cfg.featured?.length) items = cfg.featured.map((id) => cfg._index[id]).filter(Boolean);
  if (items.length < n) {
    const first = cfg.menu[0]?.items || [];
    const byPrice = [...first].sort((a, b) => b.priceEur - a.priceEur);
    for (const it of byPrice) {
      if (items.length >= n) break;
      if (!items.find((x) => x.id === it.id)) items.push(it);
    }
  }
  return items.slice(0, n).map((it) => ({
    id: it.id,
    name: localized(it.name, lang),
    priceEur: it.priceEur,
    ingredients: it.ingredients || null,
  }));
}

// Invalida la caché de configs (la usa el área de clientes al guardar cambios).
export function clearCache(){ if (typeof _cache !== "undefined" && _cache && typeof _cache.clear === "function") _cache.clear(); }
