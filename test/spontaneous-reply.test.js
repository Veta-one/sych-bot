const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Проверяем саму фичу: бот влезает в чужой разговор без обращения по имени.
// Харнесс повторяет test/conversation-routing.test.js, но управляет шансом и случаем.
function harness({ chance = 1, cooldownMs = 15 * 60 * 1000, random = () => 0, reply = 'Ну и затея, конечно.' } = {}) {
  const state = { sent: [], answers: [] };
  const storage = { isBanned: () => false, hasChat: () => true, updateChatName() {}, trackUser() {},
    isTopicMuted: () => false, getProfile: () => ({}), getChatProfile: () => ({ topic: 'test' }),
    getUserInstruction: () => '' };
  const ai = {
    getResponse: async (history, input, image, mime, instruction, profile, isSpontaneous) => {
      state.answers.push({ input, isSpontaneous, history: [...history] });
      return reply;
    },
    analyzeUserImmediate: async () => null,
    determineReaction: async () => null,
  };
  const sendRich = async (bot, chatId, content, opts) => {
    state.sent.push({ chatId, content, opts });
    return { messageId: state.sent.length };
  };
  const dependencies = {
    '../services/storage': storage,
    '../services/ai': ai,
    '../config': {
      adminId: 999, botId: 888, contextSize: 30,
      spontaneousChance: chance, spontaneousCooldownMs: cooldownMs,
      spontaneousMaxChars: 300, reactionChance: 0,
      triggerRegex: /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i,
    },
    axios: { get: async () => ({ data: Buffer.from('x') }) },
    child_process: {},
    '../utils/rich': { sendRich, escapeHtml: x => String(x), normalizeMd: x => x,
      formatVoiceMessage: x => ({ html: `VOICE CARD: ${x.text}` }), quoteFallback: () => null },
    '../utils/privacy': { isForgetMeRequest: () => false },
    '../utils/profile-query': {},
    '../utils/commands': {},
    '../services/documents': {},
    '../utils/reminders': require('../src/utils/reminders'),
    '../utils/interjection': require('../src/utils/interjection'),
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
    module: box,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    Buffer, console: { log() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math: { ...Math, random },
  });
  const bot = {
    getFileLink: async () => 'mock://file',
    sendChatAction: async () => {},
    setMessageReaction: async () => {},
  };
  return { state, async message(text, overrides = {}) {
    const msg = {
      message_id: 500, from: { id: 555, first_name: 'Тест' },
      chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 184,
      text, ...overrides,
    };
    await box.exports.processMessage(bot, msg);
    return msg;
  } };
}

const LONG_TEXT = 'Сегодня обсудили новую гипотезу по заявкам, выглядит спорно';

test('без обращения бот вставляет короткую реплику от себя', async () => {
  const { state, message } = harness({ chance: 1, random: () => 0 });
  await message(LONG_TEXT);

  assert.equal(state.answers.length, 1, 'модель вызвана один раз');
  assert.equal(state.answers[0].isSpontaneous, true, 'ответ помечен как спонтанный');
  assert.equal(state.sent.length, 1, 'в чат ушло ровно одно сообщение');
  assert.equal(state.sent[0].content.markdown, 'Ну и затея, конечно.');
  assert.equal(state.sent[0].opts.threadId, 184, 'ответ остаётся в той же теме');
});

test('кулдаун не даёт влезать в один чат чаще заданного', async () => {
  const { state, message } = harness({ chance: 1, random: () => 0 });
  await message(LONG_TEXT);
  await message(LONG_TEXT);

  assert.equal(state.answers.length, 1, 'вторая реплика заблокирована кулдауном');
  assert.equal(state.sent.length, 1);
});

test('при нулевом шансе бот молчит', async () => {
  const { state, message } = harness({ chance: 0, random: () => 0 });
  await message(LONG_TEXT);

  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 0);
});

test('по обращению «Сыч» бот отвечает как обычно, а не вмешивается', async () => {
  const { state, message } = harness({ chance: 1, random: () => 0 });
  await message('Сыч, что думаешь про новую гипотезу по заявкам?');

  assert.equal(state.answers.length, 1);
  assert.equal(state.answers[0].isSpontaneous, false, 'обычный ответ, не вмешательство');
});

test('в business-переписках бот не влезает сам', async () => {
  const { state, message } = harness({ chance: 1, random: () => 0 });
  await message(LONG_TEXT, { business_connection_id: 'bc-1' });

  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 0);
});

test('на короткую реплику бот не реагирует', async () => {
  const { state, message } = harness({ chance: 1, random: () => 0 });
  await message('ок');

  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 0);
});
