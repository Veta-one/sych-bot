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
const { selectVoiceSummary, shouldSummarizeVoice } = require('./voice');
const { collapseHtmlQuotes, collapseMarkdownQuotes, quoteFallback } = require('./quotes');

const API = `https://api.telegram.org/bot${config.telegramToken}`;

// Экранирование для вставки динамического текста в HTML-разметку.
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatVoiceMessage(transcription) {
  const long = shouldSummarizeVoice(transcription.text);
  const transcript = `<blockquote${long ? '' : ' expandable'}>${escapeHtml(transcription.text).replace(/\r?\n/g, '<br/>')}</blockquote>`;
  const summary = selectVoiceSummary(transcription.text, transcription.summary);
  if (!long) return { html: transcript };
  return {
    html: (summary ? `<p>${escapeHtml(summary).replace(/\r?\n/g, '<br/>')}</p>`
      : '<p>Не удалось подготовить короткий пересказ. Полная расшифровка ниже.</p>')
      + `<details><summary>Расшифровка</summary>${transcript}</details>`,
  };
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

const safeEphemeralErrors = new WeakSet();

function ephemeralError(code) {
  // Do not attach an Axios error/cause: its URL contains the token and its
  // request/response may contain the private content. Callers may log errors.
  const messages = {
    EPHEMERAL_INVALID_OPTIONS: 'sendRich: invalid ephemeral options or content',
    EPHEMERAL_UNCONFIRMED: 'sendRich: ephemeral delivery could not be confirmed',
    EPHEMERAL_REJECTED: 'sendRich: private Telegram delivery was rejected',
    EPHEMERAL_TEXT_TOO_LONG: 'sendRich: private text fallback exceeds Telegram limits',
  };
  const error = new Error(messages[code] || messages.EPHEMERAL_UNCONFIRMED);
  error.code = code;
  safeEphemeralErrors.add(error);
  return error;
}

// A timeout or an unexpected success body might mean Telegram already sent the
// message. Retry only a confirmed API rejection, never an ambiguous response.
async function ephemeralRequest(method, payload) {
  let data;
  try {
    const response = await axios.post(`${API}/${method}`, payload, { proxy: false, timeout: 10000 });
    data = response.data;
  } catch (error) {
    if (error.response?.data?.ok !== false) throw ephemeralError('EPHEMERAL_UNCONFIRMED');
    data = error.response.data;
  }
  if (data?.ok === false) {
    return { rejected: true, description: typeof data.description === 'string' ? data.description : '' };
  }
  if (data?.ok !== true) throw ephemeralError('EPHEMERAL_UNCONFIRMED');
  return { result: data.result };
}

function ephemeralResult(response, receiverUserId, editId, mode) {
  if (editId !== undefined) {
    if (response.result !== true) throw ephemeralError('EPHEMERAL_UNCONFIRMED');
    return { ok: true, mode, ephemeralMessageId: editId };
  }
  const result = response.result;
  if (!Number.isSafeInteger(result?.ephemeral_message_id) || result.ephemeral_message_id === 0
    || (result.receiver_user != null && result.receiver_user.id !== receiverUserId)) {
    throw ephemeralError('EPHEMERAL_UNCONFIRMED');
  }
  return { ok: true, mode, ephemeralMessageId: result.ephemeral_message_id,
    messageDate: Number.isSafeInteger(result.date) && result.date > 0 ? result.date : undefined };
}

async function sendEphemeralRich(chatId, content, opts) {
  try {
    const ephemeral = opts.ephemeral;
    const validId = value => Number.isSafeInteger(value) && value !== 0;
    if (!ephemeral || typeof ephemeral !== 'object' || Array.isArray(ephemeral)
      || !Number.isSafeInteger(ephemeral.receiverUserId) || ephemeral.receiverUserId <= 0
      || (ephemeral.editId !== undefined && !validId(ephemeral.editId))
      || (ephemeral.replyToEphemeralId !== undefined && !validId(ephemeral.replyToEphemeralId))
      || (opts.replyTo !== undefined && (!Number.isSafeInteger(opts.replyTo) || opts.replyTo <= 0))
      || !content || (typeof content.html !== 'string' && typeof content.markdown !== 'string')
      || (content.html != null && content.markdown != null)
      || (content.fallback != null && typeof content.fallback !== 'string')) {
      throw ephemeralError('EPHEMERAL_INVALID_OPTIONS');
    }

    // Snapshot the recipient and identifiers before any await. Never spread
    // caller-provided parameters into a request carrying private content.
    const { receiverUserId, editId, replyToEphemeralId } = ephemeral;
    const rich = content.html != null ? { html: collapseHtmlQuotes(content.html) }
      : { markdown: collapseMarkdownQuotes(content.markdown) };
    const plain = content.fallback != null ? content.fallback
      : content.html != null ? htmlToPlain(content.html) : content.markdown;
    const extra = {};
    if (opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
    if (editId === undefined) {
      extra.ephemeral_message_parameters = { receiver_user_id: receiverUserId };
      if (replyToEphemeralId !== undefined) extra.reply_parameters = { ephemeral_message_id: replyToEphemeralId };
      else if (opts.replyTo !== undefined) extra.reply_parameters = { message_id: opts.replyTo };
      if (opts.threadId) extra.message_thread_id = opts.threadId;
      if (opts.silent) extra.disable_notification = true;
    } else {
      extra.receiver_user_id = receiverUserId;
      extra.ephemeral_message_id = editId;
    }
    const method = editId === undefined ? 'sendRichMessage' : 'editEphemeralMessageText';
    const send = richMessage => ephemeralRequest(method, { chat_id: chatId, rich_message: richMessage, ...extra });
    let response = await send(rich);
    if (!response.rejected) return ephemeralResult(response, receiverUserId, editId, 'rich');

    const hasMedia = /!\[|<img|<tg-(collage|slideshow)/i.test(rich.markdown || rich.html || '');
    if (hasMedia && /media|no_media|RICH_MESSAGE/i.test(response.description)) {
      const noImg = rich.markdown != null ? {
        markdown: rich.markdown.replace(/<\/?tg-(collage|slideshow)>/gi, '')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<img[^>]*>/gi, '')
          .replace(/\n{3,}/g, '\n\n').trim(),
      } : { html: rich.html.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/<img[^>]*>/gi, '') };
      response = await send(noImg);
      if (!response.rejected) return ephemeralResult(response, receiverUserId, editId, 'rich-noimg');
    }

    // A rich message may exceed sendMessage/edit text limits. Keep the full
    // answer or fail; slicing/replacing a placeholder repeatedly loses content.
    if (!plain.length || plain.length > 4096) throw ephemeralError('EPHEMERAL_TEXT_TOO_LONG');
    response = await ephemeralRequest(editId === undefined ? 'sendMessage' : method, {
      chat_id: chatId, text: plain, link_preview_options: { is_disabled: true }, ...extra,
    });
    if (response.rejected) throw ephemeralError('EPHEMERAL_REJECTED');
    return ephemeralResult(response, receiverUserId, editId, 'fallback');
  } catch (error) {
    // Every private-path failure stays safe to log, even normalization errors.
    if (safeEphemeralErrors.has(error)) throw error;
    throw ephemeralError('EPHEMERAL_UNCONFIRMED');
  }
}

const safeStrictErrors = new WeakSet();

function strictDeliveryError(code) {
  // Axios and Telegram errors can carry the bot token and message content.
  // Only these fresh, payload-free errors may leave the strict path.
  const messages = {
    STRICT_DELIVERY_INVALID_OPTIONS: 'sendRich: invalid strict reply options or content',
    STRICT_DELIVERY_UNCONFIRMED: 'sendRich: strict reply delivery could not be confirmed',
    STRICT_DELIVERY_REJECTED: 'sendRich: strict Telegram reply was rejected',
    STRICT_DELIVERY_TEXT_TOO_LONG: 'sendRich: strict reply text fallback exceeds Telegram limits',
    STRICT_DELIVERY_CANCELLED: 'sendRich: strict reply delivery was cancelled',
  };
  const error = new Error(messages[code] || messages.STRICT_DELIVERY_UNCONFIRMED);
  error.code = code;
  safeStrictErrors.add(error);
  return error;
}

function strictRejection(data, httpStatus) {
  // Even an error-shaped 5xx body is ambiguous: Telegram may already have sent.
  if (httpStatus >= 500 || data?.ok !== false) return null;
  const status = Number(data.error_code || httpStatus);
  if (!Number.isInteger(status) || status < 400 || status >= 500) return null;
  return { status, description: typeof data.description === 'string' ? data.description : '' };
}

function richFallbackAllowed(rejection) {
  const { status, description } = rejection;
  // A missing source reply must never turn into a standalone message. Other
  // authorization, topic, rate-limit and parameter failures are not fallbacks.
  if (/reply|message to be replied|thread|topic|chat|business|forbidden|too many requests/i.test(description)) return false;
  if (status === 404) return /not found|unknown method|method.*(?:unsupported|unavailable)/i.test(description);
  return status === 400 && /rich[_ ]?message|rich formatting|(?:can't|cannot) parse (?:entities|html|markdown)|unsupported (?:parse mode|tag|format)|(?:invalid|unsupported) (?:html|markdown)/i.test(description);
}

function strictMessageResult(data, mode) {
  const messageId = data?.result?.message_id;
  if (data?.ok !== true || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw strictDeliveryError('STRICT_DELIVERY_UNCONFIRMED');
  }
  return { ok: true, mode, messageId };
}

function checkStrictDelivery(shouldSend) {
  if (shouldSend === undefined) return;
  try {
    if (shouldSend() === true) return;
  } catch (_) { /* Cancellation callbacks must not expose their errors. */ }
  throw strictDeliveryError('STRICT_DELIVERY_CANCELLED');
}

async function sendStrictRich(chatId, content, opts) {
  try {
    const shouldSend = opts.shouldSend;
    if (!Number.isSafeInteger(opts.replyTo) || opts.replyTo <= 0
      || (shouldSend !== undefined && typeof shouldSend !== 'function')
      || !content || (typeof content.html !== 'string' && typeof content.markdown !== 'string')
      || (content.html != null && content.markdown != null)
      || (content.fallback != null && typeof content.fallback !== 'string')) {
      throw strictDeliveryError('STRICT_DELIVERY_INVALID_OPTIONS');
    }
    const rich = content.html != null ? { html: collapseHtmlQuotes(content.html) }
      : { markdown: collapseMarkdownQuotes(content.markdown) };
    const plain = content.fallback != null ? content.fallback
      : content.html != null ? htmlToPlain(content.html) : content.markdown;
    const extra = { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: false } };
    if (opts.threadId) extra.message_thread_id = opts.threadId;
    if (opts.businessId) extra.business_connection_id = opts.businessId;
    if (opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
    if (opts.silent) extra.disable_notification = true;

    let data;
    let httpStatus;
    checkStrictDelivery(shouldSend);
    try {
      const response = await axios.post(`${API}/sendRichMessage`,
        { chat_id: chatId, rich_message: rich, ...extra }, { proxy: false, timeout: 10000 });
      data = response.data;
      httpStatus = response.status;
    } catch (error) {
      data = error.response?.data;
      httpStatus = error.response?.status;
      const rejection = strictRejection(data, httpStatus);
      if (!rejection) throw strictDeliveryError('STRICT_DELIVERY_UNCONFIRMED');
    }

    const rejection = strictRejection(data, httpStatus);
    if (!rejection) {
      if (httpStatus >= 500) throw strictDeliveryError('STRICT_DELIVERY_UNCONFIRMED');
      return strictMessageResult(data, 'rich');
    }
    if (!richFallbackAllowed(rejection)) throw strictDeliveryError('STRICT_DELIVERY_REJECTED');
    // Exactly one fallback, with no chunking, media retry or Markdown retry.
    if (!plain.length || plain.length > 4096) throw strictDeliveryError('STRICT_DELIVERY_TEXT_TOO_LONG');
    checkStrictDelivery(shouldSend);
    try {
      const response = await axios.post(`${API}/sendMessage`,
        { chat_id: chatId, text: plain, link_preview_options: { is_disabled: true }, ...extra },
        { proxy: false, timeout: 10000 });
      data = response.data;
      httpStatus = response.status;
    } catch (error) {
      throw strictDeliveryError(strictRejection(error.response?.data, error.response?.status)
        ? 'STRICT_DELIVERY_REJECTED' : 'STRICT_DELIVERY_UNCONFIRMED');
    }
    if (strictRejection(data, httpStatus)) throw strictDeliveryError('STRICT_DELIVERY_REJECTED');
    if (httpStatus >= 500) throw strictDeliveryError('STRICT_DELIVERY_UNCONFIRMED');
    return strictMessageResult(data, 'fallback');
  } catch (error) {
    if (safeStrictErrors.has(error)) throw error;
    throw strictDeliveryError('STRICT_DELIVERY_UNCONFIRMED');
  }
}

/**
 * Отправляет богатое сообщение с авто-фоллбэком.
 * @param {object} bot — инстанс node-telegram-bot-api (нужен для фоллбэка)
 * @param {number|string} chatId
 * @param {{html?:string, markdown?:string, fallback?:string}} content — ровно одно из html / markdown
 * @param {{replyTo?:number, threadId?:number, businessId?:string, replyMarkup?:object, silent?:boolean, strictDelivery?:boolean, shouldSend?:()=>boolean, ephemeral?:{receiverUserId:number, replyToEphemeralId?:number, editId?:number}}} [opts]
 * @returns {Promise<{ok:boolean, mode:'rich'|'rich-noimg'|'fallback', messageId?:number, ephemeralMessageId?:number, error?:string}>}
 */
async function sendRich(bot, chatId, content, opts = {}) {
  // Presence rather than truthiness: malformed private options must never
  // accidentally select the ordinary public delivery path.
  if (opts && typeof opts === 'object' && 'ephemeral' in opts) return sendEphemeralRich(chatId, content, opts);
  if (opts.strictDelivery === true) return sendStrictRich(chatId, content, opts);
  const rich = {};
  if (content.html != null) rich.html = collapseHtmlQuotes(content.html);
  else if (content.markdown != null) rich.markdown = collapseMarkdownQuotes(content.markdown);
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
    const response = await axios.post(`${API}/sendRichMessage`, { chat_id: chatId, rich_message: rich, ...extra }, { proxy: false });
    return { ok: true, mode: 'rich', messageId: response.data?.result?.message_id };
  } catch (e) {
    const desc = e.response?.data?.description || e.message;

    // Если rich упал из-за медиа (битый URL картинки) — пробуем ещё раз БЕЗ картинок,
    // чтобы сохранить форматирование (таблицы/списки), а не падать в плоский текст.
    // Картинки Telegram качает сам со своей стороны, поэтому доверяем именно его вердикту.
    const hasImg = /!\[|<tg-(collage|slideshow)/i.test(content.markdown || '') || /<img|<tg-(collage|slideshow)/i.test(content.html || '');
    if (hasImg && /media|no_media|RICH_MESSAGE/i.test(desc)) {
      const noImg = {};
      if (rich.markdown != null) noImg.markdown = rich.markdown.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<img[^>]*>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
      if (rich.html != null) noImg.html = rich.html.replace(/<\/?tg-(collage|slideshow)>/gi, '').replace(/<img[^>]*>/gi, '');
      try {
        const response = await axios.post(`${API}/sendRichMessage`, { chat_id: chatId, rich_message: noImg, ...extra }, { proxy: false });
        console.error(`[RICH] медиа не прошло, отправил без картинок: ${desc}`);
        return { ok: true, mode: 'rich-noimg', messageId: response.data?.result?.message_id };
      } catch (_) { /* падаем в общий фоллбэк ниже */ }
    }

    console.error(`[RICH] sendRichMessage упал, фоллбэк в текст: ${desc}`);

    // 2) Фоллбэк — обычный sendMessage
    const legacy = { link_preview_options: { is_disabled: true } };
    if (opts.replyTo) {
      legacy.reply_parameters = {
        message_id: opts.replyTo,
        allow_sending_without_reply: true,
      };
    }
    if (opts.threadId) legacy.message_thread_id = opts.threadId;
    if (opts.businessId) legacy.business_connection_id = opts.businessId;
    if (opts.replyMarkup) legacy.reply_markup = opts.replyMarkup;
    if (opts.silent) legacy.disable_notification = true;

    // Для markdown-контента пробуем сохранить разметку (legacy Markdown), иначе плейн.
    let messageId;
    const quotedChunks = content.fallback == null ? quoteFallback(rich) : null;
    if (quotedChunks) {
      for (const chunk of quotedChunks) {
        const sent = await bot.sendMessage(chatId, chunk.text, { ...legacy, entities: chunk.entities });
        messageId ||= sent.message_id;
      }
      return { ok: true, mode: 'fallback', error: desc, messageId };
    }
    if (content.markdown != null && content.fallback == null) {
      for (const chunk of splitChunks(content.markdown)) {
        try {
          const sent = await bot.sendMessage(chatId, chunk, { ...legacy, parse_mode: 'Markdown' });
          messageId ||= sent.message_id;
        } catch (_) {
          const sent = await bot.sendMessage(chatId, chunk, legacy); // совсем сырой текст
          messageId ||= sent.message_id;
        }
      }
      return { ok: true, mode: 'fallback', error: desc, messageId };
    }

    const plain = content.fallback != null ? content.fallback
      : content.html != null ? htmlToPlain(content.html)
      : String(content.markdown || '');
    for (const chunk of splitChunks(plain)) {
      const sent = await bot.sendMessage(chatId, chunk, legacy);
      messageId ||= sent.message_id;
    }
    return { ok: true, mode: 'fallback', error: desc, messageId };
  }
}

module.exports = { sendRich, htmlToPlain, escapeHtml, normalizeMd, formatVoiceMessage, quoteFallback };
