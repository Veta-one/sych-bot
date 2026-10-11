const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness() {
  const state = { sent: [], reminders: [], answers: [], summaries: [], parses: [], immediate: [], profileDescriptions: [], download: Buffer.from('audio'), transcript: 'Обычное сообщение.', muted: false, plan: { kind: 'answer' } };
  const storage = { isBanned: () => false, hasChat: () => true, updateChatName() {}, trackUser() {},
    isTopicMuted: () => state.muted, getProfile: () => ({}), getChatProfile: () => ({ topic: 'test' }),
    getUserInstruction: () => '', addReminder: (...args) => state.reminders.push(args) };
  storage.forgetUser = async () => {
    if (state.forgetResponder) await state.forgetResponder();
    return { profilesRemoved: 1, chatReferencesRemoved: 0, remindersRemoved: 0,
      instructionsRemoved: 0, chatProfilesReset: 0, backupsScrubbed: 0 };
  };
  storage.findProfileByQuery = () => state.targetProfile || null;
  const ai = {
    transcribeAudio: async () => ({ text: state.transcript }),
    summarizeVoiceTranscript: async text => { state.summaries.push(text); return 'Краткий текст'; },
    getResponse: async (history, input, media, mimeType, instruction, profile, spontaneous, chatProfile, externalContext) => {
      state.answers.push({ input, history: [...history], media, mimeType, externalContext }); return '4';
    },
    analyzeUserImmediate: async input => { state.immediate.push(input); return null; },
    describeImage: async () => null,
    generateProfileDescription: async (profile, targetName) => {
      state.profileDescriptions.push({ profile, targetName });
      return state.profileResponder ? state.profileResponder(profile) : 'Проверенное досье';
    },
    parseReminder: async (...args) => { state.parses.push(args); return state.plan; },
  };
  let messageId = 100;
  const sendRich = async (bot, chatId, content, opts) => {
    const sent = { messageId: ++messageId, chatId, content, opts };
    if (state.sendResponder) await state.sendResponder(content);
    state.sent.push(sent); return sent;
  };
  const dependencies = {
    './ephemeral': require('../src/core/ephemeral'),
    '../services/publication': require('../src/services/publication'),
    '../services/storage': storage, '../services/ai': ai,
    '../config': { adminId: 999, botId: 888, contextSize: 30, triggerRegex: /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i },
    axios: { get: async () => ({ data: state.download }) }, child_process: {},
    '../utils/rich': { sendRich, escapeHtml: x => String(x), normalizeMd: x => x,
      formatVoiceMessage: x => ({ html: `VOICE CARD: ${x.text}` }) },
    '../utils/privacy': require('../src/utils/privacy'), '../utils/profile-query': require('../src/utils/profile-query'),
    '../utils/commands': {}, '../services/documents': require('../src/services/documents'), '../utils/reminders': require('../src/utils/reminders'),
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
    module: box, require: n => { assert.ok(Object.hasOwn(dependencies, n), n); return dependencies[n]; },
    Buffer, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    Math: { random: () => 1 },
  });
  const bot = { getFileLink: async () => 'mock://voice', sendChatAction: async () => {},
    sendMessage: async (...args) => { (state.legacySends ||= []).push(args); } };
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

test('TXT captions and replies supply decoded file text without image media', async () => {
  for (const byReply of [false, true]) {
    const { state, message } = harness();
    state.download = Buffer.from('Маркер документа: FILE_TEST_731. Цена 270 рублей.', 'utf8');
    const document = { file_id: 'txt', file_name: 'sample.txt', mime_type: 'text/plain', file_size: state.download.length };
    await message(byReply
      ? { text: 'Сыч, прочитай файл', reply_to_message: { message_id: 21, from: { id: 77 }, document } }
      : { caption: 'Сыч, прочитай файл', document });
    assert.equal(state.answers.length, 1);
    assert.equal(state.answers[0].media, null);
    assert.match(state.answers[0].externalContext, /FILE_TEST_731/);
    assert.match(state.answers[0].externalContext, /270 рублей/);
  }
});

test('octet-stream TXT is decoded but PNG and PDF retain native media', async () => {
  const { state, message } = harness();
  state.download = Buffer.from('Документ с обычным текстом');
  await message({ caption: 'Сыч, прочитай', document: {
    file_id: 'txt', file_name: 'sample.txt', mime_type: 'application/octet-stream', file_size: state.download.length } });
  assert.equal(state.answers.length, 1);
  assert.equal(state.answers[0].media, null);
  assert.match(state.answers[0].externalContext, /обычным текстом/);
  for (const mime of ['image/png', 'application/pdf']) {
    state.download = Buffer.from(mime === 'image/png' ? 'synthetic PNG' : '%PDF-synthetic');
    await message({ caption: 'Сыч, прочитай', document: {
      file_id: mime, file_name: mime === 'image/png' ? 'a.png' : 'a.pdf', mime_type: mime, file_size: state.download.length } });
    assert.ok(Buffer.isBuffer(state.answers.at(-1).media));
    assert.equal(state.answers.at(-1).mimeType, mime);
  }
});

test('binary TXT produces a readable error without sending bytes to the AI', async () => {
  const { state, message } = harness();
  state.download = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3, 0]);
  await message({ caption: 'Сыч, прочитай файл', document: {
    file_id: 'binary', file_name: 'pretend.txt', mime_type: 'text/plain', file_size: state.download.length } });
  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].content.markdown, /Не смог разобрать файл/);
});

test('immediate profile analysis sees only the current user message, before any generated text', async () => {
  const { state, message } = harness();
  await message({ from: { id: 41, first_name: 'Другой' }, text: 'Сыч, я живу в тестовом городе Alpha.' });
  await message({ from: { id: 999, first_name: 'Тест' }, date: 1790000000, text: 'Сыч, привет!' });
  const input = state.immediate.at(-1);
  assert.equal(input.userId, 999);
  assert.equal(input.text, 'Сыч, привет!');
  assert.equal(input.date, 1790000000);
  assert.ok(Number.isInteger(input.messageId));
  assert.equal(JSON.stringify(input).includes('Alpha'), false);
  assert.equal(JSON.stringify(input).includes('Сыч: 4'), false);
});

test('self dossier requests use the same guarded description path as a participant query', async () => {
  for (const text of ['Сыч кто я?', 'Сыч, расскажи про меня', 'Сыч, что ты знаешь обо мне?']) {
    const { state, message } = harness();
    await message({ text });
    assert.equal(state.profileDescriptions.length, 1);
    assert.equal(state.profileDescriptions[0].profile.userId, 999);
    assert.equal(state.answers.length, 0);
    assert.equal(state.sent[0].content.markdown, 'Проверенное досье');
  }
  const { state, message } = harness();
  await message({ text: 'Сыч, кто я из героев книги?' });
  assert.equal(state.profileDescriptions.length, 0, 'creative queries stay in ordinary conversation');
  assert.equal(state.answers.length, 1);
});

test('reply-to-bot self dossier requests cannot bypass the audited profile path', async () => {
  const { state, message } = harness();
  await message({ text: 'Кто я?', reply_to_message: { message_id: 10, from: { id: 888 }, text: 'Привет!' } });
  assert.equal(state.profileDescriptions.length, 1);
  assert.equal(state.answers.length, 0);
});

test('forgetting while a self or third-party dossier is being generated cancels its publication', async () => {
  for (const aboutOther of [false, true]) {
    const { state, message } = harness();
    let release;
    state.profileResponder = () => new Promise(resolve => { release = resolve; });
    const targetId = aboutOther ? 42 : 999;
    if (aboutOther) state.targetProfile = { userId: 42, facts: 'Удаляемая тестовая информация.' };
    const pending = message({ text: aboutOther ? 'Сыч, расскажи про @target' : 'Сыч кто я?' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    await message({ text: 'Сыч, забудь меня', from: { id: targetId, first_name: 'Тест' } });
    release('Удаляемая тестовая информация.');
    await pending;
    assert.equal(state.sent.length, 1);
    assert.match(state.sent[0].content.markdown, /Готово/);
    assert.equal(JSON.stringify(state.sent).includes('Удаляемая тестовая информация'), false);
  }
});

test('dossier requests arriving during persistent deletion cannot read the previous profile', async () => {
  for (const aboutOther of [false, true]) {
    const { state, message } = harness();
    let finishDeletion;
    state.forgetResponder = () => new Promise(resolve => { finishDeletion = resolve; });
    const targetId = aboutOther ? 42 : 999;
    if (aboutOther) state.targetProfile = { userId: 42, facts: 'Удалённые сведения.' };
    const pending = message({ text: 'Сыч, забудь меня', from: { id: targetId, first_name: 'Тест' } });
    await new Promise(resolve => setImmediate(resolve));
    await message({ text: aboutOther ? 'Сыч, расскажи про @target' : 'Сыч кто я?' });
    assert.equal(state.profileDescriptions.length, 0);
    finishDeletion(); await pending;
    assert.equal(state.sent.length, 1);
  }
});

test('forgetting while ordinary delivery fails prevents emergency resending of stale content', async () => {
  const { state, message } = harness();
  let failSend;
  state.sendResponder = content => content.markdown === '4'
    ? new Promise((resolve, reject) => { failSend = reject; }) : Promise.resolve();
  const pending = message({ text: 'Сыч, привет' });
  await new Promise(resolve => setImmediate(resolve));
  await message({ text: 'Сыч, забудь меня' });
  failSend(new Error('Synthetic delivery failure')); await pending;
  assert.equal(state.legacySends?.length || 0, 0);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].content.markdown, /Готово/);
});
