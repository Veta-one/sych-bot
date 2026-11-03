const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createPrivateBudget, PRIVATE_BUDGET_UNAVAILABLE } = require('../src/services/private-budget');

const messages = [{ role: 'user', content: 'question' }];

function fixture(t, fetchImpl, usedMicros = 0, limitUsd = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'sych-private-budget-'));
  const file = join(dir, 'budget.json');
  t.after(() => {
    try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(dir);
  });
  if (usedMicros !== null) writeFileSync(file, JSON.stringify({ version: 1, usedMicros, halted: false }));
  const reopen = () => createPrivateBudget({ file, limitUsd, fetchImpl });
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const budget = reopen();
  return { budget, read, file, reopen };
}

function response(usage, extra = {}) {
  return { ok: true, json: async () => ({ usage, choices: [{ message: { content: 'answer' } }], ...extra }) };
}

test('reserves before the only provider call, keeps search bounded and settles confirmed spend', async t => {
  let calls = 0;
  const { budget, read, reopen } = fixture(t, async (url, options) => {
    calls++;
    assert.equal(read().usedMicros, 50000);
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const req = JSON.parse(options.body);
    assert.equal(req.model, 'google/gemma-3-27b-it');
    assert.equal(req.max_tokens, 2048);
    assert.deepEqual(req.provider.only, ['deepinfra/fp8']);
    assert.equal(req.provider.allow_fallbacks, false);
    assert.deepEqual(req.plugins[0], { id: 'web', engine: 'exa', mode: 'auto', max_results: 3 });
    return response({ is_byok: false, cost: 0.001 });
  });
  assert.equal(await budget.complete({ apiKey: 'fake', messages, search: true }), 'answer');
  assert.equal(calls, 1);
  assert.equal(read().usedMicros, 8000);
  assert.equal(reopen().canPurchase(200), false);
  assert.equal(reopen().canPurchase(199), true);
});

test('missing or corrupt budgets fail closed, including after restart', async t => {
  const { budget, file, reopen } = fixture(t, async () => assert.fail('unexpected network'), null);
  assert.equal(budget.canPurchase(), false);
  await assert.rejects(budget.complete({ apiKey: 'fake', messages }), { code: PRIVATE_BUDGET_UNAVAILABLE });
  writeFileSync(file, '{}');
  assert.equal(reopen().canPurchase(), false);
});

test('holds ambiguous spend and blocks requests that would consume purchased capacity', async t => {
  let calls = 0;
  const { budget, read, reopen } = fixture(t, async () => {
    calls++;
    if (calls === 1) throw new Error('timeout');
    return response({ cost: 0.001 });
  }, 9_850_000);
  await assert.rejects(budget.complete({ apiKey: 'fake', messages, floorReplies: () => 3 }), {
    code: PRIVATE_BUDGET_UNAVAILABLE,
  });
  await assert.rejects(budget.complete({ apiKey: 'fake', messages, floorReplies: () => 2 }), /timeout/);
  assert.equal(read().usedMicros, 9_900_000);
  await reopen().complete({ apiKey: 'fake', messages, floorReplies: () => 1 });
  assert.equal(read().usedMicros, 9_950_000);
  assert.equal(calls, 2);
  assert.equal(reopen().canPurchase(2), false);
});

test('concurrent requests cannot reserve beyond the durable limit', async t => {
  let finish;
  const { budget, read } = fixture(t, () => new Promise(resolve => { finish = resolve; }), 9_950_000);
  const first = budget.complete({ apiKey: 'fake', messages });
  await assert.rejects(budget.complete({ apiKey: 'fake', messages }), { code: PRIVATE_BUDGET_UNAVAILABLE });
  finish(response({ is_byok: false, cost: 0.002 }));
  await first;
  assert.equal(read().usedMicros, 9_952_000);
});

test('BYOK or unexpectedly high confirmed charge permanently pauses the pilot', async t => {
  for (const usage of [{ is_byok: true, cost: 0 }, { is_byok: false, cost: 0.051 }]) {
    const { budget, read, reopen } = fixture(t, async () => response(usage));
    await assert.rejects(budget.complete({ apiKey: 'fake', messages }), { code: PRIVATE_BUDGET_UNAVAILABLE });
    assert.equal(read().halted, true);
    assert.equal(reopen().canPurchase(1), false);
  }
});


test('a charge plus the separate search fee cannot be silently clamped', async t => {
  const { budget, read } = fixture(t, async () => response(
    { cost: 0.048 }, { openrouter_metadata: { is_byok: false } }
  ));
  await assert.rejects(budget.complete({ apiKey: 'fake', messages, search: true }), {
    code: PRIVATE_BUDGET_UNAVAILABLE,
  });
  assert.deepEqual(read(), { version: 1, usedMicros: 50000, halted: true });
});
