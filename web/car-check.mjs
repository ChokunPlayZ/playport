import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./src/car.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { prepareCarLogo, setupCarSettings } = await import(`data:text/javascript;base64,${Buffer.from(outputText + '\n//# sourceURL=car-controller-check.js').toString('base64')}`);
let bitmap = { width: 400, height: 200, close() { closed++; } };
let closed = 0;
let draws = [];
let canvas;
globalThis.createImageBitmap = async () => bitmap;
globalThis.document = {
  createElement: (tag) => {
    assert.equal(tag, 'canvas');
    canvas = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...args) => draws.push(args) }),
      toDataURL: (format) => { assert.equal(format, 'image/png'); return 'data:image/png;base64,prepared'; },
    };
    return canvas;
  },
};
const file = { type: 'image/jpeg', size: 1000 };
assert.equal(await prepareCarLogo(file), 'data:image/png;base64,prepared');
assert.equal(canvas.width, 256);
assert.equal(canvas.height, 256);
assert.deepEqual(draws.pop().slice(1), [0, 64, 256, 128], 'Wide logos are centered with their aspect ratio preserved');
bitmap = { ...bitmap, width: 100, height: 200 };
await prepareCarLogo({ ...file, type: 'image/webp' });
assert.deepEqual(draws.pop().slice(1), [64, 0, 128, 256], 'Tall logos are centered with their aspect ratio preserved');
await assert.rejects(prepareCarLogo({ ...file, type: 'text/plain' }), /PNG, JPG or WebP/);
await assert.rejects(prepareCarLogo({ ...file, size: 5 * 1024 * 1024 + 1 }), /5 MB/);
bitmap = { ...bitmap, width: 4097 };
await assert.rejects(prepareCarLogo(file), /4096/);
assert.equal(closed, 3, 'Decoded images are released on success and validation failure');
globalThis.createImageBitmap = async () => { throw new Error('decoder error'); };
await assert.rejects(prepareCarLogo(file), /Could not read this image/);

// Exercise the settings controller through its form events and actual request payloads.
const elements = new Map();
const previewState = { dataset: {} };
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
for (const [, id] of html.matchAll(/id="((?:btn-)?car(?:-[^"]+)?)"/g)) {
  const listeners = new Map();
  elements.set(id, {
    value: '', checked: false, disabled: false, hidden: false, dataset: {}, listeners,
    addEventListener: (event, handler) => listeners.set(event, handler),
    showModal() {}, close() {}, reportValidity: () => true,
    querySelector: () => previewState,
    toggleAttribute() {}, removeAttribute() {},
  });
}
globalThis.document = { getElementById: (id) => elements.get(id) };
let saved = { manufacturer: 'Toyota', title: 'My car', showBackButton: true, logo: null, rightHandDrive: true };
const requests = [];
let loadFails = false;
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  if (options?.method === 'POST') {
    saved = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: !loadFails, status: loadFails ? 503 : 200, json: async () => saved };
};
const current = (id) => elements.get(id);
const open = async () => {
  current('btn-car').listeners.get('click')();
  // Opening starts the asynchronous refresh; allow both fetch and JSON decoding to complete.
  await new Promise((resolve) => setImmediate(resolve));
};
setupCarSettings('test token');
await open();
assert.equal(current('car-driver-side').value, 'right', 'The saved right-hand-drive setting is loaded');
assert.equal(current('btn-car-apply').disabled, false);
for (const side of ['left', 'right']) {
  current('car-driver-side').value = side;
  await current('car-form').listeners.get('submit')({ preventDefault() {} });
  const { url, options } = requests.at(-1);
  assert.equal(url, '/api/car?token=test%20token');
  assert.equal(options.method, 'POST');
  assert.equal(saved.rightHandDrive, side === 'right', 'Each driver side is explicitly sent, including false');
  assert.equal(saved.title, 'My car', 'Changing driver side preserves branding');
  await open();
  assert.equal(current('car-driver-side').value, side, 'Reopening shows the saved side');
}
loadFails = true;
await open();
assert.equal(current('car-fields').disabled, true);
assert.equal(current('btn-car-apply').disabled, true, 'A failed load cannot overwrite saved car settings');
const before = requests.length;
await current('car-form').listeners.get('submit')({ preventDefault() {} });
assert.equal(requests.length, before);
console.log('Car settings check passed: logo conversion and limits, driver-side load/save, branding preservation, and failed-load protection.');
