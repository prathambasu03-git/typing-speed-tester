'use strict';

/* In-memory room store. Race logic reaches rooms only through this object, so
   a Redis store can replace it later. A Redis store will be async; game.js
   will then need per-room serialization (not needed while this is a Map). */

function createMemoryRoomStore() {
  const rooms = new Map();
  return {
    getRoom(id) {
      return rooms.get(id) || null;
    },
    saveRoom(room) {
      rooms.set(room.id, room);
    },
    deleteRoom(id) {
      rooms.delete(id);
    },
    /** Live rooms; game.js compares it with MAX_ROOMS before creating one. */
    size() {
      return rooms.size;
    },
    clear() {
      rooms.clear();
    },
  };
}

module.exports = { createMemoryRoomStore };
