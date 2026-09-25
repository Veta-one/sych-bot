const DEFAULT_OFFSET = 300; // Екатеринбург. Всегда указываем пояс в подтверждении.
const MINUTE = 60000;
const DAY = 86400000;
// Only an immediate interrogative after the verb: a time before it ("через час")
// still goes to scheduling. This guard cannot be overridden by a model guess.
function isRecallQuestion(text) {
  return /(?:^|[^а-яёa-z])напомни(?:\s+мне)?[\s,:;—-]+(?:пожалуйста[\s,:;—-]+)?(?:во\s+сколько|сколько|когда|как|почему|зачем|где|куда|откуда|кто|кого|какой|какая|какие|что)(?=$|[^а-яёa-z])/i.test(text);
}
const words = { ноль: 0, один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4,
  пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11,
  двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30,
  сорок: 40, пятьдесят: 50 };

function normalize(text) {
  return String(text).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
    .replace(/[а-я]+/g, word => Object.hasOwn(words, word) ? String(words[word]) : word)
    .replace(/\b(20|30|40|50) ([1-9])\b/g, (_, tens, units) => String(Number(tens) + Number(units)));
}

function duration(text) {
  const value = normalize(text).replace(/^(?:через|за)\s+/, '').replace(/\s+до\s+.*$/, '')
    .replace(/полчаса/g, '30 минут').replace(/полтора часа/g, '90 минут');
  let total = 0, invalid = false;
  const remaining = value.replace(/(?:^|\s)(?:(\d+)\s*)?(минут[а-я]*|час[а-я]*|день|дня|дней|сутки|недел[а-я]*)(?=\s|$)/g, (_, count, unit) => {
    const amount = count ? Number(count) : 1;
    if (amount <= 0 || amount > 525600) invalid = true;
    total += amount * (/^минут/.test(unit) ? MINUTE : /^час/.test(unit) ? 60 * MINUTE : /^недел/.test(unit) ? 7 * DAY : DAY);
    return ' ';
  }).replace(/(?:^|\s)и(?=\s|$)/g, '').trim();
  return !invalid && !remaining && total > 0 ? total : null;
}

function parseReminderTime(expression, { now = Date.now(), referenceDate = now } = {}) {
  const text = normalize(expression);
  if (/кажд|ежеднев|еженедел/.test(text)) return { issue: 'recurring' };
  if (/(?:^|\s)через(?:\s|$)/.test(text)) {
    const delay = duration(text);
    if (!delay) return { issue: 'time' };
    const timestamp = Number(referenceDate) + delay;
    return timestamp > now ? { timestamp } : { issue: 'past' };
  }
  if (/следующ(?:ем|ей)\s+(?:месяц|недел)|через|половин|четверть|после обеда/.test(text)) return { issue: 'time' };
  let offset = /мск|msk|москв/.test(text) ? 180 : DEFAULT_OFFSET;
  const zone = text.match(/(?:utc|gmt)\s*([+-])(\d{1,2})(?::(\d{2}))?/);
  if (zone) offset = (Number(zone[2]) * 60 + Number(zone[3] || 0)) * (zone[1] === '-' ? -1 : 1);
  if (Math.abs(offset) > 14 * 60) return { issue: 'time' };
  const withoutZone = text.replace(/(?:utc|gmt)\s*[+-]\d{1,2}(?::\d{2})?/, '');
  const clock = withoutZone.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/)
    || withoutZone.match(/(?:^|\s)(?:в|к|на)\s+(\d{1,2})(?:\s+(\d{2}))?(?!\d)/)
    || withoutZone.match(/^(\d{1,2})$/);
  if (!clock) return { issue: 'time' };
  let hour = Number(clock[1]);
  const minute = Number(clock[2] || 0);
  if (hour < 12 && /(?:^|\s)(?:вечера|вечером|дня)(?:\s|$)/.test(text)) hour += 12;
  if (hour === 12 && /(?:^|\s)ночи(?:\s|$)/.test(text)) hour = 0;
  if (hour > 23 || minute > 59) return { issue: 'time' };

  const base = new Date(Number(referenceDate) + offset * MINUTE);
  if (!Number.isFinite(base.getTime())) return { issue: 'date' };
  let year = base.getUTCFullYear(), month = base.getUTCMonth(), day = base.getUTCDate();
  let shift = 0;
  const numericDate = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\b/);
  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const namedDate = text.match(/(?:^|\s)(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/);
  if (numericDate) { day = Number(numericDate[1]); month = Number(numericDate[2]) - 1; year = Number(numericDate[3] || year); }
  else if (isoDate) { year = Number(isoDate[1]); month = Number(isoDate[2]) - 1; day = Number(isoDate[3]); }
  else if (namedDate) { day = Number(namedDate[1]); month = months.indexOf(namedDate[2]); year = Number(namedDate[3] || year); }
  else if (/послезавтра/.test(text)) shift = 2;
  else if (/завтра/.test(text)) shift = 1;
  else if (!/сегодня/.test(text)) {
    const weekdays = [/воскресень/, /понедельник/, /вторник/, /сред[ау]/, /четверг/, /пятниц/, /суббот/];
    const weekday = weekdays.findIndex(pattern => pattern.test(text));
    if (weekday >= 0) {
      shift = (weekday - base.getUTCDay() + 7) % 7;
      if (shift === 0 && /следующ/.test(text)) shift = 7;
    }
  }
  const date = new Date(Date.UTC(year, month, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return { issue: 'date' };
  const timestamp = date.getTime() + shift * DAY - offset * MINUTE;
  return Number.isFinite(timestamp) && timestamp > now ? { timestamp } : { issue: 'past' };
}

const questions = {
  time: 'Когда напомнить? Укажи время, например «завтра в 12:00» или «через час».',
  date: 'На какую дату поставить напоминание? Укажи дату и время.',
  past: 'Это время уже прошло. На какую будущую дату и время напомнить?',
  subject: 'О чём напомнить? Напиши тему или ответь на нужное сообщение.',
  ambiguous: 'Уточни, о каком событии и когда напомнить: в сообщении несколько вариантов.',
  recurring: 'Пока могу поставить разовое напоминание. На какую дату и время?',
};

function clarification(reason = 'time') { return { kind: 'clarify', question: questions[reason] || questions.time }; }

function resolveReminderDecision(parsed, { userText, contextText = '', contextDate, now = Date.now() }) {
  if (isRecallQuestion(userText)) return { kind: 'answer' };
  if (!parsed || !['answer_now', 'schedule', 'clarify', 'cancel'].includes(parsed.intent)) return { kind: 'error' };
  if (parsed.intent === 'answer_now') return { kind: 'answer' };
  if (parsed.intent === 'cancel') return { kind: 'cancel' };
  if (parsed.intent === 'clarify') return clarification(parsed.missing);
  let reminderText = typeof parsed.reminderText === 'string' ? parsed.reminderText.trim() : '';
  if (!reminderText && !contextText.trim()) return clarification('subject');
  if (/кажд|ежеднев|еженедел/i.test(userText)) return clarification('recurring');
  const source = parsed.timeSource === 'request' ? userText : parsed.timeSource === 'context' ? contextText : '';
  const quotes = parsed.timeQuotes;
  if (!source || !Array.isArray(quotes) || !quotes.length || quotes.some(q => typeof q !== 'string' || !q.trim() || !source.toLowerCase().includes(q.toLowerCase()))) return clarification();
  const expression = quotes.join(' ');
  // Losing a day or timezone in extraction must not silently change the deadline.
  if (/сегодня|завтра/i.test(source) && !/сегодня|завтра/i.test(expression)) return clarification('date');
  if (/мск|msk|москв/i.test(source) && !/мск|msk|москв/i.test(expression)) return clarification();
  if (/(?:utc|gmt)\s*[+-]/i.test(source) && !/(?:utc|gmt)\s*[+-]/i.test(expression)) return clarification();
  // For a bare reply request, retain the actual announcement, including its
  // details, instead of trusting a model to invent or shorten the subject.
  let subject = userText.toLowerCase();
  if (parsed.timeSource === 'request') for (const quote of quotes) subject = subject.replace(quote.toLowerCase(), '');
  if (typeof parsed.offsetQuote === 'string' && parsed.offsetQuote) subject = subject.replace(parsed.offsetQuote.toLowerCase(), '');
  subject = subject.replace(/уточнение пользователя:/g, '').replace(/об этом|про это|о н[её]м|о ней/g, '')
    .replace(/(?:^|[^а-яёa-z])(?:сыч|sych|напомни|напоминай|мне|пожалуйста)(?=$|[^а-яёa-z])/gi, ' ').replace(/[^а-яёa-z0-9]/gi, '');
  if (!subject || !reminderText || /^(сыч|sych|напоминание)$/i.test(reminderText)) {
    if (!contextText.trim()) return clarification('subject');
    reminderText = contextText.trim();
  }
  // A bare reply to a post with several clock times needs disambiguation.
  if (parsed.timeSource === 'context' && (contextText.match(/\b\d{1,2}:\d{2}\b/g) || []).length > 1) return clarification('ambiguous');
  const time = parseReminderTime(expression, { now, referenceDate: parsed.timeSource === 'context' ? (contextDate || now) : now });
  if (time.issue) return clarification(time.issue);
  let timestamp = time.timestamp;
  if (parsed.offsetQuote) {
    if (parsed.timeSource !== 'context' || typeof parsed.offsetQuote !== 'string' || !userText.toLowerCase().includes(parsed.offsetQuote.toLowerCase()) || !/^за\s/i.test(parsed.offsetQuote.trim())) return clarification();
    const offset = duration(parsed.offsetQuote);
    if (!offset) return clarification();
    timestamp -= offset;
  }
  if (timestamp <= now) return clarification('past');
  return { kind: 'schedule', targetTime: new Date(timestamp).toISOString(), reminderText };
}

function reminderConfirmation(reminder) {
  const when = new Date(reminder.targetTime).toLocaleString('ru-RU', {
    timeZone: 'Asia/Yekaterinburg', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `⏰ Напомню ${when} (Екатеринбург, UTC+5).\n${reminder.reminderText}`;
}

class PendingReminders {
  constructor({ now = Date.now, ttlMs = 30 * MINUTE } = {}) { this.entries = new Map(); this.now = now; this.ttlMs = ttlMs; }
  key(msg, threadId) { return JSON.stringify([msg.chat.id, msg.from.id, threadId ?? null, msg.business_connection_id || null]); }
  prune() { for (const [key, value] of this.entries) if (value.expires <= this.now()) this.entries.delete(key); }
  get(msg, threadId) {
    this.prune();
    const entry = this.entries.get(this.key(msg, threadId));
    return entry && entry.promptId === msg.reply_to_message?.message_id ? entry : null;
  }
  set(msg, threadId, promptId, request) {
    this.prune();
    if (promptId) this.entries.set(this.key(msg, threadId), { ...request, promptId, expires: this.now() + this.ttlMs });
  }
  clear(msg, threadId) { this.entries.delete(this.key(msg, threadId)); }
  forgetUser(userId) {
    for (const key of this.entries.keys()) if (String(JSON.parse(key)[1]) === String(userId)) this.entries.delete(key);
  }
}

module.exports = { parseReminderTime, resolveReminderDecision, reminderConfirmation, PendingReminders, isRecallQuestion };
