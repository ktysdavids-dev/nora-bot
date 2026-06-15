// order.js — estado del pedido para una llamada/sesión.
// Calcula precios con tamaños y extras y genera la comanda para Glop.

import { findItem, findSize, localized } from "./menu.js";

export class Order {
  constructor(cfg, { lang = "es", type = "delivery" } = {}) {
    this.cfg = cfg;
    this.lang = lang;
    this.type = type; // "delivery" | "pickup"
    this.lines = [];
    this.customer = { name: null, phone: null, address: null, notes: null };
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

  total() { return round2(this.lines.reduce((s, l) => s + l.lineTotalEur, 0) + (this.type === "delivery" ? this.cfg.policies?.deliveryFeeEur || 0 : 0)); }

  setCustomer(patch) { Object.assign(this.customer, patch); }

  summary() {
    const items = this.lines.map((l) =>
      `${l.qty}× ${l.name}${l.sizeName ? ` (${l.sizeName})` : ""}${l.extras ? ` +${l.extras} extra` : ""} — ${l.lineTotalEur.toFixed(2)} €`
    );
    return { type: this.type, items, totalEur: this.total(), customer: this.customer };
  }

  // Estructura neutra que el adaptador de Glop traduce a su API.
  toComanda() {
    return {
      businessId: this.cfg.id,
      channel: "voz-ia-nora",
      type: this.type,
      createdAt: new Date().toISOString(),
      customer: this.customer,
      lines: this.lines.map((l) => ({
        glopProductId: l.glopProductId,
        itemId: l.itemId,
        description: `${l.name}${l.sizeName ? ` ${l.sizeName}` : ""}`,
        qty: l.qty,
        unitPriceEur: l.unitPriceEur,
        modifiers: l.extras ? [{ type: "extra", qty: l.extras }] : [],
        notes: l.notes || "",
      })),
      totalEur: this.total(),
    };
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
