const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const axios = require('axios');
const OpenAI = require('openai');
const { tavily } = require('@tavily/core'); // Клиент Tavily

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

    // === СТАТИСТИКА ===
    this.stats = { 
        smart: 0, 
        logic: 0, 
        search: 0,
        google: this.keys.map(() => ({ count: 0, status: true }))
    };
    this.lastResetDate = new Date().getDate(); 
    
    if (this.keys.length === 0) console.warn("WARNING: Нет ключей Gemini в .env! Fallback не сработает.");
    this.initNativeModel();
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  notifyAdmin(message) {
    if (this.bot && config.adminId) {
        this.bot.sendMessage(config.adminId, message, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  // Сброс статистики в полночь
  resetStatsIfNeeded() {
    const today = new Date().getDate();
    if (today !== this.lastResetDate) {
        this.stats = { smart: 0, logic: 0, search: 0, google: this.keys.map(() => ({ count: 0, status: true })) };
        this.lastResetDate = today;
        
        if (this.usingFallback) {
            this.usingFallback = false;
            this.keyIndex = 0;
            this.initNativeModel();
            this.notifyAdmin("🌙 **Новый день!**\nЛимиты сброшены. Возврат в основной режим.");
        }
    }
  }

  getStatsReport() {
  this.resetStatsIfNeeded();
  const mode = this.usingFallback ? "⚠️ FALLBACK (Google Native)" : "⚡ API MODE";

  const apiText = `🌐 **API (${config.aiBaseUrl}):**\n   Smart: ${this.stats.smart}\n   Logic: ${this.stats.logic}\n   Search: ${this.stats.search}`;
  const googleRows = this.stats.google.map((s, i) => `   🔑${i + 1}: ${s.status ? "🟢" : "🔴"} ${s.count}`).join('\n');

  return `Режим: ${mode}\n\n${apiText}\n\n💎 **Google Native:**\n${googleRows}`;
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
    if (this.stats.google[this.keyIndex]) this.stats.google[this.keyIndex].status = false;
    
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
            if (this.stats.google[this.keyIndex]) this.stats.google[this.keyIndex].count++;
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
    return `${time} (Базовое время: Екатеринбург, UTC+5)`;
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
              include_answer: true 
          });
          this.stats.search++;
          
          let resultText = "";
          if (response.answer) resultText += `Краткий ответ Tavily: ${response.answer}\n\n`;
          response.results.forEach((res, i) => {
              resultText += `[${i+1}] ${res.title} (${res.url}):\n${res.content}\n\n`;
          });
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
          this.stats.search++;
          return completion.choices[0].message.content;
      } catch (e) {
          console.error(`[PERPLEXITY FAIL] ${e.message}`);
          return null;
      }
  }
  
  return null;
}
  
// === ОСНОВНОЙ ОТВЕТ ===
async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false) {
  this.resetStatsIfNeeded();
  console.log(`[DEBUG AI] getResponse вызван.`);

  // 1. АНАЛИЗ НА ПОИСК
  const searchTriggers = /(курс|погода|новости|цена|стоимость|сколько стоит|найди|погугли|информация о|события|счет матча|кто такой|что такое|где купить|дата выхода|когда)/i;
  const needsSearch = searchTriggers.test(currentMessage.text);
  
  // 1. ПОПЫТКА RAG (TAVILY / PERPLEXITY)
    // Пробуем искать, если провайдер НЕ google
    let searchResultText = "";
    if (needsSearch && config.searchProvider !== 'google') {
        searchResultText = await this.performSearch(currentMessage.text);
    }

    // 2. УМНЫЙ FALLBACK НА GOOGLE SEARCH
    // Если:
    // a) Нужен поиск
    // b) RAG ничего не нашел (нет ключа Tavily или ошибка)
    // c) У нас есть ключи Google
    // -> То идем в Google Native
    if (needsSearch && !searchResultText && this.keys.length > 0) {
        console.log(`[ROUTER] Tavily/Perplexity недоступен или выключен. Переключаюсь на Google Native Search.`);
        return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous);
    }
    
    // 3. ПРЯМОЙ ВЫБОР GOOGLE
    // Если в конфиге явно стоит 'google', мы попадем сюда (так как step 1 пропущен)
    if (needsSearch && config.searchProvider === 'google' && this.keys.length > 0) {
         return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous);
    }

  // 2. СБОРКА ПРОМПТА
  const relevantHistory = history.slice(-20); 
  const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
  let personalInfo = "";
  let replyContext = "";

  if (currentMessage.replyText) replyContext = `!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n"${currentMessage.replyText}"`;
  if (userInstruction) personalInfo += `\n!!! СПЕЦ-ИНСТРУКЦИЯ !!!\n${userInstruction}\n`;
  
  if (searchResultText) {
      personalInfo += `\n!!! ДАННЫЕ ИЗ ПОИСКА (${config.searchProvider.toUpperCase()}) !!!\n${searchResultText}\nИНСТРУКЦИЯ: Ответь, используя эти факты. УКАЖИ ССЫЛКИ.\n`;
  }

  if (userProfile) {
      const score = userProfile.relationship || 50;
      let relationText = score <= 20 ? "СТАТУС: ВРАГ." : score >= 80 ? "СТАТУС: БРАТАН." : "СТАТУС: НЕЙТРАЛЬНО.";
      personalInfo += `\n--- ДОСЬЕ ---\nФакты: ${userProfile.facts || "Нет"}\n`;
      if (userProfile.location) personalInfo += `📍 ЛОКАЦИЯ: ${userProfile.location} (Учитывай это!)\n`;
      personalInfo += `${relationText}\n-----------------\n`;
  }

  const fullPromptText = prompts.mainChat({
      time: this.getCurrentTime(),
      isSpontaneous: isSpontaneous,
      userMessage: currentMessage.text,
      replyContext: replyContext,
      history: contextStr,
      personalInfo: personalInfo,
      senderName: currentMessage.sender
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
              max_tokens: 2500,
              temperature: 0.9,
          });
          
          this.stats.smart++; 
          return completion.choices[0].message.content.replace(/^thought[\s\S]*?\n\n/i, ''); 
      } catch (e) {
          console.error(`[API SMART FAIL] ${e.message}. Fallback to Native...`);
      }
  }

  // 4. FALLBACK (Если API упал или ключа нет)
  return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous);
}

// Helper для Native вызова (чтобы не дублировать код)
async generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous) {
    // Собираем промпт заново, но без RAG поиска (Google сам найдет)
    // Для простоты здесь можно собрать минимальный промпт или дублировать логику сборки
    // Я сделаю упрощенную сборку на основе переданных параметров
    const relevantHistory = history.slice(-20); 
    const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
    let personalInfo = "";
    if (userProfile) personalInfo += `\nФакты: ${userProfile.facts || ""}\n`;
    
    const fullPromptText = prompts.mainChat({
      time: this.getCurrentTime(),
      isSpontaneous: isSpontaneous,
      userMessage: currentMessage.text,
      replyContext: currentMessage.replyText ? `Reply to: ${currentMessage.replyText}` : "",
      history: contextStr,
      personalInfo: personalInfo,
      senderName: currentMessage.sender
  });

    return this.executeNativeWithRetry(async () => {
      let promptParts = [];
      if (imageBuffer) promptParts.push({ inlineData: { mimeType: mimeType, data: imageBuffer.toString("base64") } });
      promptParts.push({ text: fullPromptText });

      const result = await this.nativeModel.generateContent({
          contents: [{ role: 'user', parts: promptParts }],
          generationConfig: { maxOutputTokens: 2500, temperature: 0.9 }
      });
      
      let text = result.response.text();
      if (result.response.candidates[0].groundingMetadata?.groundingChunks) {
           const links = result.response.candidates[0].groundingMetadata.groundingChunks
              .filter(c => c.web?.uri).map(c => `[${c.web.title || "Источник"}](${c.web.uri})`);
           const unique = [...new Set(links)].slice(0, 3);
           if (unique.length > 0) text += "\n\nНашел тут: " + unique.join(" • ");
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
            this.stats.logic++;
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
          this.stats.logic++;
          return completion.choices[0].message.content;
        } catch (e) {}
    }
    return null; 
}

async analyzeUserImmediate(lastMessages, currentProfile) { 
    return this.runLogicModel(prompts.analyzeImmediate(currentProfile, lastMessages)); 
}

async analyzeBatch(messagesBatch, currentProfiles) {
    const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
    const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');
    return this.runLogicModel(prompts.analyzeBatch(knownInfo, chatLog));
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
          this.stats.smart++; return completion.choices[0].message.content;
      } catch(e) {}
    }
    return "Не знаю такого.";
}

async generateFlavorText(task, result) {
  if (this.openai) {
      try {
          const completion = await this.openai.chat.completions.create({ model: config.mainModel, messages: [{ role: "user", content: prompts.flavor(task, result) }] });
          this.stats.smart++; return completion.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
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
    const requestLogic = async () => {
        this.countRequest('gemma');
        const now = this.getCurrentTime(); 
        // Передаем теперь три аргумента: Время, Текст юзера, Текст сообщения-исходника
        const prompt = prompts.parseReminder(now, userText, contextText);
        
        const result = await this.logicModel.generateContent(prompt);
        let text = result.response.text();
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
        
        return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic, 'gemma'); } catch (e) { return null; }
  }
}

module.exports = new AiService();