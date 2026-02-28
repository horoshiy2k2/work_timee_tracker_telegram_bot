require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const API = process.env.API_URL;

const userState = {};
const timers = {};
const pinnedMessages = {}; // pinned message per chat

function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ---------- ПОКАЗ МЕНЮ ----------
async function showMenu(chatId) {
  const selected = userState[chatId]?.categoryName || "None";

  await bot.sendMessage(chatId, "Выберите действие:", {
    reply_markup: {
      keyboard: [
        ["▶ Start"],
        ["⏹ Stop"],
        [`📂 Categories (current: ${selected})`]
      ],
      resize_keyboard: true
    }
  });
}

async function updatePinnedMessage(chatId) {
  // если таймер уже есть — очищаем
  if (timers[chatId]) {
    clearInterval(timers[chatId]);
    delete timers[chatId];
  }

  try {
    const { data: current } = await axios.get(`${API}/current-session`);

    if (!current) {
      // сессия закончилась
      if (timers[chatId]) {
        clearInterval(timers[chatId]);
        delete timers[chatId];
      }

      try {
        const { data: sessions } = await axios.get(`${API}/sessions`);
        const finishedSessions = sessions.filter(s => s.endTime);
        const lastSession = finishedSessions.reduce((latest, s) => {
          return !latest || new Date(s.startTime) > new Date(latest.startTime) ? s : latest;
        }, null);

        if (lastSession && pinnedMessages[chatId]) {
          const start = new Date(lastSession.startTime);
          const end = new Date(lastSession.endTime || Date.now());
          const startStr = `${String(start.getHours()).padStart(2,"0")}:${String(start.getMinutes()).padStart(2,"0")}`;
          const endStr = `${String(end.getHours()).padStart(2,"0")}:${String(end.getMinutes()).padStart(2,"0")}`;
          const durationStr = formatTime(lastSession.durationSec);
          const category = lastSession.category?.name || lastSession.categoryId || "None";

          await bot.sendMessage(chatId,
            `✅ Сессия завершена\n\n` +
            `📂 Категория: ${category}\n` +
            `⏱️ Время: ${startStr} – ${endStr}\n` +
            `⏳ Продолжительность: ${durationStr}`
          );

          await bot.editMessageText("⏹ Нет активной сессии", {
            chat_id: chatId,
            message_id: pinnedMessages[chatId],
          });
        }

      } catch (e) {
        console.error("Ошибка при показе итогов сессии:", e.response?.data || e.message);
      }

      return;
    }

    // сессия активна — создаём новое сообщение
    const startTime = new Date(current.startTime).getTime();
    const category = current.category?.name || "None";
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    const formatted = formatTime(seconds);

    // открепляем все старые pinned сообщения
    try {
      await bot.unpinAllChatMessages(chatId);
      delete pinnedMessages[chatId];
    } catch (e) {
      console.error("Ошибка при откреплении всех сообщений:", e.message);
    }

    // создаём новое сообщение и закрепляем его
    const sentMessage = await bot.sendMessage(
      chatId,
      `⏱ Сессия идёт\n\n📂 Категория: ${category}\n⏱️ Время: ${formatted}`
    );
    pinnedMessages[chatId] = sentMessage.message_id;
    await bot.pinChatMessage(chatId, sentMessage.message_id, { disable_notification: true });
    // запускаем таймер обновления
    timers[chatId] = setInterval(async () => {
      const seconds = Math.floor((Date.now() - startTime) / 1000);
      const formatted = formatTime(seconds);

      try {
        await bot.editMessageText(
          `⏱ Сессия идёт\n\n📂 Категория: ${category}\n⏱️ Время: ${formatted}`,
          {
            chat_id: chatId,
            message_id: pinnedMessages[chatId]
          }
        );
      } catch {}
    }, 1000);

    userState[chatId] = { ...userState[chatId], lastSession: current };

  } catch (e) {
    console.error("updatePinnedMessage interval:", e.response?.data || e.message);
  }
}



// ---------- /START ----------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await updatePinnedMessage(chatId);
  await showMenu(chatId);
});

// ---------- ОБРАБОТКА СООБЩЕНИЙ ----------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  // ---------- ВЫБОР КАТЕГОРИИ ----------
  if (text.startsWith("📂 Categories")) {
    try {
      const { data } = await axios.get(`${API}/categories`);
      const buttons = data.map(cat => [cat.name]);
      await bot.sendMessage(chatId, "Выберите категорию:", {
        reply_markup: { keyboard: buttons, resize_keyboard: true }
      });
      userState[chatId] = { ...userState[chatId], categories: data };
    } catch {
      await bot.sendMessage(chatId, "Ошибка загрузки категорий ❌");
    }
    return;
  }

  const categories = userState[chatId]?.categories;
  if (categories) {
    const selected = categories.find(c => c.name === text);
    if (selected) {
      userState[chatId] = {
        ...userState[chatId],
        categoryId: selected.id,
        categoryName: selected.name,
        categories: null
      };
      await bot.sendMessage(chatId, `Выбрана категория: ${selected.name} ✅`);
      await showMenu(chatId);
      return;
    }
  }

  // ---------- START ----------
  if (text === "▶ Start") {
    const categoryId = userState[chatId]?.categoryId || null;
    if (!categoryId) return bot.sendMessage(chatId, "Выберите категорию перед запуском ⚠️");

    try {
      const { data: current } = await axios.get(`${API}/current-session`);
      if (current) return bot.sendMessage(chatId, "Сессия уже запущена ❌");

      await axios.post(`${API}/current-session/start`, { categoryId });
      // pinned message и таймер обновляются, но категория не сбрасывается
      await updatePinnedMessage(chatId);

      await bot.sendMessage(chatId, "Сессия запущена ✅");
    } catch {
      await bot.sendMessage(chatId, "Ошибка запуска ❌");
    }
    return;
  }

  // ---------- STOP ----------
  if (text === "⏹ Stop") {
    try {
      await axios.post(`${API}/current-session/stop`, {});
      // pinned message и таймер обновляются, категория не трогаем
      await updatePinnedMessage(chatId);

      await bot.sendMessage(chatId, "Сессия остановлена 🛑");
    } catch {
      await bot.sendMessage(chatId, "Нет активной сессии ❌");
    }
    return;
  }
});