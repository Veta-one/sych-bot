const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OperationTimeoutError,
  withTimeout,
} = require('../src/utils/async');

test('withTimeout returns a result completed before the deadline', async () => {
  assert.equal(await withTimeout(Promise.resolve('готово'), 100, 'Тест'), 'готово');
});

test('withTimeout rejects stalled external operations', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, 'Tavily Extract'),
    error => error instanceof OperationTimeoutError
      && error.code === 'ETIMEDOUT'
      && /Tavily Extract/.test(error.message),
  );
});
