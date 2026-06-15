# Nora · Recepcionista de voz con IA

Bot telefónico **multilingüe (8 idiomas)** y **configurable para cualquier negocio** con pedidos por teléfono (pizzerías, restaurantes, chinos, kebabs…). Atiende varias llamadas a la vez, toma el pedido conversando con naturalidad y lo manda como **comanda al TPV Glop**.

> Estado: **scaffold completo + demo de venta funcional.** El motor de voz es **intercambiable** (ver `VOZ.md`): el recomendado es **Retell + voz ElevenLabs + LLM a elegir (Claude/Gemini/GPT)** — no dependes de OpenAI. La integración con Glop va con los endpoints marcados como `TODO` que rellena el informático.

---

## Arquitectura

```
Cliente llama ─► Motor de voz (RECOMENDADO: Retell + voz ElevenLabs + LLM a elegir)
                    │  telefonía · escucha · turnos/interrupciones · voz natural
                    └─► funciones HTTP en tu servidor:
                        /tools/get_menu · /tools/add_to_order · /tools/set_customer
                        /tools/review_order · /tools/place_order ─► Glop (comanda)
```

- **Motor de voz (recomendado):** **Retell AI** (orquestación + telefonía, mejores turnos/latencia) con **voz de ElevenLabs** (la más natural) y el **LLM que elijas** (Claude/Gemini/GPT). Ver `VOZ.md`.
- **Alternativas:** OpenAI Realtime (una sola pieza, incluido como driver) · Vapi (máximo control).
- **Cerebro reutilizable:** carta + pedido + Glop, expuesto como funciones HTTP (`/tools/*`) → sirve para cualquier motor de voz.
- **TPV:** adaptador `src/glop.js` → API de Glop (`https://apidoc.glop.es/`).
- **Demo de venta:** misma lógica por **texto + voz de navegador**, en `/demo/`.
- **Niche-agnóstico:** todo el negocio vive en `config/<id>.json`.

## Estructura

```
nora-bot/
├─ config/casa-nerea.json   ← negocio + carta (EJEMPLO: meter carta real)
├─ src/
│  ├─ server.js   ← Fastify: webhook Twilio + puente Realtime + API demo
│  ├─ agent.js    ← agente de VOZ (OpenAI Agents SDK) + tools
│  ├─ demo.js     ← cerebro de TEXTO para la demo (Chat Completions)
│  ├─ tools.js    ← herramientas (carta, añadir, cliente, resumen, cerrar)
│  ├─ order.js    ← carrito + cálculo de precios + comanda
│  ├─ glop.js     ← adaptador TPV Glop (TODOs del informático)
│  ├─ menu.js     ← carga config + carta multilingüe
│  └─ prompt.js   ← personalidad e instrucciones de Nora
├─ demo/index.html ← demo de venta (navegador)
├─ .env.example
└─ package.json
```

---

## ✅ Lo que necesitas para el LUNES

### De Casa Nerea (el negocio)
1. **La carta real completa**: nombres, precios, tamaños (mediana / familiar 41 cm), suplementos (+1,50 €) y bebidas. (Usa el *Formulario de Diagnóstico* que ya tienes.)
2. **Datos de pedido**: ¿reparto a domicilio, recogida o ambos? ¿zona de reparto? ¿pago a la entrega (efectivo/tarjeta/Bizum)?
3. **El número de teléfono**: ¿usamos un número nuevo de Twilio o portamos el suyo? (Decidir el lunes.)

### Del informático de Casa Nerea (Glop)
1. **Cuenta de desarrollador de Glop** y acceso a la API: registro en `https://www.glop.es/api-integraciones/` → documentación en `https://apidoc.glop.es/`.
2. **Credenciales**: base de la API, token/clave y licencia de la instancia de Casa Nerea.
3. **Endpoint exacto para crear comanda/pedido** y **el mapeo de productos** (el id de cada producto en Glop = nuestro `glopProductId` en el JSON de la carta).
4. Confirmar cómo entra la comanda en **cocina/KDS** (que salte sola, como las de Glovo/Just Eat).

> 💡 Con esos 4 puntos, rellenamos `src/glop.js` y el `glopProductId` de cada item, ponemos `GLOP_ENABLED=true` y los pedidos entran solos.

### Cuentas que pones tú (Ktys & Davids)
- **OpenAI** (API key con acceso a Realtime).
- **Twilio** (cuenta + un número de voz español).
- **Render** (despliegue, ya lo usas).

---

## Puesta en marcha (local)

```bash
npm install
cp .env.example .env        # rellena OPENAI_API_KEY (y deja GLOP_ENABLED=false)
npm start                   # arranca en http://localhost:8080
```

**Probar la demo de venta** (lo que enseñas al cliente): abre `http://localhost:8080/demo/`
Habla o escribe a Nora; verás el carrito y el total en vivo. Al cerrar el pedido, la comanda se **simula** (GLOP_ENABLED=false) y se imprime en consola.

> La demo solo necesita `OPENAI_API_KEY`. Funciona sin Twilio ni Glop → lista para vender ya.

## Despliegue en Render

1. Sube el repo a GitHub (`ktysdavids-dev`).
2. Render → New Web Service → repo → Build `npm install` · Start `npm start`.
3. Variables de entorno = tu `.env`.
4. Te queda una URL pública `https://nora-xxxx.onrender.com`.
   - Demo de venta: `…/demo/`
   - Webhook de Twilio: `…/incoming-call`

## Conectar el teléfono (Twilio)

1. Compra/usa un número de voz en Twilio.
2. En el número → *Voice* → "A call comes in" → Webhook → `https://TU-RENDER/incoming-call` (HTTP POST).
3. Llama al número: Nora saluda y toma el pedido. (Media Stream → Realtime.)

## Activar Glop (cuando haya credenciales)

1. Rellena en `src/glop.js` el endpoint real y el `mapToGlopPayload` según `apidoc.glop.es`.
2. Pon el `glopProductId` real de cada item en `config/casa-nerea.json`.
3. `.env`: `GLOP_ENABLED=true`, `GLOP_API_BASE`, `GLOP_API_TOKEN`, `GLOP_LICENSE`.
4. Haz un pedido de prueba y verifica que entra en Glop/cocina.

---

## Vender a otros negocios
Copia `config/casa-nerea.json` → `config/<nuevo>.json`, cambia carta/idiomas/saludo, pon `BUSINESS_ID=<nuevo>`. El mismo motor sirve para cualquier nicho de pedidos por teléfono.

## Lo que afinamos en el otro chat (contigo + Cursor)
- Verificar versiones exactas del OpenAI Agents SDK (`@openai/agents`) y el transporte Twilio.
- Manejo de interrupciones, fin de llamada y “derivar a humano”.
- Rellenar la API real de Glop y el mapeo de productos.
- Multi-tenant (varios negocios en un mismo despliegue) y panel de comandas.
- Voz de Nora afinada (probar `gpt-realtime` voices o TTS ElevenLabs Mateo/femenina).
```
