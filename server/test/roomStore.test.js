'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRoomStore } = require('../src/roomStore');

test('a missing room reads as null', () => {
  assert.equal(createMemoryRoomStore().getRoom('main'), null);
});

test('a saved room can be read back by id', () => {
  const store = createMemoryRoomStore();
  const room = { id: 'main', phase: 'waiting' };
  store.saveRoom(room);
  assert.equal(store.getRoom('main'), room);
});

test('a deleted room reads as null', () => {
  const store = createMemoryRoomStore();
  store.saveRoom({ id: 'main' });
  store.deleteRoom('main');
  assert.equal(store.getRoom('main'), null);
});

test('clear removes every room', () => {
  const store = createMemoryRoomStore();
  store.saveRoom({ id: 'a' });
  store.saveRoom({ id: 'b' });
  store.clear();
  assert.equal(store.getRoom('a'), null);
  assert.equal(store.getRoom('b'), null);
});

test('two stores do not share rooms', () => {
  const one = createMemoryRoomStore();
  const two = createMemoryRoomStore();
  one.saveRoom({ id: 'main' });
  assert.equal(two.getRoom('main'), null);
});
