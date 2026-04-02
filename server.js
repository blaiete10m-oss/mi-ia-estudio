import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Servir archivos estáticos desde la raíz del repo
app.use(express.static(path.join(__dirname)));

// Configuración de OpenAI
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// Chats activos en memoria mientras el banner está abierto
let activeChats = {};
// Chats guardados (persisten aunque cierres el banner)
let savedChats = [];

// Crear nuevo chat
app.post("/new-chat", (req, res) => {
  const chatId = uuidv4();
  activeChats[chatId] = [
  {
    role: "system",
    content: `
Responde SIEMPRE de forma clara, ordenada y fácil de entender.

REGLAS:
- Usa frases cortas
- Usa listas con guiones
- Resalta lo importante con **negrita**
- Explica paso a paso
- Evita párrafos largos

FORMATO:
1. Explicación breve
2. Sustitución
3. Cálculo
4. Resultado final

Ejemplo:

Si sabemos que **cos(x) = 0.6**, usamos la identidad:

sin²(x) + cos²(x) = 1

Sustituimos:
- cos²(x) = 0.36
- sin²(x) = 0.64

Entonces:
- sin(x) = **0.8**
- o sin(x) = **−0.8**

👉 Resultado: **sin(x) = ±0.8**
`
  }
];
  res.json({ chatId });
});

// Enviar mensaje al chat
app.post("/chat", async (req, res) => {
  try {
    const { message, chatId } = req.body;
    if (!chatId || !activeChats[chatId])
      return res.status(400).json({ reply: "Chat no activo" });

    activeChats[chatId].push({ role: "user", content: message });

    const response = await client.chat.completions.create({
      model: "groq/compound",
      messages: activeChats[chatId]
    });

    const iaReply = response.choices[0].message.content;
    activeChats[chatId].push({ role: "assistant", content: iaReply });

    res.json({ reply: iaReply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Error con la IA" });
  }
});

// Cerrar chat (guardar en lista de chats)
app.post("/close-chat", (req, res) => {
  const { chatId } = req.body;
  if (!chatId || !activeChats[chatId])
    return res.status(400).send("Chat no activo");

  const firstMsg = activeChats[chatId][0]?.content || "Nuevo Chat";
  const title = firstMsg.length > 20 ? firstMsg.slice(0, 20) + "..." : firstMsg;

  savedChats.push({ id: chatId, title, messages: activeChats[chatId] });

  if (savedChats.length > 10) savedChats = savedChats.slice(-10);

  delete activeChats[chatId];
  res.json({ status: "ok" });
});

// Obtener chats guardados
app.get("/saved-chats", (req, res) => {
  res.json(savedChats);
});

// Cambiar chat activo (cargar mensajes)
app.post("/switch-chat", (req, res) => {
  const { chatId } = req.body;
  const chat = savedChats.find(c => c.id === chatId);
  if (!chat) return res.status(404).json({ messages: [] });
  res.json({ messages: chat.messages });
});

// Eliminar chat
app.post("/delete-chat", (req, res) => {
  const { chatId } = req.body;
  savedChats = savedChats.filter(c => c.id !== chatId);
  delete activeChats[chatId];
  res.json({ status: "deleted" });
});

// Enviar el index.html desde la raíz
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
