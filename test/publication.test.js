const assert = require('node:assert/strict');
const test = require('node:test');
const { createPublication } = require('../src/services/publication');

const CHAT = -100;
const OWNER = 999;
const TARGET = { id: 42, first_name: 'Ася', username: 'synthetic_other' };
function message(overrides = {}) {
  return { message_id: 0, ephemeral_message_id: 11, date: 1791446400,
    from: { id: OWNER }, chat: { id: CHAT, type: 'supergroup' },
    text: '/say synthetic-private-composition-instruction', ...overrides };
}

function harness(result) {
  if (arguments.length === 0) result = { message_id: 701 };
  const calls = [];
  const bot = { sendMessage: async (...args) => {
    calls.push(args);
    if (typeof result === 'function') return result(...args);
    return result;
  } };
  return { bot, calls };
}

function assertPublic(call) {
  assert.equal(call[0], CHAT);
  const options = call[2];
  assert.equal(options?.ephemeral_message_parameters, undefined);
  assert.equal(options?.receiver_user_id, undefined);
  assert.equal(options?.reply_parameters?.ephemeral_message_id, undefined);
  assert.equal(options?.parse_mode, undefined, 'publication uses plain text with explicit mention entities');
}

test('publication sends one generated answer in the same group/topic, never the hidden prompt', async () => {
  const h = harness();
  const publication = createPublication(h.bot, message({ message_thread_id: 184 }));
  const result = await publication.send('synthetic-public-result');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1], 'synthetic-public-result');
  assert.equal(h.calls[0][2].message_thread_id, 184);
  assert.equal(h.calls[0][2].reply_parameters, undefined, 'message ID 0 from the hidden update is never a public reply');
  assert.equal(result.messageId, 701);
  assert.equal(result.text, 'synthetic-public-result');
  assertPublic(h.calls[0]);
});

test('publication replies only to a positive public source ID and inherits its topic', async () => {
  const h = harness();
  const result = await createPublication(h.bot, message({ reply_to_message: {
    message_id: 12, message_thread_id: 184, from: TARGET, text: 'public-source',
  } })).send('public-answer');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][2].reply_parameters.message_id, 12);
  assert.notEqual(h.calls[0][2].reply_parameters.allow_sending_without_reply, true);
  assert.equal(h.calls[0][2].message_thread_id, 184);
  assert.equal(result.messageId, 701);
  assertPublic(h.calls[0]);
});

test('known recipient replaces the template with a deterministic text mention', async () => {
  const h = harness();
  const result = await createPublication(h.bot, message(), TARGET).send('😀 {{recipient}}, добро пожаловать!');
  const text = h.calls[0][1];
  assert.equal(text, '😀 @synthetic_other, добро пожаловать!');
  assert.equal(result.text, text);
  const entity = h.calls[0][2].entities[0];
  assert.equal(entity.type, 'text_mention');
  assert.equal(entity.offset, '😀 '.length);
  assert.equal(entity.length, '@synthetic_other'.length);
  assert.equal(entity.user.id, TARGET.id);
  assert.equal(text.slice(entity.offset, entity.offset + entity.length), '@synthetic_other');
  assertPublic(h.calls[0]);
});

test('recipient without a username is prepended by name and uses UTF-16 mention bounds', async () => {
  const target = { id: 43, first_name: 'Ася 👩‍💻' };
  const h = harness();
  await createPublication(h.bot, message(), target).send('рады тебя видеть.');
  assert.equal(h.calls[0][1], `${target.first_name}, рады тебя видеть.`);
  const entity = h.calls[0][2].entities[0];
  assert.equal(entity.type, 'text_mention');
  assert.equal(entity.offset, 0);
  assert.equal(entity.length, target.first_name.length);
  assert.equal(entity.user.id, target.id);
});

test('optional replied author does not add an address or tag to a contextual response', async () => {
  const h = harness();
  const text = 'Не соглашусь: при изменении цены стоит показывать и старое, и новое значение.';
  await createPublication(h.bot, message({ reply_to_message: { message_id: 12, from: TARGET } }),
    { ...TARGET, mentionRequired: false }).send(text);
  assert.equal(h.calls[0][1], text);
  assert.equal(h.calls[0][2].entities, undefined);
  assert.equal(h.calls[0][2].reply_parameters.message_id, 12);
});

test('a chosen optional author mention uses their name and exact ID without requiring a username', async () => {
  for (const username of ['synthetic_other', undefined]) {
    const h = harness();
    const target = { id: 42, first_name: 'Ваня', username, mentionRequired: false };
    await createPublication(h.bot, message(), target).send('{{recipient}}, пример с изменением цены получился ясным.');
    assert.equal(h.calls[0][1], 'Ваня, пример с изменением цены получился ясным.');
    assert.equal(h.calls[0][2].entities[0].user.id, 42);
    assert.equal(h.calls[0][2].entities[0].length, 'Ваня'.length);
  }
});

test('explicit untracked username is a normal Telegram mention and cannot invent a user ID', async () => {
  const h = harness();
  await createPublication(h.bot, message(), { username: 'synthetic_untracked' }).send('{{recipient}}, привет.');
  assert.equal(h.calls[0][1], '@synthetic_untracked, привет.');
  const entity = h.calls[0][2].entities[0];
  assert.equal(entity.type, 'mention');
  assert.equal(entity.offset, 0);
  assert.equal(entity.length, '@synthetic_untracked'.length);
  assert.equal(entity.user, undefined);
});

test('private or invalid reply IDs can never become public reply targets', async () => {
  for (const source of [
    { message_id: 0, ephemeral_message_id: 51 },
    { message_id: 12, ephemeral_message_id: -51 },
    { message_id: -1 }, { message_id: '12' }, { message_id: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const h = harness();
    let error;
    try { await createPublication(h.bot, message({ reply_to_message: source })).send('public-answer'); }
    catch (caught) { error = caught; }
    assert.ok(error || h.calls[0][2].reply_parameters === undefined,
      'an invalid source must be rejected or sent without a public reply');
    if (h.calls.length) assertPublic(h.calls[0]);
  }
});

test('destination and target are snapshotted before awaiting generation or sending', async () => {
  const h = harness();
  const update = message({ message_thread_id: 184, reply_to_message: { message_id: 12 } });
  const target = { ...TARGET };
  const publication = createPublication(h.bot, update, target);
  update.chat.id = -200;
  update.message_thread_id = 185;
  update.reply_to_message.message_id = 13;
  target.id = 77;
  target.username = 'synthetic_changed';
  await publication.send('{{recipient}}, привет.');
  assert.equal(h.calls[0][0], CHAT);
  assert.equal(h.calls[0][2].message_thread_id, 184);
  assert.equal(h.calls[0][2].reply_parameters.message_id, 12);
  assert.equal(h.calls[0][1], '@synthetic_other, привет.');
  assert.equal(h.calls[0][2].entities[0].user.id, TARGET.id);
});

test('invalid input destinations, content and targets fail without making a Telegram call', async () => {
  for (const update of [message({ chat: { id: CHAT, type: 'private' } }), message({ chat: undefined }),
    message({ chat: { id: 0, type: 'group' } }), message({ chat: { id: 'not-a-chat', type: 'group' } })]) {
    const h = harness();
    await assert.rejects(async () => createPublication(h.bot, update).send('answer'));
    assert.equal(h.calls.length, 0);
  }
  for (const content of ['', '  ', null, undefined, { text: 'answer' }]) {
    const h = harness();
    await assert.rejects(async () => createPublication(h.bot, message()).send(content));
    assert.equal(h.calls.length, 0);
  }
  for (const target of [{ id: 0 }, { id: -1 }, { id: '42' }, { id: 1.5 }, { id: 42, is_bot: true },
    { username: 'not a username' }, { username: '@@invalid' }]) {
    const h = harness();
    await assert.rejects(async () => createPublication(h.bot, message(), target).send('answer'));
    assert.equal(h.calls.length, 0);
  }
});

test('failed or unconfirmed public delivery never retries or falls back to another send', async () => {
  for (const result of [undefined, true, {}, { message_id: 0 }, { message_id: -1 }, { message_id: '701' },
    { message_id: Number.MAX_SAFE_INTEGER + 1 }, () => { throw new Error('synthetic-network-error'); }]) {
    const h = harness(result);
    await assert.rejects(async () => createPublication(h.bot, message()).send('public-answer'));
    assert.equal(h.calls.length, 1, 'uncertain delivery must not create a duplicate public message');
  }
});
