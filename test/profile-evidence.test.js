const assert = require('node:assert/strict');
const test = require('node:test');
const evidence = require('../src/utils/profile-evidence');

const messages = [
  { userId: 1, messageId: 11, name: 'А', text: 'Я люблю шахматы. Маша живёт в Казани.', date: 1791700000 },
  { userId: 2, messageId: 12, name: 'Б', text: 'Я живу в Казани.' },
  { userId: 1, messageId: 13, name: 'А', text: 'Меня зовут Пётр.', isForwarded: true },
];

test('batch accepts only exact quotations owned by the target and strips invented fields', () => {
  const result = evidence.validateProfileUpdates({
    1: { facts: 'Живёт в Риме.', realName: 'Цезарь', location: 'Рим', relationship: 52, evidence: [
      { messageId: 11, quote: 'Я люблю шахматы.', date: 'invented' },
      { messageId: 11, quote: 'Я люблю покер.' },
      { messageId: 12, quote: 'Я живу в Казани.' },
      { messageId: 13, quote: 'Меня зовут Пётр.' },
      { messageId: 999, quote: 'Пустота' },
    ] },
    999: { relationship: 10, evidence: [{ messageId: 11, quote: 'Я люблю шахматы.' }] },
  }, messages, { 1: { relationship: 50 } });
  assert.deepEqual(result, { 1: { relationship: 52, factEvidence: [
    { userId: '1', messageId: '11', quote: 'Я люблю шахматы.', date: 1791700000 },
  ] } });
});

test('ambiguous message IDs, malformed updates and oversized evidence fail closed', () => {
  for (const input of [null, [], 'bad']) assert.deepEqual(evidence.validateProfileUpdates(input, messages, {}), {});
  const duplicateId = [...messages, { userId: 2, messageId: 11, text: 'Я люблю шахматы.' }];
  assert.deepEqual(evidence.validateProfileUpdates({ 1: { evidence: [{ messageId: 11, quote: 'Я люблю шахматы.' }] } }, duplicateId, {}), {});
  const long = 'x'.repeat(601);
  assert.deepEqual(evidence.validateProfileUpdates({ 1: { evidence: [{ messageId: 1, quote: long }] } }, [{ userId: 1, messageId: 1, text: long }], {}), {});
  assert.deepEqual(evidence.normalizeProfileMessages([{ userId: 1, messageId: 1, text: 'x'.repeat(8001) }]), []);
});

test('evidence merging is bounded, deduplicates identity and never changes quotations', () => {
  const first = { userId: '1', messageId: '1', quote: 'Я люблю шахматы.' };
  assert.deepEqual(evidence.mergeProfileEvidence([first], [first, { ...first, userId: '2' }], 1), [first]);
  const entries = Array.from({ length: 60 }, (_, index) => ({ userId: '1', messageId: String(index + 1), quote: `Моё сообщение ${index}` }));
  const bounded = evidence.mergeProfileEvidence([], entries);
  assert.equal(bounded.length, 40);
  assert.equal(bounded.at(-1).messageId, '60');
  assert.deepEqual(evidence.mergeProfileEvidence([], [{ ...first, quote: '' }, { ...first, quote: 'x'.repeat(601) }]), []);
});

test('profile context and deterministic fallback distinguish source words from old unverified memory', () => {
  const profile = { userId: 1, relationship: 0, facts: 'Живёт в Риме.', location: 'Рим', realName: 'Цезарь', factEvidence: [
    { userId: '1', messageId: '11', quote: 'Я люблю шахматы.' },
    { userId: '2', messageId: '12', quote: 'Я космонавт.' },
  ] };
  const context = evidence.profileContext(profile);
  assert.match(context, /НЕПРОВЕРЕННАЯ СТАРАЯ ПАМЯТЬ/);
  assert.match(context, /слова пользователя/);
  assert.match(context, /Живёт в Риме/);
  assert.doesNotMatch(context, /Я космонавт/);
  assert.equal(evidence.profileSourceData(profile).relationship, 0);
  const fallback = evidence.conservativeProfileDescription(profile, 'Тест');
  assert.match(fallback, /0\/100/);
  assert.match(fallback, /Я люблю шахматы/);
  assert.match(fallback, /без исходных сообщений/);
  assert.doesNotMatch(fallback, /Живёт в Риме|Цезарь|Я космонавт/);
});
