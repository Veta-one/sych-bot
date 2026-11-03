const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.TELEGRAM_BOT_TOKEN = '999:synthetic';
process.env.ADMIN_USER_ID = '1';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-direct-chat-'));
process.env.SYCH_DATA_DIR = dataDir;

const calls = [];
const messages = [];
const aiPath = require.resolve('../src/services/ai');
require.cache[aiPath] = { loaded: true, exports: {
  async getResponse(history, msg, image, mime, instruction) {
    calls.push({ history: history.map(entry => entry.text), text: msg.text, instruction });
    if (msg.text === 'Ошибка') throw new Error('synthetic test error');
    return 'Тестовый ответ';
  },
  async analyzeUserImmediate() { return null; },
  getStatsReport() { assert.fail('Private chat must not expose internal statistics'); },
  async generateFlavorText() { assert.fail('Private chat must not run games'); },
  async parseReminder() { assert.fail('Private chat must not set reminders'); }
}};
require('../src/utils/rich').sendRich = async (bot, chat, content, options) => {
  messages.push({ chat, content, options });
  return { ok: true, messageId: messages.length + 100 };
};

const { processMessage } = require('../src/core/logic');
const storage = require('../src/services/storage');
const bot = { sendChatAction: async () => {} };

function message(id, text, extra = {}) {
  return { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: 'private' },
    from: { id: 42, first_name: 'Tester' }, text, ...extra };
}

test('direct chat answers without a mention, avoids group tools and keeps its context private', async () => {
  const direct = { directChat: true };
  assert.equal(await processMessage(bot, message(1, 'Просто вопрос'), direct), true);
  assert.equal(await processMessage(bot, message(2, 'Сыч, подбрось монетку'), direct), true);
  assert.equal(await processMessage(bot, message(3, 'Напомни завтра'), direct), true);
  assert.equal(await processMessage(bot, message(4, 'Ошибка'), direct), false);

  assert.equal(messages.length, 4, 'even a first contact and a provider error stay in the direct chat');
  assert.ok(messages.every(entry => entry.chat === 42 && entry.options.strictDelivery));

  await processMessage(bot, message(5, 'Сыч, бизнес вопрос', { business_connection_id: 'test' }));
  assert.equal(calls.length, 5);
  assert.ok(calls[1].history.includes('Просто вопрос'));
  assert.ok(!calls[4].history.includes('Просто вопрос'));
});

test.after(() => {
  storage.forceSave();
  storage.stopAutomaticBackups();
});
