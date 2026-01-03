const packageInfo = require('../package.json');
require('dotenv').config();

// Собираем ключи для Native Google (Fallback или Search)
const geminiKeys = [];
if (process.env.GOOGLE_GEMINI_API_KEY) geminiKeys.push(process.env.GOOGLE_GEMINI_API_KEY);
let i = 2;
while (process.env[`GOOGLE_GEMINI_API_KEY_${i}`]) {
    geminiKeys.push(process.env[`GOOGLE_GEMINI_API_KEY_${i}`]);
    i++;
}

console.log(`[CONFIG] Загружено ключей Gemini (Native): ${geminiKeys.length}`);

module.exports = {
  // === TELEGRAM ===
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  version: packageInfo.version,
  botId: parseInt(process.env.TELEGRAM_BOT_TOKEN.split(':')[0], 10),
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),
  
  // === OPENROUTER / API (Основной канал) ===
  aiBaseUrl: process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
  aiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY, 

  // === АКТУАЛЬНЫЕ МОДЕЛИ (ЯНВАРЬ 2026) ===
  
  // 1. УМНАЯ (Ответы в чате)
  mainModel: 'google/gemini-3-flash-preview', 
  
  // 2. ЛОГИКА (Анализ, реакции, проверки)
  // Free версия недоступна, используем эффективную платную
  logicModel: 'google/gemma-3-27b-it', 

  // === ПОИСК (RAG или NATIVE) ===
  // Варианты: 
  // 'tavily'     -> Использует Tavily API (RAG). Лучший вариант для сторонних моделей.
  // 'perplexity' -> Использует модель Sonar через OpenRouter (RAG).
  // 'google'     -> Переключается на нативный Google API с встроенным поиском (Tools).
  searchProvider: 'tavily', 
  
  // Настройки провайдеров
  tavilyKey: process.env.TAVILY_API_KEY,
  perplexityModel: 'perplexity/sonar', // Актуальный алиас

  // === GEMINI NATIVE (FALLBACK / SEARCH) ===
  geminiKeys: geminiKeys,
  googleNativeModel: 'gemini-2.5-flash-lite', 
  fallbackModelName: 'gemini-2.5-flash-lite', 
  contextSize: 30,
  triggerRegex: /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i,
};