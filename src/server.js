// server.js — servidor único que sirve:
//  (A) Telefonía: webhook de Twilio + puente de voz con OpenAI Realtime.
//  (B) Demo de venta por navegador (texto/voz) en /demo.
//
// Arranque:  node src/server.js     (o npm start)
// Requiere variables del .env (ver .env.example).
import Fastify from "fastify";
import { registerAdmin } from "./admin.js";
import { registerClient } from "./client.js";
import fastifyWs from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyFormbody from "@fastify/formbody";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadBusiness } from "./menu.js";
import { Order } from "./order.js";
import { buildAgent } from "./agent.js";
// import { demoTurn } from "./demo.js";  (demo desactivada)
import { registerToolWebhooks } from "./webhooks.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const cfg = loadBusiness();
const app = Fastify({ logger: true });
await app.register(fastifyWs);
await app.register(fastifyFormbody);
await app.register(fastifyStatic, { root: path.join(__dirname, "..", "demo"), prefix: "/demo/" });
app.get("/", async () => ({ ok: true, bot: "Nora", business: cfg.business.name }));
// Herramientas como webhooks HTTP para el motor de voz (Retell/Vapi/ElevenLabs).
registerToolWebhooks(app, cfg);
// ---------- (A) TELEFONÍA ----------
// Twilio llama aquí al entrar una llamada. Devolvemos TwiML que saluda y abre
// un Media Stream (audio bidireccional) hacia nuestro WebSocket /media-stream.
const twiml = (host) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-ES" voice="Polly.Lucia-Neural">${cfg.greeting.es}</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
app.all("/incoming-call", async (req, reply) => {
  reply.type("text/xml").send(twiml(req.headers.host));
});
// Twilio abre un WebSocket aquí. Conectamos cada llamada a una sesión Realtime
// con su propio Order (carrito). Verificar imports del SDK al desplegar.
app.register(async (f) => {
  f.get("/media-stream", { websocket: true }, async (conn) => {
    try {
      const { RealtimeSession } = await import("@openai/agents/realtime");
      const { TwilioRealtimeTransportLayer } = await import("@openai/agents-extensions");
      const order = new Order(cfg, { lang: "es" });
      const agent = buildAgent(cfg, order);
      const transport = new TwilioRealtimeTransportLayer({ twilioWebSocket: conn });
      const session = new RealtimeSession(agent, {
        transport,
        model: process.env.REALTIME_MODEL || "gpt-realtime",
        config: { voice: process.env.NORA_VOICE || "shimmer" },
      });
      await session.connect({ apiKey: process.env.OPENAI_API_KEY });
      app.log.info("Llamada conectada a Nora (Realtime)");
    } catch (err) {
      app.log.error({ err }, "Fallo conectando Realtime");
      try { conn.close(); } catch {}
    }
  });
});
// ---------- (B) DEMO DE VENTA ----------
// Sesiones en memoria: cada navegador mantiene su carrito por sessionId.
// const demoSessions = new Map();
app.get("/api/menu", async () => ({ business: cfg.business, menu: cfg.menu, sizes: cfg.sizes, extras: cfg.extras }));

// ---------- NUEVO · GLOP: OBTENCIÓN DE LOCALIZACIONES ----------
// Glop llama a este endpoint para descubrir las localizaciones de este negocio.
// Devuelve un array; Glop la activa en su panel y la mapea a un terminal del TPV.
// El "id" debe ser único y FIJO: una vez Glop lo mapea, no se puede cambiar.
app.get("/glop/localizaciones", async () => ([
  {
    id: "7c9e6a52-3b1d-4f88-9a2e-1d6b4c0f2a91",
    nombre: "Pizzería Casa Nerea – Gandía"
  }
]));

registerAdmin(app);
registerClient(app);
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`Nora escuchando en :${PORT}  ·  demo en /demo/`);
});
