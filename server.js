import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname)));

// ─── Cliente Groq ─────────────────────────────────────────────────────────────
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  `Eres una IA avanzada, amable y muy capaz.
Respondes siempre en el idioma del usuario.
Eres preciso, claro y conciso, pero detallas cuando es necesario.
Usas Markdown para estructurar tus respuestas cuando ayuda a la claridad.`;

// ─── Almacenamiento en memoria ────────────────────────────────────────────────
let activeChats = {};
let savedChats  = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildMessages(history) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];
}

// Genera título tras acumular ~6 mensajes (3 turnos usuario+IA).
// Se llama una sola vez: cuando el historial llega a exactamente 6 mensajes.
// Si el chat tiene menos de 6 mensajes (por ej. al guardar antes), usa los que haya.
async function generateTitle(messages) {
  try {
    // Construir resumen del intercambio para el prompt
    const excerpt = messages
      .slice(0, 6)
      .map(m => `${m.role === "user" ? "Usuario" : "IA"}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 20,
      messages: [
        {
          role: "system",
          content:
            "Basándote en la siguiente conversación, genera un título breve de 4-6 palabras que describa el tema principal. Sin comillas, sin puntuación final, solo el título.",
        },
        { role: "user", content: excerpt },
      ],
    });
    return resp.choices[0].message.content.trim();
  } catch {
    // Fallback: primeras palabras del primer mensaje del usuario
    const first = messages.find(m => m.role === "user")?.content || "Nuevo chat";
    return first.slice(0, 30) + (first.length > 30 ? "…" : "");
  }
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.post("/new-chat", (req, res) => {
  const chatId = uuidv4();
  activeChats[chatId] = {
    messages:     [],
    title:        "Nuevo chat",
    createdAt:    new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  };
  res.json({ chatId, title: "Nuevo chat" });
});

app.post("/chat", async (req, res) => {
  const { chatId, message, stream = false } = req.body;

  if (!message?.trim())
    return res.status(400).json({ error: "Mensaje vacío" });

  if (!chatId || !activeChats[chatId])
    return res.status(404).json({ error: "Chat no encontrado. Crea uno nuevo." });

  const chat = activeChats[chatId];
  chat.messages.push({ role: "user", content: message.trim() });
  chat.lastActivity = new Date().toISOString();

  try {
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const streamResp = await client.chat.completions.create({
        model: MODEL,
        messages: buildMessages(chat.messages),
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
      });

      let fullReply = "";
      for await (const chunk of streamResp) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) {
          fullReply += delta;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      }

      chat.messages.push({ role: "assistant", content: fullReply });
      chat.lastActivity = new Date().toISOString();

      // Generar título tras el 6º mensaje (3 turnos completos usuario+IA)
      if (chat.messages.length === 6) {
        chat.title = await generateTitle(chat.messages);
      }

      res.write(`data: ${JSON.stringify({ done: true, title: chat.title })}\n\n`);
      res.end();

    } else {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: buildMessages(chat.messages),
        temperature: 0.7,
        max_tokens: 2048,
      });

      const iaReply = response.choices[0].message.content;
      chat.messages.push({ role: "assistant", content: iaReply });
      chat.lastActivity = new Date().toISOString();

      // Generar título tras el 6º mensaje (3 turnos completos usuario+IA)
      if (chat.messages.length === 6) {
        chat.title = await generateTitle(chat.messages);
      }

      res.json({ reply: iaReply, title: chat.title, usage: response.usage });
    }

  } catch (err) {
    console.error("Error Groq:", err?.message || err);
    const status = err?.status || 500;
    const msg =
      status === 429 ? "Límite de velocidad de Groq alcanzado. Espera un momento." :
      status === 401 ? "API Key inválida o sin permisos." :
                       "Error interno al procesar tu mensaje.";
    res.status(status).json({ error: msg });
  }
});

app.post("/close-chat", (req, res) => {
  const { chatId } = req.body;
  if (!chatId || !activeChats[chatId])
    return res.status(404).json({ error: "Chat no activo" });

  const chat = activeChats[chatId];

  // Si nunca se generó título (chat corto, menos de 6 mensajes), generarlo ahora
  if (chat.title === "Nuevo chat" && chat.messages.length >= 2) {
    chat.title = await generateTitle(chat.messages);
  }

  const existing = savedChats.findIndex(c => c.id === chatId);
  const entry = {
    id:        chatId,
    title:     chat.title,
    messages:  chat.messages,
    createdAt: chat.createdAt,
    savedAt:   new Date().toISOString(),
  };

  if (existing >= 0) savedChats[existing] = entry;
  else savedChats.push(entry);

  delete activeChats[chatId];
  res.json({ status: "saved", title: entry.title });
});

app.get("/saved-chats", (req, res) => {
  res.json(savedChats.map(({ id, title, createdAt, savedAt }) => ({ id, title, createdAt, savedAt })));
});

app.post("/switch-chat", (req, res) => {
  const { chatId } = req.body;

  if (activeChats[chatId]) {
    return res.json({ messages: activeChats[chatId].messages, title: activeChats[chatId].title });
  }

  const saved = savedChats.find(c => c.id === chatId);
  if (!saved) return res.status(404).json({ error: "Chat no encontrado" });

  activeChats[chatId] = {
    messages:     [...saved.messages],
    title:        saved.title,
    createdAt:    saved.createdAt,
    lastActivity: new Date().toISOString(),
  };

  res.json({ messages: saved.messages, title: saved.title });
});

// Compatible con frontend actual
app.post("/delete-chat", (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: "chatId requerido" });
  delete activeChats[chatId];
  savedChats = savedChats.filter(c => c.id !== chatId);
  res.json({ status: "deleted" });
});

// REST estándar
app.delete("/chat/:chatId", (req, res) => {
  const { chatId } = req.params;
  delete activeChats[chatId];
  savedChats = savedChats.filter(c => c.id !== chatId);
  res.json({ status: "deleted" });
});

app.get("/health", (req, res) => {
  res.json({
    status:      "ok",
    model:       MODEL,
    activeChats: Object.keys(activeChats).length,
    savedChats:  savedChats.length,
    uptime:      Math.floor(process.uptime()) + "s",
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((err, req, res, _next) => {
  console.error("Error no manejado:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log(`Modelo: ${MODEL}`);
});
