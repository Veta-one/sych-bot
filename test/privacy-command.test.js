const assert = require('node:assert/strict');
const test = require('node:test');

const { isForgetMeRequest } = require('../src/utils/privacy');

const trigger = /(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i;

test('forget-me matcher accepts explicit deletion phrases', () => {
  assert.equal(isForgetMeRequest('Сыч, забудь меня', trigger), true);
  assert.equal(isForgetMeRequest('sych удали все мои данные пожалуйста', trigger), true);
  assert.equal(isForgetMeRequest('Сыч! Очисти всё обо мне', trigger), true);
});

test('forget-me matcher rejects ordinary conversation about forgetting', () => {
  assert.equal(isForgetMeRequest('Забудь меня', trigger), false);
  assert.equal(isForgetMeRequest('Сыч, не забудь меня завтра разбудить', trigger), false);
  assert.equal(isForgetMeRequest('Сыч, как забыть бывшую?', trigger), false);
});
