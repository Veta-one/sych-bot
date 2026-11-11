const { withTimeout } = require('../utils/async');

function createGroupAccess(bot, ownerId, { pending = {}, notices = {}, departed = {}, botId,
  save = () => {}, notify = async () => {}, chatName = () => '', now = Date.now,
  timeoutMs = 10000, logger = console } = {}) {
  const blocked = new Set([...Object.keys(pending), ...Object.keys(departed)]);
  const checks = new Map();
  const exits = new Map();
  const epochs = new Map();
  const notifying = new Set();

  function isMember(member) {
    return ['creator', 'administrator', 'member'].includes(member?.status)
      || (member?.status === 'restricted' && member.is_member === true);
  }

  function isAbsent(member) {
    return ['left', 'kicked'].includes(member?.status)
      || (member?.status === 'restricted' && member.is_member === false);
  }

  function persist() {
    try { save(); }
    catch (_) { logger.error('[GROUP ACCESS] Could not save pending exits'); }
  }

  // Older versions queued exits after inconclusive owner lookups. Discard only
  // those unconfirmed decisions; every new operation still needs a fresh check.
  let recovered = false;
  for (const key of Object.keys(pending)) {
    if (pending[key]?.reason !== 'OWNER_CHECK_FAILED') continue;
    delete pending[key];
    if (!departed[key]) blocked.delete(key);
    recovered = true;
    logger.log(`[GROUP ACCESS] CHECK_RECOVERY chat=${key}`);
  }
  if (recovered) persist();

  function unknownOwner(key, error) {
    const status = Number(error?.response?.body?.error_code || error?.response?.statusCode);
    const description = error?.response?.body?.description || error?.message || '';
    const reason = status === 429 ? 'RATE_LIMIT'
      : status >= 500 && status < 600 ? 'TELEGRAM_UNAVAILABLE'
      : /CHAT_ADMIN_REQUIRED/i.test(description) ? 'ADMIN_REQUIRED'
      : status === 403 ? 'FORBIDDEN'
      : error?.code === 'ETIMEDOUT' || /timeout|ETIMEDOUT/i.test(description) ? 'TIMEOUT'
      : error ? 'LOOKUP_FAILED' : 'INVALID_MEMBER';
    logger.error(`[GROUP ACCESS] CHECK_DEFERRED chat=${key} reason=${reason}`);
    return false;
  }

  async function deliverNotice(key) {
    const notice = notices[key];
    if (!notice || notifying.has(key) || notice.retryAt > now()) return;
    notifying.add(key);
    try {
      await withTimeout(notify(Number(key), notice), timeoutMs, 'exit notification');
      if (notices[key] === notice) delete notices[key];
    } catch (error) {
      const retryAfter = Number(error.response?.body?.parameters?.retry_after) || 0;
      notice.retryAt = now() + Math.max(30000, retryAfter * 1000);
      logger.error(`[GROUP ACCESS] NOTICE_RETRY chat=${key}`);
    } finally {
      notifying.delete(key);
      persist();
    }
  }

  function confirmedExit(key, record, result) {
    if (pending[key] !== record) return;
    departed[key] = true;
    notices[key] = { name: record.name, reason: record.reason, result, retryAt: 0 };
    delete pending[key];
    persist();
  }

  async function leave(chatId) {
    const key = String(chatId);
    const record = pending[key];
    if (!record || record.retryAt > now()) return;
    if (exits.has(key)) return exits.get(key);
    const work = (async () => {
      try {
        const result = await withTimeout(bot.leaveChat(Number(chatId)), timeoutMs, 'leaveChat');
        if (result !== true) throw new Error('LEAVE_UNCONFIRMED');
        confirmedExit(key, record, 'left');
        logger.log(`[GROUP ACCESS] LEFT chat=${key}`);
      } catch (error) {
        const description = error.response?.body?.description || error.message || '';
        const deactivated = /chat is deactivated/i.test(description);
        let alreadyOut = /bot is not a member|bot was kicked/i.test(description);
        // Old basic groups can reject leaveChat even though the bot has already left.
        // A deactivated/inaccessible chat alone is not proof of non-membership.
        if (!alreadyOut && deactivated && Number.isSafeInteger(botId) && botId > 0) {
          try {
            const self = await withTimeout(bot.getChatMember(Number(chatId), botId),
              timeoutMs, 'getChatMember self');
            alreadyOut = ['left', 'kicked'].includes(self?.status)
              || (self?.status === 'restricted' && self.is_member === false);
          } catch (_) { /* Keep the exit pending when the self-check is inconclusive. */ }
        }
        if (alreadyOut) {
          confirmedExit(key, record, 'already_out');
          logger.log(`[GROUP ACCESS] ALREADY_OUT chat=${key}`);
        } else {
          const retryAfter = Number(error.response?.body?.parameters?.retry_after) || 0;
          record.retryAt = now() + Math.max(30000, retryAfter * 1000);
          const reason = deactivated ? 'CHAT_DEACTIVATED'
            : /chat not found/i.test(description) ? 'CHAT_NOT_FOUND' : 'OTHER';
          logger.error(`[GROUP ACCESS] LEAVE_RETRY chat=${key} reason=${reason} retryAt=${record.retryAt}`);
        }
      } finally {
        persist();
      }
    })();
    exits.set(key, work);
    try { await work; } finally { exits.delete(key); }
    await deliverNotice(key);
  }

  async function deny(chatId, reason) {
    const key = String(chatId);
    blocked.add(key);
    if (!pending[key]) {
      pending[key] = { retryAt: 0, name: chatName(chatId), reason };
      persist();
      logger.error(`[GROUP ACCESS] BLOCKED chat=${key} reason=${reason}`);
    }
    await leave(chatId);
    return false;
  }

  async function check(chatId) {
    if (Number(chatId) >= 0) return true;
    const key = String(chatId);
    if (blocked.has(key)) return false;
    if (checks.has(key)) return checks.get(key);
    const epoch = epochs.get(key);
    const work = (async () => {
      let member;
      try {
        if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('INVALID_OWNER_ID');
        member = await withTimeout(bot.getChatMember(Number(chatId), ownerId), timeoutMs, 'getChatMember');
      } catch (error) {
        if (epochs.get(key) !== epoch) return false;
        return unknownOwner(key, error);
      }
      if (blocked.has(key) || epochs.get(key) !== epoch) return false;
      if (isMember(member)) return true;
      if (isAbsent(member)) return deny(chatId, 'OWNER_ABSENT');
      return unknownOwner(key);
    })();
    checks.set(key, work);
    try { return await work; } finally { if (checks.get(key) === work) checks.delete(key); }
  }

  async function membership(update) {
    const chatId = update.chat?.id;
    if (!(chatId < 0)) return;
    const key = String(chatId);
    if (!isMember(update.new_chat_member) && !isAbsent(update.new_chat_member)) return;
    // A new membership event supersedes outstanding checks from the previous stay.
    epochs.set(key, (epochs.get(key) || 0) + 1);
    checks.delete(key);
    if (!isMember(update.new_chat_member)) {
      blocked.add(key);
      if (pending[key]) confirmedExit(key, pending[key], 'already_out');
      departed[key] = true;
      delete pending[key];
      persist();
      await deliverNotice(key);
      return;
    }
    if (!isMember(update.old_chat_member)) {
      // Finish any previous exit before checking a fresh invitation.
      await exits.get(key);
      blocked.delete(key);
      delete pending[key];
      delete departed[key];
      persist();
    }
    await check(chatId);
  }

  async function retryExits() {
    await Promise.all(Object.keys(pending).map(leave));
    for (const key of Object.keys(notices)) await deliverNotice(key);
  }

  async function requireAccess(chatId) {
    if (!(await check(chatId))) {
      const error = new Error('GROUP_ACCESS_DENIED');
      error.code = 'GROUP_ACCESS_DENIED';
      throw error;
    }
  }

  return { check, deny, membership, retryExits, requireAccess };
}

module.exports = { createGroupAccess };
