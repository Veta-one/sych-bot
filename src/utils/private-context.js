const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();

function runPrivateWork(work) {
  return context.run(true, work);
}

function isPrivateWork() {
  return context.getStore() === true;
}

module.exports = { runPrivateWork, isPrivateWork };
