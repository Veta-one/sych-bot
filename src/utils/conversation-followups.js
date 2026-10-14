const FIVE_MINUTES = 5 * 60 * 1000;

function integerId(value, positive = true) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && (positive ? number > 0 : number !== 0) ? String(number) : null;
}

function scope(msg, threadId) {
  const chatId = integerId(msg?.chat?.id, false);
  const userId = integerId(msg?.from?.id);
  const topic = threadId == null ? null : integerId(threadId);
  const businessId = msg?.business_connection_id == null || msg.business_connection_id === ''
    ? null : String(msg.business_connection_id);
  if (!chatId || !userId || (threadId != null && !topic)) return null;
  return { chatId, userId, topic, businessId };
}

function key(identity, sourceId) {
  return JSON.stringify([identity.chatId, identity.userId, identity.topic, identity.businessId, sourceId]);
}

// Only confirmed public answers create links. Pending work keeps cancellable
// tokens rather than a permanent per-user generation map.
class ConversationFollowups {
  constructor({ now = Date.now, ttlMs = FIVE_MINUTES, maxEntries = 256 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.pending = new Set();
  }

  prune() {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) if (entry.expires <= now) this.entries.delete(entryKey);
    for (const token of this.pending) if (token.expires <= now) {
      token.cancelled = true;
      this.pending.delete(token);
    }
  }

  begin(msg, threadId) {
    this.prune();
    const identity = scope(msg, threadId);
    const sourceId = integerId(msg?.message_id);
    const sourceText = msg?.text || msg?.caption || '';
    if (!identity || !sourceId || msg.ephemeral_message_id != null || msg.from.is_bot
        || String(sourceText).trimStart().startsWith('/')) return null;
    while (this.pending.size >= this.maxEntries) {
      const oldest = this.pending.values().next().value;
      oldest.cancelled = true;
      this.pending.delete(oldest);
    }
    const token = { ...identity, sourceId, sourceText: String(sourceText), expires: this.now() + this.ttlMs, cancelled: false };
    this.pending.add(token);
    return token;
  }

  confirm(token, botMessageId) {
    this.prune();
    const confirmedId = integerId(botMessageId);
    if (!token || token.cancelled || !this.pending.has(token) || !confirmedId) return false;
    const entryKey = key(token, token.sourceId);
    this.entries.delete(entryKey);
    this.entries.set(entryKey, { ...token, botMessageId: confirmedId, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return true;
  }

  get(msg, threadId) {
    this.prune();
    const identity = scope(msg, threadId);
    const sourceId = integerId(msg?.reply_to_message?.message_id);
    if (!identity || !sourceId || msg.ephemeral_message_id != null || msg.reply_to_message?.ephemeral_message_id != null
        || integerId(msg.reply_to_message?.from?.id) !== identity.userId) return null;
    return this.entries.get(key(identity, sourceId)) || null;
  }

  finish(token) {
    this.pending.delete(token);
  }

  clearWhere(matches) {
    this.prune();
    for (const [entryKey, entry] of this.entries) if (matches(entry)) this.entries.delete(entryKey);
    for (const token of this.pending) if (matches(token)) {
      token.cancelled = true;
      this.pending.delete(token);
    }
  }

  forgetUser(userId) {
    const normalized = integerId(userId);
    if (normalized) this.clearWhere(entry => entry.userId === normalized);
  }

  forgetChat(chatId) {
    const normalized = integerId(chatId, false);
    if (normalized) this.clearWhere(entry => entry.chatId === normalized);
  }
}

module.exports = { ConversationFollowups };
