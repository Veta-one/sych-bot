const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '../../data');
const debounce = require('lodash.debounce');

function cloneDefault(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // rename в пределах одного каталога атомарно заменяет целевой файл:
    // читатель увидит либо старую, либо полностью записанную новую версию.
    fs.renameSync(tempPath, filePath);

    // На POSIX дополнительно фиксируем саму запись каталога. На Windows
    // открытие каталога как файла не поддерживается — это нормально.
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) {}
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function atomicWriteJsonSync(filePath, data) {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

class StorageService {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || process.env.SYCH_DATA_DIR || DEFAULT_DATA_DIR);
    this.paths = {
      db: path.join(this.dataDir, 'db.json'),
      instructions: path.join(this.dataDir, 'instructions.json'),
      profiles: path.join(this.dataDir, 'profiles.json'),
      chatProfiles: path.join(this.dataDir, 'chatProfiles.json'),
      stats: path.join(this.dataDir, 'stats.json'),
      backups: path.join(this.dataDir, 'backups'),
    };
    this.backupRetention = Math.max(1, Number(options.backupRetention) || 14);
    this.clock = options.clock || (() => new Date());
    this.backupTimer = null;
    this.backupInProgress = false;
    this.forgottenUntil = new Map();
    this.chatProfilesBlockedUntil = new Map();

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
    this.ensureFile(this.paths.db, '{"chats": {}}');
    this.ensureFile(this.paths.instructions, '{}');
    this.ensureFile(this.paths.profiles, '{}');
    this.ensureFile(this.paths.chatProfiles, '{}');
    this.ensureFile(this.paths.stats, JSON.stringify(this._getDefaultStats()));

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
    if (!fs.existsSync(filePath)) {
      const recovered = this._recoverFromLatestBackup(path.basename(filePath));
      if (recovered !== null) {
        atomicWriteJsonSync(filePath, recovered);
        console.warn(`[STORAGE] ${path.basename(filePath)} отсутствовал и восстановлен из резервной копии.`);
      } else {
        atomicWriteFileSync(filePath, defaultContent);
      }
    }
  }

  _readJson(filePath, fallbackValue, label) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      const recovered = this._recoverFromLatestBackup(path.basename(filePath));
      if (recovered !== null) {
        console.warn(`[STORAGE] ${label} повреждён, восстановлен из последней резервной копии.`);
        atomicWriteJsonSync(filePath, recovered);
        return recovered;
      }

      console.error(`[STORAGE] Не удалось прочитать ${label}, использую пустую структуру: ${error.message}`);
      const fallback = cloneDefault(fallbackValue);
      if (fs.existsSync(filePath)) {
        const quarantinePath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
          fs.renameSync(filePath, quarantinePath);
          console.error(`[STORAGE] Повреждённый файл сохранён для ручного разбора: ${path.basename(quarantinePath)}`);
        } catch (quarantineError) {
          console.error(`[STORAGE] Не удалось изолировать повреждённый файл: ${quarantineError.message}`);
        }
      }
      atomicWriteJsonSync(filePath, fallback);
      return fallback;
    }
  }

  _recoverFromLatestBackup(fileName) {
    if (!fs.existsSync(this.paths.backups)) return null;

    const snapshots = fs.readdirSync(this.paths.backups, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-'))
      .map(entry => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots) {
      const candidate = path.join(this.paths.backups, snapshot, fileName);
      if (!fs.existsSync(candidate)) continue;
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      } catch (_) {}
    }
    return null;
  }

  load() {
    this.data = this._readJson(this.paths.db, { chats: {}, reminders: [] }, 'db.json');
    if (!this.data.chats) this.data.chats = {};
    if (!this.data.reminders) this.data.reminders = [];
    if (!this.data.bannedUsers) this.data.bannedUsers = {}; // { userId: "reason/name" }

    this.profiles = this._readJson(this.paths.profiles, {}, 'profiles.json');
    this.chatProfiles = this._readJson(this.paths.chatProfiles, {}, 'chatProfiles.json');

    // Грузим статистику
    try {
      const loaded = this._readJson(this.paths.stats, this._getDefaultStats(), 'stats.json');
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
      atomicWriteJsonSync(this.paths.db, this.data);
    } catch (e) { console.error("Ошибка записи DB:", e); }
  }

  _saveProfilesToFile() {
    try {
      atomicWriteJsonSync(this.paths.profiles, this.profiles);
    } catch (e) { console.error("Ошибка записи Profiles:", e); }
  }

  _saveChatProfilesToFile() {
    try {
      atomicWriteJsonSync(this.paths.chatProfiles, this.chatProfiles);
    } catch (e) { console.error("Ошибка записи ChatProfiles:", e); }
  }

  _saveStatsToFile() {
    try {
      atomicWriteJsonSync(this.paths.stats, this.stats);
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

  backupNow({ flush = true } = {}) {
    if (this.backupInProgress) return null;
    this.backupInProgress = true;
    let tempDir = null;

    try {
      if (flush) this.forceSave();
      fs.mkdirSync(this.paths.backups, { recursive: true });

      const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
      let snapshotName = stamp;
      let suffix = 1;
      while (fs.existsSync(path.join(this.paths.backups, snapshotName))) {
        snapshotName = `${stamp}-${suffix++}`;
      }

      const finalDir = path.join(this.paths.backups, snapshotName);
      tempDir = `${finalDir}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      fs.mkdirSync(tempDir, { recursive: true });

      const sourceFiles = [
        this.paths.db,
        this.paths.instructions,
        this.paths.profiles,
        this.paths.chatProfiles,
        this.paths.stats,
      ];

      for (const source of sourceFiles) {
        if (fs.existsSync(source)) {
          fs.copyFileSync(source, path.join(tempDir, path.basename(source)));
        }
      }

      fs.writeFileSync(
        path.join(tempDir, 'manifest.json'),
        JSON.stringify({
          createdAt: this.clock().toISOString(),
          files: sourceFiles.map(source => path.basename(source)),
        }, null, 2)
      );
      fs.renameSync(tempDir, finalDir);
      tempDir = null;
      this._pruneBackups();
      console.log(`[BACKUP] Снимок данных создан: ${snapshotName}`);
      return finalDir;
    } catch (error) {
      console.error(`[BACKUP ERROR] ${error.message}`);
      return null;
    } finally {
      if (tempDir && fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
      this.backupInProgress = false;
    }
  }

  _pruneBackups() {
    if (!fs.existsSync(this.paths.backups)) return;
    const snapshots = fs.readdirSync(this.paths.backups, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-'))
      .map(entry => entry.name)
      .sort()
      .reverse();

    for (const oldSnapshot of snapshots.slice(this.backupRetention)) {
      fs.rmSync(path.join(this.paths.backups, oldSnapshot), { recursive: true, force: true });
    }
  }

  startAutomaticBackups(intervalMs = 24 * 60 * 60 * 1000) {
    if (this.backupTimer) return this.backupTimer;
    const safeInterval = Math.max(60 * 1000, Number(intervalMs) || 24 * 60 * 60 * 1000);

    // Первый снимок делается при старте, затем — по расписанию.
    this.backupNow();
    this.backupTimer = setInterval(() => this.backupNow(), safeInterval);
    if (typeof this.backupTimer.unref === 'function') this.backupTimer.unref();
    return this.backupTimer;
  }

  stopAutomaticBackups() {
    if (!this.backupTimer) return;
    clearInterval(this.backupTimer);
    this.backupTimer = null;
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
        if (fs.existsSync(this.paths.instructions)) {
            // Читаем каждый раз заново для Hot Reload
            const instructions = this._readJson(this.paths.instructions, {}, 'instructions.json');
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
        const forgottenUntil = this.forgottenUntil.get(String(userId)) || 0;
        if (forgottenUntil > Date.now()) {
          console.log(`[PRIVACY] Пропущено устаревшее обновление профиля ${userId} после удаления памяти.`);
          continue;
        }

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

  async forgetUser(userId, username = '') {
    const targetId = String(userId);
    const normalizedUsername = String(username || '').replace(/^@/, '').toLowerCase();
    const affectedChatIds = new Set();
    const usernamesToRemove = new Set(normalizedUsername ? [normalizedUsername] : []);

    for (const [chatId, chatProfiles] of Object.entries(this.profiles)) {
      if (chatProfiles && Object.prototype.hasOwnProperty.call(chatProfiles, targetId)) {
        affectedChatIds.add(String(chatId));
      }
    }
    for (const [chatId, chat] of Object.entries(this.data.chats || {})) {
      if (!chat?.users || !Object.prototype.hasOwnProperty.call(chat.users, targetId)) continue;
      affectedChatIds.add(String(chatId));
      const trackedName = String(chat.users[targetId] || '');
      if (trackedName.startsWith('@')) usernamesToRemove.add(trackedName.slice(1).toLowerCase());
    }

    // Старые фоновые анализаторы могут закончить работу уже после команды удаления.
    // На пять минут блокируем их запоздалые результаты; новые сообщения затем снова
    // смогут сформировать профиль с чистого листа.
    this.forgottenUntil.set(targetId, Date.now() + 5 * 60 * 1000);
    for (const chatId of affectedChatIds) {
      this.chatProfilesBlockedUntil.set(chatId, Date.now() + 5 * 60 * 1000);
    }

    this.profileUpdateQueue = this.profileUpdateQueue.then(() => {
      let profilesRemoved = 0;
      let chatReferencesRemoved = 0;
      let remindersRemoved = 0;
      let instructionsRemoved = 0;
      let chatProfilesReset = 0;
      let backupsScrubbed = 0;

      for (const [chatId, chatProfiles] of Object.entries(this.profiles)) {
        if (!chatProfiles || typeof chatProfiles !== 'object') continue;
        if (String(chatId) === targetId) {
          delete this.profiles[chatId];
          profilesRemoved++;
          affectedChatIds.add(String(chatId));
          this.chatProfilesBlockedUntil.set(String(chatId), Date.now() + 5 * 60 * 1000);
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(chatProfiles, targetId)) {
          delete chatProfiles[targetId];
          profilesRemoved++;
          affectedChatIds.add(String(chatId));
          this.chatProfilesBlockedUntil.set(String(chatId), Date.now() + 5 * 60 * 1000);
        }
      }

      for (const [chatId, chat] of Object.entries(this.data.chats || {})) {
        if (String(chatId) === targetId) {
          const trackedName = String(chat?.users?.[targetId] || '');
          if (trackedName.startsWith('@')) usernamesToRemove.add(trackedName.slice(1).toLowerCase());
          delete this.data.chats[chatId];
          chatReferencesRemoved++;
          affectedChatIds.add(String(chatId));
          this.chatProfilesBlockedUntil.set(String(chatId), Date.now() + 5 * 60 * 1000);
          continue;
        }
        if (!chat?.users) continue;
        if (Object.prototype.hasOwnProperty.call(chat.users, targetId)) {
          delete chat.users[targetId];
          chatReferencesRemoved++;
          affectedChatIds.add(String(chatId));
          this.chatProfilesBlockedUntil.set(String(chatId), Date.now() + 5 * 60 * 1000);
        }
      }

      const beforeReminders = (this.data.reminders || []).length;
      this.data.reminders = (this.data.reminders || [])
        .filter(reminder => String(reminder.userId) !== targetId);
      remindersRemoved = beforeReminders - this.data.reminders.length;

      if (usernamesToRemove.size > 0 && fs.existsSync(this.paths.instructions)) {
        const instructions = this._readJson(this.paths.instructions, {}, 'instructions.json');
        for (const knownUsername of usernamesToRemove) {
          for (const key of [knownUsername, `@${knownUsername}`]) {
            if (Object.prototype.hasOwnProperty.call(instructions, key)) {
              delete instructions[key];
              instructionsRemoved++;
            }
          }
        }
        if (instructionsRemoved > 0) {
          atomicWriteJsonSync(this.paths.instructions, instructions);
        }
      }

      // Профиль чата — агрегированный текст и может косвенно содержать сведения
      // об удаляемом человеке. Точечно вырезать их без повторного AI-анализа нельзя,
      // поэтому безопаснее сбросить агрегат затронутых чатов: он восстановится по
      // новым сообщениям уже без старых данных пользователя.
      for (const chatId of affectedChatIds) {
        if (Object.prototype.hasOwnProperty.call(this.chatProfiles, chatId)) {
          delete this.chatProfiles[chatId];
          chatProfilesReset++;
        }
      }

      // Для privacy-команды не ждём debounce: физически фиксируем удаление сразу.
      this.saveDebounced.cancel();
      this.saveProfilesDebounced.cancel();
      this.saveChatProfilesDebounced.cancel();
      this._saveToFile();
      this._saveProfilesToFile();
      this._saveChatProfilesToFile();
      backupsScrubbed = this._scrubUserFromBackups(targetId, usernamesToRemove);

      return {
        profilesRemoved,
        chatReferencesRemoved,
        remindersRemoved,
        instructionsRemoved,
        chatProfilesReset,
        backupsScrubbed,
      };
    });

    return this.profileUpdateQueue;
  }

  _scrubUserFromBackups(targetId, usernamesToRemove) {
    if (!fs.existsSync(this.paths.backups)) return 0;
    let scrubbedSnapshots = 0;

    const snapshots = fs.readdirSync(this.paths.backups, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-'));

    for (const snapshot of snapshots) {
      const snapshotDir = path.join(this.paths.backups, snapshot.name);
      const dbPath = path.join(snapshotDir, 'db.json');
      const profilesPath = path.join(snapshotDir, 'profiles.json');
      const chatProfilesPath = path.join(snapshotDir, 'chatProfiles.json');
      const instructionsPath = path.join(snapshotDir, 'instructions.json');
      const snapshotAffectedChats = new Set();
      const snapshotUsernames = new Set(usernamesToRemove);
      let changed = false;

      try {
        if (fs.existsSync(profilesPath)) {
          const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
          for (const [chatId, chatProfiles] of Object.entries(profiles)) {
            if (String(chatId) === targetId) {
              delete profiles[chatId];
              snapshotAffectedChats.add(String(chatId));
              changed = true;
              continue;
            }
            if (chatProfiles && Object.prototype.hasOwnProperty.call(chatProfiles, targetId)) {
              delete chatProfiles[targetId];
              snapshotAffectedChats.add(String(chatId));
              changed = true;
            }
          }
          if (changed) atomicWriteJsonSync(profilesPath, profiles);
        }

        let dbChanged = false;
        if (fs.existsSync(dbPath)) {
          const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
          for (const [chatId, chat] of Object.entries(data.chats || {})) {
            if (String(chatId) === targetId) {
              const trackedName = String(chat?.users?.[targetId] || '');
              if (trackedName.startsWith('@')) snapshotUsernames.add(trackedName.slice(1).toLowerCase());
              delete data.chats[chatId];
              snapshotAffectedChats.add(String(chatId));
              dbChanged = true;
              continue;
            }
            if (!chat?.users || !Object.prototype.hasOwnProperty.call(chat.users, targetId)) continue;
            const trackedName = String(chat.users[targetId] || '');
            if (trackedName.startsWith('@')) snapshotUsernames.add(trackedName.slice(1).toLowerCase());
            delete chat.users[targetId];
            snapshotAffectedChats.add(String(chatId));
            dbChanged = true;
          }
          const remindersBefore = (data.reminders || []).length;
          data.reminders = (data.reminders || [])
            .filter(reminder => String(reminder.userId) !== targetId);
          if (data.reminders.length !== remindersBefore) dbChanged = true;
          if (dbChanged) {
            atomicWriteJsonSync(dbPath, data);
            changed = true;
          }
        }

        if (fs.existsSync(chatProfilesPath) && snapshotAffectedChats.size > 0) {
          const chatProfiles = JSON.parse(fs.readFileSync(chatProfilesPath, 'utf8'));
          let chatProfilesChanged = false;
          for (const chatId of snapshotAffectedChats) {
            if (Object.prototype.hasOwnProperty.call(chatProfiles, chatId)) {
              delete chatProfiles[chatId];
              chatProfilesChanged = true;
            }
          }
          if (chatProfilesChanged) {
            atomicWriteJsonSync(chatProfilesPath, chatProfiles);
            changed = true;
          }
        }

        if (fs.existsSync(instructionsPath) && snapshotUsernames.size > 0) {
          const instructions = JSON.parse(fs.readFileSync(instructionsPath, 'utf8'));
          let instructionsChanged = false;
          for (const knownUsername of snapshotUsernames) {
            for (const key of [knownUsername, `@${knownUsername}`]) {
              if (Object.prototype.hasOwnProperty.call(instructions, key)) {
                delete instructions[key];
                instructionsChanged = true;
              }
            }
          }
          if (instructionsChanged) {
            atomicWriteJsonSync(instructionsPath, instructions);
            changed = true;
          }
        }

        if (changed) scrubbedSnapshots++;
      } catch (error) {
        console.error(`[PRIVACY] Не удалось очистить backup ${snapshot.name}: ${error.message}`);
      }
    }
    return scrubbedSnapshots;
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
    
    // 2. Ищем по точному сохранённому username/имени из db.json.
    // Частичное совпадение здесь опасно: обычная тема после «расскажи про»
    // не должна случайно превращаться в запрос чужого профиля.
    for (const [uid, usernameRaw] of Object.entries(chat.users)) {
        const normalizedUsername = String(usernameRaw).trim().toLowerCase().replace(/^@/, '');
        if (normalizedUsername === q) {
            const p = this.getProfile(chatId, uid);
            return { ...p, userId: uid, username: usernameRaw };
        }
    }

    // 3. Если по нику не нашли, ищем по точному realName.
    for (const [uid, profile] of Object.entries(profiles)) {
        if (profile.realName && profile.realName.trim().toLowerCase() === q) {
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
    const blockedUntil = this.chatProfilesBlockedUntil.get(String(chatId)) || 0;
    if (blockedUntil > Date.now()) {
      console.log(`[PRIVACY] Пропущено устаревшее обновление профиля чата ${chatId} после удаления памяти.`);
      return;
    }

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

const storage = new StorageService();

module.exports = storage;
module.exports.StorageService = StorageService;
module.exports.atomicWriteFileSync = atomicWriteFileSync;
module.exports.atomicWriteJsonSync = atomicWriteJsonSync;
