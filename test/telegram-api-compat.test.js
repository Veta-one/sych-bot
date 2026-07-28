const test = require('node:test');
const assert = require('node:assert/strict');

const { TelegramBot } = require('node-telegram-bot-api');

test('node-telegram-bot-api exposes the v1 methods used by Sych', () => {
  const bot = new TelegramBot('123456:test-token', { polling: false });
  const requiredMethods = [
    'getBusinessConnection',
    'getChatMember',
    'getFileLink',
    'getMe',
    'leaveChat',
    'on',
    'processUpdate',
    'sendChatAction',
    'sendMessage',
    'setMessageReaction',
  ];

  for (const method of requiredMethods) {
    assert.equal(typeof bot[method], 'function', `${method} must remain available`);
  }

  const businessMessage = {
    message_id: 7,
    date: 1,
    business_connection_id: 'business-1',
    chat: { id: 1001, type: 'private' },
    from: { id: 2002, is_bot: false, first_name: 'Test' },
    text: 'Сыч, привет',
  };
  let receivedBusinessMessage;
  bot.once('business_message', (message) => {
    receivedBusinessMessage = message;
  });
  bot.processUpdate({ update_id: 1, business_message: businessMessage });
  assert.equal(receivedBusinessMessage, businessMessage);
});

test('node-telegram-bot-api keeps positional calls and modern reply options compatible', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const method = new URL(url).pathname.split('/').pop();
    const form = new URLSearchParams(init.body ? String(init.body) : '');
    const body = Object.fromEntries(
      [...form.entries()].map(([key, value]) => {
        if (/^[{[]/.test(value)) {
          return [key, JSON.parse(value)];
        }
        return [key, value];
      })
    );
    calls.push({ method, body });

    const result = method === 'getFile'
      ? { file_id: body.file_id, file_path: 'photos/test.jpg' }
      : { ok: true };

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const bot = new TelegramBot('123456:test-token', {
    polling: false,
    request: { fetch: fakeFetch },
  });

  await bot.sendMessage(1001, 'Привет', {
    reply_parameters: {
      message_id: 42,
      allow_sending_without_reply: true,
    },
    link_preview_options: { is_disabled: true },
  });
  await bot.getBusinessConnection('business-1');
  await bot.sendChatAction(1001, 'typing');
  await bot.setMessageReaction(1001, 42, {
    reaction: [{ type: 'emoji', emoji: '👍' }],
  });
  const fileLink = await bot.getFileLink('file-1');

  const sendMessageCall = calls.find((call) => call.method === 'sendMessage');
  assert.deepEqual(sendMessageCall.body.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(sendMessageCall.body.link_preview_options, { is_disabled: true });

  const businessCall = calls.find((call) => call.method === 'getBusinessConnection');
  assert.equal(businessCall.body.business_connection_id, 'business-1');

  assert.equal(
    fileLink,
    'https://api.telegram.org/file/bot123456:test-token/photos/test.jpg'
  );
});
