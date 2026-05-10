const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const storage = require('./services/storage');


const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = String(now.getFullYear()).slice(-2);
  const t = now.toLocaleTimeString('ru-RU', { hour12: false });
  return `${d}.${m}.${y}-${t}`;
}

console.log = (...args) => originalLog(getTimestamp(), ...args);
console.error = (...args) => originalError(getTimestamp(), ...args);


// Создаем бота
const allowedUpdates = [
  'message',
  'edited_message',
  'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
];

const bot = new TelegramBot(config.telegramToken, {
  polling: {
    params: {
      allowed_updates: allowedUpdates,
    },
  },
});

const businessConnections = new Map();

function withBusinessConnection(baseBot, msg) {
  const businessConnectionId = msg.business_connection_id;
  if (!businessConnectionId) return baseBot;

  const businessChatId = String(msg.chat.id);
  const addBusinessOption = (chatId, options = {}) => {
    if (String(chatId) !== businessChatId) return options;
    return { ...options, business_connection_id: businessConnectionId };
  };

  return new Proxy(baseBot, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (chatId, text, options = {}) => target.sendMessage(chatId, text, addBusinessOption(chatId, options));
      }
      if (prop === 'sendChatAction') {
        return (chatId, action, options = {}) => target.sendChatAction(chatId, action, addBusinessOption(chatId, options));
      }
      if (prop === 'setMessageReaction') {
        return (chatId, messageId, options = {}) => target.setMessageReaction(chatId, messageId, addBusinessOption(chatId, options));
      }

      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function isFreshMessage(msg) {
  const now = Math.floor(Date.now() / 1000);
  return !msg.date || msg.date >= now - 120;
}

// Передаем бота в AI-сервис для уведомлений
const ai = require('./services/ai');
ai.setBot(bot);

console.log("Сыч запущен и готов пояснять за жизнь.");
console.log(`Admin ID: ${config.adminId}`);

bot.getMe().then((me) => {
  console.log(`[BOT] @${me.username || 'unknown'} business=${Boolean(me.can_connect_to_business)}`);
}).catch((err) => {
  console.error(`[BOT] Не смог получить getMe: ${err.message}`);
});

// === ТИКЕР НАПОМИНАЛОК (Проверка каждую минуту) ===
setInterval(() => {
  const pending = storage.getPendingReminders();
  
  if (pending.length > 0) {
      console.log(`[REMINDER] Сработало напоминаний: ${pending.length}`);
      
      const idsToRemove = [];

      pending.forEach(task => {
          // Формируем сообщение
          const message = `⏰ ${task.username}, напоминаю!\n\n${task.text}`;
          
          // Отправляем
          bot.sendMessage(task.chatId, message).then(() => {
              console.log(`[REMINDER] Успешно отправлено: ${task.text}`);
          }).catch(err => {
              console.error(`[REMINDER ERROR] Не смог отправить в ${task.chatId}: ${err.message}`);
              // Если юзер заблочил бота, все равно удаляем, чтобы не спамить в лог ошибками
          });

          idsToRemove.push(task.id);
      });

      // Чистим базу
      storage.removeReminders(idsToRemove);
  }
}, 60 * 1000); // 60000 мс = 1 минута

// Обработка ошибок поллинга
bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
    // Если ошибка "Conflict: terminated by other getUpdates", значит запущен второй экземпляр
  });

bot.on('business_connection', (connection) => {
  businessConnections.set(connection.id, connection);
  const rights = connection.rights || {};
  const user = connection.user?.username ? `@${connection.user.username}` : connection.user?.first_name || connection.user?.id;
  console.log(`[BUSINESS] ${connection.is_enabled ? 'Подключен' : 'Отключен'}: ${user}, can_reply=${Boolean(rights.can_reply)}, id=${connection.id}`);
});

bot.on('deleted_business_messages', (update) => {
  console.log(`[BUSINESS] Удалены сообщения: chat=${update.chat?.id}, ids=${update.message_ids?.join(',')}`);
});

bot.on('business_message', async (msg) => {
  if (!isFreshMessage(msg)) return;

  const connection = businessConnections.get(msg.business_connection_id);
  if (connection && connection.is_enabled === false) return;
  if (connection?.rights && !connection.rights.can_reply) {
    console.log(`[BUSINESS] Нет права can_reply для ${msg.business_connection_id}`);
    return;
  }

  const scopedBot = withBusinessConnection(bot, msg);
  await logic.processMessage(scopedBot, msg);
});

bot.on('edited_business_message', async (msg) => {
  if (!isFreshMessage(msg)) return;

  const scopedBot = withBusinessConnection(bot, msg);
  await logic.processMessage(scopedBot, msg);
});

// Единый вход для всех сообщений
bot.on('message', async (msg) => {
  // Игнорируем сообщения, старше 2 минут (чтобы не отвечать на старое при рестарте)
  if (!isFreshMessage(msg)) return;

  const chatId = msg.chat.id;
  const chatTitle = msg.chat.title || "Личка";

  // === 🛡 SECURITY PROTOCOL: "ВЕРНЫЙ ОРУЖЕНОСЕЦ" ===
  // Проверяем наличие Админа в ЛЮБОМ групповом чате при ЛЮБОМ сообщении
  if (msg.chat.type !== 'private') {
      try {
          // 1. Проверяем статус Админа в этом чате
          const adminMember = await bot.getChatMember(chatId, config.adminId);
          const allowedStatuses = ['creator', 'administrator', 'member'];

          // 2. Если Админа нет (left, kicked) или он не участник
          if (!allowedStatuses.includes(adminMember.status)) {
            console.log(`[SECURITY] ⛔ Обнаружен чат без Админа...`);
            
            // ВОТ ТУТ МЕНЯЕМ СООБЩЕНИЕ
            const phrases = [
                "Так, стопэ. Админа не вижу. Благотворительности не будет, я уёбываю!",
                "Опа, куда это меня занесло? Бати рядом нет, так что я уёбываю!",
                "Вы че думали, украли бота? Я не работаю в беспризорных приютах. Я уёбываю!",
                "⚠️ ERROR: ADMIN NOT FOUND. Включаю протокол самоуважения. Я уёбываю!",
                "Не, ну вы видели? Затащили без спроса. Ну вас нахер, я уёбываю!"
            ];
            const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

            await bot.sendMessage(chatId, randomPhrase).catch(() => {});
            await bot.leaveChat(chatId).catch(() => {});
            return; 
        }
      } catch (e) {
        // Если ошибка проверки прав
        console.error(`[SECURITY ERROR] Ошибка проверки прав в "${chatTitle}": ${e.message}`);
        
        // ВЫХОДИМ ТОЛЬКО ЕСЛИ ЧАТА БОЛЬШЕ НЕТ ИЛИ БОТА КИКНУЛИ
        // При обычных сетевых ошибках (ETIMEDOUT, 502 и т.д.) - ОСТАЕМСЯ
        if (e.message.includes('chat not found') || e.message.includes('kicked') || e.message.includes('Forbidden')) {
           bot.leaveChat(chatId).catch(() => {});
        } 
        // Во всех остальных случаях (лаг API) — просто игнорируем и работаем дальше
    }
  }

  // === ЛОГИКА ВЫХОДА ВСЛЕД ЗА АДМИНОМ (ХАТИКО) ===
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    console.log(`[SECURITY] Админ вышел из чата "${chatTitle}". Ухожу следом.`);
    await bot.sendMessage(chatId, "Батя ушел, и я сваливаю.");
    await bot.leaveChat(chatId);
    return;
  }

  // Дальше идет обычная логика...
  await logic.processMessage(bot, msg);
});

// Сохраняем базу при выходе
process.on('SIGINT', () => {
  console.log("Сохранение данных перед выходом...");
  storage.forceSave(); 
  process.exit();
});
