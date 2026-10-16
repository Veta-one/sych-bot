const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('clarifications can be replied to after rich, image-retry and legacy delivery', async () => {
  for (const mode of ['rich', 'rich-noimg', 'fallback']) {
    let calls = 0;
    const box = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/rich.js'), 'utf8'), {
      module: box,
      console: { error() {} },
      require: name => name === 'axios' ? { post: async () => {
        calls++;
        if (mode === 'fallback' || (mode === 'rich-noimg' && calls === 1)) throw new Error('RICH_MESSAGE media failed');
        return { data: { result: { message_id: 123 } } };
      } } : name === '../config' ? { telegramToken: 'test' } : name === './quotes' ? require('../src/utils/quotes') : { selectVoiceSummary() {} },
    });
    const result = await box.exports.sendRich({ sendMessage: async () => ({ message_id: 456 }) }, 1,
      { markdown: mode === 'rich-noimg' ? '![image](https://example.com/a.png) Когда?' : 'Когда?' });
    assert.equal(result.mode, mode);
    assert.equal(result.messageId, mode === 'fallback' ? 456 : 123);
  }
});

test('failed rich voice delivery keeps one expandable transcript and reply context', async () => {
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/rich.js'), 'utf8'), {
    module: box, console: { error() {} },
    require: name => name === 'axios' ? { post: async () => { throw new Error('unavailable'); } }
      : name === '../config' ? {} : name === './voice' ? require('../src/utils/voice') : require('../src/utils/quotes'),
  });
  const sent = [];
  const card = box.exports.formatVoiceMessage({ text: 'Полная расшифровка. '.repeat(250) }, 'Тест', 179);
  const result = await box.exports.sendRich({ sendMessage: async (...args) => {
    sent.push(args); return { message_id: 456 };
  } }, 1, card, { replyTo: 23, threadId: 7, businessId: 'business' });
  assert.equal(result.mode, 'fallback');
  assert.ok(sent.length > 1);
  for (const [, text, options] of sent) {
    assert.equal(options.reply_parameters.message_id, 23);
    assert.equal(options.message_thread_id, 7);
    assert.equal(options.business_connection_id, 'business');
    assert.equal(options.entities.length, 1);
    assert.equal(options.entities[0].type, 'expandable_blockquote');
    assert.ok(text.length <= 4000);
  }
});

function strictTransport(richReply, plainReply = () => ({ status: 200, data: { ok: true, result: { message_id: 456 } } })) {
  const box = { exports: {} };
  const richCalls = [];
  const plainCalls = [];
  const sdkCalls = [];
  const logs = [];
  let deliveryOptions;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/rich.js'), 'utf8'), {
    module: box, console: { error: (...args) => logs.push(args) },
    require: name => name === 'axios' ? { post: async (url, body, options) => {
      if (url.endsWith('/sendMessage')) {
        const { chat_id: chatId, text, ...telegramOptions } = JSON.parse(JSON.stringify(body));
        plainCalls.push({ url, chatId, text, options: telegramOptions, requestOptions: options });
        return plainReply(plainCalls.length);
      }
      richCalls.push({ url, body: JSON.parse(JSON.stringify(body)), options });
      return richReply(richCalls.length);
    } } : name === '../config' ? { telegramToken: 'secret-token' }
      : name === './voice' ? require('../src/utils/voice') : require('../src/utils/quotes'),
  });
  const bot = { sendMessage: async (...args) => {
    sdkCalls.push(args);
    throw new Error('Strict delivery must not use an SDK request without its own deadline');
  } };
  return { richCalls, plainCalls, sdkCalls, logs, get deliveryOptions() { return deliveryOptions; },
    send: (content = { html: '<p>ТЛДР: содержание.</p>' }, opts = {}) => {
      deliveryOptions = { replyTo: 23, strictDelivery: true, ...opts };
      return box.exports.sendRich(bot, -1234, content, deliveryOptions);
    } };
}

function strictRejected(status = 400, description = 'Bad Request: rich formatting failed') {
  return Object.assign(new Error('secret-token private-content'), {
    response: { status, data: { ok: false, error_code: status, description } },
    config: { url: 'https://api.telegram.org/botsecret-token', data: 'private-content' },
  });
}

function strictSafeError(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(error.response, undefined);
  assert.equal(error.config, undefined);
  assert.doesNotMatch(String(error.stack), /secret-token|private-content/);
  return true;
}

test('strict ordinary reply confirms Rich delivery and preserves reply scope with a deadline', async () => {
  const t = strictTransport(() => ({ status: 200, data: { ok: true, result: { message_id: 123 } } }));
  const result = await t.send(undefined, { threadId: 7, businessId: 'business', silent: true });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'rich');
  assert.equal(result.messageId, 123);
  assert.equal(t.richCalls.length, 1);
  assert.equal(t.plainCalls.length, 0);
  const { body, options } = t.richCalls[0];
  assert.deepEqual(body.reply_parameters, { message_id: 23, allow_sending_without_reply: false });
  assert.equal(body.message_thread_id, 7);
  assert.equal(body.business_connection_id, 'business');
  assert.equal(body.disable_notification, true);
  assert.equal(options.timeout, 10000);
  assert.equal(options.proxy, false);
});

test('strict network ambiguity, server failures and malformed successes never retry or fall back', async () => {
  for (const reply of [
    () => { throw Object.assign(new Error('secret-token private-content'), { code: 'ECONNABORTED' }); },
    () => { throw new Error('secret-token private-content socket reset'); },
    () => { throw strictRejected(500, 'Bad Request: RICH_MESSAGE_INVALID'); },
    () => ({ status: 503, data: { ok: false, error_code: 400, description: 'RICH_MESSAGE_INVALID' } }),
    () => ({ status: 503, data: { ok: true, result: { message_id: 12 } } }),
    () => ({ data: { result: { message_id: 123 } } }),
    () => ({ data: { ok: true, result: {} } }),
    () => ({ data: { ok: true, result: { message_id: 0 } } }),
    () => ({ data: { ok: true, result: { message_id: '123' } } }),
    () => ({ data: { ok: true, result: { message_id: -1 } } }),
    () => ({ data: { ok: true, result: { message_id: Number.MAX_SAFE_INTEGER + 1 } } }),
  ]) {
    const t = strictTransport(reply);
    await assert.rejects(t.send(), error => strictSafeError(error, 'STRICT_DELIVERY_UNCONFIRMED'));
    assert.equal(t.richCalls.length, 1);
    assert.equal(t.plainCalls.length, 0);
    assert.deepEqual(t.logs, []);
  }
});

test('strict confirmed Rich rejections fall back once to one plain reply in exactly the same scope', async () => {
  for (const [status, description] of [[400, "Bad Request: can't parse HTML"],
    [400, 'Bad Request: RICH_MESSAGE_INVALID'], [404, 'Not Found']]) {
    const t = strictTransport(() => { throw strictRejected(status, description); });
    const result = await t.send({ html: '<p>ТЛДР: &lt;факт&gt; &amp; вывод.</p>' }, {
      threadId: 7, businessId: 'business', silent: true, replyMarkup: { inline_keyboard: [] },
    });
    assert.equal(result.mode, 'fallback');
    assert.equal(result.ok, true);
    assert.equal(result.messageId, 456);
    assert.equal(t.richCalls.length, 1);
    assert.equal(t.plainCalls.length, 1);
    assert.equal(t.sdkCalls.length, 0);
    const { url, chatId, text, options, requestOptions } = t.plainCalls[0];
    assert.ok(url.endsWith('/sendMessage'));
    assert.equal(chatId, -1234);
    assert.equal(requestOptions.timeout, 10000);
    assert.equal(requestOptions.proxy, false);
    assert.equal(text, 'ТЛДР: <факт> & вывод.');
    assert.deepEqual(options.reply_parameters, { message_id: 23, allow_sending_without_reply: false });
    assert.equal(options.message_thread_id, 7);
    assert.equal(options.business_connection_id, 'business');
    assert.equal(options.disable_notification, true);
    assert.deepEqual(options.reply_markup, { inline_keyboard: [] });
    assert.deepEqual(options.link_preview_options, { is_disabled: true });
    assert.equal(options.parse_mode, undefined);
    assert.deepEqual(t.logs, []);
  }
});

test('strict explicit API rejection returned without an HTTP exception can safely fall back', async () => {
  const t = strictTransport(() => ({ status: 200,
    data: { ok: false, error_code: 400, description: 'Bad Request: RICH_MESSAGE_INVALID' } }));
  assert.equal((await t.send()).messageId, 456);
  assert.equal(t.plainCalls.length, 1);
});

test('strict fallback snapshots its reply scope before awaiting the Rich result', async () => {
  const opts = { replyTo: 23, threadId: 7, businessId: 'business', silent: true };
  const t = strictTransport(() => {
    Object.assign(t.deliveryOptions, { replyTo: 99, threadId: 8, businessId: 'changed', silent: false });
    throw strictRejected();
  });
  await t.send(undefined, opts);
  const options = t.plainCalls[0].options;
  assert.deepEqual(options.reply_parameters, { message_id: 23, allow_sending_without_reply: false });
  assert.equal(options.message_thread_id, 7);
  assert.equal(options.business_connection_id, 'business');
  assert.equal(options.disable_notification, true);
});

test('strict cancellation prevents the first HTTP attempt and sanitizes callback failures', async () => {
  for (const shouldSend of [() => false, () => { throw new Error('secret-token private-content'); }]) {
    const t = strictTransport(() => ({ data: { ok: true, result: { message_id: 123 } } }));
    await assert.rejects(t.send(undefined, { shouldSend }),
      error => strictSafeError(error, 'STRICT_DELIVERY_CANCELLED'));
    assert.equal(t.richCalls.length, 0);
    assert.equal(t.plainCalls.length, 0);
    assert.equal(t.sdkCalls.length, 0);
    assert.deepEqual(t.logs, []);
  }
});

test('strict invalid cancellation callbacks fail before an HTTP attempt', async () => {
  for (const shouldSend of [false, true, null, 123, 'yes', {}]) {
    const t = strictTransport(() => ({ data: { ok: true, result: { message_id: 123 } } }));
    await assert.rejects(t.send(undefined, { shouldSend }),
      error => strictSafeError(error, 'STRICT_DELIVERY_INVALID_OPTIONS'));
    assert.equal(t.richCalls.length, 0);
    assert.equal(t.plainCalls.length, 0);
  }
});

test('strict delayed Rich rejection checks cancellation again before a fallback', async () => {
  for (const afterAwait of ['false', 'throw']) {
    let active = true;
    let release;
    let checks = 0;
    const t = strictTransport(() => new Promise((resolve, reject) => { release = () => reject(strictRejected()); }));
    const delivery = t.send(undefined, { shouldSend: () => {
      checks++;
      if (!active && afterAwait === 'throw') throw new Error('secret-token private-content');
      return active;
    } });
    assert.equal(t.richCalls.length, 1);
    active = false;
    release();
    await assert.rejects(delivery, error => strictSafeError(error, 'STRICT_DELIVERY_CANCELLED'));
    assert.equal(checks, 2);
    assert.equal(t.richCalls.length, 1);
    assert.equal(t.plainCalls.length, 0);
    assert.equal(t.sdkCalls.length, 0);
    assert.deepEqual(t.logs, []);
  }
});

test('strict cancellation callback stays bound while awaiting and permits one bounded fallback when current', async () => {
  let checks = 0;
  const t = strictTransport(() => {
    t.deliveryOptions.shouldSend = () => false;
    throw strictRejected();
  });
  const result = await t.send(undefined, { shouldSend: () => { checks++; return true; } });
  assert.equal(result.messageId, 456);
  assert.equal(checks, 2);
  assert.equal(t.plainCalls.length, 1);
  assert.equal(t.plainCalls[0].requestOptions.timeout, 10000);
  assert.equal(t.sdkCalls.length, 0);
});

test('strict source loss and non-format failures never become standalone replies', async () => {
  for (const [status, description] of [[400, 'Bad Request: message to be replied not found'],
    [400, "Bad Request: can't parse reply_parameters"], [400, 'Bad Request: RICH_MESSAGE_INVALID reply target'],
    [400, 'Bad Request: message thread not found'], [403, 'Forbidden'],
    [429, 'Too Many Requests'], [400, 'Bad Request: unknown parameter']]) {
    const t = strictTransport(() => { throw strictRejected(status, description); });
    await assert.rejects(t.send(), error => strictSafeError(error, 'STRICT_DELIVERY_REJECTED'));
    assert.equal(t.richCalls.length, 1);
    assert.equal(t.plainCalls.length, 0);
  }
});

test('strict fallback ambiguity and source deletion do not cause a second send', async () => {
  for (const plainReply of [
    () => { throw new Error('private-content secret-token timeout'); },
    () => undefined,
    () => ({ data: { ok: true, result: { message_id: 0 } } }),
    () => ({ data: { result: { message_id: 123 } } }),
    () => ({ status: 503, data: { ok: true, result: { message_id: 123 } } }),
    () => { throw strictRejected(400, 'Bad Request: message to be replied not found'); },
    () => ({ data: { ok: false, error_code: 400, description: 'message to be replied not found' } }),
    () => { throw strictRejected(503, 'server error'); },
  ]) {
    const t = strictTransport(() => { throw strictRejected(); }, plainReply);
    await assert.rejects(t.send(), error => {
      assert.ok(['STRICT_DELIVERY_UNCONFIRMED', 'STRICT_DELIVERY_REJECTED'].includes(error.code));
      return strictSafeError(error, error.code);
    });
    assert.equal(t.richCalls.length, 1);
    assert.equal(t.plainCalls.length, 1);
    assert.equal(t.sdkCalls.length, 0);
    assert.equal(t.plainCalls[0].options.reply_parameters.allow_sending_without_reply, false);
    assert.deepEqual(t.logs, []);
  }
});

test('strict invalid reply targets and content fail closed before sending', async () => {
  for (const replyTo of [undefined, null, 0, -1, '23', Number.MAX_SAFE_INTEGER + 1]) {
    const t = strictTransport(() => ({ data: { ok: true, result: { message_id: 123 } } }));
    await assert.rejects(t.send(undefined, { replyTo }),
      error => strictSafeError(error, 'STRICT_DELIVERY_INVALID_OPTIONS'));
    assert.equal(t.richCalls.length, 0);
    assert.equal(t.plainCalls.length, 0);
  }
  for (const content of [null, {}, { html: 123 }, { html: 'a', markdown: 'b' }, { html: 'a', fallback: {} }]) {
    const t = strictTransport(() => ({ data: { ok: true, result: { message_id: 123 } } }));
    await assert.rejects(t.send(content), error => strictSafeError(error, 'STRICT_DELIVERY_INVALID_OPTIONS'));
    assert.equal(t.richCalls.length, 0);
    assert.equal(t.plainCalls.length, 0);
  }
});

test('strict rich rejection never splits or truncates an oversized fallback', async () => {
  const t = strictTransport(() => { throw strictRejected(); });
  await assert.rejects(t.send({ html: `<p>${'а'.repeat(4097)}</p>` }),
    error => strictSafeError(error, 'STRICT_DELIVERY_TEXT_TOO_LONG'));
  assert.equal(t.richCalls.length, 1);
  assert.equal(t.plainCalls.length, 0);
});

test('strict unexpected local errors cannot smuggle raw error details through a trusted code', async () => {
  const t = strictTransport(() => ({ data: {} }));
  const content = { get html() {
    throw Object.assign(new Error('secret-token private-content'), { code: 'STRICT_DELIVERY_REJECTED' });
  } };
  await assert.rejects(t.send(content), error => strictSafeError(error, 'STRICT_DELIVERY_UNCONFIRMED'));
  assert.equal(t.richCalls.length, 0);
  assert.deepEqual(t.logs, []);
});

test('ephemeral path takes priority over strict ordinary delivery and never sends a public reply', async () => {
  const t = strictTransport(() => ({ data: { ok: true, result: { ephemeral_message_id: 91 } } }));
  const result = await t.send({ html: '<p>Личный ответ.</p>' }, { replyTo: undefined,
    ephemeral: { receiverUserId: 123 } });
  assert.equal(result.ephemeralMessageId, 91);
  assert.equal(result.messageId, undefined);
  assert.equal(t.plainCalls.length, 0);
  assert.deepEqual(t.richCalls[0].body.ephemeral_message_parameters, { receiver_user_id: 123 });
});
