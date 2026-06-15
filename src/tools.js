// tools.js — definición de las herramientas de Nora, ligadas a un Order concreto.
// Se usan tanto en la voz (Realtime) como en la demo de texto. Para la voz,
// se envuelven con el helper `tool()` de @openai/agents (ver agent.js); aquí
// exponemos la lógica pura + el esquema JSON, que es reutilizable.

import { menuForPrompt, localized, recommendations } from "./menu.js";
import { createComanda } from "./glop.js";
import { getKitchen } from "./kitchen.js";

// Esquemas JSON (formato de function-calling de OpenAI), reutilizables en la demo.
export const toolSchemas = [
  {
    type: "function",
    function: {
      name: "get_recommendations",
      description: "Devuelve las 'pizzas del día' recomendadas (las más rentables) para sugerirlas al inicio de la llamada.",
      parameters: { type: "object", properties: { lang: { type: "string" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_menu",
      description: "Devuelve la carta del negocio para recomendar o resolver dudas.",
      parameters: { type: "object", properties: { lang: { type: "string" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wait_time",
      description: "Devuelve el tiempo de espera ACTUAL (recogida y domicilio) según la carga de cocina en este momento. Llamar antes de prometer un tiempo.",
      parameters: { type: "object", properties: { type: { type: "string", enum: ["pickup", "delivery"] } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_order",
      description: "Añade un producto al pedido actual.",
      parameters: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "id del producto de la carta" },
          sizeId: { type: "string", description: "id del tamaño (opcional)" },
          qty: { type: "integer", minimum: 1, default: 1 },
          extras: { type: "integer", minimum: 0, default: 0, description: "nº de ingredientes extra" },
          notes: { type: "string", description: "observaciones (sin cebolla, etc.)" },
        },
        required: ["itemId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_customer",
      description: "Guarda datos del cliente y tipo de pedido.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          type: { type: "string", enum: ["delivery", "pickup"] },
          notes: { type: "string" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_order",
      description: "Devuelve el resumen del pedido y el total para confirmarlo con el cliente.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description: "Cierra el pedido y lo envía al TPV (Glop). Llamar SOLO tras confirmación del cliente.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// Ejecuta una llamada a herramienta sobre un Order dado. Devuelve un objeto serializable.
export async function runTool(name, args, order) {
  switch (name) {
    case "get_recommendations":
      return { recommendations: recommendations(order.cfg, 2, args.lang || order.lang) };

    case "get_menu":
      return { menu: menuForPrompt(order.cfg, args.lang || order.lang) };

    case "get_wait_time": {
      const k = getKitchen(order.cfg);
      const st = k.status();
      const type = args.type || order.type || "pickup";
      return { type, etaMin: type === "delivery" ? st.deliveryMin : st.pickupMin, busy: st.busy, status: st };
    }

    case "add_to_order": {
      const line = order.addItem(args);
      return { added: line, currentTotalEur: order.total() };
    }

    case "set_customer": {
      const { type, ...rest } = args;
      if (type) order.type = type;
      order.setCustomer(rest);
      return { ok: true, customer: order.customer, type: order.type };
    }

    case "review_order":
      return order.summary();

    case "place_order": {
      if (order.lines.length === 0) return { ok: false, error: "El pedido está vacío." };
      // Registrar la carga de cocina (cuenta de platos principales: pizzas).
      const k = getKitchen(order.cfg);
      const units = order.lines.reduce((n, l) => n + (l.isMain !== false ? l.qty : 0), 0) || 1;
      k.record(units);
      const eta = k.estimate(order.type || "pickup");
      const comanda = order.toComanda();
      const result = await createComanda(comanda);
      return { ok: true, glop: result, etaMin: eta, summary: order.summary() };
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}
