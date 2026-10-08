const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const USER_ID = 123456789;
const CHAT_ID = -100123456789;
const PRIVATE = { ephemeral: { receiverUserId: USER_ID } };
const sent = (id = 501) => ({ data: { ok: true, result: {
  message_id: 0, ephemeral_message_id: id, date: 1791446400, receiver_user: { id: USER_ID },
} } });
const edited = () => ({ data: { ok: true, result: true } });
const rejected = (description = 'Bad Request: rich formatting failed') => Object.assign(
  new Error(`Raw error with token secret-token and private-content: ${description}`),
  { response: { data: { ok: false, error_code: 400, description } },
    config: { url: 'https://api.telegram.org/botsecret-token/sendRichMessage', data: 'private-content' } },
);

function transport(respond) {
  const calls = [];
  const logs = [];
  let publicCalls = 0;
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/rich.js'), 'utf8'), {
    module: box,
    console: { error: (...args) => logs.push(args), log: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    require: name => name === 'axios' ? { post: async (url, body, opts) => {
      const call = { method: url.split('/').at(-1), body: JSON.parse(JSON.stringify(body)), opts };
      calls.push(call);
      return respond(call, calls.length);
    } } : name === '../config' ? { telegramToken: 'secret-token' }
      : name === './voice' ? require('../src/utils/voice') : require('../src/utils/quotes'),
  });
  const bot = { sendMessage: async () => {
    publicCalls++;
    throw new Error('ordinary bot.sendMessage must not be used for private content');
  } };
  return {
    calls, logs, get publicCalls() { return publicCalls; },
    send: (content, opts = PRIVATE) => box.exports.sendRich(bot, CHAT_ID, content, opts),
  };
}

function safeError(error, code) {
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error.stack), /secret-token|private-content|https:\/\//);
  assert.equal(error.cause, undefined);
  assert.equal(error.response, undefined);
  assert.equal(error.config, undefined);
  return true;
}

test('initial rich delivery carries the fixed recipient and returns an ephemeral ID', async () => {
  const t = transport(() => sent());
  const result = await t.send({ markdown: '**Ответ**' }, {
    ...PRIVATE, replyTo: 71, threadId: 19, silent: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'rich');
  assert.equal(result.ephemeralMessageId, 501);
  assert.equal(result.messageDate, 1791446400);
  assert.equal(result.messageId, undefined);
  assert.equal(t.calls[0].method, 'sendRichMessage');
  assert.deepEqual(t.calls[0].body, {
    chat_id: CHAT_ID, rich_message: { markdown: '**Ответ**' },
    ephemeral_message_parameters: { receiver_user_id: USER_ID },
    reply_parameters: { message_id: 71 }, message_thread_id: 19, disable_notification: true,
  });
  assert.equal(t.calls[0].opts.proxy, false);
  assert.ok(t.calls[0].opts.timeout <= 10000);
  assert.equal(t.publicCalls, 0);
  assert.deepEqual(t.logs, []);
});

test('an incoming ephemeral reply target wins over the ordinary message ID', async () => {
  const t = transport(() => sent());
  await t.send({ html: '<p>Ответ</p>' }, {
    ephemeral: { receiverUserId: USER_ID, replyToEphemeralId: 88 }, replyTo: 12, threadId: 19,
  });
  assert.deepEqual(t.calls[0].body.reply_parameters, { ephemeral_message_id: 88 });
  assert.equal(t.calls[0].body.message_thread_id, 19);
  assert.deepEqual(t.calls[0].body.ephemeral_message_parameters, { receiver_user_id: USER_ID });
});

test('editing uses only the ephemeral editing method and accepts its boolean acknowledgement', async () => {
  const t = transport(() => edited());
  const result = await t.send({ markdown: 'Готовый ответ' }, {
    ephemeral: { receiverUserId: USER_ID, editId: 501, replyToEphemeralId: 88 },
    replyTo: 12, threadId: 19,
  });
  assert.equal(result.ephemeralMessageId, 501);
  assert.equal(result.mode, 'rich');
  assert.deepEqual(t.calls.map(call => call.method), ['editEphemeralMessageText']);
  assert.deepEqual(t.calls[0].body, {
    chat_id: CHAT_ID, receiver_user_id: USER_ID, ephemeral_message_id: 501,
    rich_message: { markdown: 'Готовый ответ' },
  });
  assert.equal(t.publicCalls, 0);
});

test('a confirmed rich rejection falls back through raw sendMessage with identical privacy and reply context', async () => {
  const t = transport((call, n) => { if (n === 1) throw rejected(); return sent(502); });
  const result = await t.send({ html: '<p>Ответ &amp; ссылка</p>' }, {
    ephemeral: { receiverUserId: USER_ID, replyToEphemeralId: 88 }, threadId: 19,
  });
  assert.equal(result.mode, 'fallback');
  assert.equal(result.ephemeralMessageId, 502);
  assert.deepEqual(t.calls.map(call => call.method), ['sendRichMessage', 'sendMessage']);
  assert.equal(t.calls[1].body.text, 'Ответ & ссылка');
  for (const call of t.calls) {
    assert.deepEqual(call.body.ephemeral_message_parameters, { receiver_user_id: USER_ID });
    assert.deepEqual(call.body.reply_parameters, { ephemeral_message_id: 88 });
    assert.equal(call.body.message_thread_id, 19);
  }
  assert.equal(t.publicCalls, 0);
  assert.deepEqual(t.logs, []);
});

test('media retry remains private and strips only the failed media', async () => {
  const t = transport((call, n) => { if (n === 1) throw rejected('RICH_MESSAGE media failed: private-content'); return sent(); });
  const result = await t.send({ markdown: '![Картинка](https://example.com/private.png)\n\n**Полный ответ**' }, {
    ...PRIVATE, replyTo: 71, threadId: 19,
  });
  assert.equal(result.mode, 'rich-noimg');
  assert.equal(t.calls[1].body.rich_message.markdown, '**Полный ответ**');
  for (const call of t.calls) {
    assert.equal(call.method, 'sendRichMessage');
    assert.deepEqual(call.body.ephemeral_message_parameters, { receiver_user_id: USER_ID });
    assert.deepEqual(call.body.reply_parameters, { message_id: 71 });
  }
  assert.deepEqual(t.logs, []);
  assert.equal(t.publicCalls, 0);
});

test('all stages of rich media and plain fallback stay in the same private edit', async () => {
  const t = transport((call, n) => {
    if (n < 3) throw rejected('RICH_MESSAGE media failed');
    return edited();
  });
  const source = '![Фото](https://example.com/a.png)\nПолный ответ';
  const result = await t.send({ markdown: source }, {
    ephemeral: { receiverUserId: USER_ID, editId: 501 },
  });
  assert.equal(result.mode, 'fallback');
  assert.equal(result.ephemeralMessageId, 501);
  assert.equal(t.calls[2].body.text, source);
  for (const call of t.calls) {
    assert.equal(call.method, 'editEphemeralMessageText');
    assert.equal(call.body.receiver_user_id, USER_ID);
    assert.equal(call.body.ephemeral_message_id, 501);
    assert.equal(call.body.ephemeral_message_parameters, undefined);
  }
  assert.equal(t.publicCalls, 0);
});

test('a failed private fallback exposes only a sanitized error and never sends publicly', async () => {
  const t = transport(() => { throw rejected('Bad Request: private-content https://private.example/'); });
  await assert.rejects(t.send({ markdown: 'private-content' }), error => safeError(error, 'EPHEMERAL_REJECTED'));
  assert.deepEqual(t.calls.map(call => call.method), ['sendRichMessage', 'sendMessage']);
  assert.equal(t.publicCalls, 0);
  assert.deepEqual(t.logs, []);
});

test('a Telegram rejection in an HTTP success envelope still uses the private fallback', async () => {
  const t = transport((call, n) => n === 1 ? { data: { ok: false, error_code: 400, description: 'invalid formatting' } } : sent());
  const result = await t.send({ markdown: 'Полный ответ' });
  assert.equal(result.mode, 'fallback');
  assert.deepEqual(t.calls[1].body.ephemeral_message_parameters, { receiver_user_id: USER_ID });
});

test('timeout or server errors with uncertain delivery do not trigger retries or expose Axios details', async () => {
  for (const error of [
    Object.assign(new Error('private-content at https://api.telegram.org/botsecret-token/sendRichMessage'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('private-content'), { response: { status: 502, data: 'proxy failure secret-token' } }),
  ]) {
    const t = transport(() => { throw error; });
    await assert.rejects(t.send({ markdown: 'private-content' }), caught => safeError(caught, 'EPHEMERAL_UNCONFIRMED'));
    assert.equal(t.calls.length, 1);
    assert.equal(t.publicCalls, 0);
    assert.deepEqual(t.logs, []);
  }
});

test('missing or invalid initial ephemeral IDs stop immediately without fallback duplicates', async () => {
  for (const result of [undefined, true, { message_id: 42 }, { message_id: 0, ephemeral_message_id: 0 },
    { ephemeral_message_id: '501' }, { ephemeral_message_id: 501, receiver_user: { id: 999 } }]) {
    const t = transport(() => ({ data: { ok: true, result } }));
    await assert.rejects(t.send({ markdown: 'Ответ' }), error => safeError(error, 'EPHEMERAL_UNCONFIRMED'));
    assert.equal(t.calls.length, 1);
    assert.equal(t.publicCalls, 0);
  }
});

test('malformed success envelopes and edit acknowledgements never cause a second delivery', async () => {
  for (const data of [undefined, { result: true }, { ok: true, result: { ephemeral_message_id: 501 } }]) {
    const t = transport(() => ({ data }));
    await assert.rejects(t.send({ markdown: 'Ответ' }, { ephemeral: { receiverUserId: USER_ID, editId: 501 } }),
      error => safeError(error, 'EPHEMERAL_UNCONFIRMED'));
    assert.equal(t.calls.length, 1);
  }
});

test('caller parameters cannot override the recipient, including mutation while awaiting a rejection', async () => {
  const opts = {
    ephemeral: { receiverUserId: USER_ID, receiver_user_id: 999 },
    ephemeral_message_parameters: { receiver_user_id: 999 }, receiver_user_id: 999,
  };
  const t = transport((call, n) => {
    if (n === 1) { opts.ephemeral.receiverUserId = 999; throw rejected(); }
    return sent();
  });
  await t.send({ markdown: 'Ответ' }, opts);
  for (const call of t.calls) {
    assert.deepEqual(call.body.ephemeral_message_parameters, { receiver_user_id: USER_ID });
    assert.equal(call.body.receiver_user_id, undefined);
  }
});

test('long rich edits are sent whole; rejected long edits fail without truncating or sending new messages', async () => {
  const long = 'Ответ 😀 с важной деталью. '.repeat(400);
  const opts = { ephemeral: { receiverUserId: USER_ID, editId: 501 } };
  const good = transport(() => edited());
  await good.send({ markdown: long }, opts);
  assert.equal(good.calls[0].body.rich_message.markdown, long);
  const failed = transport(() => { throw rejected(); });
  await assert.rejects(failed.send({ markdown: long }, opts), error => safeError(error, 'EPHEMERAL_TEXT_TOO_LONG'));
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].body.rich_message.markdown, long);
  assert.equal(failed.publicCalls, 0);
});

test('plain fallback preserves all text up to its limit and rejects oversized initial content', async () => {
  const text = 'а'.repeat(4096);
  const t = transport((call, n) => { if (n === 1) throw rejected(); return sent(); });
  await t.send({ markdown: text });
  assert.equal(t.calls[1].body.text, text);
  const long = transport(() => { throw rejected(); });
  await assert.rejects(long.send({ markdown: `${text}б` }), error => safeError(error, 'EPHEMERAL_TEXT_TOO_LONG'));
  assert.equal(long.calls.length, 1);
  assert.equal(long.publicCalls, 0);
});

test('malformed private options fail before network or public delivery', async () => {
  for (const ephemeral of [undefined, null, false, [], {}, { receiverUserId: '123' },
    { receiverUserId: 0 }, { receiverUserId: -1 }, { receiverUserId: Number.MAX_SAFE_INTEGER + 1 },
    { receiverUserId: USER_ID, editId: 0 }, { receiverUserId: USER_ID, editId: '501' },
    { receiverUserId: USER_ID, replyToEphemeralId: null }]) {
    const t = transport(() => sent());
    await assert.rejects(t.send({ markdown: 'private-content' }, { ephemeral }),
      error => safeError(error, 'EPHEMERAL_INVALID_OPTIONS'));
    assert.equal(t.calls.length, 0);
    assert.equal(t.publicCalls, 0);
  }
});

test('malformed private content or an invalid ordinary reply ID fails closed', async () => {
  for (const [content, opts] of [
    [null, PRIVATE], [{ markdown: 123 }, PRIVATE], [{ markdown: 'a', html: '<p>a</p>' }, PRIVATE],
    [{ markdown: 'a', fallback: {} }, PRIVATE], [{ markdown: 'a' }, { ...PRIVATE, replyTo: '12' }],
  ]) {
    const t = transport(() => sent());
    await assert.rejects(t.send(content, opts), error => safeError(error, 'EPHEMERAL_INVALID_OPTIONS'));
    assert.equal(t.calls.length, 0);
    assert.equal(t.publicCalls, 0);
  }
});

test('unexpected private-path errors cannot bypass sanitization by using an ephemeral error code', async () => {
  const t = transport(() => sent());
  const content = { get markdown() {
    throw Object.assign(new Error('private-content https://api.telegram.org/botsecret-token'), {
      code: 'EPHEMERAL_UNCONFIRMED', config: { token: 'secret-token' },
    });
  } };
  await assert.rejects(t.send(content), error => safeError(error, 'EPHEMERAL_UNCONFIRMED'));
  assert.equal(t.calls.length, 0);
  assert.equal(t.publicCalls, 0);
});
