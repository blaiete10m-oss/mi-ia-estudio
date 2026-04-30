app.post("/chat", async (req, res) => {
  try {
    const { message, chatId } = req.body;

    if (!chatId || !activeChats[chatId]) {
      return res.status(400).json({ reply: "Chat no activo" });
    }

    // Limitar tamaño mensaje
    const cleanMessage = message.slice(0, 1000);

    activeChats[chatId].push({ role: "user", content: cleanMessage });

    // Limitar historial
    if (activeChats[chatId].length > 20) {
      activeChats[chatId] = activeChats[chatId].slice(-20);
    }

    const response = await client.chat.completions.create({
      model: "llama3-70b-8192",
      messages: activeChats[chatId]
    });

    const iaReply = response.choices[0].message.content;

    activeChats[chatId].push({ role: "assistant", content: iaReply });

    res.json({ reply: iaReply });

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ reply: "Error con la IA" });
  }
});
