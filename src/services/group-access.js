const { withTimeout } = require('../utils/async');

function createGroupAccess(bot, ownerId, { pending = {}, notices = {}, departed = {},
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

  function persist() {
    try { save(); }
    catch (_) { logger.error('[GROUP ACCESS] Could not save pending exits'); }
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
        if (/bot is not a member|bot was kicked/i.test(description)) {
          confirmedExit(key, record, 'already_out');
          logger.log(`[GROUP ACCESS] ALREADY_OUT chat=${key}`);
        } else {
          const retryAfter = Number(error.response?.body?.parameters?.retry_after) || 0;
          record.retryAt = now() + Math.max(30000, retryAfter * 1000);
          logger.error(`[GROUP ACCESS] LEAVE_RETRY chat=${key} retryAt=${record.retryAt}`);
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
      } catch (_) {
        if (epochs.get(key) !== epoch) return false;
        return deny(chatId, 'OWNER_CHECK_FAILED');
      }
      if (blocked.has(key) || epochs.get(key) !== epoch) return false;
      if (!isMember(member)) return deny(chatId, 'OWNER_ABSENT');
      return true;
    })();
    checks.set(key, work);
    try { return await work; } finally { if (checks.get(key) === work) checks.delete(key); }
  }

  async function membership(update) {
    const chatId = update.chat?.id;
    if (!(chatId < 0)) return;
    const key = String(chatId);
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
