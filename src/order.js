// order.js — estado del pedido para una llamada/sesión.
// Calcula precios con tamaños y extras, detecta la ZONA DE REPARTO por la
// población/dirección (tarifas de config.policies.deliveryZones) y genera la
// comanda para Glop con el total REAL (incluido el gasto de envío).
import { findItem, findSize, localized } from "./menu.js";

function norm(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

export class Order {
  constructor(cfg, { lang = "es", type = "delivery" } = {}) {
    this.cfg = cfg;
    this.lang = lang;
    this.type = type; // "delivery" | "pickup"
    this.lines = [];
    this.customer = { name: null, phone: null, address: null, poblacion: null, notes: null };
  }

  addItem({ itemId, sizeId = null, qty = 1, extras = 0, notes = "" }) {
    const item = findItem(this.cfg, itemId);
    if (!item) throw new Error(`Producto desconocido: ${itemId}`);
    const size = sizeId ? findSize(this.cfg, sizeId) : null;
    const factor = size?.priceFactor ?? 1;
    const extraPrice = (this.cfg.extras?.[0]?.priceEur ?? this.cfg.policies?.supplementEur ?? 0) * extras;
    const unit = item.priceEur * factor + extraPrice;
    const line = {
      itemId, qty,
      name: localized(item.name, this.lang),
      sizeId, sizeName: size ? localized(size.name, this.lang) : null,
      extras, notes,
      unitPriceEur: round2(unit),
      lineTotalEur: round2(unit * qty),
      glopProductId: item.glopProductId || null,
    };
    this.lines.push(line);
    return line;
  }

  removeLine(index) { return this.lines.splice(index, 1); }
  clear() { this.lines = []; }

  // Zona de reparto detectada por poblacion (preferente) o por el texto de la
  // dirección. Devuelve la zona de config.policies.deliveryZones o null.
  deliveryZone() {
    if (this.type !== "delivery") return null;
    const zones = this.cfg.policies?.deliveryZones || [];
    const target = norm(`${this.customer.poblacion || ""} ${this.customer.address || ""}`);
    if (!target) return null;
    for (const z of zones) {
      for (const m of (z.match || [])) {
        if (target.includes(norm(m))) return z;
      }
    }
    return null;
  }

  // Gasto de envío: tarifa de la zona detectada, o el fallback de policies.
  deliveryFee() {
    if (this.type !== "delivery") return 0;
    const zone = this.deliveryZone();
    const fee = zone?.feeEur ?? this.cfg.policies?.deliveryFeeEur ?? 0;
    return round2(fee);
  }

  itemsTotal() { return round2(this.lines.reduce((s, l) => s + l.lineTotalEur, 0)); }

  total() { return round2(this.itemsTotal() + this.deliveryFee()); }

  setCustomer(patch) {
    // Acepta poblacion explícita; si llega "type", cambia la modalidad.
    if (patch && patch.type) this.type = patch.type;
    Object.assign(this.customer, patch || {});
  }

  summary() {
    const items = this.lines.map((l) =>
      `${l.qty}× ${l.name}${l.sizeName ? ` (${l.sizeName})` : ""}${l.extras ? ` +${l.extras} extra` : ""} — ${l.lineTotalEur.toFixed(2)} €`
    );
    const fee = this.deliveryFee();
    const zone = this.deliveryZone();
    if (fee > 0) {
      items.push(`Envío${zone ? ` (${localized(zone.name, this.lang)})` : ""} — ${fee.toFixed(2)} €`);
    }
    return { type: this.type, items, totalEur: this.total(), customer: this.customer };
  }

  // Estructura neutra que el adaptador de Glop traduce a su API.
  toComanda() {
    const zone = this.deliveryZone();
    return {
      businessId: this.cfg.id,
      channel: "voz-ia-nora",
      type: this.type,
      createdAt: new Date().toISOString(),
      customer: this.customer,
      deliveryZoneId: zone ? zone.id : null,
      deliveryZoneName: zone ? localized(zone.name, this.lang) : null,
      deliveryFeeEur: this.deliveryFee(),
      lines: this.lines.map((l) => ({
        glopProductId: l.glopProductId,
        itemId: l.itemId,
        description: `${l.name}${l.sizeName ? ` ${l.sizeName}` : ""}`,
        qty: l.qty,
        unitPriceEur: l.unitPriceEur,
        modifiers: l.extras ? [{ type: "extra", qty: l.extras }] : [],
        notes: l.notes || "",
      })),
      itemsTotalEur: this.itemsTotal(),
      totalEur: this.total(),
    };
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
