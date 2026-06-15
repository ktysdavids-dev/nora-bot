// agent.js — Construye el agente de VOZ (OpenAI Realtime) para una llamada.
// Usa el OpenAI Agents SDK. Verificar rutas de import/versión contra la doc
// vigente de @openai/agents al desplegar (el SDK evoluciona).
//
//   npm i @openai/agents @openai/agents-extensions zod
//
// La capa de transporte Twilio (TwilioRealtimeTransportLayer) se usa en server.js
// dentro del WebSocket /media-stream.

import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { buildInstructions } from "./prompt.js";
import { runTool } from "./tools.js";

// Crea un agente ligado a un Order concreto (estado de esa llamada).
export function buildAgent(cfg, order) {
  const mk = (name, description, schema) =>
    tool({
      name,
      description,
      parameters: schema,
      execute: async (input) => JSON.stringify(await runTool(name, input ?? {}, order)),
    });

  const tools = [
    mk("get_recommendations", "Pizzas del día recomendadas (las más rentables) para sugerir al inicio.", z.object({ lang: z.string().optional() })),
    mk("get_menu", "Devuelve la carta para recomendar o resolver dudas.", z.object({ lang: z.string().optional() })),
    mk("get_wait_time", "Tiempo de espera actual según la carga de cocina. Llamar antes de prometer un tiempo.", z.object({ type: z.enum(["pickup","delivery"]).optional() })),
    mk("add_to_order", "Añade un producto al pedido.", z.object({
      itemId: z.string(),
      sizeId: z.string().optional(),
      qty: z.number().int().min(1).default(1),
      extras: z.number().int().min(0).default(0),
      notes: z.string().optional(),
    })),
    mk("set_customer", "Guarda datos del cliente y tipo de pedido.", z.object({
      name: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      type: z.enum(["delivery", "pickup"]).optional(),
      notes: z.string().optional(),
    })),
    mk("review_order", "Resumen del pedido y total.", z.object({})),
    mk("place_order", "Cierra el pedido y lo envía a Glop (solo tras confirmación).", z.object({})),
  ];

  return new RealtimeAgent({
    name: "Nora",
    instructions: buildInstructions(cfg),
    tools,
  });
}
