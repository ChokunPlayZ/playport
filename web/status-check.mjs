import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./src/status.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { connectionView } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const pairing = connectionView({ stage: 'pairing_required' });
assert.equal(pairing.kind, 'action');
assert.equal(pairing.step, 0);
assert.match(pairing.detail, /Bluetooth/);
const wifi = connectionView({ stage: 'wifi_connecting', wifiSsid: 'My <home> & Wi-Fi' });
assert.match(wifi.detail, /My <home> & Wi-Fi/);
assert.equal(wifi.kind, 'busy', 'Sending Wi-Fi credentials is progress, not a confirmed connection');
assert.equal(wifi.step, 2);
assert.match(connectionView({ stage: 'pairing' }).detail, /3939/);

const connected = { stage: 'connected' };
assert.equal(connectionView(connected, true, false).kind, 'busy', 'A connected session still waits for this viewer’s first painted frame');
assert.match(connectionView(connected, true, false).title, /video/);
assert.equal(connectionView(connected, true, true).kind, 'live');
assert.equal(connectionView(connected, true, true).step, 4);
assert.equal(connectionView(connected, false, true).kind, 'idle', 'Stale video must not claim the phone is connected');
assert.equal(connectionView({ stage: 'reconnecting' }).step, -1, 'A retry clears the completed milestones');
const error = connectionView({ stage: 'error', detail: 'No network is configured.' });
assert.equal(error.kind, 'error');
assert.equal(error.detail, 'No network is configured.');
assert.equal(connectionView({ stage: 'waiting', wirelessEnabled: false }).showSteps, false);
assert.equal(connectionView({ stage: 'future-server-stage' }).kind, 'idle', 'Unknown server states degrade to waiting');
assert.equal(connectionView({ stage: '__proto__' }).kind, 'idle');
console.log('Connection status check passed: pairing guidance, Wi-Fi handoff, first-frame readiness, retries, errors, and older-server fallback.');
