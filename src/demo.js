// demo.js — "cerebro" de Nora por TEXTO, para la demo de venta en navegador.
// Usa OpenAI Chat Completions con function-calling. Es la parte 100% lista para
// usar el lunes: el comercial abre el portátil y deja que el dueño hable con Nora.
//
//   npm i openai
//
// Mantiene una conversación stateless: el cliente (navegador) envía el historial
// de mensajes y el id de negocio; aquí reconstruimos el pedido a partir de las
// tool-calls del propio hilo (el carrito vive en el front; aquí recalculamos).

import OpenAI from "openai";
import { Order } from "./order.js";
import { toolSchemas, runTool } from "./tools.js";
import { buildInstructions } from "./prompt.js";

let client = null;
function getClient(){ if(!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return client; }
const MODEL = process.env.DEMO_MODEL || "gpt-4o-mini";

// messages: [{role:'user'|'assistant'|'tool'..., content}], pero para simplificar
// la demo recibe solo turnos user/assistant en texto y un "cartState" opcional.
export async function demoTurn(cfg, history, order) {
  const messages = [
    { role: "system", content: buildInstructions(cfg) },
    ...history,
  ];

  // Bucle de tool-calling hasta que Nora responda en texto al cliente.
  for (let i = 0; i < 6; i++) {
    const resp = await getClient().chat.completions.create({
      model: MODEL,
      messages,
      tools: toolSchemas,
      temperature: 0.5,
    });
    const msg = resp.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || "", cart: order.summary() };
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      let result;
      try { result = await runTool(tc.function.name, args, order); }
      catch (e) { result = { error: String(e.message || e) }; }
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { reply: "Perdona, ¿me lo repites?", cart: order.summary() };
}

// Reconstruye el Order desde el historial de tool-calls add_to_order/set_customer.
// (En la demo el carrito se mantiene en memoria por sesión; ver server.js.)
export function newOrder(cfg, lang = "es") {
  return new Order(cfg, { lang });
}
