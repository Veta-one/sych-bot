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
      } } : name === '../config' ? { telegramToken: 'test' } : { selectVoiceSummary() {} },
    });
    const result = await box.exports.sendRich({ sendMessage: async () => ({ message_id: 456 }) }, 1,
      { markdown: mode === 'rich-noimg' ? '![image](https://example.com/a.png) Когда?' : 'Когда?' });
    assert.equal(result.mode, mode);
    assert.equal(result.messageId, mode === 'fallback' ? 456 : 123);
  }
});
