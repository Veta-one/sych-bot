const FIVE_MINUTES = 5 * 60 * 1000;
const { buildSourceContext, sourceUserIds, isSourceRecheck, MAX_SOURCE_CHARS } = require('./source-context');

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

  begin(msg, threadId, { botId, inherited } = {}) {
    this.prune();
    const identity = scope(msg, threadId);
    const sourceId = integerId(msg?.message_id);
    const sourceText = msg?.text || msg?.caption || '';
    if (!identity || !sourceId || msg.ephemeral_message_id !== undefined || msg.from.is_bot
        || String(sourceText).trimStart().startsWith('/')) return null;
    while (this.pending.size >= this.maxEntries) {
      const oldest = this.pending.values().next().value;
      oldest.cancelled = true;
      this.pending.delete(oldest);
    }
    const sourceContext = buildSourceContext(msg, { botId, inheritedContext: inherited?.sourceContext });
    // Rechecks preserve the original text, so their authors do not become new
    // source authors unless they add a retained URL. This also bounds lineage
    // by the bounded source chain and URL count rather than conversation length.
    const contributesSource = !inherited?.sourceContext
      || sourceContext?.urls.some(url => !inherited.sourceContext.urls.includes(url));
    const token = { ...identity, sourceId, sourceText: String(sourceText).slice(0, MAX_SOURCE_CHARS),
      botId: integerId(botId), inheritedContext: inherited?.sourceContext,
      sourceContext,
      sourceUserIds: [...new Set([...(inherited?.sourceUserIds || []),
        ...(contributesSource ? [identity.userId, ...sourceUserIds(msg, botId)] : [])])],
      expires: this.now() + this.ttlMs, cancelled: false };
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
    if (!identity || !sourceId || msg.ephemeral_message_id !== undefined || msg.reply_to_message?.ephemeral_message_id !== undefined
        || integerId(msg.reply_to_message?.from?.id) !== identity.userId) return null;
    return this.entries.get(key(identity, sourceId)) || null;
  }

  // This lookup does not trigger a response. It only restores the public source
  // for an already-addressed reply to a confirmed bot delivery, regardless of
  // which group participant asks the followup.
  getSource(msg, threadId) {
    this.prune();
    const identity = scope(msg, threadId);
    const answerId = integerId(msg?.reply_to_message?.message_id);
    const botId = integerId(msg?.reply_to_message?.from?.id);
    if (!identity || !answerId || !botId || msg.ephemeral_message_id !== undefined
      || msg.reply_to_message?.ephemeral_message_id !== undefined) return null;
    for (const entry of this.entries.values()) {
      if (entry.chatId === identity.chatId && entry.topic === identity.topic && entry.businessId === identity.businessId
        && entry.botId === botId && entry.botMessageId === answerId) return entry;
    }
    return null;
  }

  getRecentSource(msg, threadId) {
    this.prune();
    const identity = scope(msg, threadId);
    if (!identity || !isSourceRecheck(msg)) return null;
    for (const entry of [...this.entries.values()].reverse()) {
      if (entry.chatId === identity.chatId && entry.topic === identity.topic && entry.businessId === identity.businessId
        && entry.botId && entry.sourceContext?.urls?.length) return entry;
    }
    return null;
  }

  update(token, msg, text) {
    if (!token || token.cancelled || !this.pending.has(token)) return;
    token.sourceText = String(text || '').slice(0, MAX_SOURCE_CHARS);
    token.sourceContext = buildSourceContext({ ...msg, text }, { botId: token.botId,
      inheritedContext: token.inheritedContext });
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
    if (normalized) this.clearWhere(entry => entry.userId === normalized || entry.sourceUserIds?.includes(normalized));
  }

  forgetChat(chatId) {
    const normalized = integerId(chatId, false);
    if (normalized) this.clearWhere(entry => entry.chatId === normalized);
  }
}

module.exports = { ConversationFollowups };
