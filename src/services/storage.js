const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/db.json');
const INSTRUCTIONS_PATH = path.join(__dirname, '../../data/instructions.json');
const PROFILES_PATH = path.join(__dirname, '../../data/profiles.json');
const CHAT_PROFILES_PATH = path.join(__dirname, '../../data/chatProfiles.json');
const STATS_PATH = path.join(__dirname, '../../data/stats.json');
const debounce = require('lodash.debounce');

class StorageService {
  constructor() {
    // Создаем отложенные функции сохранения (ждут 5 секунд тишины перед записью)
    this.saveDebounced = debounce(this._saveToFile.bind(this), 5000);
    this.saveProfilesDebounced = debounce(this._saveProfilesToFile.bind(this), 5000);
    this.saveChatProfilesDebounced = debounce(this._saveChatProfilesToFile.bind(this), 5000);
    this.saveStatsDebounced = debounce(this._saveStatsToFile.bind(this), 3000); // Статистика чаще сохраняется
    this.data = { chats: {} };
    this.profiles = {};
    this.chatProfiles = {};
    this.stats = this._getDefaultStats();
    // Очередь обновлений профилей для предотвращения race condition
    this.profileUpdateQueue = Promise.resolve();

    // 1. Создаем структуру файлов, если их нет
    this.ensureFile(DB_PATH, '{"chats": {}}');
    this.ensureFile(INSTRUCTIONS_PATH, '{}');
    this.ensureFile(PROFILES_PATH, '{}');
    this.ensureFile(CHAT_PROFILES_PATH, '{}');
    this.ensureFile(STATS_PATH, JSON.stringify(this._getDefaultStats()));

    // 2. Загружаем данные в память
    this.load();
  }

  _getDefaultStats() {
    return {
      today: {
        date: this._getTodayDate(),
        smart: 0,
        logic: 0,
        search: 0,
        google: []
      },
      history: [],  // Архив дней: [{ date, smart, logic, search, google }]
      allTime: {
        smart: 0,
        logic: 0,
        search: 0,
        google: 0
      }
    };
  }

  _getTodayDate() {
    return new Date().toISOString().split('T')[0]; // "2026-01-31"
  }

  ensureFile(filePath, defaultContent) {
    if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent);
  }


  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      // Если базы напоминаний нет — создаем пустую
      if (!this.data.bannedUsers) this.data.bannedUsers = {}; // { userId: "reason/name" }
    } catch (e) { 
      console.error("Ошибка чтения DB, сброс."); 
      this.data = { chats: {}, reminders: [] };
    }
    // Грузим профили
    try {
      this.profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8'));
    } catch (e) {
      console.error("Ошибка чтения Profiles, сброс.");
      this.profiles = {};
    }
    // Грузим профили чатов
    try {
      this.chatProfiles = JSON.parse(fs.readFileSync(CHAT_PROFILES_PATH, 'utf-8'));
    } catch (e) {
      console.error("Ошибка чтения ChatProfiles, сброс.");
      this.chatProfiles = {};
    }
    // Грузим статистику
    try {
      const loaded = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
      // Миграция со старого формата (если есть lastResetDate вместо today)
      if (loaded.lastResetDate !== undefined && !loaded.today) {
        console.log("[STATS] Миграция со старого формата...");
        this.stats = this._getDefaultStats();
      } else {
        this.stats = loaded;
        // Проверяем наличие всех полей
        if (!this.stats.today) this.stats.today = this._getDefaultStats().today;
        if (!this.stats.history) this.stats.history = [];
        if (!this.stats.allTime) this.stats.allTime = { smart: 0, logic: 0, search: 0, google: 0 };
      }
    } catch (e) {
      console.error("Ошибка чтения Stats, сброс.");
      this.stats = this._getDefaultStats();
    }
  }

  // === НАПОМИНАЛКИ (Новые методы) ===

  addReminder(chatId, userId, username, timeIso, text) {
    if (!this.data.reminders) this.data.reminders = [];
    
    this.data.reminders.push({
        id: Date.now() + Math.random(), // Уникальный ID
        chatId,
        userId,
        username,
        time: timeIso, // Время срабатывания (ISO string)
        text: text
    });
    this.save();
  }

  // Получить задачи, время которых пришло
  getPendingReminders() {
    if (!this.data.reminders) return [];
    
    // Берем текущее время как ЧИСЛО (миллисекунды с 1970 года)
    const now = Date.now();
    
    return this.data.reminders.filter(r => {
        // Превращаем время из базы тоже в ЧИСЛО
        const taskTime = new Date(r.time).getTime();
        
        // Если время задачи меньше или равно текущему — пора слать!
        return taskTime <= now;
    });
  }

  // Удалить сработавшие задачи
  removeReminders(ids) {
    if (!this.data.reminders) return;
    this.data.reminders = this.data.reminders.filter(r => !ids.includes(r.id));
    this.save();
  }

  // Вызываем отложенную запись
  save() {
    this.saveDebounced();
  }

  saveProfiles() {
    this.saveProfilesDebounced();
  }

  // Реальная физическая запись (синхронная, но редкая)
  _saveToFile() {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error("Ошибка записи DB:", e); }
  }

  _saveProfilesToFile() {
    try {
      fs.writeFileSync(PROFILES_PATH, JSON.stringify(this.profiles, null, 2));
    } catch (e) { console.error("Ошибка записи Profiles:", e); }
  }

  _saveChatProfilesToFile() {
    try {
      fs.writeFileSync(CHAT_PROFILES_PATH, JSON.stringify(this.chatProfiles, null, 2));
    } catch (e) { console.error("Ошибка записи ChatProfiles:", e); }
  }

  _saveStatsToFile() {
    try {
      fs.writeFileSync(STATS_PATH, JSON.stringify(this.stats, null, 2));
    } catch (e) { console.error("Ошибка записи Stats:", e); }
  }

  saveChatProfiles() {
    this.saveChatProfilesDebounced();
  }

  saveStats() {
    this.saveStatsDebounced();
  }

  // Принудительное сохранение (для выхода из процесса)
  forceSave() {
    this.saveDebounced.flush();
    this.saveProfilesDebounced.flush();
    this.saveChatProfilesDebounced.flush();
    this.saveStatsDebounced.flush();
  }

  // === СТАТИСТИКА ===

  // Получить статистику за сегодня
  getStats() {
    this.resetStatsIfNeeded();
    return this.stats.today;
  }

  // Получить полную статистику (для отчёта)
  getFullStats() {
    this.resetStatsIfNeeded();
    return {
      today: this.stats.today,
      week: this._calcPeriodStats(7),
      month: this._calcPeriodStats(30),
      allTime: this.stats.allTime
    };
  }

  // Подсчёт статистики за период (последние N дней)
  _calcPeriodStats(days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const result = { smart: 0, logic: 0, search: 0, google: 0 };

    // Добавляем сегодняшний день
    result.smart += this.stats.today.smart;
    result.logic += this.stats.today.logic;
    result.search += this.stats.today.search;
    result.google += (this.stats.today.google || []).reduce((sum, g) => sum + g.count, 0);

    // Добавляем из истории
    for (const day of this.stats.history) {
      if (day.date >= cutoffStr) {
        result.smart += day.smart || 0;
        result.logic += day.logic || 0;
        result.search += day.search || 0;
        result.google += day.google || 0;
      }
    }

    return result;
  }

  // Инициализировать google-ключи (вызывается из ai.js при старте)
  initGoogleStats(keyCount) {
    this.resetStatsIfNeeded();
    // Если количество ключей изменилось - пересоздаём массив
    if (!this.stats.today.google || this.stats.today.google.length !== keyCount) {
      this.stats.today.google = Array(keyCount).fill(null).map(() => ({ count: 0, status: true }));
      this.saveStats();
    }
  }

  // Увеличить счётчик (smart, logic, search)
  incrementStat(type) {
    this.resetStatsIfNeeded();
    if (this.stats.today[type] !== undefined) {
      this.stats.today[type]++;
      this.stats.allTime[type]++;
      this.saveStats();
    }
  }

  // Увеличить счётчик google-ключа
  incrementGoogleStat(keyIndex) {
    this.resetStatsIfNeeded();
    if (this.stats.today.google[keyIndex]) {
      this.stats.today.google[keyIndex].count++;
      this.stats.allTime.google++;
      this.saveStats();
    }
  }

  // Пометить google-ключ как исчерпанный
  markGoogleKeyExhausted(keyIndex) {
    if (this.stats.today.google[keyIndex]) {
      this.stats.today.google[keyIndex].status = false;
      this.saveStats();
    }
  }

  // Сброс статистики в полночь (с архивацией)
  resetStatsIfNeeded() {
    const todayDate = this._getTodayDate();
    if (this.stats.today.date !== todayDate) {
      // Архивируем вчерашний день
      const yesterday = this.stats.today;
      const googleTotal = (yesterday.google || []).reduce((sum, g) => sum + g.count, 0);

      this.stats.history.unshift({
        date: yesterday.date,
        smart: yesterday.smart,
        logic: yesterday.logic,
        search: yesterday.search,
        google: googleTotal
      });

      // Храним максимум 90 дней истории
      if (this.stats.history.length > 90) {
        this.stats.history = this.stats.history.slice(0, 90);
      }

      // Сбрасываем сегодняшний день
      const keyCount = (yesterday.google || []).length;
      this.stats.today = {
        date: todayDate,
        smart: 0,
        logic: 0,
        search: 0,
        google: Array(keyCount).fill(null).map(() => ({ count: 0, status: true }))
      };

      this.saveStats();
      console.log("[STATS] Новый день — статистика архивирована и сброшена.");
      return true;
    }
    return false;
  }

  // Проверка существования без создания (для уведомлений)
  hasChat(chatId) {
    return !!this.data.chats[chatId];
  }

  // === РАБОТА С ЧАТАМИ ===

  getChat(chatId) {
    if (!this.data.chats[chatId]) {
      this.data.chats[chatId] = { mutedTopics: [], users: {} };
      this.save();
    }
    return this.data.chats[chatId];
  }

  // Новый метод для обновления названия чата везде
  updateChatName(chatId, name) {
    if (!name) return;

    // 1. Обновляем db.json
    const chat = this.getChat(chatId);
    if (chat.chatName !== name) {
        chat.chatName = name;
        this.save();
    }

    // 2. Обновляем profiles.json (добавляем метку, чтобы ты глазами видел)
    if (!this.profiles[chatId]) this.profiles[chatId] = {};
    // Используем спец-ключ с нижним подчеркиванием, чтобы не путать с юзерами
    if (this.profiles[chatId]["_chatName"] !== name) {
        this.profiles[chatId]["_chatName"] = name;
        this.saveProfiles();
    }
  }

  trackUser(chatId, user) {
    if (user.is_bot) return;
    const chat = this.getChat(chatId);
    // Сохраняем юзернейм или имя для поиска
    const name = user.username ? `@${user.username}` : (user.first_name || "Анон");
    
    if (!chat.users[user.id] || chat.users[user.id] !== name) {
      chat.users[user.id] = name;
      this.save();
    }
  }

  getRandomUser(chatId) {
    const chat = this.getChat(chatId);
    const ids = Object.keys(chat.users);
    if (ids.length === 0) return null;
    const randomId = ids[Math.floor(Math.random() * ids.length)];
    return chat.users[randomId];
  }

  isTopicMuted(chatId, threadId) {
    const chat = this.getChat(chatId);
    // Исправление: проверяем именно на null/undefined, чтобы цифра 0 не превращалась в 'general'
    let tid = (threadId === null || threadId === undefined) ? 'general' : threadId;
    
    // Приводим все к строке для надежного сравнения
    tid = String(tid);
    
    return chat.mutedTopics.some(t => String(t) === tid);
  }

  toggleMute(chatId, threadId) {
    const chat = this.getChat(chatId);
    let tid = (threadId === null || threadId === undefined) ? 'general' : threadId;
    tid = String(tid); // Сохраняем всегда как строку
    
    const index = chat.mutedTopics.findIndex(t => String(t) === tid);
    
    if (index > -1) {
      chat.mutedTopics.splice(index, 1);
      this.save();
      return false; // Unmuted
    } else {
      chat.mutedTopics.push(tid);
      this.save();
      return true; // Muted
    }
  }


  // === ИНСТРУКЦИИ (Только чтение) ===
  getUserInstruction(username) {
    if (!username) return "";
    try {
        if (fs.existsSync(INSTRUCTIONS_PATH)) {
            // Читаем каждый раз заново для Hot Reload
            const instructions = JSON.parse(fs.readFileSync(INSTRUCTIONS_PATH, 'utf-8'));
            return instructions[username.toLowerCase()] || "";
        }
    } catch (e) { console.error("Ошибка инструкций:", e); }
    return "";
  }

  // === ПРОФИЛИ (Психологические портреты) ===

  // Получить один профиль (или заглушку)
  getProfile(chatId, userId) {
    if (!this.profiles[chatId]) this.profiles[chatId] = {};
    
    if (!this.profiles[chatId][userId]) {
        // Дефолт: репутация 50
        return { realName: null, facts: "", attitude: "Нейтральное", relationship: 50 };
    }
    // Если профиль есть, но поле relationship старое (нет его) — добавим 50
    const p = this.profiles[chatId][userId];
    if (typeof p.relationship === 'undefined') p.relationship = 50;
    
    return p;
  }

  // Получить пачку профилей (для анализатора)
  getProfilesForUsers(chatId, userIds) {
    const result = {};
    if (!this.profiles[chatId]) return {};
    
    userIds.forEach(uid => {
        if (this.profiles[chatId][uid]) {
            result[uid] = this.profiles[chatId][uid];
        }
    });
    return result;
  }

  // Массовое обновление (после анализа) с очередью для предотвращения race condition
  bulkUpdateProfiles(chatId, updatesMap) {
    // Добавляем обновление в очередь, чтобы избежать одновременных изменений
    this.profileUpdateQueue = this.profileUpdateQueue.then(() => {
      this._applyProfileUpdates(chatId, updatesMap);
    }).catch(err => {
      console.error("[PROFILE UPDATE ERROR]", err);
    });
  }

  // Внутренний метод применения обновлений
  _applyProfileUpdates(chatId, updatesMap) {
    if (!this.profiles[chatId]) this.profiles[chatId] = {};

    for (const [userId, data] of Object.entries(updatesMap)) {
        const current = this.profiles[chatId][userId] || { realName: null, facts: "", attitude: "Нейтральное", relationship: 50 };

        if (data.realName && data.realName !== "Неизвестно") current.realName = data.realName;
        if (data.facts) current.facts = data.facts;
        if (data.attitude) current.attitude = data.attitude;
        if (data.location) current.location = data.location;

        // Валидация изменения репутации
        if (data.relationship !== undefined) {
          const newScore = parseInt(data.relationship, 10);
          if (!isNaN(newScore)) {
            const oldScore = current.relationship || 50;
            const delta = newScore - oldScore;

            // Ограничиваем изменения: +1..+3 за позитив, -5..-10 за негатив
            let clampedDelta = delta;
            if (delta > 0) {
              clampedDelta = Math.min(delta, 3); // Максимум +3
            } else if (delta < 0) {
              clampedDelta = Math.max(delta, -10); // Максимум -10
              if (clampedDelta > -5 && clampedDelta < 0) clampedDelta = -5; // Минимум -5 если негатив
            }

            // Применяем изменение с ограничением 0-100
            current.relationship = Math.max(0, Math.min(100, oldScore + clampedDelta));

            if (delta !== clampedDelta) {
              console.log(`[RELATIONSHIP CLAMP] ${userId}: AI хотел ${delta > 0 ? '+' : ''}${delta}, применено ${clampedDelta > 0 ? '+' : ''}${clampedDelta}`);
            }
          }
        }

        this.profiles[chatId][userId] = current;
    }
    this.saveProfiles();
  }

  // Поиск профиля по TGID, username или realName внутри конкретного чата.
  findProfileByQuery(chatId, query) {
    const chat = this.getChat(chatId);
    const profiles = this.profiles[chatId] || {};
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return null;

    const q = rawQuery.toLowerCase().replace(/^@/, '');

    // 1. Числовой запрос — это точный Telegram user ID, без частичных совпадений.
    if (/^\d+$/.test(q)) {
        const profile = profiles[q];
        const usernameRaw = chat.users[q];

        // Не раскрываем и не создаём профиль для ID, которого бот не видел в этом чате.
        if (!profile && !usernameRaw) return null;

        const p = profile || this.getProfile(chatId, q);
        return {
            ...p,
            userId: q,
            username: usernameRaw || null,
        };
    }
    
    // 2. Ищем по сохранённому username/имени из db.json.
    for (const [uid, usernameRaw] of Object.entries(chat.users)) {
        if (String(usernameRaw).toLowerCase().includes(q)) {
            const p = this.getProfile(chatId, uid);
            return { ...p, userId: uid, username: usernameRaw };
        }
    }

    // 3. Если по нику не нашли, ищем внутри профилей по realName.
    for (const [uid, profile] of Object.entries(profiles)) {
        if (profile.realName && profile.realName.toLowerCase().includes(q)) {
            const usernameRaw = chat.users[uid] || "Unknown";
            return { ...profile, userId: uid, username: usernameRaw };
        }
    }

    return null;
  }

    // === БАН-ХАММЕР ===

    isBanned(userId) {
      if (!this.data.bannedUsers) return false;
      return !!this.data.bannedUsers[userId];
    }
  
    banUser(userId, info) {
      if (!this.data.bannedUsers) this.data.bannedUsers = {};
      this.data.bannedUsers[userId] = info || "Banned by Admin";
      this.save();
    }
  
    unbanUser(userId) {
      if (!this.data.bannedUsers) return;
      delete this.data.bannedUsers[userId];
      this.save();
    }
  
    getBannedList() {
      return this.data.bannedUsers || {};
    }
  
    // Поиск ID по никнейму (сканируем все чаты)
    findUserIdByUsername(username) {
      const target = username.replace('@', '').toLowerCase();

      for (const chat of Object.values(this.data.chats)) {
          for (const [uid, uName] of Object.entries(chat.users)) {
              if (String(uName).toLowerCase().includes(target)) {
                  return uid;
              }
          }
      }
      return null;
    }

  // === ПРОФИЛИ ЧАТОВ ===

  // Получить профиль чата (или пустой объект)
  getChatProfile(chatId) {
    if (!this.chatProfiles[chatId]) {
      return { topic: null, facts: null, style: null, lastUpdated: null };
    }
    return this.chatProfiles[chatId];
  }

  // Проверить, есть ли у чата профиль с темой
  hasChatProfile(chatId) {
    return !!(this.chatProfiles[chatId] && this.chatProfiles[chatId].topic);
  }

  // Обновить профиль чата (после AI-анализа)
  updateChatProfile(chatId, updates) {
    if (!this.chatProfiles[chatId]) {
      this.chatProfiles[chatId] = { topic: null, facts: null, style: null, lastUpdated: null };
    }

    const current = this.chatProfiles[chatId];

    // Обновляем тему, если AI её определил
    if (updates.topic) {
      // Ограничиваем длину темы до 200 символов
      current.topic = updates.topic.substring(0, 200);
    }

    // Обновляем факты
    if (updates.facts) {
      // Ограничиваем длину фактов до 500 символов
      current.facts = updates.facts.substring(0, 500);
    }

    // Обновляем стиль
    if (updates.style) {
      current.style = updates.style;
    }

    current.lastUpdated = new Date().toISOString();
    this.chatProfiles[chatId] = current;
    this.saveChatProfiles();

    console.log(`[CHAT PROFILE] Обновлен профиль чата ${chatId}: "${current.topic}"`);
  }

  // Установить тему вручную (команда "Сыч, этот чат про...")
  setChatTopic(chatId, topic) {
    if (!this.chatProfiles[chatId]) {
      this.chatProfiles[chatId] = { topic: null, facts: null, style: null, lastUpdated: null };
    }

    this.chatProfiles[chatId].topic = topic.substring(0, 200);
    this.chatProfiles[chatId].lastUpdated = new Date().toISOString();
    this.saveChatProfiles();

    console.log(`[CHAT PROFILE] Тема установлена вручную для ${chatId}: "${topic}"`);
  }
}

module.exports = new StorageService();
