'use strict';

const { MAX_KEYS_PER_EVENT, SEQ_MAX, ROOM_CODE_INPUT_MAX, ERROR_CODES } = require('./constants');

// Control characters except U+0008, which encodes Backspace.
const FORBIDDEN_KEY_CHARS = /[\u0000-\u0007\u0009-\u001F\u007F-\u009F]/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ok(value) {
  return { ok: true, value };
}

function bad(message) {
  return { ok: false, code: ERROR_CODES.BAD_PAYLOAD, message };
}

/** `{}` or `undefined`; anything else is BAD_PAYLOAD. Extra fields are ignored. */
function validateEmptyPayload(payload, eventName) {
  if (payload === undefined || isPlainObject(payload)) return ok({});
  return bad(`${eventName} payload must be an object`);
}

function validateCreate(payload) {
  return validateEmptyPayload(payload, 'room:create');
}

function validateStart(payload) {
  return validateEmptyPayload(payload, 'room:start');
}

function validateExtend(payload) {
  return validateEmptyPayload(payload, 'room:extend');
}

function validateRematch(payload) {
  return validateEmptyPayload(payload, 'race:rematch');
}

/**
 * `{ code }` with a string of 1..ROOM_CODE_INPUT_MAX. Shape only: the format
 * check (roomCode.isValidRoomCode) answers BAD_CODE and runs after the per-IP
 * rate-limit check, so it is not here.
 */
function validateJoin(payload) {
  if (!isPlainObject(payload)) return bad('room:join payload must be an object');
  const { code } = payload;
  if (typeof code !== 'string' || code.length < 1 || code.length > ROOM_CODE_INPUT_MAX) {
    return bad(`code must be a string of 1..${ROOM_CODE_INPUT_MAX} characters`);
  }
  return ok({ code });
}

/** `{ seq, keys }` only; any client-sent score, time or flag is dropped here. */
function validateProgress(payload) {
  if (!isPlainObject(payload)) return bad('race:progress payload must be an object');

  const { seq, keys } = payload;
  if (!Number.isInteger(seq) || seq < 1 || seq > SEQ_MAX) {
    return bad(`seq must be an integer in 1..${SEQ_MAX}`);
  }
  if (typeof keys !== 'string' || keys.length < 1 || keys.length > MAX_KEYS_PER_EVENT) {
    return bad(`keys must be a string of 1..${MAX_KEYS_PER_EVENT} characters`);
  }
  if (!keys.isWellFormed()) return bad('keys must be well-formed text');
  if (FORBIDDEN_KEY_CHARS.test(keys)) return bad('keys contains control characters');

  return ok({ seq, keys });
}

module.exports = {
  isPlainObject,
  validateCreate,
  validateJoin,
  validateStart,
  validateExtend,
  validateRematch,
  validateProgress,
  FORBIDDEN_KEY_CHARS,
};
