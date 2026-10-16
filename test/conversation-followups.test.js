const assert = require('node:assert/strict');
const test = require('node:test');
const { ConversationFollowups } = require('../src/utils/conversation-followups');

function question(overrides = {}) {
  return { message_id: 10, chat: { id: -100 }, from: { id: 42 }, text: 'Сыч, вопрос?', ...overrides };
}
function reply(original, overrides = {}) {
  return question({ message_id: 11, text: 'Проверь подробнее', reply_to_message: original, ...overrides });
}

test('only a confirmed positive ordinary bot message authorizes an exact own-question reply', () => {
  const links = new ConversationFollowups();
  const original = question();
  const token = links.begin(original, 184);
  assert.equal(links.get(reply(original), 184), null);
  for (const id of [undefined, null, 0, -1, 1.5, 'private', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(links.confirm(token, id), false);
  }
  assert.equal(links.confirm(token, 20), true);
  links.finish(token);
  assert.equal(links.get(reply(original), 184).sourceText, original.text);
  assert.equal(links.get(reply(original), 184).botMessageId, '20');
});

test('keys normalize Telegram identifiers and bind sender, source, chat, topic and business connection', () => {
  const links = new ConversationFollowups();
  const original = question({ business_connection_id: 'business-A' });
  const token = links.begin(original, 184);
  links.confirm(token, 20); links.finish(token);
  const candidate = reply(original, { business_connection_id: 'business-A' });
  assert.ok(links.get({ ...candidate, from: { id: '42' }, chat: { id: '-100' },
    reply_to_message: { ...original, message_id: '10', from: { id: '42' } } }, '184'));
  for (const [msg, topic] of [
    [{ ...candidate, from: { id: 43 } }, 184],
    [{ ...candidate, chat: { id: -101 } }, 184],
    [candidate, 185], [candidate, null],
    [{ ...candidate, business_connection_id: 'business-B' }, 184],
    [{ ...candidate, business_connection_id: undefined }, 184],
    [{ ...candidate, reply_to_message: { ...original, message_id: 9 } }, 184],
    [{ ...candidate, reply_to_message: { ...original, from: { id: 43 } } }, 184],
    [{ ...candidate, reply_to_message: { ...original, ephemeral_message_id: 10 } }, 184],
    [{ ...candidate, reply_to_message: undefined }, 184],
  ]) assert.equal(links.get(msg, topic), null);
});

test('confirmed links expire after five minutes and the oldest links are evicted at 256', () => {
  let now = 1000;
  const links = new ConversationFollowups({ now: () => now });
  for (let id = 1; id <= 257; id++) {
    const token = links.begin(question({ message_id: id }), null);
    links.confirm(token, id + 1000); links.finish(token);
  }
  assert.equal(links.entries.size, 256);
  assert.equal(links.get(reply(question({ message_id: 1 })), null), null);
  assert.ok(links.get(reply(question({ message_id: 257 })), null));
  now += 5 * 60 * 1000 - 1;
  assert.ok(links.get(reply(question({ message_id: 257 })), null));
  now++;
  assert.equal(links.get(reply(question({ message_id: 257 })), null), null);
  assert.equal(links.entries.size, 0);
});

test('forgetting a user clears all their scopes and cancels pending work without blocking fresh questions', () => {
  const links = new ConversationFollowups();
  const original = question();
  const completed = links.begin(original, null);
  links.confirm(completed, 20); links.finish(completed);
  const pending = links.begin(question({ chat: { id: -101 } }), 184);
  const anotherUser = links.begin(question({ from: { id: 43 } }), null);
  links.confirm(anotherUser, 21); links.finish(anotherUser);
  links.forgetUser('42');
  assert.equal(links.get(reply(original), null), null);
  assert.equal(links.confirm(pending, 22), false);
  assert.equal(links.pending.size, 0);
  assert.equal(links.entries.size, 1);
  const fresh = links.begin(original, null);
  assert.equal(links.confirm(fresh, 23), true);
  links.finish(fresh);
});

test('resetting a chat clears every topic and user in that chat and blocks late confirmations', () => {
  const links = new ConversationFollowups();
  const pending = links.begin(question(), 184);
  const completed = links.begin(question({ from: { id: 43 } }), 185);
  links.confirm(completed, 20); links.finish(completed);
  const otherChat = links.begin(question({ chat: { id: -101 } }), null);
  links.confirm(otherChat, 21); links.finish(otherChat);
  links.forgetChat('-100');
  assert.equal(links.confirm(pending, 22), false);
  assert.equal(links.pending.size, 0);
  assert.equal(links.entries.size, 1);
});

test('private, slash, invalid and bot-owned sources never create public continuation links', () => {
  const links = new ConversationFollowups();
  for (const original of [
    question({ message_id: 0, ephemeral_message_id: 'private' }),
    question({ ephemeral_message_id: 1 }),
    question({ text: ' /help@Siitch_bot' }),
    question({ text: undefined, caption: '/say@Siitch_bot Сыч' }),
    question({ from: { id: 42, is_bot: true } }),
    question({ message_id: -1 }),
  ]) assert.equal(links.begin(original, null), null);
  assert.equal(links.entries.size, 0);
  assert.equal(links.pending.size, 0);
});

test('pending work is bounded and is cleaned on finish, expiry, or eviction', () => {
  let now = 1000;
  const links = new ConversationFollowups({ now: () => now, maxEntries: 2 });
  const first = links.begin(question({ message_id: 1 }), null);
  const second = links.begin(question({ message_id: 2 }), null);
  const third = links.begin(question({ message_id: 3 }), null);
  assert.equal(links.pending.size, 2);
  assert.equal(links.confirm(first, 20), false);
  links.finish(second);
  assert.equal(links.pending.size, 1);
  now += 5 * 60 * 1000;
  assert.equal(links.confirm(third, 21), false);
  assert.equal(links.pending.size, 0);
});

test('confirmed public bot replies preserve origin for another author without authorizing other-question triggers', () => {
  const links = new ConversationFollowups();
  const post = question({ message_id: 1, from: { id: 43 }, text: undefined,
    caption: 'SyntheticMemory, SharedMemory и модель. Репозиторий, документация, веса.',
    caption_entities: [
      { type: 'text_link', offset: 0, length: 9, url: 'https://github.com/example/memory' },
      { type: 'text_link', offset: 11, length: 6, url: 'https://github.com/example/memory/docs' },
      { type: 'text_link', offset: 19, length: 6, url: 'https://huggingface.co/example/memory' },
    ] });
  const original = question({ reply_to_message: post });
  const token = links.begin(original, 184, { botId: 888 });
  const botReply = question({ message_id: 20, from: { id: 888, is_bot: true }, text: 'Неверный продукт' });
  const recheck = reply(botReply, { from: { id: 44 } });
  assert.equal(links.getSource(recheck, 184), null, 'unconfirmed bot answers have no reusable origin');
  links.confirm(token, 20); links.finish(token);
  assert.equal(links.get(reply(original, { from: { id: 44 } }), 184), null);
  const source = links.getSource(recheck, 184);
  assert.match(source.sourceContext.text, /SyntheticMemory/);
  assert.equal(source.sourceContext.text.includes(botReply.text), false);
  assert.deepEqual(source.sourceContext.urls, post.caption_entities.map(entity => entity.url));
  const next = links.begin(recheck, 184, { botId: 888, inherited: source });
  assert.deepEqual(next.sourceContext, source.sourceContext);
  assert.deepEqual(next.sourceUserIds, source.sourceUserIds, 'rechecks do not grow the retained source lineage');
  links.confirm(next, 21); links.finish(next);
  links.forgetUser(43);
  assert.equal(links.entries.size, 0, 'forgetting a source author clears inherited origin too');
});

test('public bot-origin lookup observes scope, expiry, reset and private boundaries', () => {
  let now = 1000;
  const links = new ConversationFollowups({ now: () => now });
  const token = links.begin(question({ business_connection_id: 'A' }), 184, { botId: 888 });
  links.confirm(token, 20); links.finish(token);
  const candidate = reply(question({ message_id: 20, from: { id: 888, is_bot: true } }),
    { from: { id: 43 }, business_connection_id: 'A' });
  assert.ok(links.getSource(candidate, 184));
  for (const [msg, topic] of [
    [{ ...candidate, chat: { id: -101 } }, 184], [candidate, 185],
    [{ ...candidate, business_connection_id: 'B' }, 184],
    [{ ...candidate, ephemeral_message_id: 1 }, 184],
    [{ ...candidate, reply_to_message: { ...candidate.reply_to_message, ephemeral_message_id: 1 } }, 184],
    [{ ...candidate, reply_to_message: { ...candidate.reply_to_message, from: { id: 42 } } }, 184],
  ]) assert.equal(links.getSource(msg, topic), null);
  now += 5 * 60 * 1000;
  assert.equal(links.getSource(candidate, 184), null);
  const fresh = links.begin(question({ business_connection_id: 'A' }), 184, { botId: 888 });
  links.confirm(fresh, 20); links.finish(fresh);
  links.forgetChat(-100);
  assert.equal(links.getSource(candidate, 184), null);
});

test('source collection bounds text, URLs and reply depth, handles cycles and excludes private or foreign scopes', () => {
  const { buildSourceContext, MAX_SOURCE_CHARS, MAX_SOURCE_URLS, MAX_REPLY_DEPTH } = require('../src/utils/source-context');
  const longPost = question({ text: 'Original source ' + 'x'.repeat(12000), entities: Array.from({ length: 80 }, (_, i) =>
    ({ type: 'text_link', url: `https://source.example/page-${i}` })) });
  const source = buildSourceContext(question({ text: 'Сыч, исследуй запуск с OpenClaw', reply_to_message: longPost }));
  assert.ok(source.text.length <= MAX_SOURCE_CHARS);
  assert.match(source.text, /Original source/);
  assert.match(source.text, /OpenClaw/);
  assert.equal(source.urls.length, MAX_SOURCE_URLS);
  const cyclic = question({ text: 'cycle' });
  cyclic.reply_to_message = cyclic;
  assert.equal(buildSourceContext(cyclic).text, 'cycle');
  let nested = question({ text: 'oldest' });
  for (let i = 0; i < MAX_REPLY_DEPTH + 3; i++) nested = question({ text: `step-${i}`, reply_to_message: nested });
  assert.equal(buildSourceContext(nested).text.includes('oldest'), false);
  for (const blocked of [
    question({ text: 'private origin', ephemeral_message_id: 1 }),
    question({ text: 'different chat', chat: { id: -101 } }),
    question({ text: 'bot guess', from: { id: 888, is_bot: true } }),
  ]) assert.equal(buildSourceContext(question({ text: 'current', reply_to_message: blocked }), { botId: 888 }).text, 'current');
  assert.deepEqual(buildSourceContext(question({ text: 'https://source.example/Function_(math) и (https://source.example/page).' })).urls,
    ['https://source.example/Function_(math)', 'https://source.example/page']);
});

test('recent public origin reuse requires an explicit short criticism with no new source and the exact scope/TTL', () => {
  let now = 1000;
  const links = new ConversationFollowups({ now: () => now });
  const original = question({ text: 'Сыч, проверь https://source.example/origin', business_connection_id: 'A' });
  const token = links.begin(original, 184, { botId: 888 });
  const critique = question({ from: { id: 43 }, text: 'Чет сыч налажал', business_connection_id: 'A' });
  assert.equal(links.getRecentSource(critique, 184), null);
  links.confirm(token, 20); links.finish(token);
  assert.ok(links.getRecentSource(critique, 184));
  for (const [msg, topic] of [
    [{ ...critique, text: 'Сыч, расскажи про погоду' }, 184],
    [{ ...critique, text: 'Сыч, ты ошибся. Расскажи про другую систему.' }, 184],
    [{ ...critique, text: 'Сыч, перепроверь https://new.example/source' }, 184],
    [{ ...critique, entities: [{ type: 'text_link', url: 'https://new.example/source' }] }, 184],
    [{ ...critique, reply_to_message: question() }, 184],
    [{ ...critique, photo: [{ file_id: 'new' }] }, 184],
    [{ ...critique, chat: { id: -101 } }, 184], [critique, 185],
    [{ ...critique, business_connection_id: 'B' }, 184],
    [{ ...critique, ephemeral_message_id: 1 }, 184],
  ]) assert.equal(links.getRecentSource(msg, topic), null);
  now += 5 * 60 * 1000;
  assert.equal(links.getRecentSource(critique, 184), null);
});
