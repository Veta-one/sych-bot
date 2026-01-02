const packageInfo = require('../package.json');
require('dotenv').config();

// Собираем все ключи Gemini в массив
const geminiKeys = [];
if (process.env.GOOGLE_GEMINI_API_KEY) geminiKeys.push(process.env.GOOGLE_GEMINI_API_KEY);

// Ищем ключи с суффиксами _2, _3 и т.д.
let i = 2;
while (process.env[`GOOGLE_GEMINI_API_KEY_${i}`]) {
    geminiKeys.push(process.env[`GOOGLE_GEMINI_API_KEY_${i}`]);
    i++;
}

console.log(`[CONFIG] Загружено ключей Gemini: ${geminiKeys.length}`);

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  version: packageInfo.version,
  botId: parseInt(process.env.TELEGRAM_BOT_TOKEN.split(':')[0], 10),
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),
  
  geminiKeys: geminiKeys,
  
  modelName: 'gemini-3-flash-preview', //gemini-2.5-flash
  fallbackModelName: 'gemini-2.5-flash', // Запасной вариант
  logicModelName: 'gemma-3-27b-it', // Рабочая лошадка для логики
  contextSize: 30,
  contextSize: 30,
  triggerRegex: /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i,

  // === OPENROUTER CONFIG ===
  openRouterKey: process.env.OPENROUTER_API_KEY, 
  
  // Модель для ОТВЕТОВ (умная)
  openRouterModel: 'google/gemini-3-flash-preview', // Или 'google/gemini-3-flash-preview' если она там уже есть
  
  // Модель для ЛОГИКИ (бесплатная/дешевая: реакции, анализ, проверки)
  openRouterLogicModel: 'google/gemma-3-27b-it:free', 

  // Модель для ПОИСКА (RAG)
  openRouterSearchModel: 'perplexity/sonar',

};


