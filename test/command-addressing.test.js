const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { resolveAddressedCommand } = require('../src/utils/commands');

test('commands require an exact bot recipient and accept case-insensitive names and arguments', async () => {
  let identityCalls = 0;
  const bot = { getMe: async () => { identityCalls++; return { username: 'Siitch_bot' }; } };
  for (const text of ['/mute', '/mute @Siitch_bot', '/mute@Other_bot', '/mute@Siitch_bot_extra', '/mute@Siitch_bot@Other_bot', '/mute@Siitch_bot!', 'hello /mute@Siitch_bot']) {
    assert.equal(await resolveAddressedCommand(bot, text), null, text);
  }
  const results = await Promise.all([
    resolveAddressedCommand(bot, '/MUTE@SIITCH_BOT'),
    resolveAddressedCommand(bot, '/ban@Siitch_bot @some_user'),
    resolveAddressedCommand(bot, '  /unban@siitch_bot\n123456'),
  ]);
  assert.deepEqual(results.map(result => result.name), ['/mute', '/ban', '/unban']);
  assert.equal(identityCalls, 1);
  const otherBot = { getMe: async () => ({ username: 'Another_bot' }) };
  assert.equal(await resolveAddressedCommand(otherBot, '/mute@Siitch_bot'), null);
  assert.equal((await resolveAddressedCommand(otherBot, '/mute@Another_bot')).name, '/mute');
});

test('a failed identity request can be retried without accepting a command blindly', async () => {
  let calls = 0;
  const bot = { getMe: async () => {
    if (++calls === 1) throw new Error('temporary network failure');
    return { username: 'Siitch_bot' };
  } };
  await assert.rejects(resolveAddressedCommand(bot, '/mute@Siitch_bot'), /network failure/);
  assert.equal((await resolveAddressedCommand(bot, '/mute@Siitch_bot')).name, '/mute');
});

function loadHandler() {
  const effects = [];
  const storage = {
    isBanned: () => false,
    hasChat: () => true,
    updateChatName: () => {},
    trackUser: () => {},
    isTopicMuted: () => false,
    toggleMute: (chat, thread) => { effects.push({ chat, thread }); return true; },
  };
  const dependencies = {
    '../services/storage': storage,
    '../services/ai': {},
    '../config': { adminId: 999, botId: 888, triggerRegex: /сыч|sych/i },
    axios: {},
    child_process: {},
    '../utils/rich': { sendRich: async () => { effects.push('sent'); } },
    '../utils/privacy': { isForgetMeRequest: () => false },
    '../utils/profile-query': {},
    '../utils/commands': { resolveAddressedCommand },
    '../services/documents': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
    module,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), name);
      return dependencies[name];
    },
    console: { log() {}, error() {} },
  });
  return { processMessage: module.exports.processMessage, effects };
}

test('bare and foreign commands are ignored before media, AI, or destructive command handling', async () => {
  const { processMessage, effects } = loadHandler();
  const bot = { getMe: async () => ({ username: 'Siitch_bot' }) };
  const base = {
    message_id: 10, from: { id: 999 },
    chat: { id: -100, type: 'supergroup' },
    reply_to_message: { from: { id: 888 } },
    voice: { file_id: 'must-not-download' },
  };
  for (const name of ['mute', 'reset', 'restart', 'ban', 'unban', 'banlist', 'forget_me', 'start', 'help', 'version']) {
    for (const suffix of ['', '@Other_bot']) {
      for (const type of ['private', 'supergroup']) {
        const text = `/${name}${suffix} Сыч`;
        await processMessage(bot, { ...base, chat: { ...base.chat, type }, text });
        await processMessage(bot, { ...base, chat: { ...base.chat, type }, caption: text });
      }
    }
  }
  assert.deepEqual(effects, []);
});

test('an explicitly addressed mute still targets the incoming forum topic', async () => {
  const { processMessage, effects } = loadHandler();
  await processMessage({ getMe: async () => ({ username: 'Siitch_bot' }) }, {
    message_id: 10, from: { id: 999 }, chat: { id: -100, type: 'supergroup' },
    text: '/Mute@Siitch_bot', is_topic_message: true, message_thread_id: 184,
  });
  assert.deepEqual(effects, [{ chat: -100, thread: 184 }, 'sent']);
});
