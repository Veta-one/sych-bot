const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const axios = require('axios');
const OpenAI = require('openai');

class AiService {
  constructor() {
    // Инициализация OpenRouter
    this.openai = config.openRouterKey ? new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: config.openRouterKey,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/Veta-one/sych-bot",
          "X-Title": "Sych Bot"
        }
    }) : null;

    this.keyIndex = 0; 
    this.keys = config.geminiKeys;
    this.usingFallback = false; 
    this.bot = null; 

    // === СТАТИСТИКА ===
    // Добавили OpenRouter
    this.openRouterStats = { creative: 0, logic: 0 };
    
    // Старые ключи Gemini
    this.stats = this.keys.map(() => ({ 
      flash: 0, flashStatus: true,
      lite: 0, liteStatus: true,
      gemma: 0, gemmaStatus: true 
    }));
    this.lastResetDate = new Date().getDate(); 
    // ==================

    if (this.keys.length === 0) console.error("CRITICAL: Нет ключей Gemini в .env!");
    this.initModel();
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  notifyAdmin(message) {
    if (this.bot && config.adminId) {
        this.bot.sendMessage(config.adminId, message, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  // Метод для подсчета
  countRequest(type) {
    const today = new Date().getDate();
    
    // === СБРОС В ПОЛНОЧЬ ===
    if (today !== this.lastResetDate) {
        // Сброс Gemini
        this.stats = this.keys.map(() => ({ 
            flash: 0, flashStatus: true,
            lite: 0, liteStatus: true,
            gemma: 0, gemmaStatus: true 
        })); 
        
        // Сброс OpenRouter
        this.openRouterStats = { creative: 0, logic: 0 };

        this.lastResetDate = today;
        
        if (this.usingFallback) {
            this.usingFallback = false;
            this.keyIndex = 0;
            this.initModel(); 
            this.notifyAdmin("🌙 **Новый день!**\nЛимиты сброшены.\nРежим переключен на: ⚡ **FLASH**");
        } else {
            this.keyIndex = 0;
            this.initModel();
        }
    }
    // =======================

    // Логика подсчета
    if (type === 'openrouter-creative') {
        this.openRouterStats.creative++;
    } 
    else if (type === 'openrouter-logic') {
        this.openRouterStats.logic++;
    }
    else if (this.stats[this.keyIndex]) {
        if (type === 'gemma') {
            this.stats[this.keyIndex].gemma++;
        } 
        else if (type === 'gemini') {
            if (this.usingFallback) {
                this.stats[this.keyIndex].lite++;
            } else {
                this.stats[this.keyIndex].flash++;
            }
        }
    }
  }

  // Метод для вывода отчета
  getStatsReport() {
    const mode = this.usingFallback ? "⚠️ FALLBACK (LITE)" : "⚡ NORMAL";
    
    // Блок OpenRouter
    const orText = `🌐 **OpenRouter:**\n   Creative: ${this.openRouterStats.creative}\n   Logic: ${this.openRouterStats.logic}`;

    // Блок Gemini
    const geminiRows = this.stats.map((s, i) => {
        const fIcon = s.flashStatus ? "🟢" : "🔴";
        const lIcon = s.liteStatus ? "🟢" : "🔴";
        const gIcon = s.gemmaStatus ? "🟢" : "🔴";
        return `   🔑${i + 1}: ${fIcon}${s.flash} • ${lIcon}${s.lite} • ${gIcon}${s.gemma}`;
    }).join('\n');

    return `Режим Gemini: ${mode}\n\n${orText}\n\n💎 **Google Keys:**\n   (Flash • Lite • Gemma)\n${geminiRows}`;
  }

  initModel() {
    const currentKey = this.keys[this.keyIndex];
    const genAI = new GoogleGenerativeAI(currentKey);
    
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    // Выбираем модель: Основная или Lite
    const currentModelName = this.usingFallback ? config.fallbackModelName : config.modelName;
    
    console.log(`[AI INIT] Ключ #${this.keyIndex + 1} | Модель: ${currentModelName} | Режим: ${this.usingFallback ? "FALLBACK (LITE)" : "NORMAL"}`);

    // 1. ТВОРЧЕСКАЯ МОДЕЛЬ
    this.creativeModel = genAI.getGenerativeModel({ 
        model: currentModelName,
        systemInstruction: prompts.system(),
        safetySettings: safetySettings,
        generationConfig: { maxOutputTokens: 8000, temperature: 0.9 }, 
        tools: [{ googleSearch: {} }] 
    });

    // 2. ЛОГИЧЕСКАЯ МОДЕЛЬ (Gemma всегда одна и та же)
    this.logicModel = genAI.getGenerativeModel({ 
        model: config.logicModelName,
        safetySettings: safetySettings,
        generationConfig: { maxOutputTokens: 8000, temperature: 0.2 }, 
    });
  }

  rotateKey(failedModelType) {
    // Помечаем красным только ту модель, которая отвалилась
    if (this.stats[this.keyIndex]) {
        if (failedModelType === 'gemma') {
            this.stats[this.keyIndex].gemmaStatus = false;
        } else if (failedModelType === 'gemini') {
            if (this.usingFallback) {
                this.stats[this.keyIndex].liteStatus = false;
            } else {
                this.stats[this.keyIndex].flashStatus = false;
            }
        }
    }

    console.log(`[AI WARNING] Ключ #${this.keyIndex + 1} исчерпан на модели ${failedModelType} (🔴).`);

    // Переходим к следующему
    this.keyIndex++;

    // Если прошли все ключи
    if (this.keyIndex >= this.keys.length) {
      if (!this.usingFallback) {
        // КРУГ 1 ЗАКОНЧИЛСЯ. ВКЛЮЧАЕМ LITE (КРУГ 2)
        console.log("⚠️ ВСЕ КЛЮЧИ НА FLASH ИСЧЕРПАНЫ! ПЕРЕХОЖУ НА FLASH-LITE.");
        
        this.usingFallback = true; 
        this.keyIndex = 0; 
        this.stats.forEach(s => s.status = true);
        
        // Уведомляем админа
        this.notifyAdmin("⚠️ **Внимание!**\nВсе ключи Flash исчерпаны.\nРежим переключен на: 🕯 **LITE**");
      } else {
        // КРУГ 2 ТОЖЕ ЗАКОНЧИЛСЯ. ВСЁ.
        // Сбрасываем индексы, чтобы не крашнулось, но кидаем ошибку
        this.keyIndex = 0;
        console.error("☠️ GAME OVER. Все ключи на Flash и Lite мертвы.");
      }
    }

    this.initModel();
  }

  async executeWithRetry(apiCallFn, modelType) {
    const maxAttempts = this.keys.length * 2 + 1; 

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await apiCallFn();
        } catch (error) {
            const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('Resource has been exhausted') || error.message.includes('Too Many Requests');
            
            if (isQuotaError) {
                this.rotateKey(modelType); // <-- Передаем тип модели
                continue;
            } else {
                throw error;
            }
        }
    }
    throw new Error("Все ключи Gemini (Flash и Lite) исчерпали лимит!");
  }

  getCurrentTime() {
    return new Date().toLocaleString("ru-RU", {
      timeZone: "Asia/Yekaterinburg",
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  
// === ОСНОВНОЙ ОТВЕТ ===
async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false) {
  console.log(`[DEBUG AI] getResponse вызван. Текст: ${currentMessage.text.slice(0, 20)}...`);

  // 1. Подготовка данных
  const relevantHistory = history.slice(-20); 
  const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
  let personalInfo = "";
  let replyContext = "";

  if (currentMessage.replyText) replyContext = `!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n"${currentMessage.replyText}"`;
  if (userInstruction) personalInfo += `\n!!! СПЕЦ-ИНСТРУКЦИЯ !!!\n${userInstruction}\n`;
  if (userProfile) {
      const score = userProfile.relationship || 50;
      let relationText = "";
      if (score <= 20) relationText = `СТАТУС: ВРАГ (${score}/100). Отвечай грубо, с сарказмом.`;
      else if (score <= 40) relationText = `СТАТУС: ХОЛОД (${score}/100). Язви, не доверяй.`;
      else if (score >= 80) relationText = `СТАТУС: БРАТАН (${score}/100). Поддерживай, шути по-доброму.`;
      personalInfo += `\n--- ДОСЬЕ ---\nФакты: ${userProfile.facts || "Нет"}\n${relationText}\n-----------------\n`;
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

  // === ОПРЕДЕЛЯЕМ НУЖЕН ЛИ ПОИСК ===
  const searchTriggers = /(курс|погода|новости|цена|стоимость|сколько стоит|найди|погугли|информация о|события|счет матча|кто такой|что такое|где купить|дата выхода)/i;
  const needsSearch = searchTriggers.test(currentMessage.text);

  // 2. ПОПЫТКА OPENROUTER
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

          // Базовые настройки
          const requestOptions = {
              model: config.openRouterModel,
              messages: messages,
              max_tokens: 2500,
              temperature: 0.9,
          };

          // Если нужен поиск — подключаем плагин Exa
          if (needsSearch) {
              console.log("[OPENROUTER] Запрос требует инфы. Подключаю Web Search (Exa)...");
              requestOptions.extraBody = {
                  plugins: [
                      {
                          id: "web",
                          engine: "exa",       // Явно указываем движок Exa (для Gemini это обязательно)
                          max_results: 3,      // Экономим: берем 3 результата вместо 5
                          search_prompt: "Найди актуальную информацию на 2026 год: " // Помогаем модели понять контекст
                      }
                  ]
              };
          }

          const completion = await this.openai.chat.completions.create(requestOptions);
          
          this.countRequest('openrouter-creative'); 
          
          let text = completion.choices[0].message.content;
          return text.replace(/^thought[\s\S]*?\n\n/i, ''); 
      } catch (e) {
          console.error(`[OPENROUTER FAIL] Creative Error: ${e.message}. Fallback to Google...`);
      }
  }

  // 3. GOOGLE NATIVE (FALLBACK)
  // Сюда попадем только если OpenRouter вернет ошибку (например, кончились деньги)
  const requestLogic = async () => {
      this.countRequest('gemini');
      let promptParts = [];
      if (imageBuffer) {
        promptParts.push({ inlineData: { mimeType: mimeType, data: imageBuffer.toString("base64") } });
        promptParts.push({ text: "Проанализируй этот файл. Опиши, что там, или ответь на вопрос по нему." });
      }
      promptParts.push({ text: fullPromptText });

      const result = await this.creativeModel.generateContent({
          contents: [{ role: 'user', parts: promptParts }],
          generationConfig: { maxOutputTokens: 2500, temperature: 0.9 }
      });
      
      let text = result.response.text();
      if (result.response.candidates && result.response.candidates[0].content && result.response.candidates[0].content.parts) {
           const parts = result.response.candidates[0].content.parts;
           if (parts.length > 0) text = parts[parts.length - 1].text;
      }
      
      text = text.replace(/^toolcode[\s\S]*?print\(.*?\)\s*/i, '').replace(/^thought[\s\S]*?\n\n/i, '').replace(/```json/g, '').replace(/```/g, '').trim();
      
      if (result.response.candidates[0].groundingMetadata?.groundingChunks) {
          const links = result.response.candidates[0].groundingMetadata.groundingChunks
              .filter(c => c.web?.uri).map(c => `[${c.web.title || "Источник"}](${c.web.uri})`);
          const unique = [...new Set(links)].slice(0, 3);
          if (unique.length > 0) text += "\n\nНашел тут: " + unique.join(" • ");
      }
      return text;
  };

  try { return await this.executeWithRetry(requestLogic, 'gemini'); } catch (e) { throw e; }
}

// === РЕАКЦИЯ ===
async determineReaction(contextText) {
  const allowed = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
  
  // 1. OpenRouter Logic
  if (this.openai) {
      try {
          const completion = await this.openai.chat.completions.create({
              model: config.openRouterLogicModel,
              messages: [{ role: "user", content: prompts.reaction(contextText, allowed.join(" ")) }]
          });
          this.countRequest('openrouter-logic');
          const text = completion.choices[0].message.content.trim();
          const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
          if (match && allowed.includes(match[0])) return match[0];
          return null;
      } catch (e) {}
  }

  // 2. Google Fallback
  const requestLogic = async () => {
    this.countRequest('gemma'); 
    const result = await this.logicModel.generateContent(prompts.reaction(contextText, allowed.join(" ")));
    let text = result.response.text().trim();
    const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    if (match && allowed.includes(match[0])) return match[0];
    return null;
  };
  try { return await this.executeWithRetry(requestLogic, 'gemma'); } catch (e) { return null; }
}

  // === БЫСТРЫЙ АНАЛИЗ ===
  async analyzeUserImmediate(lastMessages, currentProfile) {
    // 1. OpenRouter Logic
    if (this.openai) {
        try {
            const completion = await this.openai.chat.completions.create({
                model: config.openRouterLogicModel, // Используем FREE модель
                messages: [{ role: "user", content: prompts.analyzeImmediate(currentProfile, lastMessages) }],
                response_format: { type: "json_object" } // OpenRouter поддерживает JSON режим
            });
            this.countRequest('openrouter-logic');
            return JSON.parse(completion.choices[0].message.content);
        } catch (e) { console.error(`[OR LOGIC FAIL] Analyze: ${e.message}`); }
    }

    // 2. Google Fallback
    const requestLogic = async () => {
      this.countRequest('gemma');
      const result = await this.logicModel.generateContent(prompts.analyzeImmediate(currentProfile, lastMessages));
      let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
      const first = text.indexOf('{'), last = text.lastIndexOf('}');
      if (first !== -1 && last !== -1) text = text.substring(first, last + 1);
      return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic, 'gemma'); } catch (e) { return null; }
  }

  // === МАССОВЫЙ АНАЛИЗ ===
  async analyzeBatch(messagesBatch, currentProfiles) {
    const requestLogic = async () => {
      this.countRequest('gemma');
      const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
      const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');
      
      const result = await this.logicModel.generateContent(prompts.analyzeBatch(knownInfo, chatLog));
        let text = result.response.text();
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic, 'gemma'); } catch (e) { return null; }
  }

  async generateProfileDescription(profileData, targetName) {
     const requestLogic = async () => {
        this.countRequest('gemini');
        const res = await this.creativeModel.generateContent(prompts.profileDescription(targetName, profileData));
        return res.response.text();
     };
     try { return await this.executeWithRetry(requestLogic, 'gemini'); } catch(e) { return "Не знаю такого."; }
  }

  async generateFlavorText(task, result) {
    const requestLogic = async () => {
        this.countRequest('gemini');
        const res = await this.creativeModel.generateContent(prompts.flavor(task, result));
        return res.response.text().trim().replace(/^["']|["']$/g, '');
    };
    try { return await this.executeWithRetry(requestLogic, 'gemini'); } catch(e) { return `${result}`; }
  }
  
  async shouldAnswer(lastMessages) {
    // 1. OpenRouter Logic
    if (this.openai) {
        try {
            const completion = await this.openai.chat.completions.create({
                model: config.openRouterLogicModel,
                messages: [{ role: "user", content: prompts.shouldAnswer(lastMessages) }]
            });
            this.countRequest('openrouter-logic');
            return completion.choices[0].message.content.toUpperCase().includes('YES');
        } catch (e) {}
    }

    // 2. Google Fallback
    const requestLogic = async () => {
      this.countRequest('gemma');
      const res = await this.logicModel.generateContent(prompts.shouldAnswer(lastMessages));
      return res.response.text().toUpperCase().includes('YES');
    };
    try { return await this.executeWithRetry(requestLogic, 'gemma'); } catch(e) { return false; }
  }

  // === ТРАНСКРИБАЦИЯ ===
  async transcribeAudio(audioBuffer, userName = "Пользователь", mimeType = "audio/ogg") {
    const requestLogic = async () => {
        this.countRequest('gemini');
        const parts = [
            { inlineData: { mimeType: mimeType, data: audioBuffer.toString("base64") } },
            { text: prompts.transcription(userName) }
        ];
        const result = await this.creativeModel.generateContent(parts);
        let text = result.response.text();
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic, 'gemini'); } catch (e) { return null; }
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