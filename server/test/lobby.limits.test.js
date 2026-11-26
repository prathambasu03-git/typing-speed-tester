'use strict';

/* Socket integration (M2): per-IP create and join-failure limits, the room
   store cap, code collisions, the create/join error orders from
   docs/PROTOCOL.md section 4, and the "second tab" case with default limits. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep, eventually, FIXED_PASSAGE } = require('./helpers');
const { createMemoryRoomStore } = require('../src/roomStore');

function viaProxy(forwardedFor) {
  return { extraHeaders: { 'x-forwarded-for': forwardedFor } };
}

/** Connects, sends one join, waits for the kick; returns the error code. */
async function failedJoin(ctx, code, extra) {
  const c = await ctx.client(extra);
  const ack = await c.join(code);
  assert.equal(ack.ok, false, `join ${code} unexpectedly succeeded`);
  await c.disconnected;
  return ack.error.code;
}

/** Connects and sends one create; returns { client, ack }. */
async function tryCreate(ctx, extra) {
  const client = await ctx.client(extra);
  return { client, ack: await client.create() };
}

/* ---------- Join-failure limit ---------- */

test('after two failed joins the third gets RATE_LIMITED even with a valid existing code', async (t) => {
  const ctx = await setup(t, { joinFailLimit: { capacity: 2, refillPerSec: 0 } });
  await ctx.created();
  const missing = ctx.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  assert.equal(await failedJoin(ctx, missing), 'ROOM_NOT_FOUND');
  assert.equal(await failedJoin(ctx, missing), 'ROOM_NOT_FOUND');
  assert.equal(await failedJoin(ctx, ctx.code), 'RATE_LIMITED');
});

test('a BAD_CODE costs a join-failure token like ROOM_NOT_FOUND', async (t) => {
  const ctx = await setup(t, { joinFailLimit: { capacity: 2, refillPerSec: 0 } });
  assert.equal(await failedJoin(ctx, 'k7qm2x'), 'BAD_CODE');
  assert.equal(await failedJoin(ctx, 'K7Q-M2'), 'BAD_CODE');
  assert.equal(await failedJoin(ctx, 'AAAAAA'), 'RATE_LIMITED');
});

test('RATE_LIMITED is checked before BAD_CODE', async (t) => {
  const ctx = await setup(t, { joinFailLimit: { capacity: 1, refillPerSec: 0 } });
  assert.equal(await failedJoin(ctx, 'AAAAAA'), 'ROOM_NOT_FOUND');
  assert.equal(await failedJoin(ctx, 'k7qm2x'), 'RATE_LIMITED');
});

test('a successful join costs no join-failure token', async (t) => {
  const ctx = await setup(t, { joinFailLimit: { capacity: 1, refillPerSec: 0 } });
  await ctx.lobby(3);
  const missing = ctx.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  assert.equal(await failedJoin(ctx, missing), 'ROOM_NOT_FOUND');
});

test('ROOM_FULL, RACE_IN_PROGRESS and BAD_PAYLOAD cost no join-failure token', async (t) => {
  const ctx = await setup(t, { maxPlayers: 3, joinFailLimit: { capacity: 1, refillPerSec: 0 } });
  await ctx.lobby(3);
  assert.equal(await failedJoin(ctx, ctx.code), 'ROOM_FULL');
  assert.equal(await failedJoin(ctx, ctx.code), 'ROOM_FULL');
  const bad = await ctx.client();
  assert.equal((await bad.emitAck('room:join', { code: 5 })).error.code, 'BAD_PAYLOAD');
  await bad.disconnected;
  // A second room with a free seat, counting down.
  const host = await ctx.created();
  await ctx.joinedTo(host.code);
  await ctx.start(host);
  assert.equal(await failedJoin(ctx, host.code), 'RACE_IN_PROGRESS');
  assert.equal(await failedJoin(ctx, host.code), 'RACE_IN_PROGRESS');
  // The one token is still there.
  const missing = 'AAAAAA' === ctx.code ? 'BBBBBB' : 'AAAAAA';
  assert.equal(await failedJoin(ctx, missing), 'ROOM_NOT_FOUND');
  assert.equal(await failedJoin(ctx, missing), 'RATE_LIMITED');
});

test('with default limits the 11th failed join within a minute gets RATE_LIMITED', async (t) => {
  const ctx = await setup(t, { joinFailLimit: undefined });
  const started = performance.now();
  for (let i = 1; i <= 10; i += 1) {
    assert.equal(await failedJoin(ctx, 'AAAAAA'), 'ROOM_NOT_FOUND', `attempt ${i}`);
  }
  const code = await failedJoin(ctx, 'AAAAAA');
  // One token refills every 6 s; the loop must be well inside that.
  assert.ok(performance.now() - started < 5500, 'the attempts ran fast enough to test the bucket');
  assert.equal(code, 'RATE_LIMITED');
});

test('an ALREADY_JOINED join from a seated socket is answered before the join-failure limit', async (t) => {
  const ctx = await setup(t, { joinFailLimit: { capacity: 1, refillPerSec: 0 } });
  const a = await ctx.created();
  assert.equal(await failedJoin(ctx, 'AAAAAA' === ctx.code ? 'BBBBBB' : 'AAAAAA'), 'ROOM_NOT_FOUND');
  const ack = await a.join('k7qm2x');
  assert.equal(ack.error.code, 'ALREADY_JOINED');
  await sleep(50);
  assert.equal(a.socket.connected, true);
});

/* ---------- Create limit ---------- */

test('a second create from the same IP past the create bucket gets RATE_LIMITED and is kicked', async (t) => {
  const ctx = await setup(t, { createLimit: { capacity: 1, refillPerSec: 0 } });
  await ctx.created();
  const { client, ack } = await tryCreate(ctx);
  assert.equal(ack.error.code, 'RATE_LIMITED');
  assert.equal(await client.disconnected, 'io server disconnect');
});

test('with the default create bucket an IP may create three rooms at once, not four', async (t) => {
  const ctx = await setup(t, { createLimit: undefined });
  for (let i = 0; i < 3; i += 1) await ctx.created();
  const { ack } = await tryCreate(ctx);
  assert.equal(ack.error.code, 'RATE_LIMITED');
});

test('ALREADY_JOINED on create takes no create token', async (t) => {
  const ctx = await setup(t, { createLimit: { capacity: 2, refillPerSec: 0 } });
  const a = await ctx.created();
  for (let i = 0; i < 3; i += 1) assert.equal((await a.create()).error.code, 'ALREADY_JOINED');
  const { ack } = await tryCreate(ctx);
  assert.equal(ack.ok, true);
});

test('behind one trusted proxy each forwarded address has its own create bucket', async (t) => {
  const ctx = await setup(t, { trustProxyHops: 1, createLimit: { capacity: 1, refillPerSec: 0 } });
  assert.equal((await tryCreate(ctx, viaProxy('203.0.113.1'))).ack.ok, true);
  assert.equal((await tryCreate(ctx, viaProxy('203.0.113.2'))).ack.ok, true);
  assert.equal((await tryCreate(ctx, viaProxy('203.0.113.1'))).ack.error.code, 'RATE_LIMITED');
});

test('behind one trusted proxy two IPv6 addresses in one /64 share a create bucket', async (t) => {
  const ctx = await setup(t, { trustProxyHops: 1, createLimit: { capacity: 1, refillPerSec: 0 } });
  assert.equal((await tryCreate(ctx, viaProxy('2001:db8:1:2::1'))).ack.ok, true);
  assert.equal((await tryCreate(ctx, viaProxy('2001:db8:1:2::ffff'))).ack.error.code, 'RATE_LIMITED');
  assert.equal((await tryCreate(ctx, viaProxy('2001:db8:1:3::1'))).ack.ok, true);
});

test('behind one trusted proxy two IPv6 addresses in one /64 share a join-failure bucket', async (t) => {
  const ctx = await setup(t, { trustProxyHops: 1, joinFailLimit: { capacity: 1, refillPerSec: 0 } });
  assert.equal(await failedJoin(ctx, 'AAAAAA', viaProxy('2001:db8:1:2::1')), 'ROOM_NOT_FOUND');
  assert.equal(await failedJoin(ctx, 'AAAAAA', viaProxy('2001:db8:1:2::2')), 'RATE_LIMITED');
  assert.equal(await failedJoin(ctx, 'AAAAAA', viaProxy('2001:db8:1:3::2')), 'ROOM_NOT_FOUND');
});

/* ---------- Store cap and codes ---------- */

test('a create past maxRooms gets TOO_MANY_ROOMS and is kicked, and a create works again once a room is gone', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store, maxRooms: 1 });
  const a = await ctx.created();
  const { client, ack } = await tryCreate(ctx);
  assert.equal(ack.error.code, 'TOO_MANY_ROOMS');
  assert.equal(await client.disconnected, 'io server disconnect');
  assert.equal(store.size(), 1, 'the existing room is unaffected');
  await a.close();
  await eventually(() => store.size() === 0, 'room deleted');
  assert.equal((await tryCreate(ctx)).ack.ok, true);
});

test('RATE_LIMITED is checked before TOO_MANY_ROOMS', async (t) => {
  const ctx = await setup(t, { maxRooms: 1, createLimit: { capacity: 1, refillPerSec: 0 } });
  await ctx.created();
  assert.equal((await tryCreate(ctx)).ack.error.code, 'RATE_LIMITED');
});

test('a create refused with TOO_MANY_ROOMS still costs a create token', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store, maxRooms: 1, createLimit: { capacity: 2, refillPerSec: 0 } });
  const a = await ctx.created();
  assert.equal((await tryCreate(ctx)).ack.error.code, 'TOO_MANY_ROOMS');
  await a.close();
  await eventually(() => store.size() === 0, 'room deleted');
  assert.equal((await tryCreate(ctx)).ack.error.code, 'RATE_LIMITED');
});

test('a code collision is retried so two creates get different codes', async (t) => {
  // 12 zeros: room 1 gets AAAAAA, room 2 first draws AAAAAA (taken), then BBBBBB.
  let calls = 0;
  const randomInt = () => (calls++ < 12 ? 0 : 1);
  const ctx = await setup(t, { randomInt });
  const a = await ctx.created();
  const b = await ctx.created();
  assert.equal(a.code, 'AAAAAA');
  assert.equal(b.code, 'BBBBBB');
  assert.equal(calls, 18);
});

test('ten taken codes in a row give TOO_MANY_ROOMS and the socket is kicked', async (t) => {
  const ctx = await setup(t, { randomInt: () => 0 });
  await ctx.created();
  const { client, ack } = await tryCreate(ctx);
  assert.equal(ack.error.code, 'TOO_MANY_ROOMS');
  assert.equal(await client.disconnected, 'io server disconnect');
});

/* ---------- Second tabs ---------- */

test('with default per-IP limits one IP creates a room and three more sockets join it, and all four race', async (t) => {
  const ctx = await setup(t, { createLimit: undefined, joinFailLimit: undefined, maxConnectionsPerIp: undefined });
  const players = await ctx.lobby(4);
  await ctx.start();
  await Promise.all(players.map((c) => c.waitFor('race:start')));
  for (const c of players) c.progress(1, FIXED_PASSAGE);
  const end = await players[0].waitFor('race:end');
  assert.deepEqual(end.payload.results.map((r) => r.place), [1, 2, 3, 4]);
  assert.deepEqual(end.payload.results.map((r) => r.status), Array(4).fill('finished'));
});
