const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const axios = require('axios');

class AiService {
  constructor() {
    this.keyIndex = 0; 
    this.keys = config.geminiKeys;
    this.usingFallback = false; 
    this.bot = null; // Ссылка на бота для уведомлений

    // === СТАТИСТИКА ===
    this.stats = this.keys.map(() => ({ flash: 0, lite: 0, gemma: 0, status: true }));
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

  // Метод для подсчета (вставь его сразу после конструктора или перед initModel)
  countRequest(type) {
    const today = new Date().getDate();
    
    // === СБРОС В ПОЛНОЧЬ ===
    if (today !== this.lastResetDate) {
        this.stats = this.keys.map(s => ({ flash: 0, lite: 0, gemma: 0, status: true })); // Оживляем все ключи
        this.lastResetDate = today;
        
        // Если сидели на Lite — возвращаемся на Flash
        if (this.usingFallback) {
            this.usingFallback = false;
            this.keyIndex = 0;
            this.initModel(); // Пересоздаем модель с конфигом Flash
            this.notifyAdmin("🌙 **Новый день!**\nЛимиты сброшены.\nРежим переключен на: ⚡ **FLASH**");
        } else {
             // Если и так были на Flash, просто сбрасываем индекс на первый ключ
             this.keyIndex = 0;
             this.initModel();
        }
    }
    // =======================

    if (this.stats[this.keyIndex]) {
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
        this.stats[this.keyIndex].status = true; 
    }
  }

  // Метод для вывода отчета
  getStatsReport() {
    const mode = this.usingFallback ? "⚠️ LITE РЕЖИМ" : "⚡ FLASH РЕЖИМ";
    
    const rows = this.stats.map((s, i) => {
        const icon = s.status ? "🟢" : "🔴";
        // Формат: 🟢1 — Flash • Lite • Gemma
        return `${icon}${i + 1} — ${s.flash} • ${s.lite} • ${s.gemma}`;
    }).join('\n');

    return `Текущий режим: ${mode}\n\n(Flash • Lite • Gemma)\n${rows}`;
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

  rotateKey() {
    // Помечаем текущий ключ как "Мертвый" (🔴)
    if (this.stats[this.keyIndex]) this.stats[this.keyIndex].status = false;

    console.log(`[AI WARNING] Ключ #${this.keyIndex + 1} исчерпан (🔴).`);

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

  async executeWithRetry(apiCallFn) {
    // Умножаем на 2, так как у нас теперь 2 прохода (Flash + Lite)
    const maxAttempts = this.keys.length * 2 + 1; 

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await apiCallFn();
        } catch (error) {
            const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('Resource has been exhausted') || error.message.includes('Too Many Requests');
            
            if (isQuotaError) {
                this.rotateKey();
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
    const requestLogic = async () => {
        let promptParts = [];
        
        if (imageBuffer) {
          promptParts.push({ inlineData: { mimeType: mimeType, data: imageBuffer.toString("base64") } });
          promptParts.push({ text: "Проанализируй этот файл. Опиши, что там, или ответь на вопрос по нему." });
        }

        const relevantHistory = history.slice(-20); 
        const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
        
        let personalInfo = "";
        let replyContext = "";

        if (currentMessage.replyText) {
            replyContext = `!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n"${currentMessage.replyText}"`;
        }

        if (userInstruction) personalInfo += `\n!!! СПЕЦ-ИНСТРУКЦИЯ !!!\n${userInstruction}\n`;

        if (userProfile) {
            const score = userProfile.relationship || 50;
            let relationText = "";
            if (score <= 20) relationText = `СТАТУС: ВРАГ (${score}/100). Отвечай грубо, с сарказмом.`;
            else if (score <= 40) relationText = `СТАТУС: ХОЛОД (${score}/100). Язви, не доверяй.`;
            else if (score >= 80) relationText = `СТАТУС: БРАТАН (${score}/100). Поддерживай, шути по-доброму.`;
            
            personalInfo += `\n--- ДОСЬЕ ---\nФакты: ${userProfile.facts || "Нет"}\n${relationText}\n-----------------\n`;
        }

        const fullPromptText = 
            prompts.mainChat({
                time: this.getCurrentTime(),
                isSpontaneous: isSpontaneous,
                userMessage: currentMessage.text,
                replyContext: replyContext,
                history: contextStr,
                personalInfo: personalInfo,
                senderName: currentMessage.sender
            });

        promptParts.push({ text: fullPromptText });

        console.log(`[DEBUG AI] Отправляю запрос...`);
        
        // !!! ВОТ ТУТ ГЛАВНОЕ ИЗМЕНЕНИЕ !!!
        // Переопределяем конфиг ТОЛЬКО для этого запроса.
        // maxOutputTokens: 1000 — это примерно 1 длинное сообщение в Telegram.
        // Это не даст ему генерировать бесконечные статьи.
        const result = await this.creativeModel.generateContent({
            contents: [{ role: 'user', parts: promptParts }],
            generationConfig: {
                maxOutputTokens: 2500, 
                temperature: 0.9
            }
        });
        
        const response = result.response;
        let text = response.text();

        // === CLEANUP (ОБЯЗАТЕЛЬНО!) ===
        // Убираем только технический мусор, не трогая текст сообщения
        text = text.replace(/^toolcode[\s\S]*?print\(.*?\)\s*/i, ''); // Следы от поиска
        text = text.replace(/^thought[\s\S]*?\n\n/i, ''); // Технический блок мыслей (если API его вернет явно)
        text = text.replace(/```json/g, '').replace(/```/g, '').trim(); // Маркдаун обертки
        // ==============================

        // --- ИСТОЧНИКИ ---
        if (response.candidates && response.candidates[0].groundingMetadata) {
            const metadata = response.candidates[0].groundingMetadata;
            if (metadata.groundingChunks) {
                const links = [];
                metadata.groundingChunks.forEach(chunk => {
                    if (chunk.web && chunk.web.uri) {
                        let siteName = "Источник";
                        try { siteName = chunk.web.title || "Источник"; } catch (e) {}
                        links.push(`[${siteName}](${chunk.web.uri})`);
                    }
                });
                const uniqueLinks = [...new Set(links)].slice(0, 3);
                if (uniqueLinks.length > 0) text += "\n\nНашел тут: " + uniqueLinks.join(" • ");
            }
        }
        return text;
    };

    try { return await this.executeWithRetry(requestLogic); } catch (e) { throw e; }
  }

  // === РЕАКЦИЯ ===
  async determineReaction(contextText) {
    const allowed = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
    const requestLogic = async () => {
      const result = await this.logicModel.generateContent(prompts.reaction(contextText, allowed.join(" ")));
      let text = result.response.text().trim();
        const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
        if (match && allowed.includes(match[0])) return match[0];
        return null;
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === БЫСТРЫЙ АНАЛИЗ (С НОРМАЛЬНОЙ ЧИСТКОЙ) ===
  async analyzeUserImmediate(lastMessages, currentProfile) {
    const requestLogic = async () => {
      this.countRequest('gemma');
      const result = await this.logicModel.generateContent(prompts.analyzeImmediate(currentProfile, lastMessages));
      let text = result.response.text();
        
        // 1. Чистим Markdown-обертку (```json ... ```)
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // 2. Ищем границы JSON (на всякий случай, если бот написал вступление)
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1) {
            text = text.substring(firstBrace, lastBrace + 1);
        }
        
        // 3. Пробуем парсить
        return JSON.parse(text);
    };

    try { 
        return await this.executeWithRetry(requestLogic); 
    } catch (e) { 
        console.error(`[AI ANALYSIS ERROR]: ${e.message}`);
        // Возвращаем null, чтобы бот не падал, а просто пропускал этот шаг
        return null; 
    }
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
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  async generateProfileDescription(profileData, targetName) {
     const requestLogic = async () => {
        this.countRequest('gemini');
        const res = await this.creativeModel.generateContent(prompts.profileDescription(targetName, profileData));
        return res.response.text();
     };
     try { return await this.executeWithRetry(requestLogic); } catch(e) { return "Не знаю такого."; }
  }

  async generateFlavorText(task, result) {
    const requestLogic = async () => {
        this.countRequest('gemma');
        const res = await this.creativeModel.generateContent(prompts.flavor(task, result));
        return res.response.text().trim().replace(/^["']|["']$/g, '');
    };
    try { return await this.executeWithRetry(requestLogic); } catch(e) { return `${result}`; }
  }
  
  async shouldAnswer(lastMessages) {
    const requestLogic = async () => {
      this.countRequest('gemma');
      const res = await this.logicModel.generateContent(prompts.shouldAnswer(lastMessages));
      return res.response.text().toUpperCase().includes('YES');
  };
    try { return await this.executeWithRetry(requestLogic); } catch(e) { return false; }
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
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
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
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }
}

module.exports = new AiService();