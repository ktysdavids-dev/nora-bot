// webhooks.js — Expone las herramientas de Nora como endpoints HTTP para que
// CUALQUIER plataforma de voz (Retell, Vapi, ElevenLabs Agents…) las llame
// como "functions/tools" durante la llamada. Así el motor de voz es
// intercambiable y el cerebro (carta, pedido, Glop) es siempre el mismo.
//
// Patrón: la plataforma llama POST /tools/<nombre> con { call_id, args }.
// Mantenemos un Order por call_id (el carrito de esa llamada).

import { Order } from "./order.js";
import { runTool, toolSchemas } from "./tools.js";

const sessions = new Map(); // call_id -> Order

function getOrder(cfg, callId) {
  let o = sessions.get(callId);
  if (!o) { o = new Order(cfg, { lang: "es" }); sessions.set(callId, o); }
  return o;
}

export function registerToolWebhooks(app, cfg) {
  // Una ruta por herramienta. Acepta el formato de Retell, Vapi o genérico.
  app.post("/tools/:name", async (req, reply) => {
    const name = req.params.name;
    const body = req.body || {};
    const callId =
      body.call_id || body.call?.call_id || body.callId ||
      body.message?.call?.id || "default";
    const args = body.args || body.arguments || body.parameters || body.params || {};

    const order = getOrder(cfg, callId);
    try {
      const result = await runTool(name, args, order);
      if (name === "place_order" && result.ok) sessions.delete(callId); // fin de llamada
      return { result };
    } catch (e) {
      reply.code(400);
      return { error: String(e.message || e) };
    }
  });

  // Definiciones de funciones listas para pegar en la plataforma de voz.
  // PUBLIC_URL = la URL pública de tu despliegue (Render).
  app.get("/tools-spec", async () => {
    const base = (process.env.PUBLIC_URL || "https://TU-DOMINIO").replace(/\/$/, "");
    return toolSchemas.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      url: `${base}/tools/${t.function.name}`,
      method: "POST",
    }));
  });
}
