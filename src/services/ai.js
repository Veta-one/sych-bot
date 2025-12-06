const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const axios = require('axios');

class AiService {
  constructor() {
    this.keyIndex = 0; 
    this.keys = config.geminiKeys;
    if (this.keys.length === 0) console.error("CRITICAL: Нет ключей Gemini в .env!");
    this.initModel();
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

    const generationConfig = {
        maxOutputTokens: 8000,
        temperature: 0.9,
    };

    // [FIX] Добавляем системную инструкцию прямо в модель для железного характера
      this.model = genAI.getGenerativeModel({ 
        model: config.modelName,
        systemInstruction: prompts.system(), 
        safetySettings: safetySettings,
        generationConfig: generationConfig, 
        tools: [{ googleSearch: {} }] 
    });
  }

  rotateKey() {
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    console.log(`[AI WARNING] Лимит ключа исчерпан! Переключаюсь на ключ #${this.keyIndex + 1}...`);
    this.initModel();
  }

  async executeWithRetry(apiCallFn) {
    for (let attempt = 0; attempt < this.keys.length; attempt++) {
        try {
            return await apiCallFn();
        } catch (error) {
            const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('Resource has been exhausted');
            if (isQuotaError) {
                this.rotateKey();
                continue;
            } else {
                throw error;
            }
        }
    }
    throw new Error("Все ключи Gemini исчерпали лимит!");
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
        const result = await this.model.generateContent({
            contents: [{ role: 'user', parts: promptParts }],
            generationConfig: {
                maxOutputTokens: 2500, 
                temperature: 0.9
            }
        });
        
        const response = result.response;
        let text = response.text();

        // === CLEANUP (ОБЯЗАТЕЛЬНО!) ===
        // Убираем "мысли вслух", из-за которых был глюк с магнитными бурями
        text = text.replace(/^toolcode[\s\S]*?print\(.*?\)\s*/i, '');
        text = text.replace(/^thought[\s\S]*?\n\n/i, '');
        // Убираем markdown мусор
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
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
        const result = await this.model.generateContent(prompts.reaction(contextText, allowed.join(" ")));
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
        const result = await this.model.generateContent(prompts.analyzeImmediate(currentProfile, lastMessages));
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
        const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
        const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');
        
        const result = await this.model.generateContent(prompts.analyzeBatch(knownInfo, chatLog));
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
        const res = await this.model.generateContent(prompts.profileDescription(targetName, profileData));
        return res.response.text();
     };
     try { return await this.executeWithRetry(requestLogic); } catch(e) { return "Не знаю такого."; }
  }

  async generateFlavorText(task, result) {
    const requestLogic = async () => {
        const res = await this.model.generateContent(prompts.flavor(task, result));
        return res.response.text().trim().replace(/^["']|["']$/g, '');
    };
    try { return await this.executeWithRetry(requestLogic); } catch(e) { return `${result}`; }
  }
  
  async shouldAnswer(lastMessages) {
    const requestLogic = async () => {
      const res = await this.model.generateContent(prompts.shouldAnswer(lastMessages));
      return res.response.text().toUpperCase().includes('YES');
  };
    try { return await this.executeWithRetry(requestLogic); } catch(e) { return false; }
  }

  // === ТРАНСКРИБАЦИЯ ===
  async transcribeAudio(audioBuffer, userName = "Пользователь", mimeType = "audio/ogg") {
    const requestLogic = async () => {
        const parts = [
            { inlineData: { mimeType: mimeType, data: audioBuffer.toString("base64") } },
            { text: prompts.transcription(userName) }
        ];
        const result = await this.model.generateContent(parts);
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
        const now = this.getCurrentTime(); 
        // Передаем теперь три аргумента: Время, Текст юзера, Текст сообщения-исходника
        const prompt = prompts.parseReminder(now, userText, contextText);
        
        const result = await this.model.generateContent(prompt);
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