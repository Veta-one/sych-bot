const { sendRich, escapeHtml } = require('../utils/rich');

function createReminderDelivery(bot, storage, send = sendRich) {
  const inFlight = new Set();
  return async () => {
    for (const task of storage.getPendingReminders()) {
      if (inFlight.has(task.id)) continue;
      inFlight.add(task.id);
      try {
        const html = `⏰ <b>${escapeHtml(task.username || '')}</b>, напоминаю!`
          + (task.text ? `<blockquote>${escapeHtml(task.text)}</blockquote>` : '');
        await send(bot, task.chatId, { html }, {
          threadId: task.threadId, businessId: task.businessId, replyTo: task.sourceMessageId,
        });
        storage.removeReminders([task.id]);
        storage.forceSave();
        console.log(`[REMINDER] Доставлено id=${task.id} chat=${task.chatId} thread=${task.threadId || 'general'}`);
      } catch (error) {
        // A network error must not silently delete an undelivered reminder.
        console.error(`[REMINDER ERROR] id=${task.id}: ${error.message}`);
      } finally {
        inFlight.delete(task.id);
      }
    }
  };
}

module.exports = { createReminderDelivery };
