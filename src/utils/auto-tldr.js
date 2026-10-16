const AUTO_TLDR_THRESHOLD = 900;
const AUTO_TLDR_MAX_CHARS = 450;
const AUTO_TLDR_INPUT_MAX_CHARS = 40000;

function readableLength(message) {
  let text = String(message?.text || message?.caption || '');
  const entities = message?.text ? message.entities : message?.caption_entities;
  const ranges = (Array.isArray(entities) ? entities : []).filter(entity => ['pre', 'code'].includes(entity?.type)
    && Number.isInteger(entity.offset) && entity.offset >= 0 && Number.isInteger(entity.length) && entity.length > 0)
    .map(entity => [entity.offset, Math.min(text.length, entity.offset + entity.length)])
    .sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  const parts = [];
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  parts.push(text.slice(cursor));
  text = parts.join(' ').replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  const words = text.match(/[\p{L}\p{N}]{2,}/gu) || [];
  const ideographs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  return { characters: [...text].length, words: words.length, ideographs: ideographs.length };
}

function shouldAutoTldr(message, { enabled = true, threshold = AUTO_TLDR_THRESHOLD,
  directlyCalled = false, botId } = {}) {
  if (!enabled || directlyCalled || !['group', 'supergroup'].includes(message?.chat?.type)
    || !Number.isSafeInteger(message.chat.id) || message.chat.id >= 0
    || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
    || !Number.isSafeInteger(message.from?.id) || message.from.id <= 0 || message.from.is_bot
    || String(message.from.id) === String(botId) || message.ephemeral_message_id !== undefined
    || message.reply_to_message?.ephemeral_message_id !== undefined || message.edit_date
    || message.voice || message.audio) return false;
  const text = String(message.text || message.caption || '').trim();
  if (!text || text.startsWith('/') || [...text].length > AUTO_TLDR_INPUT_MAX_CHARS) return false;
  const length = readableLength(message);
  const minimum = Number.isFinite(threshold) && threshold > 0 ? threshold : AUTO_TLDR_THRESHOLD;
  // Avoid URL dumps, code-only posts and one repeated unbroken token.
  return length.characters >= minimum && (length.words >= 20 || length.ideographs >= 300);
}

function validTldr(text, original) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const summary = text.trim().replace(/\s+/g, ' ');
  const length = [...summary].length;
  return length <= AUTO_TLDR_MAX_CHARS && length <= [...String(original).trim()].length / 2 ? summary : '';
}

// Bounded process-local attempts prevent duplicate replies and model floods.
// Completed records contain only identity/expiry, never message text or output.
class AutoTldrJobs {
  constructor({ now = Date.now, ttlMs = 24 * 60 * 60 * 1000, maxEntries = 2048,
    concurrency = 2, maxPending = 32, queueTtlMs = 120000 } = {}) {
    Object.assign(this, { now, ttlMs, maxEntries, concurrency, maxPending, queueTtlMs });
    this.seen = new Map(); this.pending = new Map(); this.queue = []; this.active = 0;
  }

  run(message, threadId, task) {
    const now = this.now();
    for (const [key, token] of this.seen) if (token.expires <= now) this.seen.delete(key);
    const identity = { chatId: String(message.chat.id), userId: String(message.from.id),
      threadId: threadId == null ? null : String(threadId), businessId: message.business_connection_id || null };
    const key = JSON.stringify([identity.chatId, identity.threadId, identity.businessId, String(message.message_id)]);
    if (this.seen.has(key) || this.pending.has(key)) return Promise.resolve('duplicate');
    if (this.pending.size >= this.maxPending) return Promise.resolve('capacity');
    const token = { ...identity, key, cancelled: false, expires: now + this.ttlMs, startBy: now + this.queueTtlMs };
    this.seen.set(key, token);
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value);
    this.pending.set(key, token);
    return new Promise(resolve => { this.queue.push({ token, task, resolve }); this.pump(); });
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (job.token.cancelled || job.token.startBy <= this.now()) {
        this.pending.delete(job.token.key); job.resolve('cancelled'); continue;
      }
      this.active++;
      Promise.resolve().then(() => job.task(job.token)).then(delivered => job.resolve(delivered ? 'delivered' : 'skipped'),
        () => job.resolve('failed')).finally(() => {
        this.pending.delete(job.token.key); this.active--; this.pump();
      });
    }
  }

  clearWhere(matches) {
    for (const [key, token] of this.seen) if (matches(token)) this.seen.delete(key);
    for (const token of this.pending.values()) if (matches(token)) token.cancelled = true;
    this.queue = this.queue.filter(job => {
      if (!job.token.cancelled) return true;
      this.pending.delete(job.token.key); job.resolve('cancelled'); return false;
    });
  }

  forgetUser(id) { this.clearWhere(token => token.userId === String(id)); }
  forgetChat(id) { this.clearWhere(token => token.chatId === String(id)); }
}

module.exports = { AUTO_TLDR_THRESHOLD, AUTO_TLDR_MAX_CHARS, AUTO_TLDR_INPUT_MAX_CHARS,
  readableLength, shouldAutoTldr, validTldr, AutoTldrJobs };
