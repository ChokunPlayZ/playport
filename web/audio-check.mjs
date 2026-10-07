import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function moduleSource(file) {
  return ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const protocolUrl = moduleUrl(moduleSource('./src/protocol.ts'));
const { AudioCodec } = await import(protocolUrl);
const { AudioEngine } = await import(moduleUrl(
  moduleSource('./src/audio.ts').replace("from './protocol'", `from '${protocolUrl}'`),
));

// Control the audio clock and decoded output while exercising the real engine's public API.
const contexts = [];
const decoders = [];
class FakeNode {
  disconnected = false;
  connect() {}
  disconnect() { this.disconnected = true; }
}
class FakeSource extends FakeNode {
  stopped = false;
  ended = false;
  onended = null;
  start(time) { this.startTime = time; }
  stop() { this.stopped = true; }
}
class FakeAudioContext {
  currentTime = 0;
  state = 'suspended';
  sources = [];
  destination = new FakeNode();
  constructor() { contexts.push(this); }
  async resume() { this.state = 'running'; }
  createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }); }
  createBuffer(channels, frames, sampleRate) {
    return { duration: frames / sampleRate, numberOfChannels: channels, copyToChannel() {} };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  advanceTo(time) {
    this.currentTime = time;
    for (const source of this.sources) {
      if (!source.ended && source.startTime + source.buffer.duration <= time) {
        source.ended = true;
        source.onended?.();
      }
    }
  }
}
globalThis.AudioContext = FakeAudioContext;
globalThis.EncodedAudioChunk = class { constructor(init) { Object.assign(this, init); } };
globalThis.AudioDecoder = class {
  constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
  configure(config) { this.config = config; }
  decode() {
    this.emit();
  }
  emit() {
    this.callbacks.output({
      numberOfChannels: this.config.numberOfChannels,
      numberOfFrames: 1024,
      sampleRate: this.config.sampleRate,
      copyTo(plane) { plane.fill(0); },
      close() {},
    });
  }
  close() { this.closed = true; }
};

async function engineFor(codec = AudioCodec.AacLc, streamType = 102, name = 'media') {
  const errors = [];
  const engine = new AudioEngine((message) => errors.push(message));
  await engine.unlock();
  const config = {
    kind: 'audio-config', streamType, codec, sampleRate: codec === AudioCodec.Lpcm ? 16000 : 48000,
    channels: codec === AudioCodec.Lpcm ? 1 : 2, name, description: new Uint8Array(),
  };
  engine.handleConfig(config);
  const packet = (index = 0) => engine.handlePacket({
    kind: 'audio-packet', streamType, timestampUs: index * 1024 * 1e6 / config.sampleRate,
    data: new Uint8Array(codec === AudioCodec.Lpcm ? 640 : 8),
  });
  return { engine, context: contexts.at(-1), config, errors, packet };
}

function assertContinuous(sources, label) {
  for (let i = 1; i < sources.length; i++) {
    const end = sources[i - 1].startTime + sources[i - 1].buffer.duration;
    assert.ok(Math.abs(sources[i].startTime - end) < 1e-8,
      `${label}: frame ${i} must follow the previous frame without gaps or overlaps`);
  }
}

const music = await engineFor();
const burstSize = 18;
const burstDuration = burstSize * 1024 / 48000;
const jitter = [0, 0.025, 0.12, 0.04, 0.08];
for (let burst = 0; burst < 80; burst++) {
  music.context.advanceTo(burst * burstDuration + jitter[burst % jitter.length]);
  for (let frame = 0; frame < burstSize; frame++) music.packet(burst * burstSize + frame);
}
assertContinuous(music.context.sources, 'Music delivered in 384 ms bursts with up to 120 ms jitter');
assert.ok(music.context.sources[0].startTime >= 0.6, 'Music needs enough buffering for the measured 400–520 ms arrival gaps');
assert.equal(music.context.sources.some((source) => source.stopped), false, 'Normal bursts must never reset queued music');
assert.deepEqual(music.errors, []);

const voice = await engineFor(AudioCodec.Lpcm, 100, 'speechrecognition');
for (let frame = 0; frame < 80; frame++) {
  voice.context.advanceTo(frame * 0.02 + (frame % 2 ? 0.002 : 0));
  voice.packet(frame);
}
assertContinuous(voice.context.sources, 'Live speech');
assert.ok(voice.context.sources[0].startTime <= 0.15, 'Live speech must retain a short buffer');

music.context.advanceTo(40);
music.packet();
assert.ok(music.context.sources.at(-1).startTime >= 40.6, 'A real underrun must replenish the music buffer');

const overflow = await engineFor();
for (let frame = 0; frame < 300; frame++) overflow.packet(frame);
const pending = overflow.context.sources.filter((source) => !source.stopped);
assertContinuous(pending, 'Rebuffered music');
assert.ok(pending.at(-1).startTime + pending.at(-1).buffer.duration < 2.1,
  'Excess backlog must stay bounded without overlapping previously scheduled audio');
const staleDecoder = decoders.at(-1);
overflow.engine.stopStream(102);
assert.ok(pending.every((source) => source.stopped && source.disconnected), 'Stopping a stream must cancel all queued audio');
const sourceCount = overflow.context.sources.length;
staleDecoder.emit();
assert.equal(overflow.context.sources.length, sourceCount, 'Late decoder output must not revive a stopped stream');

const replacement = await engineFor();
replacement.packet();
const oldSource = replacement.context.sources[0];
replacement.engine.handleConfig(replacement.config);
assert.ok(oldSource.stopped && oldSource.disconnected, 'A format change must cancel audio from the previous stream');
replacement.packet();
replacement.context.advanceTo(5);
assert.ok(replacement.context.sources.at(-1).disconnected, 'Finished audio sources must release their connections');
replacement.engine.stopAll();
assert.deepEqual(replacement.engine.activeStreamNames(), []);

console.log('Audio check passed: burst delivery, jitter, continuous speech, underrun recovery, bounded backlog, and stream cleanup.');
