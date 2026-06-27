const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
const { sendRich, escapeHtml, normalizeMd } = require('../utils/rich');
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
  const entry = { role: sender, text: text };
  chatHistory[chatId].push(entry);
  if (chatHistory[chatId].length > config.contextSize) {
    chatHistory[chatId].shift();
  }
  return entry; // возвращаем запись, чтобы её можно было дообогатить (напр. описанием картинки)
}

function replyOpts(msg, threadId) {
    return { replyTo: msg.message_id, threadId: threadId || null, businessId: msg.business_connection_id || null };
}

function baseOpts(msg, threadId) {
    return { threadId: threadId || null, businessId: (msg && msg.business_connection_id) || null };
}

function getActionOptions(threadId) {
    // [FIX] Если топика нет, возвращаем undefined.
    // Это важно: библиотека node-telegram-bot-api не любит пустой объект {} в обычных группах.
    if (!threadId) return undefined;
    return { message_thread_id: threadId };
}

// escapeHtml импортируется из ../utils/rich (фоллбэк/парсинг разметки теперь внутри sendRich)

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
    let alertText = `<h4>🔔 Новый контакт</h4><p>📂 Чат: <b>${escapeHtml(chatTitle)}</b><br/>🆔 <code>${chatId}</code></p>`;
    
    const inviter = `@${escapeHtml(msg.from.username || "нет")} (${escapeHtml(msg.from.first_name || "")})`;

    if (msg.chat.type === 'private') {
        alertText += `<p>👤 Написал: ${inviter}</p><blockquote>${escapeHtml(text)}</blockquote>`;
    } else {
        // Если добавили в группу
        if (msg.new_chat_members && msg.new_chat_members.some(u => u.id === config.botId)) {
           alertText += `<p>👋 Меня добавил: ${inviter}<br/>👥 Тип: Группа/Канал</p>`;
        } else {
           // Просто первое сообщение из новой группы, где я уже был (или админ чистил базу)
           alertText += `<p>👤 Активация: ${inviter}</p><blockquote>${escapeHtml(text)}</blockquote>`;
        }
    }
    
        // Шлем админу тихонько
        sendRich(bot, config.adminId, { html: alertText }).catch(() => {});
        }

        // Сохраняем в базу, чтобы в файлах было видно
        storage.updateChatName(chatId, chatTitle);

        // === ЛИЧКА: ПЕРЕСЫЛКА АДМИНУ И ОТВОРОТ-ПОВОРОТ ===
    if (!isBusinessMessage && msg.chat.type === 'private' && userId !== config.adminId) {
        // 1. Стучим админу о КАЖДОМ сообщении
        const senderInfo = `@${escapeHtml(msg.from.username || "нет")} (${escapeHtml(msg.from.first_name || "")})`;

        // Формируем отчет: текст или пометка о файле
        let contentReport = text ? `<blockquote>${escapeHtml(text)}</blockquote>` : "<p>📎 [Прислал файл или стикер]</p>";

        // Шлем тебе
        sendRich(bot, config.adminId, { html: `<p>📩 <b>ЛС от ${senderInfo}</b></p>${contentReport}` }).catch(e => console.error("Ошибка пересылки ЛС:", e.message));

        // 2. Если это не команда /start — отшиваем вежливо, но с инфой
        if (command !== '/start') {
            bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)).catch(() => {});
            await new Promise(r => setTimeout(r, 1500)); // Пауза для реализма

            const infoText = `<p>В личке я общаюсь только с Админом.</p>
<b>Почему так?</b>
<p>Бот работает на моих API-ключах Google, и я отвечаю за всё, что он генерирует. Поэтому он работает только там, где есть я (в чатах) или в моей личке.</p>
<b>Где меня потестить?</b>
<p>Залетай в комментарии к <a href="https://t.me/VETA14/13">этому посту</a> или любому другому в канале — там я отвечаю всем.<br/><i>(Просто напиши «Сыч» или ответь реплаем на любое моё сообщение)</i></p>
<b>Хочешь себе такого же бота?</b>
<p>Весь мой код открыт! Скачай, вставь свои ключи и запусти у себя: <a href="https://github.com/Veta-one/sych-bot">GitHub</a></p>
<b>Инструкция по установке</b>
<p>Подробный гайд (10 минут): <a href="https://t.me/VETA14/13">читать</a></p>`;

            await sendRich(bot, chatId, { html: infoText }, baseOpts(msg, threadId));
            
            return; // Дальше не пускаем
        }
    }

  
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    await sendRich(bot, chatId, { markdown: "Батя ушел, и я сваливаю." });
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

            // Длительность голосового (0:47), если доступна
            const durSec = media.duration;
            const durStr = (typeof durSec === 'number' && durSec > 0)
                ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}`
                : '';
            const durTag = durStr ? ` · <code>${durStr}</code>` : '';
            const safeName = escapeHtml(userName);

            if (isTldrUseful) {
                // Карточка: шапка (имя + длительность) + суть + кат «Расшифровка»
                replyText = `<p>🎙 <b>Голосовое</b> · ${safeName}${durTag}</p>`
                    + `<p><b>Суть:</b> ${escapeHtml(transcription.summary)}</p>`
                    + `<details><summary>Расшифровка</summary><blockquote>${escapeHtml(transcription.text)}</blockquote></details>`;
            } else {
                // Короткое голосовое: имя + длительность + цитата (без TL;DR)
                replyText = `<p>🎙 <b>${safeName}</b>${durTag}</p><blockquote>${escapeHtml(transcription.text)}</blockquote>`;
            }

            // Останавливаем "печатает"
            try { await sendRich(bot, chatId, { html: replyText }, replyOpts(msg, threadId)); } catch(e) {}
            
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
    return sendRich(bot, chatId, { html: `<h4>🦉 Sych Bot</h4><p>Версия: <code>v${config.version}</code></p>` }, baseOpts(msg, threadId));
}

  // === АДМИН-ПАНЕЛЬ (БАНЫ) ===
  if (userId === config.adminId) {
      
    // 1. СПИСОК ЗАБАНЕННЫХ
    if (command === '/banlist') {
        const banned = storage.getBannedList();
        const items = Object.entries(banned).map(([uid, name]) => `<li><code>${uid}</code> — ${escapeHtml(String(name))}</li>`).join('');
        const html = items.length ? `<h4>⛔ Чёрный список</h4><ul>${items}</ul>` : "<p>Список пуст.</p>";
        return sendRich(bot, chatId, { html }, baseOpts(msg, threadId));
    }

    // 2. РАЗБАН
    if (command === '/unban') {
        const targetId = text.split(' ')[1];
        if (!targetId) return sendRich(bot, chatId, { html: "⚠️ Введи ID: <code>/unban 123456</code>" }, baseOpts(msg, threadId));
        
        storage.unbanUser(targetId);
        return sendRich(bot, chatId, { html: `✅ Юзер <code>${escapeHtml(targetId)}</code> разбанен.` }, baseOpts(msg, threadId));
    }

    // 3. БАН (С интерфейсом)
    if (command === '/ban') {
        const args = text.split(/\s+/);
        const target = args[1]; // Может быть ID или @username

        // Вариант А: Просто /ban (показываем последних активных)
        if (!target) {
            if (recentActiveUsers.length === 0) return sendRich(bot, chatId, { markdown: "Список активности пуст." }, baseOpts(msg, threadId));

            const list = recentActiveUsers.map((u) => {
                return `<li><b>${escapeHtml(u.name)}</b> — <code>${u.id}</code><br/>💬 "${escapeHtml(u.text)}..."<br/>📂 ${escapeHtml(String(u.chat))}</li>`;
            }).join('');

            return sendRich(bot, chatId, { html: `<h4>Последние активные</h4><ol>${list}</ol><p>Забанить: <code>/ban ID</code></p>` }, baseOpts(msg, threadId));
        }

        // Вариант Б: /ban @username или /ban 123456
        let targetId = target;
        let targetName = target;

        // Если ввели username (начинается с @ или буквы)
        if (isNaN(target)) {
           const foundId = storage.findUserIdByUsername(target);
           if (!foundId) return sendRich(bot, chatId, { html: `❌ Не нашёл юзера с ником ${escapeHtml(target)} в базе. Нужен точный ID.` }, baseOpts(msg, threadId));
           targetId = foundId;
        }

        if (parseInt(targetId) === config.adminId) return sendRich(bot, chatId, { markdown: "🤡 Себя банить плохая примета." }, baseOpts(msg, threadId));

        storage.banUser(targetId, targetName);
        return sendRich(bot, chatId, { html: `<h4>🚫 BANNED</h4><p>Пользователь: <b>${escapeHtml(String(targetName))}</b><br/>ID: <code>${escapeHtml(String(targetId))}</code></p><p>Теперь игнорю его везде.</p>` }, baseOpts(msg, threadId));
    }
}

  if (command === '/help' || command === '/start') {
    const helpText = `<h3>🦉 Что я умею</h3>
<b>Вижу и слышу</b>
<ul>
<li>Кидай <b>войс</b> — расшифрую и сделаю краткую суть</li>
<li>Кидай <b>фото/видео</b> — пойму, что там, прокомментирую и запомню для вопросов потом</li>
<li>Кидай <b>PDF/TXT/код</b> — прочитаю и отвечу на вопросы</li>
<li>Кидай ссылку на картинку — скачаю и посмотрю</li>
<li>Гуглю актуальное: курсы, новости, погода</li>
<li>«Сыч напомни завтра в 10» — поставлю напоминание (можно реплаем)</li>
</ul>
<details><summary>🎲 Развлекуха</summary>
<ul>
<li>«Сыч кинь монетку» — орёл/решка</li>
<li>«Сыч число 1-100» — рандом в диапазоне</li>
<li>«Сыч кто из нас [вопрос]» — выберу случайного</li>
</ul>
</details>
<details><summary>🕵️ Досье и память</summary>
<ul>
<li>«Сыч кто я?» — моё честное мнение о тебе</li>
<li>«Сыч расскажи про @юзера» — досье на участника</li>
<li>«Сыч стата» — статистика токенов</li>
<li>«Сыч, этот чат про [тема]» — задать тему чата</li>
</ul>
</details>
<details><summary>⚙️ Настройки</summary>
<ul>
<li><code>/mute</code> — режим тишины</li>
<li><code>/reset</code> — сброс памяти</li>
<li><code>/version</code> — версия бота</li>
</ul>
</details>
<blockquote>ver: ${config.version}</blockquote>`;
    try { return await sendRich(bot, chatId, { html: helpText }, baseOpts(msg, threadId)); } catch (e) {}
}

  if (command === '/mute') {
    const nowMuted = storage.toggleMute(chatId, threadId);
    return sendRich(bot, chatId, { markdown: nowMuted ? "🦉 Окей молчу" : "🦉 Я тут" }, baseOpts(msg, threadId));
  }
  if (command === '/reset') {
    chatHistory[chatId] = [];
    analysisBuffers[chatId] = [];
    return sendRich(bot, chatId, { markdown: "🦉 Окей, всё забыл, ну было и было" }, baseOpts(msg, threadId));
  }

  if (command === '/restart' && userId === config.adminId) {
    await sendRich(bot, chatId, { markdown: "🔄 Перезагружаюсь..." }, baseOpts(msg, threadId));
    exec('pm2 restart sych-bot', (err) => {
        if (err) sendRich(bot, config.adminId, { html: `❌ Ошибка рестарта: <code>${escapeHtml(err.message)}</code>` });
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

  const currentMsgEntry = addToHistory(chatId, senderName, text);

  // === СТАТИСТИКА ===
  if (cleanText === 'сыч стата' || cleanText === 'сыч статистика') {
    const report = ai.getStatsReport();
    return sendRich(bot, chatId, { markdown: report }, replyOpts(msg, threadId));
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
        return sendRich(bot, chatId, { markdown: parsed.confirmation }, replyOpts(msg, threadId));
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
                  const factsInfo = updates.facts ? `<br/>📝 Факты: ${escapeHtml(updates.facts.substring(0, 100))}${updates.facts.length > 100 ? '...' : ''}` : '';
                  try { return await sendRich(bot, chatId, { html: `<p>Понял, запомнил.<br/>🎯 <b>Тема:</b> ${escapeHtml(updates.topic)}${factsInfo}</p>` }, replyOpts(msg, threadId)); } catch(e){}
              } else {
                  // Fallback если AI не ответил
                  storage.setChatTopic(chatId, description.substring(0, 200));
                  try { return await sendRich(bot, chatId, { html: `<p>Понял, запомнил. Тема: "${escapeHtml(description.substring(0, 100))}..."</p>` }, replyOpts(msg, threadId)); } catch(e){}
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
            try { return await sendRich(bot, chatId, { markdown: normalizeMd(description) }, replyOpts(msg, threadId)); } catch(e){}
        }
    }
      
      if (cleanText.match(/(монетк|кинь|брось|подбрось|подкинь)/)) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const result = Math.random() > 0.5 ? "ОРЁЛ" : "РЕШКА";
          const flavor = await ai.generateFlavorText("подбросить монетку", result);
          try { return await sendRich(bot, chatId, { markdown: flavor }, replyOpts(msg, threadId)); } catch(e){}
      }

      const rangeMatch = cleanText.match(/(\d+)-(\d+)/);
      if ((cleanText.includes("число") || cleanText.includes("рандом")) && rangeMatch) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const min = parseInt(rangeMatch[1]);
          const max = parseInt(rangeMatch[2]);
          const rand = Math.floor(Math.random() * (max - min + 1)) + min;
          const flavor = await ai.generateFlavorText(`выбрать число ${min}-${max}`, String(rand));
          try { return await sendRich(bot, chatId, { markdown: flavor }, replyOpts(msg, threadId)); } catch(e){}
      }
      
      const isWhoGame = cleanText.match(/(?:кто|кого)\s+(?:из нас|тут|здесь|в чате|сегодня)/) || cleanText.match(/сыч\W+кто\??$/) || cleanText.trim() === "сыч кто";
      if (isWhoGame) {
          try { await bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)); } catch(e){}
          const randomUser = storage.getRandomUser(chatId);
          if (!randomUser) return sendRich(bot, chatId, { markdown: "Никого не знаю пока." }, baseOpts(msg, threadId));
          const flavor = await ai.generateFlavorText(`выбрать случайного человека из чата на вопрос "${text}"`, randomUser);
          try { return await sendRich(bot, chatId, { markdown: flavor }, replyOpts(msg, threadId)); } catch(e){}
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
            return sendRich(bot, chatId, { markdown: "🐢 Братан, видос жирный пиздец (больше 20мб). Я не грузчик, таскать такое. Сожми или обрежь." }, replyOpts(msg, threadId));
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
            return sendRich(bot, chatId, { markdown: "🐘 Не, файл тяжелый (больше 20мб). Я пас." }, replyOpts(msg, threadId));
        }

        if (!allowedMimes.includes(doc.mime_type) && !doc.mime_type.startsWith('image/')) {
             // Если формат странный, но юзер прямо просит - можно попробовать рискнуть, но лучше предупредить
             return sendRich(bot, chatId, { markdown: "🗿 Эт че за формат? Я такое не читаю. Давай PDF или текст." }, replyOpts(msg, threadId));
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
        sendRich(bot, config.adminId, { html: `<p>⚠️ <b>ALARM:</b> Gemini вернула пустую строку!</p><p>📂 Чат: <b>${escapeHtml(chatTitle)}</b></p>` }).catch(() => {});
        aiResponse = getSychErrorReply("503 overloaded");

    }
    
    } catch (err) {
        console.error("[CRITICAL AI ERROR]:", err.message);
        
        // 1. ШЛЕМ ТЕХНИЧЕСКИЙ РЕПОРТ АДМИНУ (В личку)
        sendRich(bot, config.adminId, { html: `<h4>🔥 Gemini упала!</h4><p>Чат: <b>${escapeHtml(chatTitle)}</b></p><pre><code>${escapeHtml(err.message)}</code></pre>` }).catch(() => {});

        // 2. ГЕНЕРИРУЕМ СМЕШНОЙ ОТВЕТ ДЛЯ ЧАТА
        // Передаем текст ошибки в нашу новую функцию
        aiResponse = getSychErrorReply(err.message);
    }

    
    // === ОТПРАВКА (rich markdown + авто-фоллбэк) ===
    // Раньше тут "упрощали" разметку под legacy Markdown. Теперь наоборот — отдаём
    // богатый Markdown как есть, Telegram сам красиво его рисует (sendRichMessage).
    let formattedResponse = aiResponse;


    try {
        // Защита от спама. Telegram rich (sendRichMessage) держит ~32768 символов —
        // режем по 30000, оставляя запас под маркер ниже. Раньше тут стояло 16000.
        if (formattedResponse.length > 30000) {
            formattedResponse = formattedResponse.substring(0, 30000) + "\n\n...[обсуждение слишком длинное, я устал]...";
        }

        // Шлём markdown ИИ напрямую — Telegram rich рисует его красивее (в т.ч. таблицы).
        // normalizeMd чинит пустую строку перед таблицей; sendRich сам ретраит без картинок
        // при битом медиа и падает в plain при ошибке парсинга.
        await sendRich(bot, chatId, { markdown: normalizeMd(formattedResponse) }, replyOpts(msg, threadId));

        stopTyping(); // <-- Всё, сообщение ушло, выключаем статус
        addToHistory(chatId, "Сыч", aiResponse);

    } catch (error) {
        stopTyping(); // <-- Если ошибка, ОБЯЗАТЕЛЬНО выключаем
        console.error(`[SEND ERROR]: ${error.message}`);

        if (isBusinessMessage && /BUSINESS[_ ]?PEER[_ ]?INVALID|BUSINESSPEERINVALID/i.test(error.message)) {
            console.log(`[BUSINESS SEND] Telegram отклонил отправку в chat=${chatId}. Обычно это значит, что peer недоступен для business-ответа или нет входящего окна 24ч.`);
            sendRich(bot, config.adminId, { html: `<p>⚠️ <b>Business отправка отклонена Telegram</b></p><p>Чат: <b>${escapeHtml(chatTitle)}</b><br/>ID: <code>${chatId}</code></p><pre><code>${escapeHtml(error.message)}</code></pre>` }).catch(() => {});
            return;
        }

        // Отчет админу
        sendRich(bot, config.adminId, { html: `<p>⚠️ <b>Ошибка отправки:</b></p><pre><code>${escapeHtml(error.message)}</code></pre><p>📂 Чат: <b>${escapeHtml(chatTitle)}</b> · 🆔 <code>${chatId}</code></p>` }).catch(() => {});

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

    // === ПАМЯТЬ О КАРТИНКЕ (variant B) ===
    // Если бот реально посмотрел на изображение — асинхронно получаем его фактическое
    // описание дешёвой нативной моделью и вшиваем прямо в запись истории этого сообщения.
    // Так по картинке можно спрашивать дальше (пока она в окне контекста), не отправляя
    // её в нейронку повторно. Точечный пересмотр пикселей — по реплаю на саму картинку.
    if (imageBuffer && typeof mimeType === 'string' && mimeType.startsWith('image/') && currentMsgEntry) {
        ai.describeImage(imageBuffer, mimeType).then(desc => {
            if (desc) {
                currentMsgEntry.text = `${currentMsgEntry.text ? currentMsgEntry.text + ' ' : ''}[🖼 на картинке: ${desc}]`;
                const preview = desc.slice(0, 200).replace(/\s+/g, ' ').trim();
                console.log(`[IMG MEMORY] Описание сохранено (${desc.length} симв.): ${preview}${desc.length > 200 ? '…' : ''}`);
            }
        }).catch(e => console.error(`[IMG MEMORY] ${e.message}`));
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
