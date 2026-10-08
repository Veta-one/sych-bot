const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createEphemeralHandler } = require('../src/core/ephemeral');
const { isPrivateWork } = require('../src/utils/private-context');

const OWNER = 999;
const BOT = 888;
const CHAT = -100;
const OTHER = 42;
const SECRET = 'synthetic-private-request';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ answer, send, download, publish, now, answerTimeoutMs, integration = false } = {}) {
  const state = { sent: [], answers: [], downloads: [], files: [], publicEffects: [],
    moderation: [], saves: 0, muted: new Set(), topicMuted: new Set(), banned: new Map(),
    publications: [], publicRecorded: [], events: [], instructionReads: 0, profileReads: [] };
  let nextId = 500;
  const config = { adminId: OWNER, botId: BOT, contextSize: 30, triggerRegex: /сыч|sych/i };
  const publicHistory = [{ role: 'Участник', text: 'synthetic-public-context', userId: String(OTHER) }];
  const record = name => (...args) => state.publicEffects.push({ name, args });
  const storage = {
    data: { chats: { [CHAT]: { users: { [OTHER]: '@synthetic_other' } } } },
    profiles: { [CHAT]: { [OTHER]: { realName: 'Участник', username: '@synthetic_other' } } },
    getUserInstruction: () => { state.instructionReads++; return 'synthetic-owner-instruction'; },
    getProfile: (...args) => { state.profileReads.push(args); return { realName: 'Владелец' }; },
    getChatProfile: () => ({ topic: 'synthetic-topic' }),
    toggleChatMute: chat => {
      if (state.muted.has(chat)) state.muted.delete(chat); else state.muted.add(chat);
      state.moderation.push({ action: 'mute', chat });
      return state.muted.has(chat);
    },
    banUserInChat: (chat, user, label) => {
      state.banned.set(`${chat}:${user}`, label);
      state.moderation.push({ action: 'ban', chat, user, label });
    },
    forceSave: () => { state.saves++; },
    isBanned: (user, chat) => state.banned.has(`${chat}:${user}`),
    unbanUser: record('unbanUser'),
    unbanUserInChat: record('unbanUserInChat'),
    isChatMuted: chat => state.muted.has(chat),
    isTopicMuted: (chat, thread) => state.muted.has(chat) || state.topicMuted.has(`${chat}:${thread}`),
    toggleMute: (chat, thread) => { record('toggleMute')(chat, thread); return true; },
    hasChat: () => true,
    updateChatName: record('updateChatName'),
    trackUser: record('trackUser'),
    bulkUpdateProfiles: record('bulkUpdateProfiles'),
    updateChatProfile: record('updateChatProfile'),
    getProfilesForUsers: () => ({}),
    getChat: () => ({ users: { [OTHER]: '@synthetic_other' } }),
    findUserIdByUsername: username => String(username).replace(/^@/, '').toLowerCase() === 'synthetic_other' ? OTHER : null,
    forgetUser: async () => ({ profilesRemoved: 0, chatReferencesRemoved: 0, remindersRemoved: 0,
      instructionsRemoved: 0, chatProfilesReset: 0, backupsScrubbed: 0 }),
  };
  const ai = {
    async getResponse(...args) {
      state.events.push('ai');
      const call = { history: args[0].map(entry => ({ ...entry })), input: { ...args[1] },
        images: args[2], instruction: args[4], profile: args[5], private: isPrivateWork() };
      state.answers.push(call);
      return answer ? answer(call) : `synthetic-answer-${state.answers.length}`;
    },
    analyzeUserImmediate: async () => { record('analyzeUserImmediate')(); return null; },
    analyzeBatch: async () => { record('analyzeBatch')(); return null; },
    analyzeChatProfile: async () => { record('analyzeChatProfile')(); return null; },
    describeImage: async () => { record('describeImage')(); return ''; },
    determineReaction: async () => { record('determineReaction')(); return '🦉'; },
    transcribeAudio: async () => { record('transcribeAudio')(); return { text: 'Сыч, ответь' }; },
  };
  const sendRich = async (bot, chat, content, opts = {}) => {
    state.events.push(opts.ephemeral ? 'private-send' : 'public-rich-send');
    const call = { chat, content, opts };
    state.sent.push(call);
    if (send) return send(call, state.sent.length);
    return opts.ephemeral ? { ephemeralMessageId: opts.ephemeral.editId || ++nextId, messageDate: 1791446400 }
      : { messageId: ++nextId };
  };
  const get = async url => {
    state.events.push('download');
    state.downloads.push(url);
    return download ? download(url) : Buffer.from(`synthetic-image:${url}`);
  };
  const bot = {
    getMe: async () => ({ id: BOT, username: 'Siitch_bot' }),
    getFileLink: async id => { state.files.push(id); return `https://media.example/${id}.jpg`; },
    sendMessage: record('sendMessage'),
    sendChatAction: async (...args) => { record('sendChatAction')(...args); },
    setMessageReaction: async (...args) => { record('setMessageReaction')(...args); },
    leaveChat: async (...args) => { record('leaveChat')(...args); },
  };
  const publishMessage = async (botInstance, msg, text, target) => {
    state.events.push('publish');
    const call = { bot: botInstance, msg, text, target, private: isPrivateWork() };
    state.publications.push(call);
    return publish ? publish(call) : { messageId: ++nextId, text };
  };
  const onPublicMessage = (chat, text) => {
    state.events.push('record-public');
    state.publicRecorded.push({ chat, text });
  };
  const handler = createEphemeralHandler({ config, storage, ai, sendRich, download: get,
    getPublicHistory: () => publicHistory, publishMessage, onPublicMessage, ...(now ? { now } : {}),
    ...(answerTimeoutMs ? { answerTimeoutMs } : {}) });
  let processMessage;
  if (integration) {
    const dependencies = {
      './ephemeral': require('../src/core/ephemeral'),
      '../services/storage': storage, '../services/ai': ai, '../config': config,
      axios: { get: async url => ({ data: await get(url) }) }, child_process: {},
      '../utils/rich': { sendRich, escapeHtml: value => String(value), normalizeMd: value => value },
      '../utils/privacy': { isForgetMeRequest: () => false }, '../utils/profile-query': {},
      '../utils/commands': require('../src/utils/commands'),
      '../utils/reminders': require('../src/utils/reminders'), '../services/documents': {},
      '../services/publication': { createPublication: (botInstance, msg, target) => ({
        send: text => publishMessage(botInstance, msg, text, target),
      }) },
    };
    const box = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/logic.js'), 'utf8'), {
      module: box, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
      Buffer, console: { log() {}, error() {} },
      setTimeout: (fn, ms, ...args) => { const timer = setTimeout(fn, ms, ...args); if (ms >= 4000) timer.unref(); return timer; },
      clearTimeout, setInterval: (...args) => setInterval(...args).unref(), clearInterval,
      Math: { random: () => 0, floor: Math.floor },
    });
    processMessage = box.exports.processMessage;
  }
  let incomingId = 10;
  const message = overrides => ({ message_id: 0, ephemeral_message_id: ++incomingId,
    date: 1791446400, chat: { id: CHAT, type: 'supergroup' },
    from: { id: OWNER, first_name: 'Владелец', username: 'synthetic_owner' }, text: `/ask ${SECRET}`,
    ...overrides });
  return { state, publicHistory, storage, ai, bot, handler, message,
    handle: overrides => handler(bot, message(overrides)),
    process: overrides => processMessage(bot, message(overrides)),
  };
}

function assertPrivateOnly(state) {
  for (const sent of state.sent) {
    assert.equal(sent.chat, CHAT, 'private content never goes to another chat');
    assert.equal(sent.opts.ephemeral?.receiverUserId, OWNER, 'every send/edit retains the private recipient');
    assert.equal(sent.opts.replyTo, undefined, 'ordinary message ID is not a private reply target');
  }
  assert.deepEqual(state.publicEffects, [], 'no tracking, observers, typing, reactions, or public delivery');
}

test('public unban rejects malformed IDs and accepts whitespace-separated valid IDs', async () => {
  const h = harness({ integration: true });
  for (const value of ['abc', '-42', '1.5', '0', '9007199254740992', '']) {
    await h.process({ message_id: 12, ephemeral_message_id: undefined, text: `/unban@Siitch_bot ${value}` });
  }
  assert.equal(h.state.publicEffects.filter(effect => effect.name.startsWith('unban')).length, 0);
  await h.process({ message_id: 13, ephemeral_message_id: undefined, text: '/unban@Siitch_bot\n42' });
  assert.deepEqual(h.state.publicEffects.filter(effect => effect.name.startsWith('unban')), [
    { name: 'unbanUser', args: ['42'] }, { name: 'unbanUserInChat', args: [CHAT, '42'] },
  ]);
});

test('owner hidden reply combines request text, link, own photo and replied photo without public effects', async () => {
  const h = harness({ integration: true });
  await h.process({ text: undefined, caption: '/ask сравни https://article.example/source',
    photo: [{ file_id: 'request-small' }, { file_id: 'request-large' }], message_thread_id: 184,
    reply_to_message: { message_id: 12, from: { id: OTHER }, caption: 'Исходная картинка',
      photo: [{ file_id: 'source-small' }, { file_id: 'source-large' }] } });
  assert.equal(h.state.answers.length, 1);
  const call = h.state.answers[0];
  assert.equal(call.input.text, 'сравни https://article.example/source');
  assert.equal(call.input.replyText, 'Исходная картинка');
  assert.deepEqual(h.state.files.sort(), ['request-large', 'source-large']);
  assert.equal(call.images.length, 2);
  assert.ok(call.images.every(image => Buffer.isBuffer(image.buffer)));
  assert.ok(call.images[0].label !== call.images[1].label, 'the model can distinguish request and source');
  assert.equal(call.private, true);
  assert.equal(h.state.sent.length, 2);
  assert.equal(h.state.sent[0].opts.ephemeral.replyToEphemeralId, 11);
  assert.equal(h.state.sent[0].opts.threadId, 184);
  assert.ok(h.state.sent[1].opts.ephemeral.editId);
  assertPrivateOnly(h.state);
});

test('hidden text/link and image URL use the ordinary AI request while source text remains distinct', async () => {
  const h = harness();
  await h.handle({ text: '/ASK@SIITCH_BOT оцени https://images.example/picture.png?size=large',
    reply_to_message: { message_id: 12, from: { id: OTHER }, text: 'https://article.example/page' } });
  const call = h.state.answers[0];
  assert.equal(call.input.text, 'оцени https://images.example/picture.png?size=large');
  assert.equal(call.input.replyText, 'https://article.example/page');
  assert.equal(call.images.length, 1);
  assert.equal(call.images[0].mimeType, 'image/png');
  assert.deepEqual(h.state.downloads, ['https://images.example/picture.png?size=large']);
  assert.deepEqual(call.history, h.publicHistory);
  assertPrivateOnly(h.state);
});

test('acknowledgement completes before any media or AI work, then the same private message is edited', async () => {
  const ack = deferred();
  const h = harness({ send: async (call, n) => n === 1 ? ack.promise : { ephemeralMessageId: call.opts.ephemeral.editId } });
  const pending = h.handle({ photo: [{ file_id: 'delayed-photo' }] });
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.files.length, 0);
  assert.equal(h.state.downloads.length, 0);
  assert.equal(h.state.answers.length, 0);
  ack.resolve({ ephemeralMessageId: 701 });
  await pending;
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.sent[1].opts.ephemeral.editId, 701);
  assert.equal(h.state.sent[1].opts.ephemeral.replyToEphemeralId, undefined);
  assertPrivateOnly(h.state);
});

test('nonzero signed Telegram ephemeral IDs remain private reply and edit targets', async () => {
  const h = harness({ send: async (call, n) => n === 1 ? { ephemeralMessageId: -701 }
    : { ephemeralMessageId: call.opts.ephemeral.editId } });
  await h.handle({ ephemeral_message_id: -11 });
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.sent[0].opts.ephemeral.replyToEphemeralId, -11);
  assert.equal(h.state.sent[1].opts.ephemeral.editId, -701);
  assertPrivateOnly(h.state);
});

test('static replied stickers are read privately and animated unsupported sources get guidance', async () => {
  const h = harness();
  await h.handle({ text: '/ask объясни картинку', reply_to_message: { message_id: 12, from: { id: OTHER },
    sticker: { file_id: 'static-sticker', is_animated: false, is_video: false } } });
  assert.equal(h.state.answers.length, 1);
  assert.deepEqual(h.state.files, ['static-sticker']);
  assert.equal(h.state.answers[0].images[0].mimeType, 'image/webp');
  await h.handle({ text: '/ask объясни картинку', reply_to_message: { message_id: 13, from: { id: OTHER },
    sticker: { file_id: 'animated-sticker', is_animated: true, is_video: false } } });
  assert.equal(h.state.answers.length, 1, 'unsupported sticker must not be silently omitted from the answer');
  assert.deepEqual(h.state.files, ['static-sticker']);
  assertPrivateOnly(h.state);
});

test('hidden input is intercepted before observer buffers and never leaks to a subsequent public AI call', async () => {
  const h = harness({ integration: true });
  await h.process({ message_id: 20, ephemeral_message_id: undefined, text: 'public-before' });
  h.state.publicEffects.length = 0;
  for (let i = 0; i < 55; i++) await h.process({ text: `/ask ${SECRET}-${i}` });
  assertPrivateOnly(h.state);
  const privateAnswers = h.state.answers.length;
  await h.process({ message_id: 21, ephemeral_message_id: undefined, text: 'Сыч, public-after' });
  const publicCall = h.state.answers[privateAnswers];
  assert.equal(publicCall.private, false);
  assert.ok(publicCall.history.some(entry => entry.text === 'public-before'));
  assert.ok(publicCall.history.some(entry => entry.text === 'Сыч, public-after'));
  assert.equal(JSON.stringify(publicCall.history).includes(SECRET), false);
  assert.equal(JSON.stringify(publicCall.history).includes('synthetic-answer'), false);
  assert.equal(h.state.publicEffects.some(effect => ['analyzeBatch', 'analyzeChatProfile'].includes(effect.name)), false,
    '55 private messages did not fill observer buffers');
});

test('only owner group inputs execute hidden commands; malformed and foreign commands cannot fall through', async () => {
  const h = harness({ integration: true });
  const invalid = [
    { from: { id: OTHER } }, { from: undefined }, { chat: { id: CHAT, type: 'private' } },
    { chat: undefined }, { message_id: 12 }, { ephemeral_message_id: null },
    { ephemeral_message_id: 0 }, { ephemeral_message_id: '11' }, { ephemeral_message_id: 1.5 },
    { text: '/mute@Other_bot' }, { text: '/ask@Other_bot Сыч', photo: [{ file_id: 'foreign' }] },
  ];
  for (const item of invalid) await h.process(item);
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.files.length, 0);
  assert.equal(h.state.moderation.length, 0);
  assertPrivateOnly(h.state);
  await h.process({ text: '/unknown Сыч' });
  await h.process({ text: 1 });
  assert.equal(h.state.sent.length, 1, 'unknown command gets only private guidance');
  assert.equal(h.state.answers.length, 0);
  assertPrivateOnly(h.state);
});

test('mute toggles the whole group and persists each choice while owner hidden questions stay available', async () => {
  const h = harness({ integration: true });
  await h.process({ text: '/mute', message_thread_id: 184 });
  assert.equal(h.storage.isTopicMuted(CHAT, 184), true);
  assert.equal(h.storage.isTopicMuted(CHAT, 185), true);
  assert.equal(h.storage.isTopicMuted(-200, 184), false);
  assert.equal(h.state.saves, 1);
  h.state.sent.length = 0;
  for (const topic of [undefined, 184, 185]) {
    await h.process({ message_id: 22, ephemeral_message_id: undefined, message_thread_id: topic,
      from: { id: OTHER }, text: 'Сыч, публичный вопрос', voice: { file_id: 'ignored-voice' } });
  }
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.files.length, 0);
  assert.equal(h.state.sent.length, 0);
  h.state.publicEffects.length = 0;
  await h.process({ text: '/ask ответь скрытно', message_thread_id: 185 });
  assert.equal(h.state.answers.length, 1);
  assertPrivateOnly(h.state);
  await h.process({ text: '/mute', message_thread_id: 185 });
  assert.equal(h.storage.isTopicMuted(CHAT, 184), false);
  assert.equal(h.state.saves, 2);
});

test('reply ban affects only the source author in the current group and ignores their media/triggers', async () => {
  const h = harness({ integration: true });
  await h.process({ text: '/ban', reply_to_message: { message_id: 12,
    from: { id: OTHER, first_name: 'Участник', username: 'synthetic_other' }, text: 'source' } });
  assert.deepEqual(h.state.moderation, [{ action: 'ban', chat: CHAT, user: OTHER, label: '@synthetic_other' }]);
  assert.equal(h.state.saves, 1);
  assert.equal(h.storage.isBanned(OTHER, CHAT), true);
  assert.equal(h.storage.isBanned(OTHER, -200), false);
  h.state.sent.length = 0;
  await h.process({ message_id: 22, ephemeral_message_id: undefined,
    from: { id: OTHER }, text: 'Сыч, ответь', photo: [{ file_id: 'banned-photo' }], voice: { file_id: 'banned-voice' } });
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.files.length, 0);
  assertPrivateOnly(h.state);
});

test('a whole-chat mute also silences legacy publicly addressed commands in every topic', async () => {
  const h = harness({ integration: true });
  await h.process({ text: '/mute' });
  h.state.sent.length = 0;
  h.state.publicEffects.length = 0;
  for (const text of ['/help@Siitch_bot', '/version@Siitch_bot', '/mute@Siitch_bot']) {
    await h.process({ message_id: 20, ephemeral_message_id: undefined, text, message_thread_id: 185 });
  }
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.storage.isChatMuted(CHAT), true);
  assertPrivateOnly(h.state);
});

test('a new mute or reply-ban suppresses a public answer that was already being generated', async () => {
  for (const command of ['mute', 'ban']) {
    const answer = deferred();
    const h = harness({ integration: true, answer: () => answer.promise });
    const pending = h.process({ ephemeral_message_id: undefined, message_id: 20,
      from: { id: OTHER, first_name: 'Участник' }, text: 'Сыч, медленный публичный вопрос' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.answers.length, 1);
    await h.process({ text: `/${command}`, reply_to_message: { message_id: 20,
      from: { id: OTHER }, text: 'Сыч, медленный публичный вопрос' } });
    answer.resolve('synthetic-late-public-answer');
    await pending;
    assert.equal(h.state.sent.filter(call => !call.opts.ephemeral).length, 0,
      `${command} must take effect before a pending public answer is delivered`);
  }
});

test('a new mute or reply-ban suppresses a reaction that was already being chosen', async () => {
  for (const command of ['mute', 'ban']) {
    const reaction = deferred();
    const h = harness({ integration: true });
    h.ai.determineReaction = () => reaction.promise;
    await h.process({ ephemeral_message_id: undefined, message_id: 20,
      from: { id: OTHER, first_name: 'Участник' }, text: 'ordinary-long-public-message' });
    h.state.publicEffects.length = 0;
    await h.process({ text: `/${command}`, reply_to_message: { message_id: 20,
      from: { id: OTHER }, text: 'ordinary-long-public-message' } });
    reaction.resolve('🦉');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.publicEffects.some(effect => effect.name === 'setMessageReaction'), false,
      `${command} must take effect before a pending reaction is delivered`);
  }
});

test('ban cannot target the owner, bots, anonymous senders or malformed IDs', async () => {
  const h = harness();
  for (const source of [undefined, { from: { id: OWNER } }, { from: { id: BOT, is_bot: true } },
    { from: { id: OTHER }, sender_chat: { id: -300 } }, { from: { id: 0 } },
    { from: { id: -1 } }, { from: { id: '42' } }, { from: { id: Number.MAX_SAFE_INTEGER + 1 } }]) {
    await h.handle({ text: '/ban', reply_to_message: source });
  }
  assert.equal(h.state.moderation.length, 0);
  assert.equal(h.state.saves, 0);
  assert.equal(h.state.sent.length, 8);
  assertPrivateOnly(h.state);
});

test('new mute and ban suppress pending voice failures, reminder clarification, games and profile replies', async () => {
  const cases = [
    { text: 'Сыч кинь монетку', method: 'generateFlavorText', value: 'Late coin answer' },
    { text: 'Сыч число 1-100', method: 'generateFlavorText', value: 'Late random answer' },
    { text: 'Сыч кто из нас сегодня', method: 'generateFlavorText', value: 'Late person answer',
      setup: h => { h.storage.getRandomUser = () => 'Synthetic user'; } },
    { text: '', voice: { file_id: 'pending-voice' }, method: 'transcribeAudio', value: null },
    { text: 'Сыч напомни завтра', method: 'parseReminder', value: { kind: 'clarify', question: 'When?' } },
    { text: 'Сыч этот чат про очень длинную тему', method: 'processManualChatDescription', value: { topic: 'Topic' } },
    { text: 'Сыч расскажи про @someone', method: 'generateProfileDescription', value: 'Late profile answer',
      setup: h => { h.storage.findProfileByQuery = () => ({ userId: 77 }); } },
  ];
  for (const scenario of cases) for (const command of ['mute', 'ban']) {
    const gate = deferred();
    const h = harness({ integration: true });
    scenario.setup?.(h);
    let started = false;
    h.ai[scenario.method] = () => { started = true; return gate.promise; };
    const pending = h.process({ ephemeral_message_id: undefined, message_id: 20,
      from: { id: OTHER, first_name: 'Участник' }, text: scenario.text, voice: scenario.voice });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, true, scenario.method);
    await h.process({ text: `/${command}`, reply_to_message: { message_id: 20,
      from: { id: OTHER }, text: scenario.text } });
    gate.resolve(scenario.value);
    await pending;
    assert.equal(h.state.sent.filter(call => !call.opts.ephemeral).length, 0, `${command}: ${scenario.method}`);
  }
});

test('reusing an ephemeral ID with another date cannot recover an older private dialog', async () => {
  for (const date of [1791446401, undefined, 0]) {
    const h = harness();
    await h.handle({ text: '/ask older-private-secret' });
    await h.handle({ text: 'continue new message', reply_to_message: { message_id: 0,
      ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId, date,
      from: { id: BOT }, text: 'New generation of the reused message' } });
    assert.equal(h.state.answers[1].history.some(entry => entry.text === 'older-private-secret'), false);
  }
});

test('private continuations retain history only in the same group/topic and expire after 30 minutes', async () => {
  let clock = 0;
  const h = harness({ now: () => clock });
  await h.handle({ text: '/ask private-first', message_thread_id: 184 });
  const reply = { message_id: 0, ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId,
    date: 1791446400, from: { id: BOT }, text: 'synthetic-answer-1' };
  await h.handle({ text: 'private-follow-up', message_thread_id: 184, reply_to_message: reply });
  assert.equal(h.state.answers[1].history.some(entry => entry.text === 'private-first'), true);
  assert.equal(h.state.answers[1].history.some(entry => entry.text === 'synthetic-answer-1'), true);
  await h.handle({ text: '/ask another-topic', message_thread_id: 185, reply_to_message: reply });
  assert.equal(h.state.answers[2].history.some(entry => entry.text === 'private-first'), false);
  await h.handle({ chat: { id: -200, type: 'supergroup' }, text: '/ask another-group',
    message_thread_id: 184, reply_to_message: reply });
  assert.equal(h.state.answers[3].history.some(entry => entry.text === 'private-first'), false);
  clock = 30 * 60 * 1000;
  await h.handle({ text: 'expired-follow-up', message_thread_id: 184, reply_to_message: reply });
  assert.equal(h.state.answers[4].history.some(entry => entry.text === 'private-first'), false);
  assert.deepEqual(h.publicHistory, [{ role: 'Участник', text: 'synthetic-public-context', userId: String(OTHER) }]);
});

test('a fresh hidden question does not include an earlier private discussion', async () => {
  const h = harness();
  await h.handle({ text: '/ask old-private-question' });
  await h.handle({ text: '/ask independent-private-question' });
  assert.deepEqual(h.state.answers[1].history, h.publicHistory);
});

test('replying to an older private answer cannot pick up a different more recent private discussion', async () => {
  const h = harness();
  await h.handle({ text: '/ask first-private-question' });
  const oldReply = { message_id: 0, ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId,
    date: 1791446400, from: { id: BOT }, text: 'synthetic-answer-1' };
  await h.handle({ text: '/ask unrelated-private-question' });
  await h.handle({ text: 'продолжи первый разговор', reply_to_message: oldReply });
  const continuation = h.state.answers.at(-1);
  assert.equal(continuation.history.some(entry => entry.text === 'unrelated-private-question'), false);
  assert.equal(continuation.history.some(entry => entry.text === 'synthetic-answer-2'), false);
  assert.equal(continuation.history.some(entry => entry.text === 'first-private-question'), true);
});

test('an exact cached private reply can continue when Telegram omits its text', async () => {
  const h = harness();
  await h.handle({ text: '/ask private-cached-question' });
  await h.handle({ text: 'продолжи', reply_to_message: { message_id: 0,
    ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId, date: 1791446400, from: { id: BOT } } });
  assert.equal(h.state.answers.length, 2);
  assert.ok(h.state.answers[1].history.some(entry => entry.text === 'private-cached-question'));
});

test('forgetting the owner removes cached private discussion across chats and topics', async () => {
  const h = harness();
  await h.handle({ text: '/ask private-to-forget', message_thread_id: 184 });
  const reply = { message_id: 0, ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId,
    date: 1791446400, from: { id: BOT } };
  h.handler.forgetUser(OWNER);
  await h.handle({ text: 'продолжи', message_thread_id: 184, reply_to_message: reply });
  assert.equal(h.state.answers.length, 1, 'an unavailable forgotten reply cannot recover old cached context');
  assertPrivateOnly(h.state);
});

test('forgetting while media is pending prevents stale work from refilling the private cache', async () => {
  const media = deferred();
  const h = harness({ download: () => media.promise });
  const pending = h.handle({ text: '/ask in-flight-private-to-forget', photo: [{ file_id: 'pending-photo' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.downloads.length, 1);
  h.handler.forgetUser(OWNER);
  media.resolve(Buffer.from('synthetic-image'));
  await pending;
  const reply = { message_id: 0, ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId,
    date: 1791446400, from: { id: BOT } };
  await h.handle({ text: 'продолжи', reply_to_message: reply });
  assert.equal(h.state.answers.length, 1, 'old in-flight work must not restore a forgotten dialog');
  assertPrivateOnly(h.state);
});

test('the existing public forget command also clears private cached answers', async () => {
  const h = harness({ integration: true });
  await h.process({ text: '/ask private-before-public-forget' });
  const reply = { message_id: 0, ephemeral_message_id: h.state.sent.at(-1).opts.ephemeral.editId,
    date: 1791446400, from: { id: BOT } };
  await h.process({ ephemeral_message_id: undefined, message_id: 20, text: '/forget_me@Siitch_bot' });
  h.state.sent.length = 0;
  h.state.publicEffects.length = 0;
  await h.process({ text: 'продолжи', reply_to_message: reply });
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.sent.length, 1, 'only private guidance remains after the forgotten source is unavailable');
  assertPrivateOnly(h.state);
});

test('empty request and unavailable replied content get private guidance without calling AI', async () => {
  const h = harness();
  await h.handle({ text: '/ask' });
  await h.handle({ text: '/ask что он имеет в виду?', reply_to_message: { message_id: 12, from: { id: OTHER } } });
  assert.equal(h.state.answers.length, 0, 'the bot must not pretend it has read an unavailable reply source');
  assert.equal(h.state.sent.length, 2);
  assertPrivateOnly(h.state);
});

test('download, empty AI, thrown AI and timeout failures edit only the private acknowledgement', async () => {
  const cases = [
    { download: async () => { throw new Error('synthetic-secret-download-error'); } },
    { answer: async () => '' },
    { answer: async () => { throw new Error('synthetic-secret-model-error'); } },
    { answer: () => new Promise(() => {}), answerTimeoutMs: 5 },
  ];
  for (const setup of cases) {
    const h = harness(setup);
    await h.handle({ photo: [{ file_id: 'synthetic-photo' }] });
    assert.equal(h.state.sent.length, 2);
    assert.ok(h.state.sent[1].opts.ephemeral.editId);
    assert.equal(JSON.stringify(h.state.sent[1]).includes('synthetic-secret'), false);
    assertPrivateOnly(h.state);
  }
});

test('media above the size budget is rejected privately before it reaches AI', async () => {
  const h = harness();
  await h.handle({ photo: [{ file_id: 'too-large', file_size: 20 * 1024 * 1024 + 1 }] });
  assert.equal(h.state.files.length, 0);
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.sent.length, 2);
  assertPrivateOnly(h.state);
});

test('failed acknowledgement stops work, and failed final edits cannot trigger a public fallback', async () => {
  const ackFailure = harness({ send: async () => { throw new Error('synthetic-ack-secret'); } });
  await ackFailure.handle({ photo: [{ file_id: 'never-download' }] });
  assert.equal(ackFailure.state.sent.length, 1);
  assert.equal(ackFailure.state.files.length, 0);
  assert.equal(ackFailure.state.answers.length, 0);
  assertPrivateOnly(ackFailure.state);
  const editFailure = harness({ send: async (call, n) => {
    if (n === 1) return { ephemeralMessageId: 701 };
    throw new Error('synthetic-edit-secret');
  } });
  await editFailure.handle({});
  assert.equal(editFailure.state.answers.length, 1);
  assert.ok(editFailure.state.sent.slice(1).every(call => call.opts.ephemeral.editId === 701));
  assertPrivateOnly(editFailure.state);
});

test('simultaneous duplicate update performs one acknowledgement, media read and AI request', async () => {
  const result = deferred();
  const h = harness({ answer: () => result.promise });
  const msg = h.message({ photo: [{ file_id: 'deduplicated-photo' }] });
  const first = h.handler(h.bot, msg);
  const duplicate = h.handler(h.bot, { ...msg });
  await duplicate;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.answers.length, 1);
  assert.deepEqual(h.state.files, ['deduplicated-photo']);
  result.resolve('synthetic-complete');
  await first;
  assert.equal(h.state.sent.length, 2);
  assertPrivateOnly(h.state);
});

test('a concurrent duplicate mute cannot toggle the group back on', async () => {
  const confirmation = deferred();
  const h = harness({ send: () => confirmation.promise });
  const msg = h.message({ text: '/mute' });
  const first = h.handler(h.bot, msg);
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.saves, 1);
  assert.equal(h.state.moderation.length, 1);
  assert.equal(h.storage.isTopicMuted(CHAT, 185), true);
  confirmation.resolve({ ephemeralMessageId: 701 });
  await first;
  assertPrivateOnly(h.state);
});

test('say publishes one generated result after a private acknowledgement and records only the delivered text', async () => {
  const h = harness({ answer: async () => 'synthetic-model-composition',
    publish: async () => ({ messageId: 701, text: 'synthetic-delivered-public-composition' }) });
  await h.handle({ text: `/say ${SECRET}`, message_thread_id: 184,
    reply_to_message: { message_id: 12, from: { id: OTHER }, text: 'public-source' } });
  assert.equal(h.state.answers.length, 1);
  const call = h.state.answers[0];
  assert.deepEqual(call.history, h.publicHistory);
  assert.equal(call.input.sender, 'Сыч');
  assert.equal(call.input.replyText, 'public-source');
  assert.ok(call.input.text.includes(SECRET));
  assert.equal(call.private, true);
  assert.equal(call.profile, null);
  assert.equal(h.state.instructionReads, 0);
  assert.deepEqual(h.state.profileReads, []);
  assert.ok(call.instruction.length > 0, 'composition has its own directive');
  assert.equal(call.instruction.includes('synthetic-owner-instruction'), false);
  assert.equal(h.state.publications.length, 1);
  assert.equal(h.state.publications[0].text, 'synthetic-model-composition');
  assert.equal(h.state.publications[0].msg.reply_to_message.message_id, 12);
  assert.deepEqual(h.state.publicRecorded, [{ chat: CHAT, text: 'synthetic-delivered-public-composition' }]);
  assert.equal(JSON.stringify(h.state.publicRecorded).includes(SECRET), false);
  assert.deepEqual(h.state.events, ['private-send', 'ai', 'publish', 'record-public', 'private-send']);
  assertPrivateOnly(h.state);
});

test('say accepts both image sources but publishes only the composition returned by AI', async () => {
  const h = harness({ answer: async () => 'public-image-commentary' });
  await h.handle({ text: undefined, caption: '/say сравни эти картинки https://article.example/page',
    photo: [{ file_id: 'private-request-photo' }],
    reply_to_message: { message_id: 12, from: { id: OTHER }, caption: 'public-source-caption',
      photo: [{ file_id: 'public-source-photo' }] } });
  assert.equal(h.state.answers[0].images.length, 2);
  assert.deepEqual(h.state.files.sort(), ['private-request-photo', 'public-source-photo']);
  assert.equal(h.state.publications.length, 1);
  assert.equal(h.state.publications[0].text, 'public-image-commentary');
  assert.equal(h.state.events[0], 'private-send');
  assert.ok(h.state.events.indexOf('ai') > h.state.events.indexOf('download'));
  assertPrivateOnly(h.state);
});

test('a plain say reply supplies the source content and author without requiring a handle or an address', async () => {
  const sourceText = 'При изменении цены публикую старое и новое значения и разницу между ними.';
  for (const request of ['Сыч похвали его', 'Сыч оспорь его довод', 'Сыч раскритикуй этот пример',
    'Сыч оспорь его довод о методе @synthetic_other',
    'Сыч оспорь его довод о категории @synthetic_other',
    'Сыч раскритикуй пример, отметь слабые места',
    'Сыч оспорь его довод о тегах HTML',
    'Сыч не тегай автора, оспорь его довод',
    'Сыч не тегни @synthetic_other, оспорь довод',
    'Сыч отметь авторизацию как главный риск',
    'Сыч упомяни пользовательские сценарии']) {
    const h = harness({ answer: async () => 'Не соглашусь с этим доводом.' });
    await h.handle({ text: `/say ${request}`, reply_to_message: {
      message_id: 12, from: { id: OTHER, first_name: 'Ваня', username: 'synthetic_vanya' }, text: sourceText,
    } });
    const call = h.state.answers[0];
    assert.equal(call.input.replyText, sourceText);
    assert.match(call.input.text, /Автор исходного сообщения: Ваня/);
    assert.match(call.input.text, /Обращение и упоминание не обязательны/);
    assert.equal(h.state.publications[0].target.id, OTHER);
    assert.equal(h.state.publications[0].target.mentionRequired, false);
    assert.equal(h.state.publications[0].msg.reply_to_message.message_id, 12);
    assert.equal(h.state.publications[0].text, 'Не соглашусь с этим доводом.');
    assertPrivateOnly(h.state);
  }
});

test('say without a replied source does not force a forbidden username mention', async () => {
  for (const verb of ['тегай', 'упоминай', 'отмечай']) {
    const h = harness({ answer: async () => 'Сам подход спорный.' });
    await h.handle({ text: `/say Сыч не ${verb} @synthetic_other, раскритикуй этот подход` });
    assert.equal(h.state.publications[0].target, null);
    assert.equal(h.state.publications[0].text, 'Сам подход спорный.');
    assertPrivateOnly(h.state);
  }
});

test('say keeps explicit tracked and untracked usernames independent of historical user IDs', async () => {
  for (const username of ['synthetic_other', 'synthetic_untracked']) {
    const h = harness({ answer: async () => '{{recipient}}, привет.' });
    await h.handle({ text: `/say @${username} поздоровайся с участником` });
    assert.equal(h.state.publications.length, 1);
    const target = h.state.publications[0].target;
    assert.equal(String(target.username).replace(/^@/, ''), username);
    assert.equal(target.id, undefined, 'a reassigned explicit handle must not bind to a historical user ID');
    assertPrivateOnly(h.state);
  }
  const h = harness();
  await h.handle({ text: '/say отметь пользователя и поприветствуй' });
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.answers.length, 0);
  assertPrivateOnly(h.state);
});

test('stale or duplicate cached handles cannot override the explicitly requested username', async () => {
  for (const users of [{ [OTHER]: '@synthetic_reassigned' },
    { [OTHER]: '@synthetic_reassigned', 77: '@synthetic_reassigned' }]) {
    const h = harness({ answer: async () => '{{recipient}}, привет.' });
    h.storage.data.chats[CHAT].users = users;
    h.storage.profiles[CHAT][OTHER] = { realName: 'Previous owner', username: '@synthetic_reassigned' };
    h.storage.profiles[CHAT][77] = { realName: 'Another old owner', username: '@synthetic_reassigned' };
    await h.handle({ text: '/say тегни @synthetic_reassigned и скажи привет' });
    assert.equal(h.state.publications.length, 1);
    assert.deepEqual(h.state.publications[0].target, { username: 'synthetic_reassigned' });
    assertPrivateOnly(h.state);
  }
});

test('an instruction to mention the replied author takes priority over an incidental username in the body', async () => {
  const source = { message_id: 12, from: { id: OTHER, first_name: 'Боб', username: 'synthetic_bob' }, text: 'public-source' };
  for (const text of [
    '/say отметь автора и скажи, что @synthetic_alice его ждёт',
    '/say тегни его и скажи, что @synthetic_alice его ждёт',
    '/say упомяни её и скажи, что @synthetic_alice ждёт',
  ]) {
    const h = harness({ answer: async () => '{{recipient}}, тебя ждут.' });
    await h.handle({ text, reply_to_message: source });
    assert.equal(h.state.publications.length, 1);
    assert.equal(h.state.publications[0].target.id, OTHER);
    assert.equal(h.state.publications[0].target.username, 'synthetic_bob');
    assertPrivateOnly(h.state);
  }
});

test('an explicit instruction to mention another handle does not switch to the replied author', async () => {
  for (const request of ['тегни @synthetic_alice и скажи привет',
    'Сыч не тегай автора, тегни @synthetic_alice и оспорь довод',
    'Сыч оспорь метод @synthetic_other и тегни @synthetic_alice']) {
    const h = harness({ answer: async () => '{{recipient}}, привет.' });
    await h.handle({ text: `/say ${request}`, reply_to_message: {
      message_id: 12, from: { id: OTHER, first_name: 'Боб', username: 'synthetic_bob' }, text: 'public-source',
    } });
    assert.equal(h.state.publications.length, 1);
    assert.deepEqual(h.state.publications[0].target, { username: 'synthetic_alice' });
    assertPrivateOnly(h.state);
  }
});

test('say can mention a replied human without a username, including a locally banned participant', async () => {
  const h = harness({ answer: async () => '{{recipient}}, привет.' });
  h.storage.banUserInChat(CHAT, OTHER, 'synthetic-local-ban');
  await h.handle({ text: '/say отметь автора и скажи привет', reply_to_message: {
    message_id: 12, from: { id: OTHER, first_name: 'Ася' }, text: 'public-source',
  } });
  assert.equal(h.state.publications.length, 1);
  assert.equal(h.state.publications[0].target.id, OTHER);
  assert.equal(h.state.publications[0].target.first_name, 'Ася');
  assert.equal(h.state.publications[0].target.username, undefined);
  assertPrivateOnly(h.state);
});

test('say cannot use private ask history or become a cached private dialog itself', async () => {
  const h = harness();
  await h.handle({ text: '/ask old-private-secret' });
  h.state.instructionReads = 0;
  h.state.profileReads.length = 0;
  await h.handle({ text: '/say independent-public-composition' });
  assert.deepEqual(h.state.answers[1].history, h.publicHistory);
  assert.equal(h.state.answers[1].profile, null);
  assert.equal(h.state.instructionReads, 0);
  assert.deepEqual(h.state.profileReads, []);
  const sayReceiptId = h.state.sent.at(-1).opts.ephemeral.editId;
  await h.handle({ text: 'продолжи', reply_to_message: { message_id: 0,
    ephemeral_message_id: sayReceiptId, date: 1791446400, from: { id: BOT } } });
  assert.equal(h.state.answers.length, 2, 'say receipts are not cached private answers');
  assert.equal(h.state.publications.length, 1);
  assert.equal(JSON.stringify(h.state.publicRecorded).includes('old-private-secret'), false);
});

test('say rejects every private replied source before AI, even if it claims a public message ID', async () => {
  const h = harness();
  for (const source of [
    { message_id: 0, ephemeral_message_id: 51, from: { id: BOT }, text: 'private-answer' },
    { message_id: 12, ephemeral_message_id: -51, from: { id: OTHER }, text: 'private-source' },
  ]) await h.handle({ text: '/say republish source', reply_to_message: source });
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.publicRecorded.length, 0);
  assertPrivateOnly(h.state);
});

test('say respects whole-chat and topic mutes before any AI work', async () => {
  for (const wholeChat of [true, false]) {
    const h = harness();
    if (wholeChat) h.state.muted.add(CHAT);
    else h.state.topicMuted.add(`${CHAT}:184`);
    await h.handle({ text: '/say публичное сообщение', message_thread_id: 184 });
    assert.equal(h.state.answers.length, 0);
    assert.equal(h.state.publications.length, 0);
    assertPrivateOnly(h.state);
  }
});

test('a mute applied while say is being generated prevents public publication and history writes', async () => {
  const answer = deferred();
  const h = harness({ answer: () => answer.promise });
  const pending = h.handle({ text: '/say slow-public-composition' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.answers.length, 1);
  await h.handle({ text: '/mute' });
  answer.resolve('synthetic-late-public-composition');
  await pending;
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.publicRecorded.length, 0);
  assertPrivateOnly(h.state);
});

test('an inherited topic mute or forgetting during say generation cancels the pending publication', async () => {
  for (const action of ['topic-mute', 'forget']) {
    const answer = deferred();
    const h = harness({ answer: () => answer.promise });
    const pending = h.handle({ text: '/say slow-public-composition', reply_to_message: {
      message_id: 12, message_thread_id: 184, from: { id: OTHER }, text: 'public-source',
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.answers.length, 1);
    if (action === 'topic-mute') h.state.topicMuted.add(`${CHAT}:184`);
    else h.handler.forgetUser(OWNER);
    answer.resolve('synthetic-late-public-composition');
    await pending;
    assert.equal(h.state.publications.length, 0, action);
    assert.equal(h.state.publicRecorded.length, 0, action);
    assertPrivateOnly(h.state);
  }
});

test('failed, empty or timed-out say generation never reaches public delivery', async () => {
  for (const setup of [
    { answer: async () => { throw new Error('synthetic-private-model-error'); } },
    { answer: async () => '' },
    { answer: () => new Promise(() => {}), answerTimeoutMs: 5 },
  ]) {
    const h = harness(setup);
    await h.handle({ text: `/say ${SECRET}` });
    assert.equal(h.state.publications.length, 0);
    assert.equal(h.state.publicRecorded.length, 0);
    assert.equal(JSON.stringify(h.state.sent).includes('synthetic-private-model-error'), false);
    assertPrivateOnly(h.state);
  }
});

test('say publication errors stay private and do not retry even when the same update is redelivered', async () => {
  const h = harness({ publish: async () => { throw new Error('synthetic-private-network-error'); } });
  const msg = h.message({ text: `/say ${SECRET}` });
  await h.handler(h.bot, msg);
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.publications.length, 1, 'an uncertain public send cannot be retried by duplicate updates');
  assert.equal(h.state.publicRecorded.length, 0);
  assert.equal(h.state.answers.length, 1);
  assert.equal(JSON.stringify(h.state.sent).includes('synthetic-private-network-error'), false);
  assertPrivateOnly(h.state);
});

test('say acknowledgement failure stops generation and cannot publish', async () => {
  const h = harness({ send: async () => { throw new Error('synthetic-private-ack-error'); } });
  await h.handle({ text: '/say public-result', photo: [{ file_id: 'never-read' }] });
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.files.length, 0);
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.publicRecorded.length, 0);
  assertPrivateOnly(h.state);
});

test('a failed say generation cannot publish on redelivery after AI recovers, but a new owner input can', async () => {
  let recovered = false;
  const h = harness({ answer: async () => {
    if (!recovered) throw new Error('synthetic-private-model-error');
    return 'synthetic-recovered-public-result';
  } });
  const msg = h.message({ text: '/say initial-failed-composition' });
  await h.handler(h.bot, msg);
  recovered = true;
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.publications.length, 0, 'redelivery is not renewed permission to publish a failed request');
  await h.handle({ text: '/say new-owner-composition' });
  assert.equal(h.state.answers.length, 2);
  assert.equal(h.state.publications.length, 1);
  assertPrivateOnly(h.state);
});

test('a say rejected while muted cannot publish on redelivery after unmuting, but a new owner input can', async () => {
  const h = harness();
  const msg = h.message({ text: '/say initial-muted-composition' });
  h.state.muted.add(CHAT);
  await h.handler(h.bot, msg);
  h.state.muted.delete(CHAT);
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.publications.length, 0, 'unmuting must not revive a rejected request');
  await h.handle({ text: '/say new-owner-composition' });
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.publications.length, 1);
  assertPrivateOnly(h.state);
});

test('a say with failed private acknowledgement cannot publish on redelivery after transport recovers', async () => {
  let recovered = false;
  const h = harness({ send: async call => {
    if (!recovered) throw new Error('synthetic-private-ack-error');
    return { ephemeralMessageId: call.opts.ephemeral.editId || 701, messageDate: 1791446400 };
  } });
  const msg = h.message({ text: '/say initial-unacknowledged-composition' });
  await h.handler(h.bot, msg);
  recovered = true;
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.sent.length, 1, 'a completed failed request is not acknowledged again on redelivery');
  await h.handle({ text: '/say new-owner-composition' });
  assert.equal(h.state.answers.length, 1);
  assert.equal(h.state.publications.length, 1);
  assertPrivateOnly(h.state);
});

test('failed private say receipt cannot repeat a successful public publication', async () => {
  const h = harness({ send: async (call, n) => {
    if (n === 1) return { ephemeralMessageId: 701, messageDate: 1791446400 };
    throw new Error('synthetic-private-receipt-error');
  } });
  const msg = h.message({ text: '/say public-result' });
  await h.handler(h.bot, msg);
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.publications.length, 1);
  assert.equal(h.state.publicRecorded.length, 1);
  assert.equal(h.state.answers.length, 1);
  assertPrivateOnly(h.state);
});

test('concurrent and completed duplicate say updates produce a single public message', async () => {
  const answer = deferred();
  const h = harness({ answer: () => answer.promise });
  const msg = h.message({ text: '/say public-once' });
  const first = h.handler(h.bot, msg);
  await h.handler(h.bot, { ...msg });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.answers.length, 1);
  answer.resolve('synthetic-public-once');
  await first;
  await h.handler(h.bot, { ...msg });
  assert.equal(h.state.publications.length, 1);
  assert.equal(h.state.publicRecorded.length, 1);
  assert.equal(h.state.answers.length, 1);
  assertPrivateOnly(h.state);
});

test('unauthorized and ordinary say commands cannot publish or reach public AI handling', async () => {
  const h = harness({ integration: true });
  await h.process({ text: '/say private-unauthorized', from: { id: OTHER } });
  await h.process({ text: '/say@Other_bot Сыч, public-result' });
  await h.process({ text: '/say@Siitch_bot Сыч, public-result', ephemeral_message_id: undefined, message_id: 20 });
  await h.process({ text: '/say Сыч, public-result', ephemeral_message_id: undefined, message_id: 21 });
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.answers.length, 0);
  assert.equal(h.state.sent.length, 0);
});

test('say enters only the delivered public result in subsequent public history', async () => {
  const h = harness({ integration: true, answer: async call => call.private ? 'synthetic-public-final' : 'public-follow-up' });
  await h.process({ text: `/say ${SECRET}` });
  await h.process({ ephemeral_message_id: undefined, message_id: 20, text: 'Сыч, follow-up' });
  assert.equal(h.state.answers.length, 2);
  const publicHistory = h.state.answers[1].history;
  assert.equal(publicHistory.some(entry => entry.text === 'synthetic-public-final'), true);
  assert.equal(JSON.stringify(publicHistory).includes(SECRET), false);
  assert.equal(h.state.answers[1].private, false);
});

test('public help does not expose hidden owner commands for either owner or other participants', async () => {
  for (const user of [OWNER, OTHER]) {
    const h = harness({ integration: true });
    await h.process({ ephemeral_message_id: undefined, message_id: 20, text: '/help@Siitch_bot',
      from: { id: user, first_name: 'Участник' } });
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.state.sent[0].opts.ephemeral, undefined);
    assert.doesNotMatch(h.state.sent[0].content.html, /\/(?:ask|say|mute|ban)(?:@|\b)|скрыт/iu);
    assert.equal(h.state.publications.length, 0);
    assert.equal(h.state.answers.length, 0);
  }
});
