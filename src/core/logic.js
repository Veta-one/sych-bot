const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
const chatHistory = {};
const analysisBuffers = {};
const chatAnalysisBuffers = {}; // Буфер для анализа профиля чата
const BUFFER_SIZE = 20;
const CHAT_BUFFER_SIZE = 50; // Анализируем чат каждые 50 сообщений
// Храним 10 последних активных юзеров для удобного бана
const recentActiveUsers = []; 

// === ГЕНЕРАТОР ОТМАЗОК СЫЧА ===
function getSychErrorReply(errText) {
    const error = errText.toLowerCase();

    // 1. ЦЕНЗУРА (Safety / Blocked)
    if (error.includes('prohibited') || error.includes('safety') || error.includes('blocked') || error.includes('policy')) {
        const phrases = [
            "🤬 Гугл опять включил моралиста и зацензурил мой ответ. Сказал, что мы тут слишком токсичные. Сорян.",
            "🔞 Не, ну это бан. Нейронка отказалась это генерить, говорит \"Violation of Safety Policy\". Слишком грязно даже для меня.",
            "👮‍♂️ Опа, цензура подъехала. Гугл считает, что этот контент оскорбляет чьи-то нежные чувства. Попробуй помягче спросить."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // 2. ПЕРЕГРУЗКА (503 / Overloaded)
    if (error.includes('503') || error.includes('overloaded') || error.includes('unavailable') || error.includes('timeout')) {
        const phrases = [
            "🔥 Там у Гугла сервера плавятся. Говорят \"Model is overloaded\". Подожди минуту, пусть остынут.",
            "🐌 Гугл тупит страшно, 503-я ошибка. Я запрос кинул, а там тишина. Походу, китайцы опять все видеокарты заняли.",
            "💤 Чёт нейронка устала. Пишет \"Service Unavailable\". Дай ей перекур пару секунд."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // 3. ЛИМИТЫ (429 / Quota)
    if (error.includes('429') || error.includes('quota') || error.includes('exhausted') || error.includes('лимит')) {
        const phrases = [
            "💸 Всё, пацаны, лимиты всё. Мы слишком много болтаем, Гугл перекрыл краник. Ждем отката квоты.",
            "🛑 Стопэ. Ошибка 429 — \"Too Many Requests\". Я слишком быстро отвечаю, меня притормозили. Ща отдышусь.",
            "📉 Квота всё. Гугл сказал «хватит болтать». Попробуй позже."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // 4. ТЯЖЕЛЫЙ ЗАПРОС (400 / Too Large)
    if (error.includes('400') || error.includes('too large') || error.includes('invalid argument')) {
        const phrases = [
            "🐘 Ты мне библиотеку Конгресса скинул? Гугл говорит, файл слишком жирный, я это не переварю.",
            "📜 Много буков. Ошибка \"Payload size limit\". Сократи басню, братан, не лезет.",
            "💾 Файл слишком жирный, не лезет в промпт. Давай что-то полегче."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // 5. ДЕФОЛТНАЯ ОШИБКА (Зовем Админа)
    // Если ничего не подошло — значит, упал сам бот или сервер
    const phrases = [
        "🛠 Так, у меня шестеренки встали. Какая-то дичь в коде. Админ, просыпайся, тут всё сломалось!",
        "💥 Я упал. Критическая ошибка. Админ чини давай, я работать не могу.",
        "🚑 Хьюстон, у нас проблемы. Я поймал баг и не знаю, что делать. Админ, выручай."
    ];
    return phrases[Math.floor(Math.random() * phrases.length)];
}

function addToHistory(chatId, sender, text) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role: sender, text: text });
  if (chatHistory[chatId].length > config.contextSize) {
    chatHistory[chatId].shift();
  }
}

function getBaseOptions(threadId) {
    const opts = { parse_mode: 'Markdown', disable_web_page_preview: true };
    if (threadId) opts.message_thread_id = threadId;
    return opts;
}

function getReplyOptions(msg) {
    return { reply_to_message_id: msg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true };
}

function getActionOptions(threadId) {
    // [FIX] Если топика нет, возвращаем undefined.
    // Это важно: библиотека node-telegram-bot-api не любит пустой объект {} в обычных группах.
    if (!threadId) return undefined;
    return { message_thread_id: threadId };
}

function isTelegramEntityParseError(error) {
    const message = error?.message || "";
    return /can'?t parse entities|can't find end of the entity|parse entities/i.test(message);
}

function withoutParseMode(options = {}) {
    const clean = { ...options };
    delete clean.parse_mode;
    return clean;
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function processBuffer(chatId) {
    const buffer = analysisBuffers[chatId];
    if (!buffer || buffer.length === 0) return;

    const userIds = [...new Set(buffer.map(m => m.userId))];
    const currentProfiles = storage.getProfilesForUsers(chatId, userIds);
    const updates = await ai.analyzeBatch(buffer, currentProfiles);

    if (updates) {
        storage.bulkUpdateProfiles(chatId, updates);
        console.log(`[OBSERVER] Обновлено профилей: ${Object.keys(updates).length}`);
    }
    analysisBuffers[chatId] = [];
}

// Анализ профиля чата (каждые 50 сообщений)
async function processChatBuffer(chatId) {
    const buffer = chatAnalysisBuffers[chatId];
    if (!buffer || buffer.length === 0) return;

    const currentProfile = storage.getChatProfile(chatId);
    const updates = await ai.analyzeChatProfile(buffer, currentProfile);

    if (updates) {
        storage.updateChatProfile(chatId, updates);
        console.log(`[CHAT PROFILE] Обновлен профиль чата ${chatId}`);
    }
    chatAnalysisBuffers[chatId] = [];
}

// Инициализация профиля чата (для новых чатов или при пустом профиле)
async function initChatProfile(bot, chatId) {
    try {
        // Пытаемся получить последние 50 сообщений из истории
        // (используем chatHistory если есть, или начинаем с нуля)
        const history = chatHistory[chatId] || [];

        if (history.length >= 10) {
            // Если есть хотя бы 10 сообщений — анализируем
            const messages = history.slice(-50).map(m => ({ name: m.role, text: m.text }));
            const currentProfile = storage.getChatProfile(chatId);
            const updates = await ai.analyzeChatProfile(messages, currentProfile);

            if (updates) {
                storage.updateChatProfile(chatId, updates);
                console.log(`[CHAT PROFILE INIT] Инициализирован профиль чата ${chatId}: "${updates.topic}"`);
            }
        } else {
            console.log(`[CHAT PROFILE INIT] Недостаточно сообщений для анализа чата ${chatId}, ждём накопления`);
        }
    } catch (e) {
        console.error(`[CHAT PROFILE INIT ERROR] ${e.message}`);
    }
}

async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    const isBusinessMessage = Boolean(msg.business_connection_id);

    // === ⛔ ГЛОБАЛЬНЫЙ БАН ===
    if (storage.isBanned(userId) && userId !== config.adminId) {
        return; // Полный игнор
    }
    
    // 1. УМНЫЙ ПОИСК ТОПИКА
    // Если это топик, ID должен быть тут. Если это реплай, иногда ID лежит внутри reply_to_message.
    // [FIX] ЖЕСТКАЯ ПРОВЕРКА: Топик должен быть числом.
    // В обычных группах тут может быть undefined, null или мусор — всё превращаем в null.
    let threadId = msg.is_topic_message ? msg.message_thread_id : (msg.message_thread_id || (msg.reply_to_message ? msg.reply_to_message.message_thread_id : null));
    if (typeof threadId !== 'number') threadId = null;
    
    let text = msg.text || msg.caption || "";

    const cleanText = text.toLowerCase();
    const replyUserId = msg.reply_to_message?.from?.id;
    const isReplyToBot = replyUserId && String(replyUserId) === String(config.botId);
    const hasTriggerWord = config.triggerRegex.test(cleanText); 
    const isDirectlyCalled = hasTriggerWord || isReplyToBot; 

    // === ЕДИНЫЙ КОНТРОЛЛЕР СТАТУСА "ПЕЧАТАЕТ" ===
    let typingTimer = null;
    let safetyTimeout = null; // Предохранитель

    const stopTyping = () => {
        if (typingTimer) {
            clearInterval(typingTimer);
            typingTimer = null;
        }
        if (safetyTimeout) {
            clearTimeout(safetyTimeout);
            safetyTimeout = null;
        }
    };

    const startTyping = () => {
        if (typingTimer) return; // Уже печатает

        const sendAction = () => {
            // Шлем action с учетом треда
            if (threadId) {
                bot.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
            } else {
                bot.sendChatAction(chatId, 'typing').catch(() => {});
            }
        };

        sendAction(); // Шлем первый раз сразу
        typingTimer = setInterval(sendAction, 4000); // Повторяем каждые 4 сек

        // !!! ЗАЩИТА ОТ ВЕЧНОГО ПЕЧАТАНИЯ !!!
        // Если через 60 секунд мы все еще печатаем — вырубаем принудительно.
        safetyTimeout = setTimeout(() => {
            console.log(`[TYPING SAFETY] Принудительная остановка тайпинга в ${chatId}`);
            stopTyping();
        }, 20000);
    };

    const command = text.trim().split(/[\s@]+/)[0].toLowerCase(); 
  
    // Определяем красивое имя чата (Название группы или Имя юзера в личке)
    const chatTitle = msg.chat.title || msg.chat.username || msg.chat.first_name || "Unknown";
    // Запоминаем активность для команды /ban (кроме Админа)
    if (userId !== config.adminId) {
        const senderInfo = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        // Убираем дубли, если юзер уже есть в начале списка
        const existingIndex = recentActiveUsers.findIndex(u => u.id === userId);
        if (existingIndex !== -1) recentActiveUsers.splice(existingIndex, 1);
        
        recentActiveUsers.unshift({
            id: userId,
            name: senderInfo,
            text: text.slice(0, 30), // Сохраняем начало сообщения
            chat: chatTitle
        });
        if (recentActiveUsers.length > 10) recentActiveUsers.pop();
    }
      // === УВЕДОМЛЕНИЕ О НОВОМ ЧАТЕ ===
  // Если чата нет в базе И это не сам админ пишет себе в личку
  if (!storage.hasChat(chatId) && chatId !== config.adminId) {
    let alertText = `🔔 **НОВЫЙ КОНТАКТ!**\n\n📂 **Чат:** ${chatTitle}\n🆔 **ID:** \`${chatId}\`\n`;
    
    const inviter = `@${msg.from.username || "нет"} (${msg.from.first_name})`;

    if (msg.chat.type === 'private') {
        alertText += `👤 **Написал:** ${inviter}\n💬 **Текст:** ${text}`;
    } else {
        // Если добавили в группу
        if (msg.new_chat_members && msg.new_chat_members.some(u => u.id === config.botId)) {
           alertText += `👋 **Меня добавил:** ${inviter}\n👥 **Тип:** Группа/Канал`;
        } else {
           // Просто первое сообщение из новой группы, где я уже был (или админ чистил базу)
           alertText += `👤 **Активация:** ${inviter}\n💬 **Сообщение:** ${text}`;
        }
    }
    
        // Шлем админу тихонько
        bot.sendMessage(config.adminId, alertText, { parse_mode: 'Markdown' }).catch(() => {});
        }

        // Сохраняем в базу, чтобы в файлах было видно
        storage.updateChatName(chatId, chatTitle);

        // === ЛИЧКА: ПЕРЕСЫЛКА АДМИНУ И ОТВОРОТ-ПОВОРОТ ===
    if (!isBusinessMessage && msg.chat.type === 'private' && userId !== config.adminId) {
        // 1. Стучим админу о КАЖДОМ сообщении
        const senderInfo = `@${msg.from.username || "нет"} (${msg.from.first_name})`;
        
        // Формируем отчет: текст или пометка о файле
        let contentReport = text ? `💬 ${text}` : "📎 [Прислал файл или стикер]";
        
        // Шлем тебе
        bot.sendMessage(config.adminId, `📩 ЛС от ${senderInfo}:\n${contentReport}`).catch(e => console.error("Ошибка пересылки ЛС:", e.message));

        // 2. Если это не команда /start — отшиваем вежливо, но с инфой
        if (command !== '/start') {
            bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)).catch(() => {});
            await new Promise(r => setTimeout(r, 1500)); // Пауза для реализма

            const infoText = `В личке я общаюсь только с Админом.**

**Почему так?**
Бот работает на моих API-ключах Google, и я отвечаю за всё, что он генерирует. Поэтому он работает только там, где есть я (в чатах) или в моей личке.

**Где меня потестить?**
Залетай в комментарии к [этому посту](https://t.me/VETA14/13) или любому другому в канале, там я отвечаю всем.
*(Просто напиши там «Сыч» или ответь реплаем на любое мое сообщение)*

**Хочешь себе такого же бота?**
Весь мой код открыт! Ты можешь скачать меня, вставить свои ключи и запустить на своем компе или сервере.
[Скачать с GitHub](https://github.com/Veta-one/sych-bot)

**Инструкция по установке**
Подробный гайд (займет 10 минут) лежит вот тут:
[Читать инструкцию](https://t.me/VETA14/13)`;

            // Отправляем с Markdown.
            // disable_web_page_preview: true — чтобы не забивать чат картинками ссылок
            await bot.sendMessage(chatId, infoText, { parse_mode: 'Markdown', disable_web_page_preview: true });
            
            return; // Дальше не пускаем
        }
    }

  
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    await bot.sendMessage(chatId, "Батя ушел, и я сваливаю.");
    await bot.leaveChat(chatId);
    return;
  }

   // === ОБРАБОТКА ГОЛОСОВЫХ (Voice to Text) ===
   if (msg.voice || msg.audio) {
    startTyping(); 

    try {
        const media = msg.voice || msg.audio;
        const fileId = media.file_id;
        const mimeType = msg.voice ? 'audio/ogg' : (media.mime_type || 'audio/mpeg');
        const link = await bot.getFileLink(fileId);
        const resp = await axios.get(link, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(resp.data);
        const userName = msg.from.first_name || "Анон";

        const transcription = await ai.transcribeAudio(buffer, userName, mimeType);
        
        stopTyping();

        if (transcription) {
            let replyText = "";
            
            // Считаем длины
            const fullLen = transcription.text.length;
            const tldrLen = transcription.summary.length;

            // Логика полезности TLDR:
            // Показываем суть, только если она короче оригинала хотя бы на 15% (умножаем на 0.85).
            // Если TLDR почти такой же длины или длиннее — в нем нет смысла.
            const isTldrUseful = tldrLen < (fullLen * 0.65);

            if (isTldrUseful) {
                replyText = `• <b>Краткая суть:</b>\n${escapeHtml(transcription.summary)}\n\n• <b>Полный текст:</b>\n<blockquote expandable>${escapeHtml(transcription.text)}</blockquote>`;
            } else {
                // Если TLDR бесполезен, просто пишем кто сказал
                replyText = `<b>${escapeHtml(userName)} сказал:</b>\n<blockquote expandable>${escapeHtml(transcription.text)}</blockquote>`;
            }

            // Останавливаем "печатает"
            try { await bot.sendMessage(chatId, replyText, { reply_to_message_id: msg.message_id, parse_mode: 'HTML' }); } catch(e) {}
            
            // !!! ВАЖНО: Если чат в муте — на этом всё. Не отвечаем на содержимое.
            if (storage.isTopicMuted(chatId, threadId)) return;

            // Если не в муте — подменяем текст, чтобы бот мог прокомментировать
            text = transcription.text; 
            msg.text = transcription.text;
        }
    } catch (e) {
        console.error("Ошибка голосового:", e.message);
    }
}

  
    if (!text && !msg.photo && !msg.sticker && !msg.voice && !msg.audio) return;

  if (msg.chat.type === 'private' && !isBusinessMessage) {
    if (userId !== config.adminId) return;
  } else {
    storage.trackUser(chatId, msg.from);
  }

  // === НАБЛЮДАТЕЛЬ ===
  if (!analysisBuffers[chatId]) analysisBuffers[chatId] = [];
  
  // Собираем полную инфу о юзере для лога
  const senderName = msg.from.first_name || "User";
  const senderUsername = msg.from.username ? `@${msg.from.username}` : "";
  const displayName = senderUsername ? `${senderName} (${senderUsername})` : senderName;

  if (!text.startsWith('/')) {
      // Пишем в буфер для анализа профилей юзеров
      analysisBuffers[chatId].push({ userId, name: displayName, text });

      // Пишем в буфер для анализа профиля чата
      if (!chatAnalysisBuffers[chatId]) chatAnalysisBuffers[chatId] = [];
      chatAnalysisBuffers[chatId].push({ name: displayName, text });
  }
  if (analysisBuffers[chatId].length >= BUFFER_SIZE) {
      processBuffer(chatId);
  }
  // Анализ профиля чата каждые 50 сообщений
  if (chatAnalysisBuffers[chatId] && chatAnalysisBuffers[chatId].length >= CHAT_BUFFER_SIZE) {
      processChatBuffer(chatId);
  }

  const isMuted = storage.isTopicMuted(chatId, threadId);

  // === КОМАНДЫ ===
  if (command === '/version') {
    return bot.sendMessage(chatId, `🦉 **Sych Bot**\nВерсия: \`v${config.version}\``, getBaseOptions(threadId));
}

  // === АДМИН-ПАНЕЛЬ (БАНЫ) ===
  if (userId === config.adminId) {
      
    // 1. СПИСОК ЗАБАНЕННЫХ
    if (command === '/banlist') {
        const banned = storage.getBannedList();
        const list = Object.entries(banned).map(([uid, name]) => `⛔ \`${uid}\` — ${name}`).join('\n');
        return bot.sendMessage(chatId, list.length ? `**Черный список:**\n${list}` : "Список пуст.", getBaseOptions(threadId));
    }

    // 2. РАЗБАН
    if (command === '/unban') {
        const targetId = text.split(' ')[1];
        if (!targetId) return bot.sendMessage(chatId, "⚠️ Введи ID: `/unban 123456`", getBaseOptions(threadId));
        
        storage.unbanUser(targetId);
        return bot.sendMessage(chatId, `✅ Юзер \`${targetId}\` разбанен.`, getBaseOptions(threadId));
    }

    // 3. БАН (С интерфейсом)
    if (command === '/ban') {
        const args = text.split(/\s+/);
        const target = args[1]; // Может быть ID или @username

        // Вариант А: Просто /ban (показываем последних активных)
        if (!target) {
            if (recentActiveUsers.length === 0) return bot.sendMessage(chatId, "Список активности пуст.", getBaseOptions(threadId));
            
            const list = recentActiveUsers.map((u, i) => {
                return `${i+1}. **${u.name}**\n🆔 \`${u.id}\`\n💬 "${u.text}..."\n📂 ${u.chat}`;
            }).join('\n\n');
            
            return bot.sendMessage(chatId, `**Последние активные:**\n\n${list}\n\nЧтобы забанить: \`/ban ID\``, getBaseOptions(threadId));
        }

        // Вариант Б: /ban @username или /ban 123456
        let targetId = target;
        let targetName = target;

        // Если ввели username (начинается с @ или буквы)
        if (isNaN(target)) {
           const foundId = storage.findUserIdByUsername(target);
           if (!foundId) return bot.sendMessage(chatId, `❌ Не нашел юзера с ником ${target} в своей базе. Нужен точный ID.`, getBaseOptions(threadId));
           targetId = foundId;
        }

        if (parseInt(targetId) === config.adminId) return bot.sendMessage(chatId, "🤡 Себя банить плохая примета.", getBaseOptions(threadId));

        storage.banUser(targetId, targetName);
        return bot.sendMessage(chatId, `🚫 **BANNED**\nПользователь: ${targetName}\nID: \`${targetId}\`\n\nТеперь я буду его игнорить везде.`, getBaseOptions(threadId));
    }
}

  if (command === '/help' || command === '/start') {
    const helpText = `
*Вот тебе гайд*

**🦉 Вижу и Слышу:**
• Кидай войс — расшифрую текст и напишу краткую суть.
• Кидай фото или видео — пойму, что там, и прокомментирую.
• Кидай PDF, TXT или код — прочитаю и отвечу на вопросы.
• Кидай ссылку на картинку (.jpg, .png, .webp) — скачаю и посмотрю.
• Умею гуглить актуальную инфу (курсы, новости, погода).
• «Сыч напомни завтра в 10» — поставлю напоминание. Можно реплаем на сообщение с датой.

**🎲 Развлекуха:**
• "Сыч кинь монетку" — Орёл/Решка.
• "Сыч число 1-100" — Рандомное число в диапазоне.
• "Сыч кто из нас [вопрос]" — Выберу случайного из чата.

**🕵️ Досье и Память:**
• "Сыч кто я?" — Моё честное мнение о тебе.
• "Сыч расскажи про @юзера" — Выдам досье на участника.
• "Сыч стата" — Статистика токенов за сутки.
• "Сыч, этот чат про [тема]" — Задать тему чата вручную.

**⚙️ Настройки:**
• /mute — Режим тишины (перестану отвечать в этом чате).
• /reset — Сброс памяти (если начал тупить или забыл контекст).
• /version — Узнать текущую версию бота.

_ver: ${config.version}_
        `;
    try { return await bot.sendMessage(chatId, helpText, getBaseOptions(threadId)); } catch (e) {}
}

  if (command === '/mute') {
    const nowMuted = storage.toggleMute(chatId, threadId);
    return bot.sendMessage(chatId, nowMuted ? "🦉 Окей молчу" : "🦉 Я тут", getBaseOptions(threadId));
  }
  if (command === '/reset') {
    chatHistory[chatId] = [];
    analysisBuffers[chatId] = [];
    return bot.sendMessage(chatId, "🦉 Окей, всё забыл, ну было и было", getBaseOptions(threadId));
  }

  if (command === '/restart' && userId === config.adminId) {
    await bot.sendMessage(chatId, "🔄 Перезагружаюсь...", getBaseOptions(threadId));
    exec('pm2 restart sych-bot', (err) => {
        if (err) bot.sendMessage(config.adminId, `❌ Ошибка рестарта: ${err.message}`);
    });
    return;
  }

  // === СТРОГАЯ ПРОВЕРКА МУТА ===
  // Если топик в муте, мы игнорируем ЛЮБОЙ текст (триггеры, реплаи, имя),
  // кроме команд выше (/mute, /reset, /start).
  if (storage.isTopicMuted(chatId, threadId)) {
    return; // Полный игнор
  }

  // === ТЕПЕРЬ, КОГДА МЫ ТОЧНО НЕ В МУТЕ ===
  if (isDirectlyCalled) {
    startTyping(); 
  }

  addToHistory(chatId, senderName, text);

  // === СТАТИСТИКА ===
  if (cleanText === 'сыч стата' || cleanText === 'сыч статистика') {
    const report = ai.getStatsReport();
    return bot.sendMessage(chatId, report, getReplyOptions(msg));
  }

  // === НАПОМИНАЛКИ ===
  if (isDirectlyCalled && (cleanText.includes("напомни") || cleanText.includes("напоминай"))) {
      
    bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)).catch(() => {});
    console.log(`[LOGIC] Обнаружен запрос на напоминание: ${text}`);

    // 1. Вытаскиваем текст сообщения, на которое ответили (если есть)
    const replyContent = msg.reply_to_message 
        ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") 
        : "";

    // 2. Передаем и запрос юзера, и контекст реплая
    const parsed = await ai.parseReminder(text, replyContent);
    
    if (parsed && parsed.targetTime) {
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        
        storage.addReminder(chatId, userId, username, parsed.targetTime, parsed.reminderText);
        
        console.log(`[REMINDER SET] Установлено на: ${parsed.targetTime}`);
        return bot.sendMessage(chatId, parsed.confirmation, getReplyOptions(msg));
    } else {
        console.log(`[REMINDER ERROR] AI не смог распарсить время.`);
    }
}


  // === ФИЧИ ===
  if (hasTriggerWord) {
      // Команда "Сыч, этот чат про..." — используем оригинальный текст (не lowercase)
      const chatTopicMatch = text.match(/(?:этот чат про|чат про|мы тут|здесь мы)\s+([\s\S]+)/i);
      if (chatTopicMatch) {
          const description = chatTopicMatch[1].trim();
          if (description.length > 10) {
              startTyping();
              const currentProfile = storage.getChatProfile(chatId);
              const updates = await ai.processManualChatDescription(description, currentProfile);
              stopTyping();

              if (updates && updates.topic) {
                  storage.updateChatProfile(chatId, updates);
                  const factsInfo = updates.facts ? `\n📝 Факты: ${updates.facts.substring(0, 100)}${updates.facts.length > 100 ? '...' : ''}` : '';
                  try { return await bot.sendMessage(chatId, `Понял, запомнил.\n🎯 Тема: ${updates.topic}${factsInfo}`, getReplyOptions(msg)); } catch(e){}
              } else {
                  // Fallback если AI не ответил
                  storage.setChatTopic(chatId, description.substring(0, 200));
                  try { return await bot.sendMessage(chatId, `Понял, запомнил. Тема: "${description.substring(0, 100)}..."`, getReplyOptions(msg)); } catch(e){}
              }
          }
      }

      const aboutMatch = cleanText.match(/(?:расскажи про|кто так(?:ой|ая)|мнение о|поясни за)\s+(.+)/);
      if (aboutMatch) {
        const targetName = aboutMatch[1].replace('?', '').trim();
        const targetProfile = storage.findProfileByQuery(chatId, targetName);
        if (targetProfile) {
            startTyping();
            const description = await ai.generateProfileDescription(targetProfile, targetName);
            stopTyping();
            try { return await bot.sendMessage(chatId, description, getReplyOptions(msg)); } catch(e){}
        }
    }
      
      if (cleanText.match(/(монетк|кинь|брось|подбрось|подкинь)/)) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const result = Math.random() > 0.5 ? "ОРЁЛ" : "РЕШКА";
          const flavor = await ai.generateFlavorText("подбросить монетку", result);
          try { return await bot.sendMessage(chatId, flavor, getReplyOptions(msg)); } catch(e){}
      }

      const rangeMatch = cleanText.match(/(\d+)-(\d+)/);
      if ((cleanText.includes("число") || cleanText.includes("рандом")) && rangeMatch) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const min = parseInt(rangeMatch[1]);
          const max = parseInt(rangeMatch[2]);
          const rand = Math.floor(Math.random() * (max - min + 1)) + min;
          const flavor = await ai.generateFlavorText(`выбрать число ${min}-${max}`, String(rand));
          try { return await bot.sendMessage(chatId, flavor, getReplyOptions(msg)); } catch(e){}
      }
      
      const isWhoGame = cleanText.match(/(?:кто|кого)\s+(?:из нас|тут|здесь|в чате|сегодня)/) || cleanText.match(/сыч\W+кто\??$/) || cleanText.trim() === "сыч кто";
      if (isWhoGame) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const randomUser = storage.getRandomUser(chatId);
          if (!randomUser) return bot.sendMessage(chatId, "Никого не знаю пока.", getBaseOptions(threadId));
          const flavor = await ai.generateFlavorText(`выбрать случайного человека из чата на вопрос "${text}"`, randomUser);
          try { return await bot.sendMessage(chatId, flavor, getReplyOptions(msg)); } catch(e){}
      }
  }

  // === РЕШЕНИЕ ОБ ОТВЕТЕ ===
  // Бот отвечает ТОЛЬКО когда его явно вызвали (тег "сыч/sych") или ответили на его сообщение
  const shouldAnswer = isDirectlyCalled;

  // === ЛОГИКА РЕАКЦИЙ (15%) ===
  if (!shouldAnswer && text.length > 10 && !isReplyToBot && Math.random() < 0.015) {
      
    // Берем контекст (последние 10 сообщений), чтобы реакция была в тему
    const historyBlock = chatHistory[chatId].slice(-15).map(m => `${m.role}: ${m.text}`).join('\n');
    
    // Передаем истории вместе с текущим текстом
    ai.determineReaction(historyBlock + `\nСообщение для реакции: ${text}`).then(async (emoji) => {
        if (emoji) {
            try { await bot.setMessageReaction(chatId, msg.message_id, { reaction: [{ type: 'emoji', emoji: emoji }] }); } catch (e) {}
        }
    });
}

  // === ОТПРАВКА ОТВЕТА ===
  if (shouldAnswer) {
    startTyping();

    let imageBuffer = null;
    let mimeType = "image/jpeg"; // По умолчанию для фото

    // === ОБРАБОТКА МЕДИА (ФОТО, ВИДЕО, ДОКИ, СТИКЕРЫ) ===
    
    // 1. СТИКЕР
    if (msg.sticker) {
        const stickerEmoji = msg.sticker.emoji || "";
        if (stickerEmoji) text += ` [Отправлен стикер: ${stickerEmoji}]`;

        if (!msg.sticker.is_animated && !msg.sticker.is_video) {
            try {
                const link = await bot.getFileLink(msg.sticker.file_id);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                mimeType = "image/webp";
            } catch (e) { console.error("Ошибка стикера:", e.message); }
        }
    }

    // 2. ФОТО (обычное или реплай)
    else if (msg.photo || (msg.reply_to_message && msg.reply_to_message.photo)) {
       try {
         const photoObj = msg.photo ? msg.photo[msg.photo.length-1] : msg.reply_to_message.photo[msg.reply_to_message.photo.length-1];
         const link = await bot.getFileLink(photoObj.file_id);
         const resp = await axios.get(link, { responseType: 'arraybuffer' });
         imageBuffer = Buffer.from(resp.data);
         mimeType = "image/jpeg";
         console.log(`[MEDIA] Фото скачано`);
       } catch(e) { console.error("Ошибка фото:", e.message); }
    }

    // 3. ВИДЕО
    else if (msg.video || (msg.reply_to_message && msg.reply_to_message.video)) {
        const vid = msg.video || msg.reply_to_message.video;
        // Лимит 20 МБ (Telegram API limit for getFile)
        if (vid.file_size > 20 * 1024 * 1024) {
            return bot.sendMessage(chatId, "🐢 Братан, видос жирный пиздец (больше 20мб). Я не грузчик, таскать такое. Сожми или обрежь.", getReplyOptions(msg));
        }
        try {
            await bot.sendChatAction(chatId, 'upload_video', getActionOptions(threadId));
            const link = await bot.getFileLink(vid.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = vid.mime_type || "video/mp4";
            console.log(`[MEDIA] Видео скачано (${mimeType})`);
        } catch(e) { console.error("Ошибка видео:", e.message); }
    }

    // 4. ДОКУМЕНТЫ (PDF, TXT, CSV...)
    else if (msg.document || (msg.reply_to_message && msg.reply_to_message.document)) {
        const doc = msg.document || msg.reply_to_message.document;
        
        // Список того, что Gemini точно ест
        const allowedMimes = [
            'application/pdf', 'application/x-javascript', 'text/javascript', 
            'application/x-python', 'text/x-python', 'text/plain', 'text/html', 
            'text/css', 'text/md', 'text/csv', 'text/xml', 'text/rtf'
        ];

        if (doc.file_size > 20 * 1024 * 1024) {
            return bot.sendMessage(chatId, "🐘 Не, файл тяжелый (больше 20мб). Я пас.", getReplyOptions(msg));
        }

        if (!allowedMimes.includes(doc.mime_type) && !doc.mime_type.startsWith('image/')) {
             // Если формат странный, но юзер прямо просит - можно попробовать рискнуть, но лучше предупредить
             return bot.sendMessage(chatId, "🗿 Эт че за формат? Я такое не читаю. Давай PDF или текст.", getReplyOptions(msg));
        }

        try {
            await bot.sendChatAction(chatId, 'upload_document', getActionOptions(threadId));
            const link = await bot.getFileLink(doc.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = doc.mime_type;
            console.log(`[MEDIA] Док скачан (${mimeType})`);
        } catch(e) { console.error("Ошибка дока:", e.message); }
    }

    // 5. ССЫЛКА (если ничего другого нет)
    // 5. ССЫЛКА (ищем в текущем тексте ИЛИ в реплае)
    else if (!imageBuffer) {
        // Сначала ищем в том, что ты написал
        let urlMatch = text.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif|bmp)/i);
        
        // Если нет, и это реплай — ищем в сообщении, на которое ответили
        if (!urlMatch && msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) {
             const replyText = msg.reply_to_message.text || msg.reply_to_message.caption;
             urlMatch = replyText.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif|bmp)/i);
        }

        if (urlMatch) {
            try {
                const resp = await axios.get(urlMatch[0], { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                if (urlMatch[0].endsWith('.webp')) mimeType = "image/webp";
                else mimeType = "image/jpeg"; 
                console.log(`[MEDIA] Картинка по ссылке скачана`);
            } catch(e) {}
        }
    }
    const instruction = msg.from.username ? storage.getUserInstruction(msg.from.username) : "";
    const userProfile = storage.getProfile(chatId, userId);

    // === ЛОГИКА ССЫЛОК ===
    let targetLink = null;
    
    // Ищем ссылку
    const linkRegex = /https?:\/\/[^\s]+/;
    const linkInText = text.match(linkRegex);
    
    if (linkInText) {
        targetLink = linkInText[0];
    } else if (msg.reply_to_message) {
        if (msg.reply_to_message.text) {
             const linkInReply = msg.reply_to_message.text.match(linkRegex);
             if (linkInReply) targetLink = linkInReply[0];
        } else if (msg.reply_to_message.caption) {
             const linkInCaption = msg.reply_to_message.caption.match(linkRegex);
             if (linkInCaption) targetLink = linkInCaption[0];
        }
    }

    let aiResponse = "";

    // Получаем профиль чата для контекста
    let chatProfile = storage.getChatProfile(chatId);

    // Если профиль чата пустой и есть достаточно истории — пробуем инициализировать
    if (!chatProfile.topic && chatHistory[chatId] && chatHistory[chatId].length >= 10) {
        console.log(`[CHAT PROFILE] Профиль пуст, запускаю инициализацию для ${chatId}`);
        initChatProfile(bot, chatId); // Асинхронно, не блокируем ответ
    }

    try {
    // Вытаскиваем текст реплая для контекста
    const replyText = msg.reply_to_message ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") : "";

    aiResponse = await ai.getResponse(
        chatHistory[chatId],
        { sender: senderName, text: text, replyText: replyText },
        imageBuffer,
        mimeType,
        instruction,
        userProfile,
        !isDirectlyCalled,
        chatProfile // <--- Передаём профиль чата
    );

    console.log(`[DEBUG] 2. Ответ от AI получен! Длина: ${aiResponse ? aiResponse.length : "PUSTO"}`);
    
    if (!aiResponse) {
        console.log(`[DEBUG] 🚨 ОШИБКА: AI вернул пустоту!`);
        bot.sendMessage(config.adminId, `⚠️ **ALARM:** Gemini вернула пустую строку!\n📂 **Чат:** ${chatTitle}`, { parse_mode: 'Markdown' }).catch(() => {});
        aiResponse = getSychErrorReply("503 overloaded");

    }
    
    } catch (err) {
        console.error("[CRITICAL AI ERROR]:", err.message);
        
        // 1. ШЛЕМ ТЕХНИЧЕСКИЙ РЕПОРТ АДМИНУ (В личку)
        const errorMsg = `🔥 **Gemini упала!**\n\nЧат: ${chatTitle}\nОшибка: \`${err.message}\``;
        bot.sendMessage(config.adminId, errorMsg, { parse_mode: 'Markdown' }).catch(() => {});

        // 2. ГЕНЕРИРУЕМ СМЕШНОЙ ОТВЕТ ДЛЯ ЧАТА
        // Передаем текст ошибки в нашу новую функцию
        aiResponse = getSychErrorReply(err.message);
    }

    
    // === ФОРМАТИРОВАНИЕ И ОТПРАВКА ===
    
    // Создаем копию текста для обработки
    let formattedResponse = aiResponse;

    try {
        // --- 1. ФОРМАТИРОВАНИЕ ---
        
        // Заголовки (### Текст -> *ТЕКСТ*)
        formattedResponse = formattedResponse.replace(/^#{1,6}\s+(.*?)$/gm, (match, title) => {
            return `\n*${title.toUpperCase()}*`;
        });

        // Жирный шрифт (**текст** -> *текст*)
        formattedResponse = formattedResponse.replace(/\*\*([\s\S]+?)\*\*/g, '*$1*');
        formattedResponse = formattedResponse.replace(/__([\s\S]+?)__/g, '*$1*');

        // Списки (* пункт -> • пункт)
        formattedResponse = formattedResponse.replace(/^(\s*)[\*\-]\s+/gm, '$1• ');

        // Убираем лишние переносы
        formattedResponse = formattedResponse.replace(/\n{3,}/g, '\n\n');

    } catch (fmtErr) {
        console.error("[FORMAT ERROR] Ошибка форматирования, шлю сырой текст:", fmtErr.message);
        formattedResponse = aiResponse; // Если формат сломался, шлем оригинал
    }


    try {
        // --- 2. ОТПРАВКА ---

        // Защита от спама (обрезаем, если больше 8500)
        if (formattedResponse.length > 8500) {
            formattedResponse = formattedResponse.substring(0, 8500) + "\n\n...[обсуждение слишком длинное, я устал]...";
        }

        // Разбиваем на куски по 4000 символов
        let chunks = formattedResponse.match(/[\s\S]{1,4000}/g) || [];

        // !!! ГЛАВНОЕ ИСПРАВЛЕНИЕ !!!
        // Если match вернул пустоту (глюк), но текст ЕСТЬ — создаем кусок вручную
        if (chunks.length === 0 && formattedResponse.length > 0) {
            console.log("[DEBUG] Регулярка вернула 0 кусков! Форсирую отправку.");
            chunks = [formattedResponse];
        }
        
        for (const chunk of chunks) {
            try {
                await bot.sendMessage(chatId, chunk, getReplyOptions(msg));
            } catch (sendError) {
                if (!isTelegramEntityParseError(sendError)) throw sendError;
                console.log(`[SEND FALLBACK] Markdown parse failed in chat=${chatId}, sending plain text.`);
                await bot.sendMessage(chatId, chunk, withoutParseMode(getReplyOptions(msg)));
            }
        }

        stopTyping(); // <-- Всё, сообщение ушло, выключаем статус
        
        addToHistory(chatId, "Сыч", aiResponse);

    } catch (error) {
        stopTyping(); // <-- Если ошибка, ОБЯЗАТЕЛЬНО выключаем
        console.error(`[SEND ERROR]: ${error.message}`);

        if (isBusinessMessage && /BUSINESS[_ ]?PEER[_ ]?INVALID|BUSINESSPEERINVALID/i.test(error.message)) {
            console.log(`[BUSINESS SEND] Telegram отклонил отправку в chat=${chatId}. Обычно это значит, что peer недоступен для business-ответа или нет входящего окна 24ч.`);
            bot.sendMessage(config.adminId, `⚠️ Business отправка отклонена Telegram\n\nЧат: ${chatTitle}\nID: ${chatId}\nОшибка: ${error.message}`, { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        if (!isTelegramEntityParseError(error)) {
            // Отчет админу
            bot.sendMessage(config.adminId, `⚠️ **Ошибка отправки:** ${error.message}\n📂 **Чат:** ${chatTitle}\n🆔 **ID:** ${chatId}`, { parse_mode: 'Markdown' }).catch(() => {});
        }

        // АВАРИЙНАЯ ОТПРАВКА (Если Markdown сломался или что-то еще)
        // Шлем чистый текст без всякого форматирования
        try { 
             const rawChunks = aiResponse.match(/[\s\S]{1,4000}/g) || [aiResponse];
             for (const chunk of rawChunks) {
                await bot.sendMessage(chatId, chunk, { reply_to_message_id: msg.message_id });
             }
             addToHistory(chatId, "Сыч", aiResponse);
        } catch (e2) { console.error("FATAL SEND ERROR (Даже аварийная не ушла):", e2.message); }
    }

    // Рефлекс (Анализ стиля общения и репутации)
    const contextForAnalysis = chatHistory[chatId].slice(-5).map(m => `${m.role}: ${m.text}`).join('\n');
    
    // Запускаем анализ
    ai.analyzeUserImmediate(contextForAnalysis, userProfile).then(updated => {
        if (updated) {
            // ЛОГИРУЕМ ИЗМЕНЕНИЯ
            if (updated.relationship) {
                console.log(`[RELATIONSHIP] ${senderName}: Новая репутация = ${updated.relationship}/100`);
            }
            
            const updates = {}; updates[userId] = updated;
            storage.bulkUpdateProfiles(chatId, updates);
        } else {
            console.log(`[RELATIONSHIP] Не удалось обновить профиль (AI вернул null)`);
        }
    }).catch(err => console.error("[RELATIONSHIP ERROR]", err));
  }
}

module.exports = { processMessage };
