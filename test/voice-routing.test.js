const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function indexHarness({ provider = 'off', ownerPresent = true, privateEnabled = true } = {}) {
  const calls = { processed: [], sent: [], billing: [], left: [], ownerChecks: [], business: [] };
  const handlers = {};
  const bot = {
    on(name, handler) { handlers[name] = handler; },
    async sendMessage(...args) { calls.sent.push(args); },
    async getMe() { return { id: 99, username: 'Synthetic_Bot' }; },
    async getChatMember(id) { calls.ownerChecks.push(id); return { status: ownerPresent ? 'member' : 'left' }; },
    async leaveChat(id) { calls.left.push(id); return true; },
    async getBusinessConnection(id) { calls.business.push(id); throw new Error('connection unavailable'); },
    async _request() { return true; },
  };
  const config = { adminId: 1, botId: 99, telegramToken: '99:synthetic', triggerRegex: /сыч/i,
    voiceTranscriptionProvider: provider };
  const dependencies = {
    'node-telegram-bot-api': { TelegramBot: function () { return bot; } },
    './config': config,
    './core/logic': { async processMessage(...args) { calls.processed.push(args); } },
    './services/storage': { data: { chats: {} }, paths: {}, save() {}, forceSave() {},
      startAutomaticBackups() {}, stopAutomaticBackups() {}, getPendingReminders: () => [] },
    './services/ai': { setBot() {} },
    './services/reminder-delivery': { createReminderDelivery: () => async () => {} },
    './services/private-billing': { createPrivateBilling: () => ({
      hasPurchased: () => true, handleMessage(msg) { calls.billing.push(msg); },
    }) },
    './services/ephemeral-commands': { async ensureOwnerEphemeralCommands() {} },
    './utils/rich': { escapeHtml: String, async sendRich() { assert.fail('Unexpected rich response'); } },
    axios: {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8'), {
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      assert.ok(name.startsWith('./'), name);
      return require(path.join(__dirname, '../src', name));
    },
    console: { log() {}, error() {}, warn() {} },
    process: { env: { SYCH_PRIVATE_CHAT_ENABLED: String(privateEnabled),
      SYCH_PAYMENT_SUPPORT_URL: 'https://t.me/synthetic_support' }, on() {}, exit() {} },
    setTimeout, clearTimeout, setInterval() { return { unref() {} }; },
  });
  const message = extra => ({ message_id: 42, date: Math.floor(Date.now() / 1000),
    chat: { id: -123, type: 'supergroup' }, from: { id: 2 }, ...extra });
  return { handlers, calls, message };
}

test('off silently skips group, owner-private and ephemeral audio updates', async () => {
  const f = indexHarness();
  for (const media of ['voice', 'audio']) {
    for (const extra of [{}, { ephemeral_message_id: 4 }, { chat: { id: 1, type: 'private' }, from: { id: 1 } }]) {
      await f.handlers.message(f.message({ [media]: { file_id: 'synthetic' }, ...extra }));
    }
  }
  assert.equal(f.calls.processed.length, 0);
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.billing.length, 0);
  assert.equal(f.calls.ownerChecks.length, 4, 'group access remains checked before off');
});

test('off does not suppress an exit from a group without the owner', async () => {
  const f = indexHarness({ ownerPresent: false });
  await f.handlers.message(f.message({ voice: { file_id: 'synthetic' } }));
  assert.deepEqual(f.calls.left, [-123]);
  assert.equal(f.calls.processed.length, 0);
  assert.equal(f.calls.sent.length, 1, 'owner still receives the confirmed exit notice');
  assert.equal(f.calls.sent[0][0], 1);
});

test('off bypasses private billing and pause replies for audio but preserves payments', async () => {
  for (const privateEnabled of [true, false]) {
    const f = indexHarness({ privateEnabled });
    const privateMessage = extra => f.message({ chat: { id: 2, type: 'private' }, ...extra });
    for (const media of ['voice', 'audio']) {
      await f.handlers.message(privateMessage({ [media]: { file_id: 'synthetic' } }));
    }
    assert.equal(f.calls.billing.length, 0);
    assert.equal(f.calls.sent.length, 0);
    for (const event of ['successful_payment', 'refunded_payment']) {
      await f.handlers.message(privateMessage({ [event]: { currency: 'XTR' } }));
    }
    assert.equal(f.calls.billing.length, 2);
  }
});

test('off ignores new and edited business audio before connection lookup or debug notices', async () => {
  const f = indexHarness();
  for (const handler of ['business_message', 'edited_business_message']) {
    await f.handlers[handler](f.message({ business_connection_id: 'synthetic-connection',
      chat: { id: 2, type: 'private' }, caption: 'Сыч, проверь', audio: { file_id: 'synthetic' } }));
  }
  assert.equal(f.calls.business.length, 0);
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.processed.length, 0);
});

test('off preserves ordinary text and text replies to audio; enabled providers preserve voice routing', async () => {
  const f = indexHarness();
  await f.handlers.message(f.message({ text: 'Сыч, привет' }));
  await f.handlers.message(f.message({ text: 'Сыч, обсудим', reply_to_message: { voice: { file_id: 'old' } } }));
  assert.equal(f.calls.processed.length, 2);
  for (const provider of ['google', 'openrouter']) {
    const enabled = indexHarness({ provider });
    await enabled.handlers.message(enabled.message({ voice: { file_id: 'synthetic' } }));
    assert.equal(enabled.calls.processed.length, 1);
  }
});

test('the real logic handler ignores off audio before any downstream side effect', async () => {
  const calls = [];
  const dependency = new Proxy({}, { get(_target, name) { return () => { calls.push(name); }; } });
  const mod = { exports: {} };
  // Real logic.js with import-time factories supplied; all runtime dependencies fail the assertion.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
    module: mod, Buffer, console,
    require(name) {
      if (name === '../config') return { voiceTranscriptionProvider: 'off' };
      if (name === '../utils/reminders') return require('../src/utils/reminders');
      if (name === './ephemeral') return {
        isEphemeralMessage: msg => Boolean(msg.ephemeral_message_id),
        createEphemeralHandler: () => async () => { calls.push('ephemeral'); },
      };
      if (name === '../services/publication') return { createPublication: () => ({}) };
      if (name === '../utils/conversation-followups') return require('../src/utils/conversation-followups');
      if (name === '../utils/auto-tldr') return require('../src/utils/auto-tldr');
      return dependency;
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  for (const media of ['voice', 'audio']) {
    for (const extra of [{}, { ephemeral_message_id: 9 }]) {
      const msg = { chat: { id: 2, type: 'private' }, from: { id: 2 }, [media]: {}, ...extra };
      await mod.exports.processMessage(dependency, msg, { directChat: true });
    }
  }
  assert.deepEqual(calls, []);
});

test('help reflects disabled voice support without exposing provider configuration', () => {
  const { buildHelp } = require('../src/utils/help');
  const args = { version: 'test', commandSuffix: '@Synthetic_Bot' };
  assert.match(buildHelp(args), /Скажи в <b>голосовом/);
  const disabled = buildHelp({ ...args, voiceTranscriptionProvider: 'off' });
  assert.match(disabled, /Голосовые и аудиофайлы отключены/);
  assert.doesNotMatch(disabled, /Скажи в <b>голосовом|Короткий <b>войс|Можно голосом|OPENROUTER|VOICE_TRANSCRIPTION/);
});
