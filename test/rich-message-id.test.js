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
