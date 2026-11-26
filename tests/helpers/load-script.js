'use strict';

/*
 * Runs the app's classic scripts (stats.js, words.js, optionally
 * multiplayer.js, then script.js) in one fresh `vm` context with a minimal
 * fake DOM, the way the browser would with <script defer> tags.
 *
 * Only Node built-ins are used. The fake DOM is deliberately small: plain
 * objects with recording stubs, one per id found in index.html, so that
 * `init()` in script.js can run and its effects can be observed.
 *
 * Timers (setTimeout, requestAnimationFrame) and performance.now() share one
 * fake clock. Nothing runs until a test calls `clock.advance(ms)`, so tests
 * that never advance it see inert timers.
 */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const META_PATTERN = /<meta\s+name="typing-server-url"\s+content="([^"]*)"/;

/** The typing-server-url meta content in `html` (index.html by default). */
function readMetaContent(html = read('index.html')) {
  return (html.match(META_PATTERN) || [])[1];
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * id -> { tag, hidden, parentId } for every element with an id in index.html.
 * parentId is the nearest ancestor that has an id (or null), so the fake DOM
 * can answer contains() for nested elements, as isFocusIn() needs.
 */
function idsFromHtml(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const ids = new Map();
  const stack = []; // open elements: { tag, id }
  for (const match of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, closing, rawTag, attrs] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((open) => open.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const idMatch = attrs.match(/\sid="([^"]+)"/);
    const id = idMatch ? idMatch[1] : null;
    if (id !== null) {
      let parentId = null;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].id !== null) { parentId = stack[i].id; break; }
      }
      ids.set(id, { tag, hidden: /\shidden(?=[\s=/]|$)/.test(attrs), parentId });
    }
    if (!VOID_TAGS.has(tag) && !attrs.trim().endsWith('/')) stack.push({ tag, id });
  }
  return ids;
}

/** Stands in for the browser's Element, so `instanceof Element` checks work. */
class FakeElement {}

/** Matches one simple selector: a tag name or a [data-*] attribute. */
function matchesSimple(node, selector) {
  const data = /^\[data-([a-z-]+)\]$/.exec(selector);
  if (data) {
    const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return Boolean(node.dataset) && key in node.dataset;
  }
  if (/^[a-z]+$/.test(selector)) return node.tagName === selector.toUpperCase();
  return false;
}

function createClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains: (name) => set.has(name),
  };
}

function createElement(tagName, extra = {}, owner = { document: null }) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    removed: false,
    selected: false,
    parentNode: null,
    children: [],
    attributes: {},
    listeners: {},
    dataset: {},
    style: {},
    classList: createClassList(),
    offsetLeft: 0,
    offsetTop: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    },
    appendChild(child) {
      const added = child && child.isFragment ? child.children : [child];
      for (const node of added) {
        if (node && typeof node === 'object') node.parentNode = this;
        this.children.push(node);
      }
      if (child && child.isFragment) child.children = [];
      return child;
    },
    append(...nodes) { for (const node of nodes) this.appendChild(node); },
    replaceChildren(...nodes) {
      this.children = [];
      for (const node of nodes) this.appendChild(node);
    },
    remove() { this.removed = true; },
    /** True for this element and any descendant (through parentNode links). */
    contains(other) {
      for (let node = other; node; node = node.parentNode) if (node === this) return true;
      return false;
    },
    /** Comma-separated tag names or [data-*] selectors, on this and its ancestors. */
    closest(selector) {
      const parts = String(selector).split(',').map((part) => part.trim());
      for (let node = this; node; node = node.parentNode) {
        if (parts.some((part) => matchesSimple(node, part))) return node;
      }
      return null;
    },
    select() { this.selected = true; },
    focus() { owner.document.activeElement = this; },
    blur() { if (owner.document.activeElement === this) owner.document.activeElement = null; },
    setSelectionRange() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    ...extra,
  };
  Object.setPrototypeOf(el, FakeElement.prototype);
  return el;
}

/** A fake clock for setTimeout, requestAnimationFrame and performance.now(). */
function createClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id -> { at, fn }
  const schedule = (fn, delay) => {
    const id = nextId++;
    pending.set(id, { at: now + Math.max(0, Number(delay) || 0), fn });
    return id;
  };
  const cancel = (id) => { pending.delete(id); };
  return {
    now: () => now,
    setTimeout: (fn, delay) => schedule(fn, delay),
    clearTimeout: cancel,
    requestAnimationFrame: (fn) => schedule(() => fn(now), 16),
    cancelAnimationFrame: cancel,
    pendingCount: () => pending.size,
    /** Runs every timer due within `ms`, in time order, moving `now` along. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let dueId = null;
        let dueAt = Infinity;
        for (const [id, timer] of pending) {
          if (timer.at <= end && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const { fn } = pending.get(dueId);
        pending.delete(dueId);
        now = dueAt;
        fn();
      }
      now = end;
    },
  };
}

/**
 * @param {object} options
 * @param {boolean} options.withMultiplayer  load multiplayer.js before script.js
 * @param {string}  [options.hostname]       window.location.hostname ('localhost')
 * @param {string}  [options.protocol]       window.location.protocol ('http:')
 * @param {string|null} [options.metaContent] typing-server-url meta content;
 *          omitted = read from index.html, null = no meta tag at all
 * @param {string}  [options.scriptSource]   replacement source for script.js
 * @param {string}  [options.pathname]       window.location.pathname ('/')
 * @param {string}  [options.search]         window.location.search ('')
 * @param {string}  [options.hash]           window.location.hash ('')
 * @param {object}  [options.navigator]      the navigator global ({}: no clipboard)
 * @param {boolean} [options.withElement]   false = no global Element (default true)
 * @param {boolean} [options.isSecureContext] window.isSecureContext
 *          (default: true on an https: or localhost page)
 * @returns {{ ctx, elements, document, window, history, clock, modeButtons, error }}
 *          error is the thrown value, or null when every script ran cleanly.
 */
function loadApp(options = {}) {
  const {
    withMultiplayer, hostname = 'localhost', protocol = 'http:', scriptSource,
    pathname = '/', search = '', hash = '', navigator = {}, withElement = true,
  } = options;
  const html = read('index.html');
  let metaUrl;
  if (options.metaContent === undefined) metaUrl = readMetaContent(html);
  else if (options.metaContent !== null) metaUrl = String(options.metaContent);

  // Filled in once `document` exists; elements' focus()/blur() write to it.
  const owner = { document: null };
  const make = (tag, extra) => createElement(tag, extra, owner);

  const elements = new Map();
  const parsed = idsFromHtml(html);
  for (const [id, { tag, hidden }] of parsed) elements.set(id, make(tag, { id, hidden }));
  for (const [id, { parentId }] of parsed) {
    if (parentId !== null) elements.get(id).parentNode = elements.get(parentId);
  }
  const buttons = (attr, values) => values.map((v) => {
    const b = make('button');
    b.dataset[attr] = v;
    return b;
  });
  const modeButtons = buttons('mode', ['solo', 'multi']);
  const durationButtons = buttons('duration', ['15', '30', '60']);
  // Inside #mode, so the click delegation's dom.mode.contains(button) holds.
  if (elements.has('mode')) elements.get('mode').append(...modeButtons);
  if (elements.has('settings')) elements.get('settings').append(...durationButtons);

  const document = {
    documentElement: make('html'),
    body: make('body'),
    head: make('head'),
    activeElement: null,
    visibilityState: 'visible',
    listeners: {},
    getElementById: (id) => elements.get(id) || null,
    querySelector(selector) {
      if (selector === 'meta[name="typing-server-url"]') {
        return metaUrl === undefined ? null : { content: metaUrl };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '#mode [data-mode]') return modeButtons;
      if (selector === '#settings [data-duration]') return durationButtons;
      return [];
    },
    createElement: (tag) => make(tag),
    createDocumentFragment: () => make('#fragment', { isFragment: true }),
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
  };
  owner.document = document;

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };

  const clock = createClock();
  const href = protocol === 'file:'
    ? `file:///index.html${search}${hash}`
    : `${protocol}//${hostname}${pathname}${search}${hash}`;
  const location = {
    hostname, protocol, href, pathname: protocol === 'file:' ? '/index.html' : pathname, search, hash,
  };
  // Records replaceState URLs and applies them to location, as browsers do
  // (without firing hashchange).
  const history = {
    calls: [],
    replaceState(stateObj, title, url) {
      history.calls.push(String(url));
      const next = new URL(String(url), location.href);
      location.href = next.href;
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    },
  };
  const isSecureContext = options.isSecureContext ?? (protocol === 'https:' || hostname === 'localhost');
  const window = {
    location,
    history,
    navigator,
    isSecureContext,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    console,
    URL, // browser global used by multiplayer.js
    ...(withElement ? { Element: FakeElement } : {}),
    navigator,
    performance: { now: clock.now },
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    getComputedStyle: () => ({ lineHeight: '32px' }),
    matchMedia: window.matchMedia,
  });

  const files = ['stats.js', 'words.js'];
  if (withMultiplayer) files.push('multiplayer.js');

  let error = null;
  try {
    for (const file of files) vm.runInContext(read(file), ctx, { filename: file });
    vm.runInContext(scriptSource ?? read('script.js'), ctx, { filename: 'script.js' });
  } catch (err) {
    error = err;
  }

  return { ctx, elements, document, window, history, clock, modeButtons, error };
}

module.exports = { loadApp, readMetaContent };
