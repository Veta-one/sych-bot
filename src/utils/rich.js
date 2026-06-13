// === RICH MESSAGES (Telegram Bot API 10.1, sendRichMessage) ===
// Единая точка отправки "богатых" сообщений.
// На новых клиентах Telegram рисует document-grade формат (заголовки, списки,
// таблицы, цитаты, сворачиваемые блоки <details>, спойлеры, код с подсветкой).
// На старых клиентах / при любой ошибке — автоматический фоллбэк в обычный sendMessage.
//
// node-telegram-bot-api пока не знает метод sendRichMessage, поэтому шлём сырым HTTP
// (тот же приём, что уже используется для getBusinessConnection в index.js).

const axios = require('axios');
const config = require('../config');

const API = `https://api.telegram.org/bot${config.telegramToken}`;

// Экранирование для вставки динамического текста в HTML-разметку.
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Грубая, но надёжная конвертация нашего HTML в читаемый плейн-текст (для фоллбэка).
function htmlToPlain(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n──────────\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<summary[^>]*>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|details|summary|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Markdown ИИ шлём как есть — Telegram rich рисует его красиво (в т.ч. таблицы).
// Единственное: гарантируем пустую строку ПЕРЕД таблицей, иначе парсер иногда
// не распознаёт её как таблицу, если прямо над ней идёт текст.
function normalizeMd(md = '') {
  const lines = String(md).split('\n');
  const out = [];
  const isRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const isSep = (s) => s.includes('|') && s.includes('-') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = out.length ? out[out.length - 1] : '';
    if (isRow(line) && isSep(lines[i + 1] || '') && prev.trim() !== '' && !isRow(prev)) {
      out.push(''); // вставляем пустую строку перед таблицей
    }
    out.push(line);
  }
  return out.join('\n');
}

function splitChunks(text, size = 4000) {
  return String(text).match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [String(text)];
}

/**
 * Отправляет богатое сообщение с авто-фоллбэком.
 * @param {object} bot — инстанс node-telegram-bot-api (нужен для фоллбэка)
 * @param {number|string} chatId
 * @param {{html?:string, markdown?:string, fallback?:string}} content — ровно одно из html / markdown
 * @param {{replyTo?:number, threadId?:number, businessId?:string, replyMarkup?:object, silent?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, mode:'rich'|'fallback', error?:string}>}
 */
async function sendRich(bot, chatId, content, opts = {}) {
  const rich = {};
  if (content.html != null) rich.html = content.html;
  else if (content.markdown != null) rich.markdown = content.markdown;
  else throw new Error('sendRich: нужен html или markdown');

  // Параметры для нового метода (стиль Bot API: reply_parameters вместо reply_to_message_id)
  const extra = {};
  if (opts.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  if (opts.threadId) extra.message_thread_id = opts.threadId;
  if (opts.businessId) extra.business_connection_id = opts.businessId;
  if (opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
  if (opts.silent) extra.disable_notification = true;

  // 1) Пытаемся отправить богато.
  // proxy:false — чтобы axios шёл напрямую (как node-telegram-bot-api), игнорируя
  // переменные окружения HTTP(S)_PROXY (иначе локальный прокси ломает запрос).
  try {
    await axios.post(`${API}/sendRichMessage`, { chat_id: chatId, rich_message: rich, ...extra }, { proxy: false });
    return { ok: true, mode: 'rich' };
  } catch (e) {
    const desc = e.response?.data?.description || e.message;

    // Если rich упал из-за медиа (битый URL картинки) — пробуем ещё раз БЕЗ картинок,
    // чтобы сохранить форматирование (таблицы/списки), а не падать в плоский текст.
    // Картинки Telegram качает сам со своей стороны, поэтому доверяем именно его вердикту.
    const hasImg = /!\[|<tg-(collage|slideshow)/i.test(content.markdown || '') || /<img|<tg-(collage|slideshow)/i.test(content.html || '');
    if (hasImg && /media|no_media|RICH_MESSAGE/i.test(desc)) {
      const noImg = {};
      if (content.markdown != null) noImg.markdown = content.markdown.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (content.html != null) noImg.html = content.html.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/<img[^>]*>/gi, '');
      try {
        await axios.post(`${API}/sendRichMessage`, { chat_id: chatId, rich_message: noImg, ...extra }, { proxy: false });
        console.error(`[RICH] медиа не прошло, отправил без картинок: ${desc}`);
        return { ok: true, mode: 'rich-noimg' };
      } catch (_) { /* падаем в общий фоллбэк ниже */ }
    }

    console.error(`[RICH] sendRichMessage упал, фоллбэк в текст: ${desc}`);

    // 2) Фоллбэк — обычный sendMessage
    const legacy = { disable_web_page_preview: true };
    if (opts.replyTo) legacy.reply_to_message_id = opts.replyTo;
    if (opts.threadId) legacy.message_thread_id = opts.threadId;
    if (opts.businessId) legacy.business_connection_id = opts.businessId;
    if (opts.replyMarkup) legacy.reply_markup = opts.replyMarkup;
    if (opts.silent) legacy.disable_notification = true;

    // Для markdown-контента пробуем сохранить разметку (legacy Markdown), иначе плейн.
    if (content.markdown != null && content.fallback == null) {
      for (const chunk of splitChunks(content.markdown)) {
        try {
          await bot.sendMessage(chatId, chunk, { ...legacy, parse_mode: 'Markdown' });
        } catch (_) {
          await bot.sendMessage(chatId, chunk, legacy); // совсем сырой текст
        }
      }
      return { ok: true, mode: 'fallback', error: desc };
    }

    const plain = content.fallback != null ? content.fallback
      : content.html != null ? htmlToPlain(content.html)
      : String(content.markdown || '');
    for (const chunk of splitChunks(plain)) {
      await bot.sendMessage(chatId, chunk, legacy);
    }
    return { ok: true, mode: 'fallback', error: desc };
  }
}

module.exports = { sendRich, htmlToPlain, escapeHtml, normalizeMd };
