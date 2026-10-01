import { AudioEngine } from './audio';
import { InputController } from './input';
import { MicrophoneUplink } from './mic';
import type { ServerMessage, WireMessage } from './protocol';
import { VideoPlayer } from './video';
import { Connection, type ConnectionState } from './ws';

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} element`);
  return element as T;
}

function resolveToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('playport-token', fromUrl);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  return localStorage.getItem('playport-token') ?? '';
}

const canvas = requiredElement<HTMLCanvasElement>('screen');
const surface = requiredElement<HTMLDivElement>('surface');
const statusDot = requiredElement<HTMLSpanElement>('status-dot');
const statusText = requiredElement<HTMLSpanElement>('status-text');
const overlay = requiredElement<HTMLDivElement>('overlay');
const overlayText = requiredElement<HTMLParagraphElement>('overlay-text');
const errorBanner = requiredElement<HTMLDivElement>('error-banner');
const streamInfo = requiredElement<HTMLSpanElement>('stream-info');
const micStatus = requiredElement<HTMLSpanElement>('mic-status');
const muteButton = requiredElement<HTMLButtonElement>('btn-mute');

let audioUnlocked = false;
let framesPainted = 0;
let framesReceived = 0;
let bytesReceived = 0;
let lastFrameArrival = 0;
let latencySampleMs = 0;
let streamWidth = 0;
let streamHeight = 0;

const video = new VideoPlayer(
  canvas,
  (message) => showError(message),
  () => {
    if (!video.isConfigured) return;
    framesPainted += 1;
    const now = performance.now();
    if (lastFrameArrival > 0) latencySampleMs = Math.max(0, now - lastFrameArrival);
    overlay.classList.add('hidden');
  },
  () => connection.send({ type: 'keyframe' }),
  (width, height) => {
    streamWidth = width;
    streamHeight = height;
  },
);

const microphone = new MicrophoneUplink(
  (payload, opus) => {
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = opus ? 0x11 : 0x10;
    frame.set(payload, 1);
    connection.sendBinary(frame);
  },
  (message) => {
    micStatus.textContent = message;
  },
);

const audio = new AudioEngine((message) => showError(message));

const token = resolveToken();
const connection = new Connection(token, {
  onWire: (message: WireMessage) => {
    switch (message.kind) {
      case 'video-config':
        video.configure(message);
        break;
      case 'video-frame':
        framesReceived += 1;
        lastFrameArrival = performance.now();
        video.pushFrame(message);
        break;
      case 'audio-config':
        audio.handleConfig(message);
        break;
      case 'audio-packet':
        audio.handlePacket(message);
        break;
      case 'audio-stopped':
        audio.stopStream(message.streamType);
        break;
      case 'screen-active':
        break;
    }
  },
  onServer: (message: ServerMessage) => applyServerState(message),
  onState: (state: ConnectionState) => applyConnectionState(state),
  onBytes: (count) => {
    bytesReceived += count;
  },
});

const input = new InputController(surface, (message) => connection.send(message));
input.attach();

function applyServerState(message: ServerMessage): void {
  switch (message.type) {
    case 'mic': {
      if (message.micActive === true) {
        void microphone.start({
          sampleRate: message.micRate ?? 16_000,
          channels: message.micChannels ?? 1,
          codec: message.micCodec ?? 'lpcm',
          samplesPerPacket: message.micSamplesPerPacket ?? 320,
          bitrate: message.micBitrate ?? null,
        });
      } else {
        void microphone.stop();
        micStatus.textContent = '';
      }
      break;
    }
    case 'hello':
    case 'session': {
      const device = message.deviceName ?? 'playport';
      const phone = message.message ?? null;
      const active = message.sessionActive === true;
      setStatus(active ? 'live' : 'idle', active ? `${phone ?? 'iPhone'} connected` : `${device} ready — waiting for an iPhone`);
      if (!active) {
        video.close();
        if (microphone.isActive) {
          void microphone.stop();
        }
        micStatus.textContent = '';
        overlay.classList.remove('hidden');
        setOverlayText('Waiting for CarPlay. Connect the iPhone to this server (wireless bootstrap or an existing session).');
      } else {
        setOverlayText('Connected. Waiting for the first video frame…');
      }
      break;
    }
    default:
      break;
  }
}

function applyConnectionState(state: ConnectionState): void {
  switch (state) {
    case 'connecting':
      setStatus('idle', 'Connecting to the server…');
      break;
    case 'open':
      setStatus('idle', 'Connected to the server');
      break;
    case 'closed':
      setStatus('idle', 'Disconnected — retrying…');
      break;
  }
}

function setStatus(kind: 'live' | 'idle', text: string): void {
  statusDot.dataset.state = kind;
  statusText.textContent = text;
}

function setOverlayText(text: string): void {
  overlayText.textContent = text;
}

function showError(message: string): void {
  if (!message) {
    errorBanner.classList.add('hidden');
    errorBanner.textContent = '';
    return;
  }
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function sendMedia(index: number): void {
  connection.send({ type: 'media', media: index });
}

function clickButton(id: string, handler: () => void): void {
  requiredElement<HTMLButtonElement>(id).addEventListener('click', (event) => {
    event.preventDefault();
    handler();
  });
}

clickButton('btn-home', () => connection.send({ type: 'knob', knob: { select: false, home: true, back: false, x: 0, y: 0, wheel: 0 } }));
clickButton('btn-back', () => connection.send({ type: 'knob', knob: { select: false, home: false, back: true, x: 0, y: 0, wheel: 0 } }));
clickButton('btn-select', () => connection.send({ type: 'knob', knob: { select: true, home: false, back: false, x: 0, y: 0, wheel: 0 } }));
clickButton('btn-siri', () => connection.send({ type: 'siri' }));
clickButton('btn-prev', () => sendMedia(5));
clickButton('btn-play', () => sendMedia(3));
clickButton('btn-next', () => sendMedia(4));
clickButton('btn-keyframe', () => connection.send({ type: 'keyframe' }));
clickButton('btn-fullscreen', () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen();
  }
});

muteButton.addEventListener('click', () => {
  const muted = muteButton.dataset.muted === 'true';
  muteButton.dataset.muted = muted ? 'false' : 'true';
  muteButton.textContent = muted ? 'Mute' : 'Unmute';
  audio.setVolume(muted ? 1 : 0);
});

async function unlockAudio(): Promise<void> {
  if (audioUnlocked) return;
  try {
    await audio.unlock();
    audioUnlocked = true;
  } catch {
    // The next gesture retries.
  }
}

window.addEventListener('pointerdown', () => void unlockAudio(), { once: false });
window.addEventListener('keydown', () => void unlockAudio(), { once: false });

if (!token) {
  setOverlayText('Missing access token. Open the URL printed by the server (it contains ?token=…).');
  overlay.classList.remove('hidden');
}

if (typeof VideoDecoder === 'undefined') {
  showError(
    'Video decoding needs WebCodecs, which browsers only expose in a secure context. ' +
      'Open the https:// URL printed by the server (accept the self-signed certificate warning once), ' +
      'not the plain http:// LAN address.',
  );
}

connection.connect();

// --- Display panel: resolution, orientation and CarPlay UI size ---

interface DisplayPreset {
  label: string;
  width: number;
  height: number;
  orientation: string;
}

interface DisplayInfo {
  width: number;
  height: number;
  fps: number;
  uiScale: number;
  hevc: boolean;
  orientation: string;
  presets: DisplayPreset[];
}

const displayPanel = requiredElement<HTMLDivElement>('display-panel');
const displayPresets = requiredElement<HTMLDivElement>('display-presets');
const displayWidthInput = requiredElement<HTMLInputElement>('display-width');
const displayHeightInput = requiredElement<HTMLInputElement>('display-height');
const displayUiScale = requiredElement<HTMLSelectElement>('display-uiscale');
const displayCodec = requiredElement<HTMLSelectElement>('display-codec');
const displayFps = requiredElement<HTMLSelectElement>('display-fps');
const displayStatus = requiredElement<HTMLParagraphElement>('display-status');

let hevcSupported = false;

async function probeHevcSupport(): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') return false;
  const probes = ['hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0', 'hvc1.1.6.L120.90', 'hvc1.2.4.L120.B0'];
  for (const codec of probes) {
    try {
      const support = await VideoDecoder.isConfigSupported({ codec });
      if (support.supported) return true;
    } catch {
      // Try the next probe.
    }
  }
  return false;
}

function renderPresets(presets: DisplayPreset[]): void {
  displayPresets.replaceChildren();
  for (const preset of presets) {
    const button = document.createElement('button');
    button.textContent = `${preset.label}`;
    button.title = preset.orientation;
    button.addEventListener('click', () => {
      displayWidthInput.value = String(preset.width);
      displayHeightInput.value = String(preset.height);
      for (const other of displayPresets.querySelectorAll('button')) {
        other.classList.remove('selected');
      }
      button.classList.add('selected');
    });
    displayPresets.append(button);
  }
}

async function refreshDisplayInfo(): Promise<void> {
  try {
    const response = await fetch('/api/display');
    const info = (await response.json()) as DisplayInfo;
    renderPresets(info.presets);
    displayUiScale.value = String(info.uiScale);
    displayWidthInput.value = String(info.width);
    displayHeightInput.value = String(info.height);
    displayFps.value = String(info.fps);
    displayCodec.value = info.hevc ? 'h265' : 'h264';
    hevcSupported = await probeHevcSupport();
    const hevcOption = displayCodec.querySelector('option[value="h265"]') as HTMLOptionElement | null;
    if (hevcOption) {
      hevcOption.disabled = !hevcSupported;
      hevcOption.textContent = hevcSupported
        ? 'H.265 / HEVC (sharper)'
        : 'H.265 / HEVC (unavailable in this browser)';
    }
    displayStatus.textContent =
      `Current: ${info.width}×${info.height} @ ${info.fps} fps (${info.orientation}), ` +
      `${info.hevc ? 'HEVC' : 'H.264'}, UI size ${info.uiScale}%`;
  } catch {
    displayStatus.textContent = 'Could not load display settings.';
  }
}

async function applyDisplay(): Promise<void> {
  const width = Number(displayWidthInput.value);
  const height = Number(displayHeightInput.value);
  const uiScale = Number(displayUiScale.value);
  const fps = Number(displayFps.value);
  const hevc = displayCodec.value === 'h265';
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    displayStatus.textContent = 'Enter a width and height.';
    return;
  }
  displayStatus.textContent = 'Applying…';
  try {
    const response = await fetch(`/api/display?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height, fps, uiScale, hevc }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    displayStatus.textContent =
      response.ok && body.ok
        ? 'Applied. CarPlay is restarting — video returns in a few seconds.'
        : (body.error ?? `Request failed (${response.status})`);
  } catch (error) {
    displayStatus.textContent = `Request failed: ${String(error)}`;
  }
}

clickButton('btn-display', () => {
  if (displayPanel.classList.contains('hidden')) {
    displayPanel.classList.remove('hidden');
    void refreshDisplayInfo();
  } else {
    displayPanel.classList.add('hidden');
  }
});
clickButton('btn-display-close', () => displayPanel.classList.add('hidden'));
clickButton('btn-display-match', () => {
  const ratio = window.devicePixelRatio || 1;
  const even = (value: number) => Math.max(480, Math.min(3840, Math.round((value * ratio) / 2) * 2));
  displayWidthInput.value = String(even(window.innerWidth));
  displayHeightInput.value = String(even(window.innerHeight));
  displayStatus.textContent =
    `Window physical pixels: ${displayWidthInput.value}×${displayHeightInput.value} (devicePixelRatio ${ratio}). ` +
    'Put the browser in fullscreen first for a 1:1 mapping.';
  for (const button of displayPresets.querySelectorAll('button')) button.classList.remove('selected');
});
clickButton('btn-display-apply', () => void applyDisplay());

// --- Stream statistics HUD ---

let statsTick = performance.now();

function updateStats(): void {
  const now = performance.now();
  const elapsedSeconds = Math.max(0.001, (now - statsTick) / 1000);
  statsTick = now;
  const fps = framesPainted / elapsedSeconds;
  const mbps = (bytesReceived * 8) / 1_000_000 / elapsedSeconds;
  const dropped = Math.max(0, framesReceived - framesPainted);
  const queue = video.decodeQueueSize;
  const latency = latencySampleMs;
  framesPainted = 0;
  framesReceived = 0;
  bytesReceived = 0;
  if (streamWidth === 0) {
    streamInfo.textContent = '';
    return;
  }
  const parts = [`Stream ${streamWidth}×${streamHeight}`];
  parts.push(`${fps.toFixed(0)} fps`);
  parts.push(`${mbps.toFixed(1)} Mbps`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  if (queue > 2) parts.push(`queue ${queue}`);
  if (latency > 0 && latency < 1000) parts.push(`${latency.toFixed(0)} ms`);
  streamInfo.textContent = parts.join(' · ');
}

window.setInterval(updateStats, 500);

// --- Call / night controls ---

clickButton('btn-answer', () => connection.send({ type: 'telephony', telephony: 1 }));
clickButton('btn-call-mute', () => connection.send({ type: 'telephony', telephony: 2 }));

let nightMode = false;
clickButton('btn-night', () => {
  nightMode = !nightMode;
  connection.send({ type: 'night', night: nightMode });
  requiredElement<HTMLButtonElement>('btn-night').dataset.active = nightMode ? 'true' : 'false';
});

// --- Audio mixer ---

const audioPanel = requiredElement<HTMLDivElement>('audio-panel');
const audioStreams = requiredElement<HTMLDivElement>('audio-streams');
const audioMaster = requiredElement<HTMLInputElement>('audio-master');
const audioStatus = requiredElement<HTMLParagraphElement>('audio-status');

const savedMaster = Number(localStorage.getItem('playport-master') ?? '100');
audioMaster.value = String(Number.isFinite(savedMaster) ? savedMaster : 100);
audio.setVolume(Number(audioMaster.value) / 100);

audioMaster.addEventListener('input', () => {
  const value = Number(audioMaster.value) / 100;
  audio.setVolume(value);
  localStorage.setItem('playport-master', String(audioMaster.value));
});

function streamGainKey(name: string): string {
  return `playport-gain-${name}`;
}

function ensureStreamSliders(): void {
  const names = audio.activeStreamNames();
  const existing = new Set(
    Array.from(audioStreams.querySelectorAll<HTMLElement>('[data-stream]'), (element) => element.dataset.stream ?? ''),
  );
  if (names.length === 0) {
    audioStatus.textContent = 'No CarPlay audio streams right now.';
  } else {
    audioStatus.textContent = '';
  }
  if (names.length === existing.size && names.every((name) => existing.has(name))) return;
  audioStreams.replaceChildren();
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'audio-stream-row';
    row.dataset.stream = name;
    const label = document.createElement('label');
    label.textContent = name;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    const stored = Number(localStorage.getItem(streamGainKey(name)) ?? '100');
    slider.value = String(Number.isFinite(stored) ? stored : 100);
    audio.setStreamGain(name, Number(slider.value) / 100);
    slider.addEventListener('input', () => {
      audio.setStreamGain(name, Number(slider.value) / 100);
      localStorage.setItem(streamGainKey(name), slider.value);
    });
    row.append(label, slider);
    audioStreams.append(row);
  }
}

window.setInterval(ensureStreamSliders, 1000);

clickButton('btn-audio', () => {
  if (audioPanel.classList.contains('hidden')) {
    audioPanel.classList.remove('hidden');
    ensureStreamSliders();
  } else {
    audioPanel.classList.add('hidden');
  }
});
clickButton('btn-audio-close', () => audioPanel.classList.add('hidden'));

if (!('mediaDevices' in navigator)) {
  micStatus.textContent = '';
}
