const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const axios = require('axios');
const OpenAI = require('openai');
const { tavily } = require('@tavily/core'); // Клиент Tavily
const storage = require('./storage');
const { sendRich } = require('../utils/rich');

class AiService {
  constructor() {
    // 1. Инициализация OpenAI-совместимого клиента (OpenRouter / Mistral / DeepSeek)
    this.openai = config.aiKey ? new OpenAI({
        baseURL: config.aiBaseUrl,
        apiKey: config.aiKey,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/Veta-one/sych-bot",
          "X-Title": "Sych Bot"
        }
    }) : null;

    // 2. Инициализация Tavily
    this.tavilyClient = config.tavilyKey ? tavily({ apiKey: config.tavilyKey }) : null;

    // 3. Google Native (Fallback)
    this.keyIndex = 0;
    this.keys = config.geminiKeys;
    this.usingFallback = false;
    this.bot = null;

    // === СТАТИСТИКА (теперь персистентная через storage) ===
    storage.initGoogleStats(this.keys.length);

    if (this.keys.length === 0) console.warn("WARNING: Нет ключей Gemini в .env! Fallback не сработает.");
    this.initNativeModel();
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  notifyAdmin(message) {
    if (this.bot && config.adminId) {
        sendRich(this.bot, config.adminId, { markdown: message }).catch(() => {});
    }
  }

  // Сброс статистики в полночь (проверка через storage)
  resetStatsIfNeeded() {
    const wasReset = storage.resetStatsIfNeeded();
    if (wasReset && this.usingFallback) {
      this.usingFallback = false;
      this.keyIndex = 0;
      this.initNativeModel();
      this.notifyAdmin("🌙 **Новый день!**\nЛимиты сброшены. Возврат в основной режим.");
    }
  }

  // Возвращает HTML для rich-сообщения (sendRichMessage)
  getStatsReport() {
    this.resetStatsIfNeeded();
    const { today, week, month, allTime } = storage.getFullStats();
    const mode = this.usingFallback ? "⚠️ FALLBACK" : "⚡️ API";
    const dateStr = today.date ? today.date.split('-').reverse().slice(0, 2).join('.') : '--';

    const googleRows = (today.google || []).map((s, i) =>
      `| Ключ ${i + 1} | ${s.status ? "🟢" : "🔴"} | ${s.count} |`
    ).join('\n') || `| — | — | 0 |`;

    const allTimeTotal = allTime.smart + allTime.logic + allTime.google;

    return `## 📊 Статистика Сыча

Сегодня **${dateStr}** · режим **${mode}**

| Канал | Сегодня |
|:------|--------:|
| Smart (ответы) | ${today.smart} |
| Logic (анализ) | ${today.logic} |
| Search (поиск) | ${today.search} |

**Google Native (ключи)**

| Ключ | Статус | Запросов |
|:-----|:------:|---------:|
${googleRows}

<details><summary>За периоды</summary>

Неделя: API ${week.smart + week.logic} · Google ${week.google} · Поиск ${week.search}
Месяц: API ${month.smart + month.logic} · Google ${month.google} · Поиск ${month.search}
Всего: ${this._formatNumber(allTimeTotal)} запросов

</details>`;
  }

  _formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }

  initNativeModel() {
    if (this.keys.length === 0) return;
    const currentKey = this.keys[this.keyIndex];
    const genAI = new GoogleGenerativeAI(currentKey);
    
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    // Используем Fallback модель или стандартную Flash (она доступна в нативе)
    const modelName = this.usingFallback ? config.fallbackModelName : config.googleNativeModel;
    console.log(`[AI INIT] Native Key #${this.keyIndex + 1} | Model: ${modelName}`);

    this.nativeModel = genAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: prompts.system(),
        safetySettings: safetySettings,
        // Включаем нативный поиск Google (Tools)
        tools: [{ googleSearch: {} }] 
    });
  }

  rotateNativeKey() {
    storage.markGoogleKeyExhausted(this.keyIndex);

    console.log(`[AI WARNING] Native Key #${this.keyIndex + 1} исчерпан.`);
    this.keyIndex++;

    if (this.keyIndex >= this.keys.length) {
        this.keyIndex = 0;
        console.error("☠️ Все нативные ключи исчерпаны.");
        this.notifyAdmin("⚠️ **Внимание!** Все Google ключи исчерпаны.");
    }
    this.initNativeModel();
  }

  async executeNativeWithRetry(apiCallFn) {
    const maxAttempts = this.keys.length * 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            storage.incrementGoogleStat(this.keyIndex);
            return await apiCallFn();
        } catch (error) {
            const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('403');
            if (isQuotaError) {
                this.rotateNativeKey();
                continue;
            } else {
                throw error;
            }
        }
    }
    throw new Error("Все ключи Google Native исчерпаны!");
  }

  getCurrentTime() {
    const time = new Date().toLocaleString("ru-RU", {
      timeZone: "Asia/Yekaterinburg",
      weekday: 'short', // Сократим до Пт, Пн (экономим токены)
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    // Явно указываем базу для расчетов
    return `${time} (UTC+5)`;
  }

// === УНИВЕРСАЛЬНЫЙ ПОИСК ===
async performSearch(query) {
  this.resetStatsIfNeeded();

  // 1. TAVILY
  if (config.searchProvider === 'tavily' && this.tavilyClient) {
      try {
          console.log(`[SEARCH] Tavily ищет: ${query}`);
          const response = await this.tavilyClient.search(query, {
              search_depth: "advanced",
              max_results: 3,
              include_answer: true,
              include_images: true
          });
          storage.incrementStat('search');

          let resultText = "";
          if (response.answer) resultText += `Краткий ответ Tavily: ${response.answer}\n\n`;
          response.results.forEach((res, i) => {
              resultText += `[${i+1}] ${res.title} (${res.url}):\n${res.content}\n\n`;
          });
          const images = (response.images || []).map(im => (typeof im === 'string' ? im : im?.url)).filter(Boolean).slice(0, 4);
          if (images.length) {
              resultText += `\nДОСТУПНЫЕ КАРТИНКИ (реальные URL из поиска):\n${images.join('\n')}\n`;
          }
          return resultText;
      } catch (e) {
          console.error(`[TAVILY FAIL] ${e.message}`);
          return null;
      }
  }

  // 2. PERPLEXITY
  if (config.searchProvider === 'perplexity' && this.openai) {
      try {
          console.log(`[SEARCH] Perplexity ищет: ${query}`);
          const completion = await this.openai.chat.completions.create({
              model: config.perplexityModel,
              messages: [
                  { role: "system", content: `Date: ${this.getCurrentTime()}. Search engine mode. Provide facts with URLs.` },
                  { role: "user", content: query }
              ],
              temperature: 0.1
          });
          storage.incrementStat('search');
          return completion.choices[0].message.content;
      } catch (e) {
          console.error(`[PERPLEXITY FAIL] ${e.message}`);
          return null;
      }
  }
  
  return null;
}
  
// === ОСНОВНОЙ ОТВЕТ ===
async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false, chatProfile = null) {
  this.resetStatsIfNeeded();
  console.log(`[DEBUG AI] getResponse вызван.`);

  // 1. AI ОПРЕДЕЛЯЕТ НУЖЕН ЛИ ПОИСК
  const recentHistory = history.slice(-5).map(m => `${m.role}: ${m.text}`).join('\n');
  const searchDecision = await this.checkSearchNeeded(
      currentMessage.text,
      recentHistory,
      chatProfile?.topic || null
  );

  let searchResultText = "";

  if (searchDecision.needsSearch && searchDecision.searchQuery) {
      // 2. ПОИСК ЧЕРЕЗ TAVILY / PERPLEXITY
      if (config.searchProvider !== 'google') {
          searchResultText = await this.performSearch(searchDecision.searchQuery);
      }

      // 3. FALLBACK НА GOOGLE NATIVE SEARCH
      // Если Tavily/Perplexity недоступен или провайдер = google
      if (!searchResultText && this.keys.length > 0) {
          console.log(`[ROUTER] Переключаюсь на Google Native Search.`);
          return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous, chatProfile);
      }
  }

  // 2. СБОРКА ПРОМПТА
  const relevantHistory = history.slice(-20); 
  const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
  let personalInfo = "";
  let replyContext = "";

  if (currentMessage.replyText) replyContext = `!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n"${currentMessage.replyText}"`;
  if (userInstruction) personalInfo += `\n!!! СПЕЦ-ИНСТРУКЦИЯ !!!\n${userInstruction}\n`;
  
  if (searchResultText) {
      personalInfo += `\n!!! ДАННЫЕ ИЗ ПОИСКА (${config.searchProvider.toUpperCase()}) !!!\n${searchResultText}\n`
        + `ИНСТРУКЦИЯ: Ответь, опираясь на эти факты.\n`
        + `ИСТОЧНИКИ (СТРОГО): ссылки вставляй ПРЯМО в подходящие слова текста через [слова](URL) — НЕ используй номера-сноски вида [1], [2]. В САМОМ КОНЦЕ ответа добавь сворачиваемый список источников РОВНО в таком формате (с пустыми строками внутри, заголовок именно "Источники", без эмодзи):\n<details><summary>Источники</summary>\n\n1. [Название](URL)\n2. [Название](URL)\n\n</details>\nURL и названия бери ТОЛЬКО из данных выше, не выдумывай.\n`
        + `КАРТИНКИ: если есть блок «ДОСТУПНЫЕ КАРТИНКИ» и это уместно (просят показать / «как выглядит») — вставь картинку через ![](URL). Если уместно НЕСКОЛЬКО картинок — оберни их в <tg-collage> и </tg-collage> (каждая ![](URL) с новой строки, с пустыми строками внутри блока). URL бери ТОЛЬКО из этого списка, не выдумывай.\n`;
  }

  if (userProfile) {
      const score = userProfile.relationship || 50;
      let relationText = score <= 20 ? "СТАТУС: ВРАГ." : score >= 80 ? "СТАТУС: БРАТАН." : "СТАТУС: НЕЙТРАЛЬНО.";
      personalInfo += `\n--- ДОСЬЕ ---\nФакты: ${userProfile.facts || "Нет"}\n`;
      if (userProfile.location) personalInfo += `📍 Локация: ${userProfile.location}\n`;
      personalInfo += `${relationText}\n-----------------\n`;
  }

  const fullPromptText = prompts.mainChat({
      time: this.getCurrentTime(),
      isSpontaneous: isSpontaneous,
      userMessage: currentMessage.text,
      replyContext: replyContext,
      history: contextStr,
      personalInfo: personalInfo,
      senderName: currentMessage.sender,
      chatContext: chatProfile
  });

  // 3. ЗАПРОС К SMART МОДЕЛИ (API)
  if (this.openai) {
      try {
          const messages = [{ role: "system", content: prompts.system() }, { role: "user", content: [] }];
          messages[1].content.push({ type: "text", text: fullPromptText });
          if (imageBuffer) {
              messages[1].content.push({
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` }
              });
          }

          const completion = await this.openai.chat.completions.create({
              model: config.mainModel,
              messages: messages,
              max_tokens: 3500,
              temperature: 0.9,
          });
          
          storage.incrementStat('smart'); 
          return completion.choices[0].message.content.replace(/^thought[\s\S]*?\n\n/i, ''); 
      } catch (e) {
          console.error(`[API SMART FAIL] ${e.message}. Fallback to Native...`);
      }
  }

  // 4. FALLBACK (Если API упал или ключа нет)
  return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous, chatProfile);
}

// Helper для Native вызова (чтобы не дублировать код)
async generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous, chatProfile = null) {
    const relevantHistory = history.slice(-20);
    const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');

    // Собираем полную информацию о пользователе (как в основном методе)
    let personalInfo = "";
    let replyContext = "";

    if (currentMessage.replyText) {
        replyContext = `!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n"${currentMessage.replyText}"`;
    }

    if (userInstruction) {
        personalInfo += `\n!!! СПЕЦ-ИНСТРУКЦИЯ !!!\n${userInstruction}\n`;
    }

    if (userProfile) {
        const score = userProfile.relationship || 50;
        let relationText = score <= 20 ? "СТАТУС: ВРАГ." : score >= 80 ? "СТАТУС: БРАТАН." : "СТАТУС: НЕЙТРАЛЬНО.";
        personalInfo += `\n--- ДОСЬЕ ---\nФакты: ${userProfile.facts || "Нет"}\n`;
        if (userProfile.location) personalInfo += `📍 Локация: ${userProfile.location}\n`;
        personalInfo += `${relationText}\n-----------------\n`;
    }

    const fullPromptText = prompts.mainChat({
        time: this.getCurrentTime(),
        isSpontaneous: isSpontaneous,
        userMessage: currentMessage.text,
        replyContext: replyContext,
        history: contextStr,
        personalInfo: personalInfo,
        senderName: currentMessage.sender,
        chatContext: chatProfile
    });

    return this.executeNativeWithRetry(async () => {
      let promptParts = [];
      if (imageBuffer) promptParts.push({ inlineData: { mimeType: mimeType, data: imageBuffer.toString("base64") } });
      promptParts.push({ text: fullPromptText });

      const result = await this.nativeModel.generateContent({
          contents: [{ role: 'user', parts: promptParts }],
          generationConfig: { maxOutputTokens: 3500, temperature: 0.9 }
      });
      
      let text = result.response.text();
      if (result.response.candidates[0].groundingMetadata?.groundingChunks) {
           const links = result.response.candidates[0].groundingMetadata.groundingChunks
              .filter(c => c.web?.uri).map(c => `[${c.web.title || "Источник"}](${c.web.uri})`);
           const unique = [...new Set(links)].slice(0, 3);
           if (unique.length > 0) {
               text += `\n\n<details><summary>Источники</summary>\n\n` + unique.map((l, i) => `${i + 1}. ${l}`).join('\n') + `\n\n</details>`;
           }
      }
      return text;
    });
}

// === ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ (LOGIC MODEL) ===
  
  // Универсальный метод для логики
  async runLogicModel(promptJson) {
    // 1. Пробуем через API (Logic Model)
    if (this.openai) {
        try {
            const completion = await this.openai.chat.completions.create({
                model: config.logicModel,
                messages: [{ role: "user", content: promptJson }],
                response_format: { type: "json_object" }
            });
            storage.incrementStat('logic');
            return JSON.parse(completion.choices[0].message.content);
        } catch (e) {}
    }
    // 2. Fallback Native
    try {
        return await this.executeNativeWithRetry(async () => {
           const result = await this.nativeModel.generateContent(promptJson);
           let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
           const first = text.indexOf('{'), last = text.lastIndexOf('}');
           if (first !== -1 && last !== -1) text = text.substring(first, last + 1);
           return JSON.parse(text);
        });
    } catch (e) { return null; }
}

// Простой текстовый ответ (для реакций и ShouldAnswer)
async runLogicText(promptText) {
    if (this.openai) {
        try {
          const completion = await this.openai.chat.completions.create({
              model: config.logicModel,
              messages: [{ role: "user", content: promptText }]
          });
          storage.incrementStat('logic');
          return completion.choices[0].message.content;
        } catch (e) {}
    }
    return null; 
}

async analyzeUserImmediate(lastMessages, currentProfile) {
    return this.runLogicModel(prompts.analyzeImmediate(currentProfile, lastMessages));
}

// Определение необходимости поиска (AI-решение вместо regex)
async checkSearchNeeded(userMessage, recentHistory, chatTopic) {
    const prompt = prompts.shouldSearch(
        this.getCurrentTime(),
        userMessage,
        recentHistory,
        chatTopic
    );

    try {
        const result = await this.runLogicModel(prompt);
        if (result && typeof result.needsSearch === 'boolean') {
            console.log(`[SEARCH CHECK] needsSearch=${result.needsSearch}, query="${result.searchQuery}", reason="${result.reason}"`);
            return result;
        }
    } catch (e) {
        console.error(`[SEARCH CHECK ERROR] ${e.message}`);
    }

    // Fallback: не искать если AI не ответил
    return { needsSearch: false, searchQuery: null, reason: "fallback" };
}

async analyzeBatch(messagesBatch, currentProfiles) {
    const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
    const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');
    return this.runLogicModel(prompts.analyzeBatch(knownInfo, chatLog));
}

// Анализ профиля чата (каждые 50 сообщений)
async analyzeChatProfile(messagesBatch, currentProfile) {
    const messagesText = messagesBatch.map(m => `${m.name}: ${m.text}`).join('\n');
    return this.runLogicModel(prompts.analyzeChatProfile(currentProfile, messagesText));
}

// Обработка ручного описания чата (команда "Сыч, этот чат про...")
async processManualChatDescription(description, currentProfile) {
    return this.runLogicModel(prompts.processManualChatDescription(description, currentProfile));
}

async determineReaction(contextText) {
  const allowed = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
  const text = await this.runLogicText(prompts.reaction(contextText, allowed.join(" ")));
  if (!text) return null;
  const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
  return (match && allowed.includes(match[0])) ? match[0] : null;
}

async generateProfileDescription(profileData, targetName) {
    if (this.openai) {
      try {
          const completion = await this.openai.chat.completions.create({ model: config.mainModel, messages: [{ role: "user", content: prompts.profileDescription(targetName, profileData) }] });
          storage.incrementStat('smart'); return completion.choices[0].message.content;
      } catch(e) {}
    }
    return "Не знаю такого.";
}

async generateFlavorText(task, result) {
  if (this.openai) {
      try {
          const completion = await this.openai.chat.completions.create({ model: config.mainModel, messages: [{ role: "user", content: prompts.flavor(task, result) }] });
          storage.incrementStat('smart'); return completion.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
      } catch(e) {}
  }
  return `${result}`;
}

  // === ТРАНСКРИБАЦИЯ ===
  async transcribeAudio(audioBuffer, userName, mimeType) {
    // Только Native поддерживает загрузку файлов из буфера так легко и бесплатно
    if (!this.keys || this.keys.length === 0) {
        console.warn("[AI WARN] Получено голосовое, но нет ключей Google для расшифровки. Пропускаю.");
        return null;
    }

    try {
        return await this.executeNativeWithRetry(async () => {
          const parts = [ { inlineData: { mimeType: mimeType, data: audioBuffer.toString("base64") } }, { text: prompts.transcription(userName) }];
          const result = await this.nativeModel.generateContent(parts);
          let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
          const first = text.indexOf('{'), last = text.lastIndexOf('}');
          if (first !== -1 && last !== -1) text = text.substring(first, last + 1);
          return JSON.parse(text);
        });
    } catch (e) { 
        console.error(`[TRANSCRIPTION FAIL] ${e.message}`);
        return null; 
    }
  }

  // === ПАРСИНГ НАПОМИНАНИЯ (С КОНТЕКСТОМ) ===
  async parseReminder(userText, contextText = "") {
    const now = this.getCurrentTime();
    const prompt = prompts.parseReminder(now, userText, contextText);
    return this.runLogicModel(prompt);
  }
}

module.exports = new AiService();