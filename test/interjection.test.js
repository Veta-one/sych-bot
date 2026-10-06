const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIN_MESSAGE_CHARS,
  normalizeChance,
  shouldInterject,
  trimInterjection,
} = require('../src/utils/interjection');

const MINUTE = 60 * 1000;

test('шанс вмешательства ограничен диапазоном 0..1', () => {
  assert.equal(normalizeChance(0.05), 0.05);
  assert.equal(normalizeChance('0.5'), 0.5);
  assert.equal(normalizeChance(7), 1);
  assert.equal(normalizeChance(-3), 0);
  assert.equal(normalizeChance('нет', 0.05), 0.05);
  assert.equal(normalizeChance(undefined, 0.05), 0.05);
});

test('нулевой шанс не даёт вмешательства', () => {
  assert.equal(shouldInterject({ chance: 0, cooldownMs: MINUTE, random: () => 0 }), false);
  assert.equal(shouldInterject({ chance: -1, cooldownMs: MINUTE, random: () => 0 }), false);
});

test('вмешательство срабатывает, когда случайное число ниже шанса', () => {
  assert.equal(shouldInterject({ chance: 0.2, cooldownMs: 0, random: () => 0.19 }), true);
  assert.equal(shouldInterject({ chance: 0.2, cooldownMs: 0, random: () => 0.2 }), false);
  assert.equal(shouldInterject({ chance: 1, cooldownMs: 0, random: () => 0.999 }), true);
});

test('кулдаун блокирует повторное вмешательство в тот же чат', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const options = { chance: 1, cooldownMs: 15 * MINUTE, now, random: () => 0 };

  assert.equal(shouldInterject({ ...options, lastAt: now - 5 * MINUTE }), false, 'недавно вмешивался — молчим');
  assert.equal(shouldInterject({ ...options, lastAt: now - 15 * MINUTE }), true, 'кулдаун истёк — можно');
  assert.equal(shouldInterject({ ...options, lastAt: 0 }), true, 'первый раз в чате — можно');
});

test('без кулдауна решение зависит только от шанса', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(shouldInterject({ chance: 1, cooldownMs: 0, lastAt: now, now, random: () => 0.5 }), true);
});

test('короткая реплика остаётся как есть', () => {
  assert.equal(trimInterjection('Ну и бред.'), 'Ну и бред.');
  assert.equal(trimInterjection('  много   пробелов\nи перенос  '), 'много пробелов и перенос');
  assert.equal(trimInterjection(''), '');
  assert.equal(trimInterjection(null), '');
  assert.equal(trimInterjection(undefined), '');
});

test('длинная реплика режется по границе предложения', () => {
  const long = `${'а'.repeat(120)}. ${'б'.repeat(400)}`;
  const result = trimInterjection(long, 200);
  assert.ok(result.length <= 200, `длина ${result.length}`);
  assert.ok(result.endsWith('.'), `обрезано не по предложению: ${result.slice(-20)}`);
});

test('если границы предложения рядом нет — ставим многоточие', () => {
  const result = trimInterjection('в'.repeat(500), 100);
  assert.equal(result.length, 101);
  assert.ok(result.endsWith('…'));
});

test('порог длины сообщения осмысленный', () => {
  assert.ok(MIN_MESSAGE_CHARS >= 5 && MIN_MESSAGE_CHARS <= 20);
});
