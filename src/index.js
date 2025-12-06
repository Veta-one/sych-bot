const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const storage = require('./services/storage');

// Создаем бота
const bot = new TelegramBot(config.telegramToken, { polling: true });

console.log("Сыч запущен и готов пояснять за жизнь.");
console.log(`Admin ID: ${config.adminId}`);

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

// Единый вход для всех сообщений
bot.on('message', async (msg) => {
  // Игнорируем сообщения, старше 2 минут (чтобы не отвечать на старое при рестарте)
  const now = Math.floor(Date.now() / 1000);
  if (msg.date < now - 120) return;

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
            console.log(`[SECURITY] ⛔ Обнаружен чат без Админа: "${chatTitle}" (ID: ${chatId}).`);
            console.log(`[SECURITY] Статус админа: ${adminMember.status}. Покидаю чат...`);
            // Пытаемся попрощаться. Если не вышло (уже кикнули) — пофиг, глушим ошибку.
            await bot.sendMessage(chatId, "⛔ Хозяина (Admin ID) нет в этом чате. ББ.").catch(() => {});
            // Пытаемся выйти. Если уже вышли — тоже пофиг.
            await bot.leaveChat(chatId).catch(() => {});
            return; // Прерываем обработку
        }
      } catch (e) {
          // Если мы даже не можем проверить админа (например, бот забанен или нет прав), лучше уйти
          console.error(`[SECURITY ERROR] Ошибка проверки прав в "${chatTitle}": ${e.message}`);
          // На всякий случай пытаемся выйти, если ошибка критичная
          if (e.message.includes('chat not found') || e.message.includes('kicked')) {
             // Игнорим, мы и так не там
          } else {
             // Пытаемся выйти
             bot.leaveChat(chatId).catch(() => {});
          }
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