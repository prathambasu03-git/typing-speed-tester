'use strict';

/*
 * Runs the app's classic scripts (stats.js, words.js, optionally
 * multiplayer.js, then script.js) in one fresh `vm` context with a minimal
 * fake DOM, the way the browser would with <script defer> tags.
 *
 * Only Node built-ins are used. The fake DOM is deliberately small: plain
 * objects with recording stubs, one per id found in index.html, so that
 * `init()` in script.js can run and its effects can be observed.
 */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** id -> whether the element carries the `hidden` attribute in index.html. */
function idsFromHtml(html) {
  const ids = new Map();
  for (const match of html.matchAll(/<[a-zA-Z][^>]*\sid="([^"]+)"[^>]*>/g)) {
    ids.set(match[1], /\shidden(?=[\s>=])/.test(match[0]));
  }
  return ids;
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
      if (child && child.isFragment) this.children.push(...child.children);
      else this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const node of nodes) this.appendChild(node);
    },
    contains(other) { return other === this || this.children.includes(other); },
    closest() { return null; },
    focus() { owner.document.activeElement = this; },
    blur() { if (owner.document.activeElement === this) owner.document.activeElement = null; },
    setSelectionRange() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    ...extra,
  };
  return el;
}

/**
 * @param {object} options
 * @param {boolean} options.withMultiplayer  load multiplayer.js before script.js
 * @param {string}  [options.hostname]       window.location.hostname
 * @param {string}  [options.scriptSource]   replacement source for script.js
 * @returns {{ ctx, elements, document, window, error }} error is the thrown
 *          value, or null when every script ran cleanly.
 */
function loadApp({ withMultiplayer, hostname = 'localhost', scriptSource } = {}) {
  const html = read('index.html');
  const metaUrl = (html.match(/<meta\s+name="typing-server-url"\s+content="([^"]*)"/) || [])[1];

  // Filled in once `document` exists; elements' focus()/blur() write to it.
  const owner = { document: null };
  const make = (tag, extra) => createElement(tag, extra, owner);

  const elements = new Map();
  for (const [id, hidden] of idsFromHtml(html)) {
    const el = make('div', { id, hidden });
    elements.set(id, el);
  }
  const buttons = (attr, values) => values.map((v) => {
    const b = make('button');
    b.dataset[attr] = v;
    return b;
  });
  const modeButtons = buttons('mode', ['solo', 'multi']);
  const durationButtons = buttons('duration', ['15', '30', '60']);

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

  const timers = [];
  const window = {
    location: { hostname, protocol: 'http:', href: `http://${hostname}/` },
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
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { timers.push(fn); return timers.length; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
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

  return { ctx, elements, document, window, error };
}

module.exports = { loadApp };
