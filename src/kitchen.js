// kitchen.js — "Carga de cocina": Nora calcula el tiempo de entrega/recogida
// en función de cuántos pedidos (o pizzas) se están vendiendo por minuto.
//
// Idea: lleva una ventana deslizante de los últimos pedidos. Cuanto más
// se vende en poco tiempo, más sube el tiempo estimado. Todo es CONFIGURABLE
// por negocio en config/<id>.json -> "kitchen".

const DEFAULTS = {
  basePickupMin: 20,        // tiempo base de recogida (min)
  baseDeliveryMin: 35,      // tiempo base de domicilio (min)
  windowMin: 10,            // ventana para medir la carga (min)
  capacityPerWindow: 8,     // nº de "unidades" (pizzas) que la cocina hace sin retraso en esa ventana
  minutesPerExtraUnit: 1.5, // min añadidos por cada unidad por encima de la capacidad
  stepMin: 5,               // redondeo del tiempo a múltiplos de (5 -> 20,25,30…)
  maxPickupMin: 60,         // tope de recogida
  maxDeliveryMin: 80,       // tope de domicilio
};

export class Kitchen {
  constructor(cfg = {}) {
    this.k = { ...DEFAULTS, ...(cfg.kitchen || {}) };
    this.events = []; // [{ t: ms, units: n }]
  }

  // Registrar un pedido cerrado (units = nº de pizzas/platos principales).
  record(units = 1, when = Date.now()) {
    this.events.push({ t: when, units });
    this._prune(when);
  }

  _prune(now = Date.now()) {
    const cutoff = now - this.k.windowMin * 60_000;
    this.events = this.events.filter((e) => e.t >= cutoff);
  }

  // Unidades vendidas en la ventana actual.
  unitsInWindow(now = Date.now()) {
    this._prune(now);
    return this.events.reduce((s, e) => s + e.units, 0);
  }

  // Minutos extra por saturación.
  _surge(now = Date.now()) {
    const sold = this.unitsInWindow(now);
    const over = Math.max(0, sold - this.k.capacityPerWindow);
    return over * this.k.minutesPerExtraUnit;
  }

  _round(mins) {
    const s = this.k.stepMin;
    return Math.round(mins / s) * s;
  }

  // Tiempo estimado actual. type: "pickup" | "delivery".
  estimate(type = "pickup", now = Date.now()) {
    const base = type === "delivery" ? this.k.baseDeliveryMin : this.k.basePickupMin;
    const cap = type === "delivery" ? this.k.maxDeliveryMin : this.k.maxPickupMin;
    const raw = base + this._surge(now);
    return Math.min(cap, this._round(raw));
  }

  // Estado para que la voz/LLM lo lea (lo expone la tool get_wait_time).
  status(now = Date.now()) {
    const sold = this.unitsInWindow(now);
    const busy = sold > this.k.capacityPerWindow;
    return {
      soldLastWindow: sold,
      windowMin: this.k.windowMin,
      busy,
      pickupMin: this.estimate("pickup", now),
      deliveryMin: this.estimate("delivery", now),
    };
  }
}

// Una instancia por negocio (en memoria del proceso).
const _kitchens = new Map();
export function getKitchen(cfg) {
  const id = cfg.business?.id || cfg._id || "default";
  if (!_kitchens.has(id)) _kitchens.set(id, new Kitchen(cfg));
  return _kitchens.get(id);
}
