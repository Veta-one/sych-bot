const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

let chatProfileMethods;
function useRealChatProfiles(h) {
  if (!chatProfileMethods) {
    const os = require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-init-regression-'));
    const original = process.env.SYCH_DATA_DIR;
    try {
      process.env.SYCH_DATA_DIR = directory;
      chatProfileMethods = require('../src/services/storage').StorageService.prototype;
    } finally {
      if (original === undefined) delete process.env.SYCH_DATA_DIR;
      else process.env.SYCH_DATA_DIR = original;
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  h.storage.chatProfiles = {};
  h.storage.chatProfilesBlockedUntil = new Map();
  h.storage.saveChatProfiles = () => {};
  h.storage.getChatProfile = chatProfileMethods.getChatProfile;
  h.storage.updateChatProfile = chatProfileMethods.updateChatProfile;
}

function harness({ manualProfileTimer = true } = {}) {
  const profileTimers = [];
  const timerSet = (fn, ms, ...args) => {
    if (manualProfileTimer && ms === 10000) {
      const timer = { fn, cancelled: false, unref() {} }; profileTimers.push(timer); return timer;
    }
    return setTimeout(fn, ms, ...args);
  };
  const timerClear = timer => profileTimers.includes(timer) ? timer.cancelled = true : clearTimeout(timer);
  const state = { sent: [], reminders: [], answers: [], summaries: [], tldrSummaries: [], parses: [], immediate: [], profileDescriptions: [], download: Buffer.from('audio'), transcript: 'Обычное сообщение.', muted: false, plan: { kind: 'answer' } };
  const storage = { isBanned: () => Boolean(state.banned), hasChat: () => true, updateChatName() {}, trackUser() {},
    isTopicMuted: () => state.muted, getProfile: () => ({}), getChatProfile: () => ({ topic: 'test' }),
    getUserInstruction: () => '', addReminder: (...args) => state.reminders.push(args),
    getProfilesForUsers: () => ({}), bulkUpdateProfiles: (...args) => (state.profileWrites ||= []).push(args),
    updateChatProfile: (...args) => (state.chatProfileWrites ||= []).push(args) };
  storage.forgetUser = async () => {
    if (state.forgetResponder) await state.forgetResponder();
    return { profilesRemoved: 1, chatReferencesRemoved: 0, remindersRemoved: 0,
      instructionsRemoved: 0, chatProfilesReset: 0, backupsScrubbed: 0 };
  };
  storage.findProfileByQuery = () => state.targetProfile || null;
  const ai = {
    summarizeLongMessage: async text => { state.tldrSummaries.push(text); return state.tldrResponder
      ? state.tldrResponder(text) : 'Автор объясняет устройство нового инструмента. Оригинал полезен тем, кто планирует его подключать.'; },
    transcribeAudio: async () => state.transcriptionResponder ? state.transcriptionResponder() : ({ text: state.transcript }),
    summarizeVoiceTranscript: async text => { state.summaries.push(text); return 'Краткий текст'; },
    getResponse: async (history, input, media, mimeType, instruction, profile, spontaneous, chatProfile, externalContext, policy) => {
      state.answers.push({ input, history: [...history], media, mimeType, externalContext });
      return state.answerResponder ? state.answerResponder(policy) : '4';
    },
    analyzeUserImmediate: async (input, profile, context) => { state.immediate.push(input); (state.relationshipContexts ||= []).push(context); return null; },
    analyzeBatch: async messages => { (state.batches ||= []).push(messages); return {}; }, analyzeChatProfile: async () => ({}),
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
    if (state.sendResponder) {
      const result = await state.sendResponder(content, chatId);
      if (result !== undefined) { state.sent.push(sent); return result; }
    }
    state.sent.push(sent); return sent;
  };
  const dependencies = {
    './ephemeral': require('../src/core/ephemeral'),
    '../services/publication': require('../src/services/publication'),
    '../services/storage': storage, '../services/ai': ai,
    '../config': { adminId: 999, botId: 888, contextSize: 30, triggerRegex: /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i },
    axios: { get: async () => ({ data: state.download }) }, child_process: {},
    '../utils/rich': { sendRich, escapeHtml: x => String(x), normalizeMd: x => x,
      quoteFallback: () => null, formatVoiceMessage: x => ({ html: `VOICE CARD: ${x.text}` }) },
    '../utils/privacy': require('../src/utils/privacy'), '../utils/profile-query': require('../src/utils/profile-query'),
    '../utils/help': require('../src/utils/help'), '../utils/commands': require('../src/utils/commands'), '../services/documents': require('../src/services/documents'), '../utils/reminders': require('../src/utils/reminders'),
    '../utils/conversation-followups': require('../src/utils/conversation-followups'),
    '../utils/auto-tldr': require('../src/utils/auto-tldr'),
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
    module: box, require: n => { assert.ok(Object.hasOwn(dependencies, n), n); return dependencies[n]; },
    Buffer, console: { log() {}, error() {}, warn() {} }, setTimeout: timerSet, clearTimeout: timerClear, setInterval, clearInterval,
    Math: { random: () => 1 },
  });
  const bot = { getFileLink: async () => 'mock://voice', sendChatAction: async () => {},
    getMe: async () => ({ username: 'Siitch_bot' }),
    sendMessage: async (...args) => {
      (state.legacySends ||= []).push(args);
      return state.legacyResponder ? state.legacyResponder(...args) : { message_id: ++messageId };
    } };
  return { state, ai, storage, bot, async flushProfiles() {
    for (const timer of profileTimers.splice(0)) if (!timer.cancelled) timer.fn();
    await new Promise(setImmediate);
  }, async message(overrides) {
    const msg = { message_id: ++messageId, from: { id: 999, first_name: 'Тест' },
      chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 184, ...overrides };
    await box.exports.processMessage(bot, msg); return msg;
  } };
}

test('an unconfirmed gallery recovery does not trigger a duplicate emergency message', async () => {
  const { state, message } = harness();
  let attempts = 0;
  state.sendResponder = async () => {
    attempts++;
    throw Object.assign(new Error('Gallery delivery unconfirmed'), { code: 'RICH_DELIVERY_UNCONFIRMED' });
  };
  await message({ text: 'Сыч, покажи как выглядит буханка' });
  assert.equal(attempts, 1);
  assert.equal(state.legacySends?.length || 0, 0);
});

test('ordinary unaddressed conversation gains and loses reputation through one background channel', async () => {
  const h = harness({ manualProfileTimer: true });
  h.ai.analyzeBatch = async messages => ({ 999: { relationshipEvents: messages.map(m => ({ messageId: m.messageId,
    delta: m.text.includes('полезный') ? 1 : -1 })) } });
  await h.message({ message_id: 1, text: 'Вот полезный разбор ошибки для всех.' });
  await h.message({ message_id: 2, text: 'бессмысленный повторный спам' });
  assert.equal(h.state.answers.length, 0);
  await h.flushProfiles();
  const events = h.state.profileWrites.flatMap(call => Object.values(call[1]).map(update => update.relationshipEvent).filter(Boolean));
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ messageId: 1, delta: 1 }, { messageId: 2, delta: -1 }]);
  assert.equal(h.state.immediate.length, 0);
});

test('an answered request is scored once by the observer, never a second time after the answer', async () => {
  const h = harness({ manualProfileTimer: true });
  h.ai.analyzeBatch = async messages => ({ 999: { relationshipEvents: messages.map(m => ({ messageId: m.messageId, delta: 1 })) } });
  await h.message({ message_id: 10, text: 'Сыч, спасибо за полезный разговор' });
  await h.flushProfiles();
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.immediate.length, 0);
  assert.equal(h.state.profileWrites.filter(call => call[1][999]?.relationshipEvent).length, 1);
});

test('a flush due during an active drain processes the small new backlog when the drain ends', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeBatch = messages => new Promise(resolve => batches.push({ messages, resolve }));
  await h.message({ message_id: 1, text: 'Первая реплика' }); await h.flushProfiles();
  await h.message({ message_id: 2, text: 'Вторая реплика' }); await h.flushProfiles();
  assert.equal(batches.length, 1);
  batches[0].resolve({}); await new Promise(setImmediate);
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1].messages.map(m => m.messageId)], [2]);
  batches[1].resolve({}); await new Promise(setImmediate);
});

test('a failed background batch waits for another input instead of retrying on a timer forever', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeBatch = async messages => { batches.push(messages); return null; };
  await h.message({ message_id: 1, text: 'Реплика' }); await h.flushProfiles();
  await h.flushProfiles(); await h.flushProfiles();
  assert.equal(batches.length, 1);
  await h.message({ message_id: 2, text: 'Новая реплика' }); await h.flushProfiles();
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1].map(m => m.messageId)], [1, 2]);
});

test('duplicate delivery during a failed active batch cannot poison the retry with ambiguous IDs', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeBatch = messages => new Promise(resolve => batches.push({ messages, resolve }));
  await h.message({ message_id: 1, text: 'Реплика' }); await h.flushProfiles();
  await h.message({ message_id: 1, text: 'Реплика' });
  batches[0].resolve(null); await new Promise(setImmediate);
  await h.message({ message_id: 2, text: 'Новая реплика' }); await h.flushProfiles();
  assert.deepEqual([...batches[1].messages.map(m => m.messageId)], [1, 2]);
  batches[1].resolve({ 999: { relationshipEvents: [{ messageId: 1, delta: 1 }, { messageId: 2, delta: 1 }] } });
  await new Promise(setImmediate);
  assert.equal(h.state.profileWrites.filter(call => call[1][999]?.relationshipEvent).length, 2);
});

test('forgetting a context author invalidates nearby reputation but retains another authors own evidence', async () => {
  const h = harness(); let finish;
  h.ai.analyzeBatch = () => new Promise(resolve => { finish = resolve; });
  await h.message({ message_id: 1, from: { id: 42 }, text: 'Слова участника A' });
  await h.message({ message_id: 2, text: 'Я люблю шахматы.' }); await h.flushProfiles();
  await h.message({ from: { id: 42 }, text: 'Сыч, забудь меня' });
  finish({ 999: { factEvidence: [{ userId: '999', messageId: '2', quote: 'Я люблю шахматы.' }],
    relationshipEvents: [{ messageId: 2, delta: 1, attitude: 'Отношение из старого контекста' }] } });
  await new Promise(setImmediate);
  assert.equal(h.state.profileWrites.length, 1);
  assert.deepEqual(Object.keys(h.state.profileWrites[0][1][999]), ['factEvidence']);
});

test('context dependency is checked again inside the storage queue and stays scoped to its topic', async () => {
  const h = harness();
  h.ai.analyzeBatch = async () => ({ 999: { relationshipEvents: [{ messageId: 2, delta: 1 }, { messageId: 3, delta: 1 }] } });
  await h.message({ message_id: 1, from: { id: 42 }, text: 'Контекст' });
  await h.message({ message_id: 2, text: 'Участник B' });
  await h.message({ message_id: 3, text: 'Другой топик', message_thread_id: 185 }); await h.flushProfiles();
  const writes = h.state.profileWrites.filter(call => call[1][999]?.relationshipEvent);
  assert.equal(writes.length, 2);
  await h.message({ from: { id: 42 }, text: 'Сыч, забудь меня' });
  assert.equal(writes[0][2].isCurrent(999), false);
  assert.equal(writes[1][2].isCurrent(999), true);
});

test('a failed detached batch cannot requeue a forgotten replied authors words', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeBatch = messages => new Promise(resolve => batches.push({ messages, resolve }));
  await h.message({ message_id: 2, text: 'Мой ответ', reply_to_message: {
    message_id: 1, from: { id: 42 }, text: 'FORGOTTEN_REPLY_CONTEXT',
  } }); await h.flushProfiles();
  await h.message({ from: { id: 42 }, text: 'Сыч, забудь меня' });
  batches[0].resolve(null); await new Promise(setImmediate);
  await h.message({ message_id: 3, text: 'Новая реплика' }); await h.flushProfiles();
  assert.doesNotMatch(JSON.stringify(batches[1].messages), /FORGOTTEN_REPLY_CONTEXT/);
  batches[1].resolve({}); await new Promise(setImmediate);
});

test('forgetting a reply author during group access lookup removes their context before the model request', async () => {
  const h = harness(), requests = []; let allow, checks = 0;
  h.bot.requireGroupAccess = () => ++checks === 1 ? new Promise(resolve => { allow = resolve; }) : Promise.resolve();
  h.ai.analyzeBatch = async messages => { requests.push(messages); return {}; };
  await h.message({ message_id: 2, text: 'Моя реплика', reply_to_message: {
    message_id: 1, from: { id: 42 }, text: 'FORGOTTEN_BEFORE_MODEL',
  } }); await h.flushProfiles();
  await h.message({ from: { id: 42 }, text: 'Сыч, забудь меня' });
  allow(); await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /FORGOTTEN_BEFORE_MODEL/);
});

test('only public human nonforwarded ordinary messages can receive background reputation', async () => {
  const h = harness();
  h.ai.analyzeBatch = async messages => Object.fromEntries(messages.map(m => [String(m.userId), {
    relationshipEvents: messages.filter(other => other.userId === m.userId).map(other => ({ messageId: other.messageId, delta: 1 })),
  }]));
  await h.message({ message_id: 1, text: 'Пересланное', forward_origin: { type: 'user' } });
  await h.message({ message_id: 2, text: 'Бот', from: { id: 77, is_bot: true } });
  await h.message({ message_id: 3, text: 'Анонимный канал', sender_chat: { id: -500 } });
  await h.message({ message_id: 4, text: ' /version@Siitch_bot' });
  h.state.muted = true;
  await h.message({ message_id: 5, text: 'Замьюченное' }); h.state.muted = false;
  await h.message({ message_id: 6, text: 'Сыч, личное', chat: { id: 999, type: 'private' } });
  await h.message({ message_id: 7, text: 'Обычный вклад' }); await h.flushProfiles();
  const events = (h.state.profileWrites || []).flatMap(call => Object.values(call[1]).map(u => u.relationshipEvent).filter(Boolean));
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ messageId: 7, delta: 1 }]);
});

test('long messages are split into bounded batches without silently dropping the first messages', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeBatch = async messages => { batches.push(messages); return {}; };
  for (let id = 1; id <= 20; id++) await h.message({ message_id: id, text: 'А'.repeat(8100) });
  await new Promise(setImmediate);
  await h.flushProfiles();
  assert.deepEqual(batches.flatMap(batch => [...batch.map(m => m.messageId)]), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(batches.every(batch => batch.reduce((sum, m) => sum + m.text.length, 0) <= 32000));
});

test('forgetting during voice summary cannot enqueue the old transcript after deletion', async () => {
  const h = harness({ manualProfileTimer: true });
  const batches = [];
  h.ai.analyzeBatch = async messages => { batches.push(messages); return {}; };
  let finish;
  h.ai.summarizeVoiceTranscript = () => new Promise(resolve => { finish = resolve; });
  h.state.transcript = 'OLD_TRANSCRIPT_BEFORE_FORGET';
  const pending = h.message({ message_id: 1, voice: { file_id: 'voice' } });
  await new Promise(setImmediate);
  await h.message({ text: 'Сыч, забудь меня' });
  finish('Кратко'); await pending;
  for (let id = 2; id <= 20; id++) await h.message({ message_id: id, text: 'Новая реплика' });
  await h.flushProfiles();
  assert.ok(batches.every(batch => batch.every(message => !message.text.includes('OLD_TRANSCRIPT_BEFORE_FORGET'))));
});

test('group delivery does not cut off the last link in a long collected source list', async () => {
  const { state, message } = harness();
  const { renderFoundSources } = require('../src/services/research');
  const foundSources = Array.from({ length: 24 }, (_, index) => ({ title: `Source ${index}`, url: `https://example.org/${index}?q=${'a'.repeat(1500)}` }));
  const list = renderFoundSources({ foundSources });
  assert.ok(list.length > 30000);
  state.answerResponder = policy => { policy.onFoundSources(); return list; };
  await message({ text: 'Сыч, покажи ссылки' });
  assert.ok(state.sent.at(-1).content.markdown.includes(foundSources.at(-1).url));
});

test('observer detaches twenty messages once and retains message22 for the next nonoverlapping batch', async () => {
  const { message, ai, storage } = harness();
  storage.getProfilesForUsers = () => ({});
  storage.bulkUpdateProfiles = () => {};
  const batches = [];
  ai.analyzeBatch = messages => new Promise(resolve => batches.push({ ids: messages.map(m => m.messageId), resolve }));
  for (let id = 1; id <= 21; id++) await message({ message_id: id, text: 'Обычная реплика' });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].ids.length, 20);
  await message({ message_id: 22, text: 'Новая реплика' });
  batches[0].resolve({}); await new Promise(setImmediate);
  for (let id = 23; id <= 40; id++) await message({ message_id: id, text: 'Обычная реплика' });
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1].ids], Array.from({ length: 20 }, (_, i) => i + 21));
  batches[1].resolve({}); await new Promise(setImmediate);
});

test('observer drains accumulated batches sequentially and preserves new input after technical failure', async () => {
  for (const failed of [false, true]) {
    const { message, ai } = harness();
    const batches = [];
    ai.analyzeBatch = messages => new Promise(resolve => batches.push({ ids: messages.map(m => m.messageId), resolve }));
    for (let id = 1; id <= 41; id++) await message({ message_id: id, text: 'Реплика' });
    assert.equal(batches.length, 1);
    batches[0].resolve(failed ? null : {}); await new Promise(setImmediate);
    if (failed) {
      assert.equal(batches.length, 1, 'An unavailable batch is not retried in a loop');
      await message({ message_id: 42, text: 'Новая реплика' });
      assert.equal(batches.length, 2);
      assert.deepEqual([...batches[1].ids], Array.from({ length: 20 }, (_, i) => i + 1));
      batches[1].resolve({}); await new Promise(setImmediate);
    }
    const next = batches[failed ? 2 : 1];
    assert.ok(next, 'A full backlog drains without another incoming message');
    assert.deepEqual([...next.ids], Array.from({ length: 20 }, (_, i) => i + 21));
    next.resolve({}); await new Promise(setImmediate);
    for (let id = failed ? 43 : 42; id <= 60; id++) await message({ message_id: id, text: 'Реплика' });
    assert.deepEqual([...batches.at(-1).ids], Array.from({ length: 20 }, (_, i) => i + 41));
    batches.at(-1).resolve({}); await new Promise(setImmediate);
  }
});

test('one answered message collects facts and its sole relationship event from the observer', async () => {
  const { message, ai, state } = harness();
  let finishBatch;
  ai.analyzeBatch = () => new Promise(resolve => { finishBatch = resolve; });
  ai.analyzeUserImmediate = async input => ({ relationshipEvent: { messageId: input.messageId, delta: 1 } });
  for (let id = 1; id <= 19; id++) await message({ message_id: id, text: 'Реплика' });
  let finishAnswer;
  state.answerResponder = () => new Promise(resolve => { finishAnswer = resolve; });
  const answer = message({ message_id: 20, text: 'Сыч, спасибо' }); await new Promise(setImmediate);
  finishBatch({ 999: { relationship: 53, attitude: 'Недопустимое мнение batch', relationshipEvent: { messageId: 20, delta: 3 },
    relationshipEvents: [{ messageId: 20, delta: 1 }],
    factEvidence: [{ userId: '999', messageId: '20', quote: 'Сыч, спасибо' }] } });
  await new Promise(setImmediate);
  finishAnswer('Пожалуйста'); await answer; await new Promise(setImmediate);
  const updates = state.profileWrites.map(call => call[1]['999']);
  assert.equal(updates.length, 2);
  assert.deepEqual(Object.keys(updates[0]), ['factEvidence']);
  assert.deepEqual(JSON.parse(JSON.stringify(updates[1])), { relationshipEvent: { messageId: 20, delta: 1 } });
});

test('background inputs preserve authors, topic and business scope without inserting bot answers', async () => {
  const { message, state, flushProfiles } = harness();
  state.answerResponder = () => `BOT_${state.answers.at(-1).input.text}`;
  await message({ text: 'Сыч, OWN_OLD' });
  await message({ text: 'Сыч, FOREIGN_USER', from: { id: 77, first_name: 'Чужой' } });
  await message({ text: 'Сыч, FOREIGN_TOPIC', message_thread_id: 185 });
  await message({ text: 'Сыч, FOREIGN_BUSINESS', business_connection_id: 'another' });
  await message({ text: 'FORWARDED_TEXT', forward_origin: { type: 'user' } });
  let finish;
  state.answerResponder = () => new Promise(resolve => { finish = resolve; });
  const pending = message({ text: 'Сыч, TARGET_NOW' });
  await new Promise(setImmediate);
  await message({ text: 'FUTURE_MESSAGE' });
  finish('CURRENT_BOT_REPLY'); await pending;
  await flushProfiles();
  const batch = state.batches.at(-1);
  assert.equal(batch.find(m => m.text.includes('FOREIGN_USER')).userId, 77);
  const own = batch.find(m => m.text.includes('OWN_OLD'));
  assert.notEqual(batch.find(m => m.text.includes('FOREIGN_TOPIC')).scope, own.scope);
  assert.notEqual(batch.find(m => m.text.includes('FOREIGN_BUSINESS')).scope, own.scope);
  assert.equal(batch.find(m => m.text === 'FORWARDED_TEXT').isForwarded, true);
  assert.doesNotMatch(JSON.stringify(batch), /BOT_|CURRENT_BOT_REPLY/);
});

test('relationship context never attributes a generated image description to its sender', async () => {
  const { ai, message, state, flushProfiles } = harness();
  ai.describeImage = async () => 'FOREIGN_PHOTO_DESCRIPTION';
  await message({ text: 'Сыч, посмотри', reply_to_message: {
    message_id: 10, from: { id: 77 }, photo: [{ file_id: 'foreign-photo' }],
  } });
  await new Promise(setImmediate);
  await message({ text: 'Сыч, продолжаем' });
  assert.ok(state.answers.at(-1).history.some(entry => entry.text.includes('FOREIGN_PHOTO_DESCRIPTION')),
    'The image-memory enrichment must actually have occurred');
  await flushProfiles();
  const context = state.batches.at(-1);
  assert.equal(context[0].text, 'Сыч, посмотри');
  assert.doesNotMatch(JSON.stringify(context), /FOREIGN_PHOTO_DESCRIPTION/);
});

test('background batch restores message order after late voice recognition', async () => {
  const { message, state, flushProfiles } = harness();
  await message({ message_id: 10, text: 'Сыч, OLD_MESSAGE' });
  let finish;
  state.transcriptionResponder = () => new Promise(resolve => { finish = resolve; });
  const pending = message({ message_id: 30, voice: { file_id: 'voice' } });
  await new Promise(setImmediate);
  await message({ message_id: 31, text: 'Сыч, FUTURE_MESSAGE' });
  finish({ text: 'Сыч, VOICE_MESSAGE' }); await pending;
  await flushProfiles();
  assert.deepEqual([...state.batches.at(-1).map(m => m.messageId)], [10, 30, 31]);
});

test('forgetting during command address resolution invalidates its earlier relationship context', async () => {
  const { message, state, bot, flushProfiles } = harness();
  await message({ text: 'Сыч, FORGOTTEN_MESSAGE' });
  let finish;
  bot.getMe = () => new Promise(resolve => { finish = resolve; });
  const before = state.immediate.length;
  const pending = message({ text: '/comment@Siitch_bot Сыч, спасибо' });
  await new Promise(setImmediate);
  await message({ text: 'Сыч, забудь меня' });
  finish({ username: 'Siitch_bot' }); await pending;
  assert.equal(state.immediate.length, before, 'Stale address resolution must not resurrect forgotten context');
  assert.equal(state.answers.length, 1);
  await message({ text: 'Сыч, новый разговор' });
  await flushProfiles();
  assert.doesNotMatch(JSON.stringify(state.batches.at(-1)), /FORGOTTEN_MESSAGE|\/comment/);
});

test('forgotten in-flight batch results and failed-batch requeue cannot resurrect that user', async () => {
  for (const failed of [false, true]) {
    const { message, ai, state } = harness();
    const batches = [];
    ai.analyzeBatch = messages => new Promise(resolve => batches.push({ messages, resolve }));
    for (let id = 1; id <= 20; id++) await message({ message_id: id, from: { id: id <= 10 ? 42 : 999 }, text: 'Реплика' });
    await message({ text: 'Сыч, забудь меня', from: { id: 42 } });
    batches[0].resolve(failed ? null : {
      42: { factEvidence: [{ userId: '42', messageId: '1', quote: 'Удалённые слова' }] },
      999: { factEvidence: [{ userId: '999', messageId: '11', quote: 'Реплика' }] },
    });
    await new Promise(setImmediate);
    assert.ok(!(state.profileWrites || []).some(call => call[1]['42']));
    for (let id = 21; id <= (failed ? 30 : 40); id++) await message({ message_id: id, text: 'Новая реплика' });
    assert.equal(batches.length, 2);
    assert.ok(batches[1].messages.every(message => message.userId === 999));
    batches[1].resolve({}); await new Promise(setImmediate);
  }
});

test('forget/reset invalidates late background events and queued profile writes', async () => {
  for (const command of ['Сыч, забудь меня', '/reset@Siitch_bot']) {
    const h = harness();
    let finish;
    h.ai.analyzeBatch = () => new Promise(resolve => { finish = resolve; });
    await h.message({ message_id: 10, text: 'Сыч, привет' });
    await h.flushProfiles();
    await h.message({ text: command });
    finish({ 999: { relationshipEvents: [{ messageId: 10, delta: 3 }] } }); await new Promise(setImmediate);
    assert.equal(h.state.profileWrites?.length || 0, 0);

    h.ai.analyzeBatch = async () => ({ 999: { relationshipEvents: [{ messageId: 11, delta: 1 }] } });
    await h.message({ message_id: 11, text: 'Сыч, привет' }); await new Promise(setImmediate);
    await h.flushProfiles();
    const guard = h.state.profileWrites.at(-1)[2].isCurrent;
    assert.equal(guard(999), true);
    await h.message({ text: command });
    assert.equal(guard(999), false, 'The actual storage queue must be able to reject a write after a later reset');
  }
});

test('chat profile drain also detaches its batch and preserves message51; reset cancels in-flight output', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeChatProfile = messages => new Promise(resolve => batches.push({ ids: messages.map(message => message.messageId), resolve }));
  for (let id = 1; id <= 51; id++) await h.message({ message_id: id, text: 'Реплика' });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].ids.length, 50);
  batches[0].resolve({ topic: 'Синтетическая тема' }); await new Promise(setImmediate);
  for (let id = 52; id <= 100; id++) await h.message({ message_id: id, text: 'Реплика' });
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1].ids], Array.from({ length: 50 }, (_, i) => i + 51));
  await h.message({ text: '/reset@Siitch_bot' });
  batches[1].resolve({ topic: 'Удалённая тема' }); await new Promise(setImmediate);
  assert.equal(h.state.chatProfileWrites.length, 1);
});

test('chat analysis timeout releases its drain for a later input without losing the detached batch', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeChatProfile = messages => new Promise(resolve => batches.push({ ids: messages.map(message => message.messageId), resolve }));
  for (let id = 1; id <= 51; id++) await h.message({ message_id: id, text: 'Реплика' });
  batches[0].resolve(null); await new Promise(setImmediate);
  assert.equal(batches.length, 1, 'No autonomous retry loop after a technical failure');
  await h.message({ message_id: 52, text: 'Новая реплика' });
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1].ids], Array.from({ length: 50 }, (_, i) => i + 1));
  batches[1].resolve({}); await new Promise(setImmediate);
  for (let id = 53; id <= 100; id++) await h.message({ message_id: id, text: 'Реплика' });
  assert.deepEqual([...batches[2].ids], Array.from({ length: 50 }, (_, i) => i + 51));
  batches[2].resolve({}); await new Promise(setImmediate);
});

test('pending deletion excludes newly buffered user messages and stale results while preserving other users', async () => {
  const h = harness(), batches = [];
  h.ai.analyzeBatch = messages => new Promise(resolve => batches.push({ messages, resolve }));
  for (let id = 1; id <= 20; id++) await h.message({ message_id: id, from: { id: id <= 10 ? 42 : 999 }, text: 'Реплика' });
  let finishDeletion;
  h.state.forgetResponder = () => new Promise(resolve => { finishDeletion = resolve; });
  const deletion = h.message({ text: 'Сыч, забудь меня', from: { id: 42 } }); await new Promise(setImmediate);
  await h.message({ message_id: 21, from: { id: 42 }, text: 'Сообщение во время удаления' });
  batches[0].resolve(null); await new Promise(setImmediate);
  for (let id = 22; id <= 31; id++) await h.message({ message_id: id, text: 'Реплика' });
  assert.equal(batches.length, 2);
  assert.ok(batches[1].messages.every(message => message.userId === 999));
  finishDeletion(); await deletion;
  batches[1].resolve({ 42: { factEvidence: [{ userId: '42', messageId: '21', quote: 'Сообщение во время удаления' }] } });
  await new Promise(setImmediate);
  assert.ok(!(h.state.profileWrites || []).some(call => call[1]['42']));
});

test('empty chat profile initialization cannot overlap another initialization or publish after reset', async () => {
  const h = harness(), calls = [];
  useRealChatProfiles(h);
  h.ai.analyzeChatProfile = messages => new Promise(resolve => calls.push({ messages, resolve }));
  for (let id = 1; id <= 9; id++) await h.message({ message_id: id, text: 'Реплика', is_topic_message: false });
  await h.message({ message_id: 10, text: 'Сыч, привет', is_topic_message: false });
  await h.message({ message_id: 11, text: 'Сыч, привет снова', is_topic_message: false });
  const count = calls.length;
  await h.message({ message_id: 12, text: '/reset@Siitch_bot', is_topic_message: false });
  for (const call of calls) call.resolve({ topic: 'OLD_TOPIC_BEFORE_RESET' });
  await new Promise(setImmediate);
  assert.equal(h.storage.getChatProfile(-100).topic, null, 'A reset invalidates initialization before the actual storage update');
  assert.equal(count, 1, 'Only one chat analysis may run at a time');
});

test('chat profile initialization releases its shared drain and starts a full accumulated batch after failure', async () => {
  for (const throws of [false, true]) {
    const h = harness(), calls = [];
    useRealChatProfiles(h);
    h.ai.analyzeChatProfile = messages => new Promise((resolve, reject) => calls.push({ messages, resolve, reject }));
    for (let id = 1; id <= 50; id++) await h.message({ message_id: id, text: id === 10 ? 'Сыч, привет' : 'Реплика', is_topic_message: false });
    const count = calls.length;
    if (throws) calls[0].reject(new Error('synthetic failure')); else calls[0].resolve(null);
    await new Promise(setImmediate);
    assert.equal(count, 1, 'An accumulated batch must wait for the active initialization');
    assert.equal(calls.length, 2, 'The ready batch starts when initialization releases the drain');
    assert.deepEqual([...calls[1].messages.map(message => message.messageId)], Array.from({ length: 50 }, (_, i) => i + 1));
    calls[1].resolve({}); await new Promise(setImmediate);
  }
});

test('initialization guards the forgotten author referenced only by a surviving bot reply', async () => {
  const h = harness(), calls = [];
  useRealChatProfiles(h);
  h.ai.analyzeChatProfile = messages => new Promise(resolve => calls.push({ messages, resolve }));
  await h.message({ message_id: 1, text: 'Сыч, привет', from: { id: 42 }, is_topic_message: false });
  for (let id = 2; id <= 29; id++) await h.message({ message_id: id, text: 'Реплика', is_topic_message: false });
  await h.message({ message_id: 30, text: 'Сыч, привет снова', is_topic_message: false });
  assert.equal(calls.length, 1);
  await h.message({ text: 'Сыч, забудь меня', from: { id: 42 }, is_topic_message: false });
  calls[0].resolve({ topic: 'TOPIC_FROM_FORGOTTEN_REPLY' }); await new Promise(setImmediate);
  assert.equal(h.storage.getChatProfile(-100).topic, null);
});

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

test('background profile inputs retain actual ownership and never append generated text', async () => {
  const { state, message, flushProfiles } = harness();
  await message({ from: { id: 41, first_name: 'Другой' }, text: 'Сыч, я живу в тестовом городе Alpha.' });
  await message({ from: { id: 999, first_name: 'Тест' }, date: 1790000000, text: 'Сыч, привет!' });
  await flushProfiles();
  const input = state.batches.at(-1).find(m => m.userId === 999);
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

test('a confirmed ordinary answer permits an explicit reply to the author own question', async () => {
  const { state, message } = harness();
  const original = await message({ text: 'Сыч, как работает тестовая лицензия?' });
  const continuation = await message({ text: 'Проверь подробнее', reply_to_message: original });
  assert.equal(state.answers.length, 2);
  assert.equal(state.answers[1].input.replyText, original.text);
  assert.equal(state.answers[1].history.some(entry => entry.text === '4'), true);
  await message({ text: 'А теперь сравни', reply_to_message: continuation });
  assert.equal(state.answers.length, 3, 'confirmed followups can themselves receive a followup');
});

test('own-question followups require the same sender, chat, topic, business connection and known target', async () => {
  const { state, message } = harness();
  const original = await message({ text: 'Сыч, вопрос', business_connection_id: 'business-A' });
  for (const overrides of [
    { from: { id: 42, first_name: 'Другой' } },
    { chat: { id: -101, type: 'supergroup' } },
    { message_thread_id: 185 },
    { business_connection_id: 'business-B' },
    { business_connection_id: undefined },
    { reply_to_message: { ...original, message_id: 98765 } },
    { reply_to_message: { ...original, from: { id: 42 } } },
    { reply_to_message: undefined },
  ]) {
    await message({ text: 'Проверь подробнее', business_connection_id: 'business-A', reply_to_message: original, ...overrides });
  }
  assert.equal(state.answers.length, 1);
  await message({ text: 'Проверь подробнее', business_connection_id: 'business-A', reply_to_message: original });
  assert.equal(state.answers.length, 2);
});

test('a delivery still awaiting confirmation cannot authorize an own-question followup', async () => {
  const { state, message } = harness();
  let finishDelivery;
  state.sendResponder = (content, chatId) => chatId === -100 && content.markdown === '4'
    ? new Promise(resolve => { finishDelivery = resolve; }) : undefined;
  const original = { message_id: 220, from: { id: 999 }, text: 'Сыч, вопрос' };
  const pending = message(original);
  await new Promise(resolve => setImmediate(resolve));
  await message({ text: 'Проверь подробнее', reply_to_message: original });
  assert.equal(state.answers.length, 1);
  finishDelivery({ messageId: 221 }); await pending;
  state.sendResponder = null;
  await message({ text: 'Проверь подробнее', reply_to_message: original });
  assert.equal(state.answers.length, 2);
});

test('missing confirmation and failed or uncertain deliveries never authorize followups', async () => {
  for (const scenario of ['missing', 'reported-failed', 'failed', 'uncertain', 'partial']) {
    const { state, message } = harness();
    state.sendResponder = (content, chatId) => {
      if (chatId !== -100 || !content.markdown) return;
      if (scenario === 'missing') return { ok: true };
      if (scenario === 'reported-failed') return { ok: false, messageId: 221 };
      throw new Error(scenario === 'uncertain' ? 'ETIMEDOUT ambiguous delivery' : 'Synthetic rejected formatting');
    };
    if (scenario === 'partial') state.answerResponder = () => 'x'.repeat(4100);
    let legacyChunks = 0;
    state.legacyResponder = () => scenario === 'partial' && ++legacyChunks === 1
      ? { message_id: 221 } : Promise.reject(new Error('Unconfirmed legacy delivery'));
    const original = await message({ text: 'Сыч, вопрос' });
    await message({ text: 'Проверь подробнее', reply_to_message: original });
    assert.equal(state.answers.length, 1, scenario);
  }
});

test('a confirmed emergency plain delivery also permits an own-question followup', async () => {
  const { state, message } = harness();
  state.sendResponder = (content, chatId) => {
    if (chatId === -100 && content.markdown === '4') throw new Error('Synthetic rejected formatting');
  };
  const original = await message({ text: 'Сыч, вопрос' });
  assert.equal(state.legacySends.length, 1);
  state.sendResponder = null;
  await message({ text: 'Проверь подробнее', reply_to_message: original });
  assert.equal(state.answers.length, 2);
});

test('an approved voice followup survives direct-call recomputation and retains source question text', async () => {
  const { state, message } = harness();
  const original = await message({ text: 'Сыч, как это устроено?' });
  state.transcript = 'А почему?';
  await message({ voice: { file_id: 'v' }, reply_to_message: { ...original, text: undefined } });
  assert.equal(state.answers.length, 2);
  assert.equal(state.answers[1].input.replyText, original.text);
  assert.equal(state.summaries.length, 0);
});

test('an answered original voice question retains its recognized text for a later own-question followup', async () => {
  const { state, message } = harness();
  state.transcript = 'Сыч, как это устроено?';
  const original = await message({ voice: { file_id: 'v' } });
  await message({ text: 'Проверь подробнее', reply_to_message: { ...original, text: undefined } });
  assert.equal(state.answers.length, 2);
  assert.equal(state.answers[1].input.replyText, state.transcript);
});

test('forget user and reset chat remove followups, including late in-flight confirmations', async () => {
  for (const command of ['Сыч, забудь меня', '/reset@Siitch_bot']) {
    const { state, message } = harness();
    const original = await message({ text: 'Сыч, вопрос' });
    let finishDelivery;
    state.sendResponder = (content, chatId) => chatId === -100 && content.markdown === '4'
      ? new Promise(resolve => { finishDelivery = resolve; }) : undefined;
    const lateSource = { message_id: 230, from: { id: 999 }, text: 'Сыч, новый вопрос' };
    const pending = message(lateSource);
    await new Promise(resolve => setImmediate(resolve));
    await message({ text: command });
    finishDelivery({ messageId: 231 }); await pending;
    state.sendResponder = null;
    await message({ text: 'Проверь подробнее', reply_to_message: original });
    await message({ text: 'Проверь подробнее', reply_to_message: lateSource });
    assert.equal(state.answers.length, 2, command);
  }
});

test('slash commands, owner ephemeral commands, muted messages and banned users cannot use followups', async () => {
  const { state, message } = harness();
  const original = await message({ text: 'Сыч, вопрос' });
  for (const text of ['/help', '/help@Other_bot', '/ask@Siitch_bot Сыч секрет', '/say@Siitch_bot Сыч секрет']) {
    await message({ text, reply_to_message: original });
  }
  await message({ message_id: 0, ephemeral_message_id: 'private', from: { id: 42 }, text: 'Проверь подробнее', reply_to_message: original });
  state.muted = true;
  await message({ text: 'Проверь подробнее', reply_to_message: original });
  assert.equal(state.answers.length, 1);
  const bannedCase = harness();
  const bannedSource = await bannedCase.message({ from: { id: 42 }, text: 'Сыч, вопрос' });
  bannedCase.state.banned = true;
  await bannedCase.message({ from: { id: 42 }, text: 'Проверь подробнее', reply_to_message: bannedSource });
  assert.equal(bannedCase.state.answers.length, 1);
});

test('forgetting or resetting during followup voice recognition cancels stale continuations', async () => {
  for (const command of ['Сыч, забудь меня', '/reset@Siitch_bot']) {
    const { state, message } = harness();
    const original = await message({ text: 'Сыч, как это устроено?' });
    let finishTranscription;
    state.transcriptionResponder = () => new Promise(resolve => { finishTranscription = resolve; });
    const pending = message({ voice: { file_id: 'v' }, reply_to_message: original });
    await new Promise(resolve => setImmediate(resolve));
    await message({ text: command });
    finishTranscription({ text: 'А почему?' }); await pending;
    assert.equal(state.answers.length, 1, command);
    assert.equal(state.summaries.length, 0);
  }
});

test('ordinary slash command and profile responses cannot authorize own-question followups', async () => {
  for (const text of ['/help@Siitch_bot', 'Сыч кто я?']) {
    const { state, message } = harness();
    const original = await message({ text });
    assert.equal(state.sent.length, 1);
    await message({ text: 'Проверь подробнее', reply_to_message: original });
    assert.equal(state.answers.length, 0, text);
  }
});

test('photo-post links and original request survive a different participant rechecking the public bot answer', async () => {
  const { state, message } = harness();
  const urls = ['https://github.com/example/SyntheticMemory', 'https://github.com/example/SyntheticMemory/shared-memory',
    'https://huggingface.co/example/SyntheticMemory'];
  const post = { message_id: 10, from: { id: 42 }, caption: 'SyntheticMemory: движок памяти, SharedMemory, модель.',
    photo: [{ file_id: 'post-image' }], caption_entities: urls.map(url => ({ type: 'text_link', offset: 0, length: 9, url })) };
  const original = await message({ text: 'Сыч, проверь все ссылки и запуск с OpenClaw', reply_to_message: post });
  const answer = { message_id: state.sent.at(-1).messageId, from: { id: 888, is_bot: true }, text: 'Ответ о другом продукте' };
  assert.match(state.answers[0].input.sourceContext.text, /OpenClaw/);
  assert.deepEqual(Array.from(state.answers[0].input.sourceContext.urls), urls);
  await message({ from: { id: 43 }, text: 'Перепроверь, ты уверен?', reply_to_message: answer });
  assert.equal(state.answers.length, 2);
  assert.match(state.answers[1].input.sourceContext.text, /SyntheticMemory/);
  assert.match(state.answers[1].input.sourceContext.text, /OpenClaw/);
  assert.equal(state.answers[1].input.sourceContext.text.includes(answer.text), false);
  assert.deepEqual(Array.from(state.answers[1].input.sourceContext.urls), urls);
  await message({ text: 'Проверь ещё раз', reply_to_message: original });
  assert.deepEqual(Array.from(state.answers[2].input.sourceContext.urls), urls);
  assert.match(state.answers[2].input.sourceContext.text, /SyntheticMemory/);
});

test('an unknown bot reply cannot recover another answer origin and ordinary replies to another user stay untriggered', async () => {
  const { state, message } = harness();
  const original = await message({ text: 'Сыч, проверь https://source.example/origin' });
  await message({ from: { id: 43 }, text: 'Перепроверь', reply_to_message: original });
  assert.equal(state.answers.length, 1);
  await message({ from: { id: 43 }, text: 'Перепроверь', reply_to_message: { message_id: 987,
    from: { id: 888 }, text: 'Иной ответ' } });
  assert.equal(state.answers.length, 2);
  assert.equal(JSON.stringify(state.answers[1].input.sourceContext).includes('source.example'), false);
});

test('ordinary replies to private bot messages never expose their contents or authorize public processing', async () => {
  const { state, message } = harness();
  await message({ text: 'Сыч, перепроверь', reply_to_message: { message_id: 0, ephemeral_message_id: 32,
    from: { id: 888 }, text: 'private original https://private.example/source', photo: [{ file_id: 'private-image' }] } });
  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 0);
});

test('standalone short criticism restores the recent public source before another participant rechecks that reply', async () => {
  const { state, message } = harness();
  const urls = ['https://github.com/example/memory', 'https://models.example/memory'];
  await message({ text: 'Сыч, проверь все ссылки и запуск с OpenClaw', reply_to_message: {
    message_id: 10, from: { id: 42 }, caption: 'SyntheticMemory и SharedMemory',
    caption_entities: urls.map(url => ({ type: 'text_link', url })) } });
  await message({ from: { id: 43 }, text: 'Чет сыч налажал' });
  assert.deepEqual(Array.from(state.answers[1].input.sourceContext.urls), urls);
  assert.match(state.answers[1].input.sourceContext.text, /OpenClaw/);
  const defensiveReply = { message_id: state.sent.at(-1).messageId, from: { id: 888 }, text: 'Ошибочная защита ответа' };
  await message({ from: { id: 44 }, text: 'Перепроверь, ты уверен?', reply_to_message: defensiveReply });
  assert.deepEqual(Array.from(state.answers[2].input.sourceContext.urls), urls);
  assert.match(state.answers[2].input.sourceContext.text, /SyntheticMemory/);
  await message({ text: 'Сыч, расскажи про погоду' });
  assert.equal(JSON.stringify(state.answers.at(-1).input.sourceContext).includes(urls[0]), false);
});

const longPost = 'В новом инструменте сохраняется исходный контекст задачи. Автор подробно описывает подключение и ограничения работы. '.repeat(12);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('long human posts receive exactly one short TLDR reply without an explicit call or ordinary answer', async () => {
  const { state, message } = harness();
  const original = await message({ text: longPost, from: { id: 42, first_name: 'Участник' } });
  assert.equal(state.tldrSummaries.length, 1);
  assert.equal(state.tldrSummaries[0], longPost);
  assert.equal(state.answers.length, 0);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].content.html, /TL;DR:/);
  assert.equal(state.sent[0].opts.replyTo, original.message_id);
  assert.equal(state.sent[0].opts.threadId, 184);
  assert.equal(state.sent[0].opts.strictDelivery, true);
  await message({ text: 'Сыч, проверь источники', reply_to_message: {
    message_id: state.sent[0].messageId, from: { id: 888, is_bot: true }, text: 'TL;DR: краткий пересказ' } });
  assert.equal(state.answers.length, 1);
  assert.equal(state.answers[0].input.sourceContext.text, longPost);
});

test('forwarded photo captions qualify while short, bot, edited and directly called texts do not auto-summarize', async () => {
  const photo = harness();
  await photo.message({ caption: longPost, photo: [{ file_id: 'public-image' }], forward_origin: { type: 'channel' } });
  assert.equal(photo.state.tldrSummaries.length, 1);
  for (const overrides of [{ text: 'Короткая реплика.' }, { text: longPost, from: { id: 888, is_bot: true } },
    { text: longPost, from: { id: 43, is_bot: true } }, { text: longPost, edit_date: 100 }]) {
    const h = harness(); await h.message(overrides);
    assert.equal(h.state.tldrSummaries.length, 0);
    assert.equal(h.state.sent.length, 0);
  }
  const called = harness(); await called.message({ text: 'Сыч, объясни этот текст. ' + longPost });
  assert.equal(called.state.tldrSummaries.length, 0);
  assert.equal(called.state.answers.length, 1);
});

test('concurrent redelivery, failed generation and unconfirmed delivery do not duplicate TLDR', async () => {
  const h = harness();
  const gate = deferred(); h.state.tldrResponder = () => gate.promise;
  const input = { message_id: 600, text: longPost };
  const first = h.message(input);
  await new Promise(setImmediate);
  await h.message(input);
  assert.equal(h.state.tldrSummaries.length, 1);
  gate.resolve('Автор описывает новый инструмент. Полезно тем, кто планирует подключение.');
  await first;
  assert.equal(h.state.sent.length, 1);
  await h.message(input); assert.equal(h.state.sent.length, 1);
  for (const invalid of ['', 'x'.repeat(451)]) {
    const failed = harness(); failed.state.tldrResponder = () => invalid;
    await failed.message({ text: longPost });
    assert.equal(failed.state.sent.length, 0);
  }
  const ambiguous = harness(); ambiguous.state.sendResponder = () => { throw Error('unknown delivery'); };
  await ambiguous.message(input); await ambiguous.message(input);
  assert.equal(ambiguous.state.tldrSummaries.length, 1);
  assert.equal(ambiguous.state.legacySends, undefined);
});

test('mute, ban, forget and reset stop late automatic summaries', async () => {
  for (const change of ['mute', 'ban', 'forget', 'reset']) {
    const h = harness(); const gate = deferred(); h.state.tldrResponder = () => gate.promise;
    const work = h.message({ text: longPost, from: { id: 42, first_name: 'Участник' } });
    await new Promise(setImmediate);
    if (change === 'mute') h.state.muted = true;
    if (change === 'ban') h.state.banned = true;
    if (change === 'forget') await h.message({ text: '/forget_me@Siitch_bot', from: { id: 42 } });
    if (change === 'reset') await h.message({ text: '/reset@Siitch_bot' });
    gate.resolve('Автор описывает новый инструмент. Полезно тем, кто планирует подключение.');
    await work;
    assert.equal(h.state.sent.some(sent => sent.content.html?.includes('TL;DR:')), false, change);
  }
});
