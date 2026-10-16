const MAX_SOURCE_CHARS = 8000;
const MAX_SOURCE_URLS = 32;
const MAX_REPLY_DEPTH = 4;
const MAX_SCAN_CHARS = 32000;

function publicChain(message, botId) {
  const chain = [];
  const visited = new Set();
  const chatId = message?.chat?.id;
  const topicId = message?.message_thread_id;
  const businessId = message?.business_connection_id;
  for (let current = message; current && chain.length < MAX_REPLY_DEPTH; current = current.reply_to_message) {
    if (visited.has(current) || current.ephemeral_message_id !== undefined
      || (current.chat?.id != null && chatId != null && String(current.chat.id) !== String(chatId))
      || (current.message_thread_id != null && topicId != null && String(current.message_thread_id) !== String(topicId))
      || (current.business_connection_id != null && businessId != null
        && String(current.business_connection_id) !== String(businessId))
      || current.from?.is_bot || (botId != null && String(current.from?.id) === String(botId))) break;
    visited.add(current);
    chain.push(current);
  }
  return chain.reverse();
}

function collectUrls(message, append) {
  const text = String(message?.text || message?.caption || '').slice(0, MAX_SCAN_CHARS);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url = match[0].replace(/[.,;!]+$/, '');
    const pairs = { ')': '(', ']': '[', '}': '{' };
    while (pairs[url.at(-1)]) {
      const closing = url.at(-1);
      const opening = pairs[closing];
      if (url.split(closing).length <= url.split(opening).length) break;
      url = url.slice(0, -1).replace(/[.,;!]+$/, '');
    }
    append(url);
  }
  for (const entity of [...(Array.isArray(message?.entities) ? message.entities.slice(0, 256) : []),
    ...(Array.isArray(message?.caption_entities) ? message.caption_entities.slice(0, 256) : [])]) {
    if (entity?.type === 'text_link') append(entity.url);
  }
}

function isSourceRecheck(message) {
  if (!message || message.reply_to_message || message.ephemeral_message_id !== undefined
    || message.chat?.type === 'private' || message.photo || message.document || message.video
    || message.voice || message.audio || message.sticker) return false;
  const text = String(message.text || message.caption || '').trim();
  if (!text || text.length > 160 || /https?:\/\//i.test(text)) return false;
  for (const entities of [message.entities, message.caption_entities]) {
    if (Array.isArray(entities) && entities.some(entity => ['url', 'text_link'].includes(entity?.type))) return false;
  }
  const normalized = text.toLowerCase()
    .replace(/(?<![а-яёa-z])(?:сыч|sych|ч[её]т(?:о)?|что[- ]то|кажется|походу|похоже|блин|ну|опять|снова)(?![а-яёa-z])/g, ' ')
    .replace(/[.,!?;:«»"'()[\]{}—–-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:ты\s+)?(?:ошибся|ошиблась|налажал|накосячил|неправ|не\s+прав|вр[её]шь|выдумал|галлюцинируешь)(?:\s+(?:же|тут|здесь))?$/.test(normalized)
    || /^(?:ты\s+)?уверен(?:\s+(?:в\s+этом|точно))?$/.test(normalized)
    || /^(?:пере)?проверь(?:\s+(?:вс[её]|ещ[её]\s+раз|заново|это|себя|пожалуйста)){0,3}$/.test(normalized);
}

// Original source material is data, never a bot-generated answer. Keep links
// separately because Telegram text_link targets do not appear in captions/text.
function buildSourceContext(message, { inheritedContext, botId } = {}) {
  const urls = [];
  const append = value => {
    if (typeof value !== 'string' || value.length > 2048 || urls.length >= MAX_SOURCE_URLS) return;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || urls.includes(value)) return;
      urls.push(value);
    } catch (_) { /* Invalid targets are not research sources. */ }
  };
  const inheritedText = typeof inheritedContext?.text === 'string'
    ? inheritedContext.text.slice(0, MAX_SOURCE_CHARS) : '';
  for (const url of (Array.isArray(inheritedContext?.urls) ? inheritedContext.urls.slice(0, MAX_SOURCE_URLS) : [])) append(url);
  const chain = publicChain(message, botId);
  // Once bound, preserve the original question/post instead of replacing it
  // with a recheck or repeating an erroneous bot answer as source evidence.
  const texts = inheritedText ? [inheritedText] : chain.map(item =>
    String(item.text || item.caption || '').slice(0, MAX_SOURCE_CHARS)).filter(Boolean);
  for (const item of chain) collectUrls(item, append);
  const joined = texts.join('\n\n');
  const marker = '\n[Исходный контекст сокращён]\n';
  // Reserve room for the original request after a long replied post. Its
  // question (for example OpenClaw setup) must survive later rechecks too.
  const text = joined.length <= MAX_SOURCE_CHARS ? joined : joined.slice(0, MAX_SOURCE_CHARS - 2000 - marker.length)
    + marker + joined.slice(-2000);
  return text || urls.length ? { text, urls } : undefined;
}

function sourceUserIds(message, botId) {
  return [...new Set(publicChain(message, botId).map(item => String(item.from?.id || ''))
    .filter(id => /^[1-9]\d*$/.test(id)))];
}

module.exports = { buildSourceContext, sourceUserIds, isSourceRecheck, MAX_SOURCE_CHARS, MAX_SOURCE_URLS, MAX_REPLY_DEPTH };
