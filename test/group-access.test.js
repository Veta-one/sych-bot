const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
process.env.TELEGRAM_BOT_TOKEN = '99:synthetic';

function loadIndex({ member = { status: 'member' }, error, knownChats = {} } = {}) {
  const calls = { processed: [], left: [], requests: [], notices: [], timers: [] };
  const handlers = {};
  let options;
  const bot = {
    on(name, handler) { handlers[name] = handler; },
    async sendMessage(chatId, text) { calls.notices.push({ chatId, text }); return { message_id: 1 }; },
    async getMe() { return { id: 99, username: 'Sych_Test_Bot' }; },
    async getChatMember() { if (error) throw error; return member; },
    async leaveChat(chatId) { calls.left.push(chatId); return true; },
    async _request(method, args) { calls.requests.push({ method, args }); return true; },
  };
  const storage = {
    paths: {}, data: { chats: knownChats }, startAutomaticBackups() {},
    stopAutomaticBackups() {}, forceSave() {}, getPendingReminders() { return []; },
  };
  const dependencies = {
    'node-telegram-bot-api': { TelegramBot: function (token, settings) { options = settings; return bot; } },
    './config': { telegramToken: '99:synthetic', botId: 99, adminId: 1, triggerRegex: /сыч/i },
    './core/logic': { async processMessage(...args) { calls.processed.push(args); } },
    './services/storage': storage,
    './services/ai': { setBot() {} },
    './services/private-billing': { createPrivateBilling: () => ({}) },
    './services/ephemeral-commands': { async ensureOwnerEphemeralCommands() {} },
    './utils/rich': { sendRich: async () => {}, escapeHtml: String },
    axios: {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8'), {
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      assert.ok(name.startsWith('./'), name);
      return require(path.join(__dirname, '../src', name));
    },
    console: { log() {}, error() {}, warn() {} },
    process: { env: {}, on() {}, exit() {} },
    setInterval(fn) { calls.timers.push(fn); return { unref() {} }; },
    setTimeout, clearTimeout,
  });
  const message = extra => ({ chat: { id: -123, type: 'supergroup' }, from: { id: 2 },
    date: Math.floor(Date.now() / 1000), text: 'Сыч, привет', ...extra });
  return { bot, handlers, calls, message, options, storage };
}

test('CHAT_ADMIN_REQUIRED leaves the group before any conversation processing', async () => {
  const f = loadIndex({ error: new Error('ETELEGRAM: 400 Bad Request: CHAT_ADMIN_REQUIRED') });
  await f.handlers.message(f.message());
  assert.equal(f.calls.processed.length, 0);
  assert.deepEqual(f.calls.left, [-123]);
});

test('all failed owner checks block ordinary and hidden group inputs', async () => {
  for (const text of ['ETIMEDOUT', '502 Bad Gateway', 'Forbidden']) {
    for (const extra of [{}, { ephemeral_message_id: 7 }]) {
      const f = loadIndex({ error: new Error(text) });
      await f.handlers.message(f.message(extra));
      assert.equal(f.calls.processed.length, 0, text);
      assert.deepEqual(f.calls.left, [-123]);
    }
  }
});

test('owner membership allows messages, absence exits, including restricted membership', async () => {
  for (const member of [{ status: 'creator' }, { status: 'administrator' }, { status: 'member' },
    { status: 'restricted', is_member: true }]) {
    const f = loadIndex({ member });
    await f.handlers.message(f.message());
    assert.equal(f.calls.processed.length, 1);
    assert.equal(f.calls.left.length, 0);
  }
  for (const member of [{ status: 'left' }, { status: 'kicked' }, { status: 'restricted', is_member: false }, null]) {
    const f = loadIndex({ member });
    await f.handlers.message(f.message());
    assert.equal(f.calls.processed.length, 0);
    assert.deepEqual(f.calls.left, [-123]);
  }
});

test('addition event checks the group even when there have been no messages', async () => {
  const f = loadIndex({ member: { status: 'left' } });
  assert.ok(f.options.polling.params.allowed_updates.includes('my_chat_member'));
  await f.handlers.my_chat_member({ chat: { id: -123 },
    old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } });
  assert.deepEqual(f.calls.left, [-123]);
  assert.equal(f.calls.processed.length, 0);
});

test('owner departure blocks without relying on another successful Telegram lookup', async () => {
  const f = loadIndex();
  await f.handlers.message(f.message({ left_chat_member: { id: 1 } }));
  assert.equal(f.calls.processed.length, 0);
  assert.deepEqual(f.calls.left, [-123]);
  await assert.rejects(f.bot._request('sendMessage', { form: { chat_id: -123, text: 'late answer' } }),
    { code: 'GROUP_ACCESS_DENIED' });
  assert.equal(f.calls.requests.length, 0);
});

test('outgoing messages and reactions recheck access while private destinations remain usable', async () => {
  const f = loadIndex({ error: new Error('CHAT_ADMIN_REQUIRED') });
  for (const method of ['sendMessage', 'sendPhoto', 'sendChatAction', 'setMessageReaction', 'editMessageText']) {
    await assert.rejects(f.bot._request(method, { form: { chat_id: -123 } }), { code: 'GROUP_ACCESS_DENIED' });
  }
  await f.bot._request('sendMessage', { form: { chat_id: 1 } });
  assert.equal(f.calls.requests.length, 1);
  assert.deepEqual(f.calls.left, [-123]);
});

test('known groups are checked at startup', async () => {
  const f = loadIndex({ error: new Error('CHAT_ADMIN_REQUIRED'), knownChats: { '-123': { chatName: 'Test group' } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.calls.left, [-123]);
  assert.equal(f.calls.notices.length, 1);
  assert.equal(f.calls.notices[0].chatId, 1);
  assert.match(f.calls.notices[0].text, /Вышел из группы\nTest group\nID -123/);
  assert.deepEqual(Object.keys(f.storage.data.groupDeparted), ['-123']);
});

const { createGroupAccess } = require('../src/services/group-access');
const quiet = { log() {}, error() {} };

test('failed exit stays persisted and blocked, respects retry_after, and succeeds on a later tick', async () => {
  let clock = 1000;
  let attempts = 0;
  let saved = '';
  const pending = {};
  const bot = {
    async getChatMember() { throw new Error('CHAT_ADMIN_REQUIRED'); },
    async leaveChat() {
      if (++attempts === 1) throw Object.assign(new Error('Too Many Requests'), {
        response: { body: { parameters: { retry_after: 60 } } },
      });
      return true;
    },
  };
  const access = createGroupAccess(bot, 1, { pending, save: () => { saved = JSON.stringify(pending); },
    now: () => clock, logger: quiet });
  assert.equal(await access.check(-123), false);
  assert.equal(JSON.parse(saved)['-123'].retryAt, 61000);
  assert.equal(await access.check(-123), false);
  await access.retryExits();
  assert.equal(attempts, 1);
  clock = 61000;
  await access.retryExits();
  assert.equal(attempts, 2);
  assert.equal(saved, '{}');
  assert.equal(await access.check(-123), false, 'an exited group stays blocked until a new invitation');
});

test('pending exits recover after a restart and do not enable message handling', async () => {
  const calls = [];
  const pending = { '-123': { retryAt: 0 } };
  const access = createGroupAccess({ async leaveChat(id) { calls.push(id); return true; } }, 1,
    { pending, logger: quiet });
  assert.equal(await access.check(-123), false);
  await access.retryExits();
  assert.deepEqual(calls, [-123]);
  assert.deepEqual(pending, {});
});

test('concurrent messages share one failed check and one exit', async () => {
  let checks = 0;
  let exits = 0;
  const access = createGroupAccess({
    async getChatMember() { checks++; throw new Error('CHAT_ADMIN_REQUIRED'); },
    async leaveChat() { exits++; return true; },
  }, 1, { logger: quiet });
  const results = await Promise.all(Array.from({ length: 20 }, () => access.check(-123)));
  assert.ok(results.every(result => result === false));
  assert.equal(checks, 1);
  assert.equal(exits, 1);
});

test('a stuck membership lookup times out and initiates exit', async () => {
  const left = [];
  const access = createGroupAccess({ getChatMember: () => new Promise(() => {}),
    async leaveChat(id) { left.push(id); return true; } }, 1, { timeoutMs: 10, logger: quiet });
  assert.equal(await access.check(-123), false);
  assert.deepEqual(left, [-123]);
});

test('a delayed successful lookup cannot override a block', async () => {
  let resolveCheck;
  const access = createGroupAccess({ getChatMember: () => new Promise(resolve => { resolveCheck = resolve; }),
    async leaveChat() { return true; } }, 1, { logger: quiet });
  const checking = access.check(-123);
  await access.deny(-123, 'OWNER_LEFT');
  resolveCheck({ status: 'member' });
  assert.equal(await checking, false);
});

test('a fresh invitation can authorize a previously exited group', async () => {
  const access = createGroupAccess({ async getChatMember() { return { status: 'member' }; },
    async leaveChat() { return true; } }, 1, { logger: quiet });
  await access.deny(-123, 'OWNER_ABSENT');
  await access.membership({ chat: { id: -123 }, old_chat_member: { status: 'left' },
    new_chat_member: { status: 'member' } });
  assert.equal(await access.check(-123), true);
});

test('Rich delivery stops before any HTTP request when the group is denied', async () => {
  const { sendRich } = require('../src/utils/rich');
  let checks = 0;
  const bot = { async requireGroupAccess() { checks++; throw new Error('blocked before HTTP'); } };
  for (const options of [{}, { strictDelivery: true }, { ephemeral: { receiverUserId: 1 } }]) {
    await assert.rejects(sendRich(bot, -123, { markdown: 'late answer' }, options), /blocked before HTTP/);
  }
  assert.equal(checks, 3);
});

test('denied reminders are retained without sending', async () => {
  const { createReminderDelivery } = require('../src/services/reminder-delivery');
  let sent = 0;
  const storage = { getPendingReminders: () => [{ id: 1, chatId: -123, text: 'test' }],
    removeReminders() { assert.fail('must retain reminder'); } };
  const deliver = createReminderDelivery({ async requireGroupAccess() { throw new Error('blocked'); } },
    storage, async () => { sent++; });
  await deliver();
  assert.equal(sent, 0);
});

test('owner notifications are sent only after confirmed exit and retried after delivery failure', async () => {
  let clock = 0;
  let canLeave = false;
  let canNotify = false;
  let attempts = 0;
  const pending = {};
  const notices = {};
  const departed = {};
  const access = createGroupAccess({ async leaveChat() {
    if (!canLeave) throw new Error('temporary failure');
    return true;
  } }, 1, { pending, notices, departed, now: () => clock, logger: quiet,
    chatName: () => 'Test group', async notify(id, notice) {
      attempts++;
      assert.equal(id, -123);
      assert.equal(notice.name, 'Test group');
      assert.equal(notice.result, 'left');
      if (!canNotify) throw new Error('temporary delivery failure');
    } });
  await access.deny(-123, 'OWNER_ABSENT');
  assert.equal(attempts, 0, 'failed leave must never be announced as completed');
  clock = 30000;
  canLeave = true;
  await access.retryExits();
  assert.equal(attempts, 1);
  assert.equal(notices['-123'].name, 'Test group');
  assert.equal(departed['-123'], true);
  clock = 60000;
  canNotify = true;
  await access.retryExits();
  assert.equal(attempts, 2);
  assert.deepEqual(notices, {});
});

test('already exited groups do not generate repeated exit notices after restart', async () => {
  const access = createGroupAccess({ getChatMember() { assert.fail('already exited'); },
    leaveChat() { assert.fail('already exited'); } }, 1, { departed: { '-123': true }, logger: quiet });
  assert.equal(await access.check(-123), false);
});

test('unconfirmed and hanging exits remain in the retry queue', async () => {
  for (const leaveChat of [async () => false, () => new Promise(() => {})]) {
    const pending = {};
    const access = createGroupAccess({ leaveChat }, 1, { pending, logger: quiet, timeoutMs: 10 });
    await access.deny(-123, 'OWNER_ABSENT');
    assert.ok(pending['-123']);
    assert.equal(await access.check(-123), false);
  }
});

test('a block between Rich attempts prevents ordinary, strict and hidden HTTP fallbacks', async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const { sendRich } = require('../src/utils/rich');
  try {
    for (const options of [{}, { strictDelivery: true, replyTo: 3 },
      { ephemeral: { receiverUserId: 1 } }]) {
      let blocked = false;
      let requests = 0;
      const requireGroupAccess = async () => {
        if (blocked) throw Object.assign(new Error('GROUP_ACCESS_DENIED'), { code: 'GROUP_ACCESS_DENIED' });
      };
      const bot = { requireGroupAccess, async sendMessage() {
        await requireGroupAccess();
        assert.fail('legacy fallback must remain blocked');
      } };
      axios.post = async () => {
        requests++;
        blocked = true;
        throw Object.assign(new Error('format rejected'), { response: { status: 400,
          data: { ok: false, error_code: 400, description: 'Bad Request: RICH_MESSAGE_INVALID' } } });
      };
      await assert.rejects(sendRich(bot, -123, { markdown: '![image](https://example.com/image.png) text' }, options));
      assert.equal(requests, 1);
    }
  } finally { axios.post = originalPost; }
});
