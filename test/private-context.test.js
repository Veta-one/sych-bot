const assert = require('node:assert/strict');
const test = require('node:test');
const { runPrivateWork, isPrivateWork } = require('../src/utils/private-context');

test('private AI context crosses awaits and nested calls but cannot affect concurrent public work', async () => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  assert.equal(isPrivateWork(), false);
  const privateTask = runPrivateWork(async () => {
    assert.equal(isPrivateWork(), true);
    await paused;
    assert.equal(isPrivateWork(), true);
    await runPrivateWork(async () => {
      await Promise.resolve();
      assert.equal(isPrivateWork(), true);
    });
    assert.equal(isPrivateWork(), true);
  });
  await Promise.resolve();
  assert.equal(isPrivateWork(), false);
  release();
  await privateTask;
  assert.equal(isPrivateWork(), false);
});

test('a failed private operation restores the callers public context', async () => {
  await assert.rejects(runPrivateWork(async () => {
    await Promise.resolve();
    assert.equal(isPrivateWork(), true);
    throw new Error('synthetic-private-failure');
  }), /synthetic-private-failure/);
  assert.equal(isPrivateWork(), false);
});
