# Voz de Nora — la más humana posible

Objetivo: que quien llame piense que habla con una persona encantadora, no con una IA.

## Motor recomendado (producción)
- **Retell AI** orquesta la llamada (telefonía, turnos, interrupciones, baja latencia ~600 ms) y llama a nuestras funciones en `/tools/*`.
- **Voz: ElevenLabs** (la más natural del mercado). Elegir una voz **femenina, cálida, española**.
- **LLM a elegir** dentro de Retell: Claude / Gemini / GPT (no dependes de OpenAI).

## Ajustes de ElevenLabs para realismo (punto de partida)
- Modelo de baja latencia (eleven_turbo / flash) para que conteste rápido en llamada.
- **Stability ~0.45** (algo baja = más expresiva y humana; si suena inestable, sube a 0.55).
- **Similarity ~0.80**.
- **Style ~0.30–0.45** (da color comercial sin pasarse).
- **Speaker boost: ON**.
- Probar 2–3 voces femeninas y quedarte con la más cálida y natural en español.

## Trucos para que NO suene a robot
- El `prompt.js` ya instruye: frases cortas, contracciones, muletillas suaves, reacciones ("¡buena elección!"), variar el lenguaje.
- Pausas naturales: deja que el modelo use comas y puntos; evita frases largas de carrerilla.
- Que confirme con calidez y use el nombre del cliente.

## Tiempos de entrega dinámicos
- `kitchen.js` calcula el tiempo según la carga (pedidos por ventana de minutos).
- Nora llama a `get_wait_time` ANTES de prometer tiempo y, si hay saturación, lo avisa con naturalidad.
- Parámetros configurables por negocio en `config/<id>.json -> kitchen`.

## Coherencia de voz
- Nora SIEMPRE la misma voz (femenina, cálida), en todos los idiomas. Solo cambia el idioma, no la "persona".
