const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isExplicitTelegramIdentity,
  shouldHandleProfileQuery,
} = require('../src/utils/profile-query');

test('explicit Telegram identities keep the profile command behavior', () => {
  assert.equal(isExplicitTelegramIdentity('@VetaOne'), true);
  assert.equal(isExplicitTelegramIdentity('304648510'), true);
  assert.equal(shouldHandleProfileQuery('@unknown_user', null), true);
  assert.equal(shouldHandleProfileQuery('304648510', null), true);
});

test('ordinary “расскажи про” topics continue to the AI', () => {
  assert.equal(shouldHandleProfileQuery('влияние сахара на кофе', null), false);
  assert.equal(
    shouldHandleProfileQuery(
      'это видео о чём оно?\nhttps://www.youtube.com/watch?v=FV_Sq3NxxPQ&t=3185s',
      null,
    ),
    false,
  );
  assert.equal(shouldHandleProfileQuery('2026 год', null), false);
});

test('a real participant found in this chat is still handled as a profile', () => {
  assert.equal(shouldHandleProfileQuery('Виталий', { userId: '304648510' }), true);
});
