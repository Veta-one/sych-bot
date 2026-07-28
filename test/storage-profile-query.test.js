const test = require('node:test');
const assert = require('node:assert/strict');

const storage = require('../src/services/storage');

test('findProfileByQuery resolves username, real name and exact TGID within one chat', () => {
  const originalData = storage.data;
  const originalProfiles = storage.profiles;

  try {
    storage.data = {
      chats: {
        '-1001': {
          mutedTopics: [],
          users: {
            '304648510': '@VetaOne',
            '777000': '@KnownWithoutProfile',
          },
        },
        '-1002': {
          mutedTopics: [],
          users: {
            '999999': '@OtherChatUser',
          },
        },
      },
    };
    storage.profiles = {
      '-1001': {
        '304648510': {
          realName: 'Виталий',
          facts: 'Тестовый профиль',
          attitude: 'Хорошее',
          relationship: 82,
        },
        '888888': {
          realName: 'Профиль без username',
          facts: 'Бот видел пользователя раньше',
          attitude: 'Нейтральное',
          relationship: 50,
        },
      },
      '-1002': {
        '999999': {
          realName: 'Чужой чат',
          facts: 'Не должен находиться из другого чата',
          attitude: 'Нейтральное',
          relationship: 50,
        },
      },
    };

    const byId = storage.findProfileByQuery('-1001', '304648510');
    assert.equal(byId.userId, '304648510');
    assert.equal(byId.username, '@VetaOne');
    assert.equal(byId.realName, 'Виталий');

    const byUsername = storage.findProfileByQuery('-1001', '@vetaone');
    assert.equal(byUsername.userId, '304648510');

    const byRealName = storage.findProfileByQuery('-1001', 'виталий');
    assert.equal(byRealName.userId, '304648510');

    const knownWithoutProfile = storage.findProfileByQuery('-1001', '777000');
    assert.equal(knownWithoutProfile.userId, '777000');
    assert.equal(knownWithoutProfile.relationship, 50);

    const profileWithoutUsername = storage.findProfileByQuery('-1001', '888888');
    assert.equal(profileWithoutUsername.userId, '888888');
    assert.equal(profileWithoutUsername.username, null);

    assert.equal(storage.findProfileByQuery('-1001', '30464851'), null);
    assert.equal(storage.findProfileByQuery('-1001', '999999'), null);
    assert.equal(storage.findProfileByQuery('-1001', '123456789'), null);
  } finally {
    storage.data = originalData;
    storage.profiles = originalProfiles;
  }
});
