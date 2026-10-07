import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real controller with just the DOM surface it uses; no browser or phone needed.
const source = readFileSync(new URL('./src/input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { InputController } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const listeners = new Map();
const frames = new Map();
let nextFrame = 1;
const messages = [];
const captured = new Set();
let modalOpen = false;
let rect = { left: 100, top: 50, width: 400, height: 225 };
class Element {
  constructor(tag = 'canvas') { this.tag = tag; }
  closest(selector) { return selector.split(',').map((s) => s.trim()).includes(this.tag) ? this : null; }
}
globalThis.Element = Element;
globalThis.document = { querySelector: () => modalOpen ? {} : null };
globalThis.window = {
  addEventListener: (name, handler) => listeners.set(name, handler),
  removeEventListener: (name) => listeners.delete(name),
  requestAnimationFrame: (handler) => { const id = nextFrame++; frames.set(id, handler); return id; },
  cancelAnimationFrame: (id) => frames.delete(id),
};
const surface = Object.assign(new Element(), {
  inert: false, style: {}, focus() {},
  setPointerCapture: (id) => captured.add(id),
  hasPointerCapture: (id) => captured.has(id),
  releasePointerCapture: (id) => captured.delete(id),
  addEventListener: window.addEventListener, removeEventListener: window.removeEventListener,
  getBoundingClientRect: () => rect,
});
const controller = new InputController(surface, (message) => messages.push(message));
controller.attach();
const key = (value, target = surface, extra = {}) => listeners.get('keydown')({ key: value, target, preventDefault() {}, ...extra });
const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(); };

key('ArrowRight');
assert.equal(messages.pop().knob.x, 127);
key('Enter');
assert.equal(messages.pop().knob.select, true);
key(' ');
assert.deepEqual(messages.pop(), { type: 'media', media: 3 });
surface.inert = true;
key('s');
surface.inert = false;
modalOpen = true;
key('Escape');
modalOpen = false;
for (const tag of ['input', 'select', 'textarea', '[contenteditable="true"]']) key('ArrowUp', new Element(tag));
key('Enter', new Element('button'));
key(' ', new Element('a'));
key('s', surface, { ctrlKey: true });
key('s', surface, { defaultPrevented: true });
assert.equal(messages.length, 0, 'Settings, native controls, browser shortcuts, and disconnected screens must not send CarPlay commands');
key('ArrowLeft', new Element('button'));
assert.equal(messages.pop().knob.x, -127, 'Navigation still works after clicking a toolbar button');

const pointer = (id, x, y, extra = {}) => ({ pointerId: id, clientX: x, clientY: y, button: 0, preventDefault() {}, ...extra });
// A click completed before the next paint must still send both edges, at the clicked location.
listeners.get('pointerdown')(pointer(1, 300, 162.5));
listeners.get('pointerup')(pointer(1, 300, 162.5));
assert.deepEqual(messages.splice(0), [
  { type: 'touch', contacts: [{ id: 0, x: .5, y: .5, down: true }] },
  { type: 'touch', contacts: [{ id: 0, x: .5, y: .5, down: false }] },
], 'Fast clicks must reach the phone as a press and a release at the same position');
flush();
assert.equal(messages.length, 0, 'A completed click must not leave a stale frame queued');
assert.equal(captured.size, 0);

listeners.get('pointerdown')(pointer(1, 300, 162.5));
messages.length = 0;
rect = { left: 100, top: 50, width: 225, height: 400 };
listeners.get('pointermove')(pointer(1, 212.5, 250));
listeners.get('pointerdown')(pointer(2, 500, 0));
listeners.get('pointerdown')(pointer(3, 200, 100));
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: true }, { id: 1, x: 1, y: 0, down: true }]);
listeners.get('pointerup')(pointer(1, 235, 290));
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .6, y: .6, down: false }, { id: 1, x: 1, y: 0, down: true }], 'Releasing one finger must preserve both its final position and the other finger');
listeners.get('pointermove')(pointer(2, 190, 210));
listeners.get('pointermove')(pointer(2, 212.5, 250));
assert.equal(messages.length, 0, 'Only moves are coalesced until the next paint');
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 1, x: .5, y: .5, down: true }], 'The remaining finger keeps its original contact ID');
listeners.get('pointercancel')(pointer(2, 0, 0));
assert.deepEqual(messages.pop().contacts, [{ id: 1, x: .5, y: .5, down: false }], 'Cancelled touches release at their last known position');
flush();
assert.equal(messages.length, 0);

listeners.get('pointerdown')(pointer(4, 212.5, 250));
messages.length = 0;
listeners.get('pointermove')(pointer(4, 235, 290));
listeners.get('lostpointercapture')(pointer(4, 0, 0));
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .6, y: .6, down: false }], 'Losing capture releases the touch without moving it to the corner');
flush();
assert.equal(messages.length, 0);

listeners.get('pointerdown')(pointer(5, 212.5, 250, { button: 2 }));
assert.equal(messages.length, 0, 'Secondary mouse buttons must not activate CarPlay');
surface.inert = true;
listeners.get('pointerdown')(pointer(5, 212.5, 250));
surface.inert = false;
assert.equal(messages.length, 0);

listeners.get('pointerdown')(pointer(5, 212.5, 250));
messages.length = 0;
listeners.get('blur')();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: false }], 'Leaving the browser must not leave a button held down');

listeners.get('pointerdown')(pointer(6, 212.5, 250));
messages.length = 0;
listeners.get('pointermove')(pointer(6, 235, 290));
controller.detach();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .6, y: .6, down: false }]);
assert.equal(frames.size, 0, 'Detaching cancels pending moves');
assert.equal(listeners.size, 0);
console.log('Viewer input check passed: keyboard isolation, fast taps, release coordinates, multi-touch IDs, capture loss, and cleanup.');
