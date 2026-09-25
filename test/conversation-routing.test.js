const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness() {
  const state = { sent: [], reminders: [], answers: [], summaries: [], parses: [], transcript: 'Обычное сообщение.', muted: false, plan: { kind: 'answer' } };
  const storage = { isBanned: () => false, hasChat: () => true, updateChatName() {}, trackUser() {},
    isTopicMuted: () => state.muted, getProfile: () => ({}), getChatProfile: () => ({ topic: 'test' }),
    getUserInstruction: () => '', addReminder: (...args) => state.reminders.push(args) };
  const ai = {
    transcribeAudio: async () => ({ text: state.transcript }),
    summarizeVoiceTranscript: async text => { state.summaries.push(text); return 'Краткий текст'; },
    getResponse: async (history, input) => { state.answers.push({ input, history: [...history] }); return '4'; },
    analyzeUserImmediate: async () => null,
    parseReminder: async (...args) => { state.parses.push(args); return state.plan; },
  };
  let messageId = 100;
  const sendRich = async (bot, chatId, content, opts) => {
    const sent = { messageId: ++messageId, chatId, content, opts };
    state.sent.push(sent); return sent;
  };
  const dependencies = {
    '../services/storage': storage, '../services/ai': ai,
    '../config': { adminId: 999, botId: 888, contextSize: 30, triggerRegex: /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i },
    axios: { get: async () => ({ data: Buffer.from('audio') }) }, child_process: {},
    '../utils/rich': { sendRich, escapeHtml: x => String(x), normalizeMd: x => x,
      formatVoiceMessage: x => ({ html: `VOICE CARD: ${x.text}` }) },
    '../utils/privacy': { isForgetMeRequest: () => false }, '../utils/profile-query': {},
    '../utils/commands': {}, '../services/documents': {}, '../utils/reminders': require('../src/utils/reminders'),
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
    module: box, require: n => { assert.ok(Object.hasOwn(dependencies, n), n); return dependencies[n]; },
    Buffer, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    Math: { random: () => 1 },
  });
  const bot = { getFileLink: async () => 'mock://voice', sendChatAction: async () => {} };
  return { state, async message(overrides) {
    const msg = { message_id: ++messageId, from: { id: 999, first_name: 'Тест' },
      chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 184, ...overrides };
    await box.exports.processMessage(bot, msg); return msg;
  } };
}

test('spoken Sych request gets one ordinary answer without a transcript card or summary', async () => {
  const { state, message } = harness();
  state.transcript = 'Сыч, сколько будет 2+2?';
  await message({ voice: { file_id: 'v' } });
  assert.equal(state.answers.length, 1);
  assert.equal(state.answers[0].input.text, state.transcript);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].content.markdown, '4');
  assert.equal(state.sent[0].opts.threadId, 184);
  assert.equal(state.summaries.length, 0);
});

test('spoken reply continues the dialog without needing the name; captions also call the bot', async () => {
  for (const overrides of [{ reply_to_message: { message_id: 2, from: { id: 888 }, text: 'Прошлый ответ' } }, { caption: 'Сыч, ответь на вопрос' }]) {
    const { state, message } = harness();
    state.transcript = 'А почему?';
    await message({ voice: { file_id: 'v' }, ...overrides });
    assert.equal(state.answers.length, 1);
    assert.equal(state.summaries.length, 0);
    assert.equal(state.sent.length, 1);
  }
});

test('ordinary voice remains a transcript card, and muted voice produces no output', async () => {
  const { state, message } = harness();
  await message({ voice: { file_id: 'v' } });
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].content.html, /VOICE CARD/);
  assert.equal(state.answers.length, 0);
  state.muted = true;
  state.transcript = 'Сыч, сколько будет 2+2?';
  await message({ voice: { file_id: 'v' } });
  assert.equal(state.sent.length, 1);
  assert.equal(state.answers.length, 0);
});

test('informational remind question reaches the normal answer without scheduling', async () => {
  const { state, message } = harness();
  await message({ text: 'Сыч, напомни, сколько раз Путин участвовал в дебатах?' });
  assert.equal(state.answers.length, 1);
  assert.equal(state.reminders.length, 0);
  assert.equal(state.sent.length, 1);
});

test('voice scheduling uses the same handler, preserving topic and original announcement', async () => {
  const { state, message } = harness();
  state.transcript = 'Сыч, напомни завтра в двенадцать';
  state.plan = { kind: 'schedule', targetTime: '2030-01-01T07:00:00Z', reminderText: 'Посмотреть стрим' };
  await message({ voice: { file_id: 'v' }, reply_to_message: { message_id: 12, text: 'Анонс стрима', date: 1790000000 } });
  assert.equal(state.parses[0][1], 'Анонс стрима');
  assert.equal(state.reminders.length, 1);
  assert.equal(state.reminders[0][5].threadId, 184);
  assert.equal(state.reminders[0][5].sourceMessageId, 12);
  assert.equal(state.summaries.length, 0);
  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 1);
});

test('clarification retains original intent and accepts only an exact reply from the same user and topic', async () => {
  const { state, message } = harness();
  state.plan = { kind: 'clarify', question: 'Во сколько завтра?' };
  await message({ text: 'Сыч, напомни завтра', reply_to_message: { message_id: 12, text: 'Анонс стрима' } });
  const question = state.sent[0];
  const reply = { message_id: question.messageId, from: { id: 888 }, text: question.content.markdown };
  const parses = state.parses.length;
  await message({ text: 'в 12', reply_to_message: reply, from: { id: 42, first_name: 'Другой' } });
  await message({ text: 'в 12', reply_to_message: reply, message_thread_id: 185 });
  assert.equal(state.parses.length, parses);
  state.plan = { kind: 'schedule', targetTime: '2030-01-01T07:00:00Z', reminderText: 'Стрим' };
  await message({ text: 'в 12', reply_to_message: reply });
  assert.equal(state.reminders.length, 1);
  assert.match(state.parses.at(-1)[0], /Сыч, напомни завтра.*\n.*в 12/);
  assert.equal(state.parses.at(-1)[1], 'Анонс стрима');
  await message({ text: 'в 12', reply_to_message: reply });
  assert.equal(state.reminders.length, 1, 'consumed clarification cannot schedule twice');
});

test('cancelling a pending clarification creates no reminder', async () => {
  const { state, message } = harness();
  state.plan = { kind: 'clarify', question: 'Когда?' };
  await message({ text: 'Сыч напомни купить молоко' });
  const prompt = state.sent[0];
  state.plan = { kind: 'cancel' };
  await message({ text: 'отмена', reply_to_message: { message_id: prompt.messageId, from: { id: 888 }, text: prompt.content.markdown } });
  assert.equal(state.reminders.length, 0);
  assert.match(state.sent.at(-1).content.markdown, /не создаю/);
});
