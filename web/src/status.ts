export type SetupStage =
  | 'preparing' | 'finding_iphone' | 'pairing_required' | 'bluetooth_connecting'
  | 'identifying' | 'authenticating' | 'awaiting_carplay' | 'wifi_connecting'
  | 'pairing' | 'starting_carplay' | 'connected' | 'reconnecting' | 'error' | 'waiting';

export interface ConnectionStatus {
  stage: SetupStage;
  detail?: string | null;
  wifiSsid?: string | null;
  wirelessEnabled?: boolean;
}

export interface StatusView {
  title: string;
  detail: string;
  kind: 'idle' | 'busy' | 'action' | 'error' | 'live';
  step: number;
  showSteps: boolean;
}

const stages: Record<SetupStage, Omit<StatusView, 'showSteps'>> = {
  preparing: { title: 'Preparing wireless setup…', detail: 'Checking the server’s Wi-Fi network and Bluetooth helper.', kind: 'busy', step: -1 },
  finding_iphone: { title: 'Looking for your iPhone…', detail: 'Checking saved Bluetooth pairings. Keep your iPhone nearby with Bluetooth turned on.', kind: 'busy', step: 0 },
  pairing_required: { title: 'Pair your iPhone', detail: 'Open Settings → Bluetooth on your iPhone and pair it using the server’s Bluetooth helper. Confirm the pairing request on both devices.', kind: 'action', step: 0 },
  bluetooth_connecting: { title: 'Connecting Bluetooth…', detail: 'Opening the Bluetooth connection. Keep your iPhone nearby and unlocked.', kind: 'busy', step: 0 },
  identifying: { title: 'Setting up the iPhone connection…', detail: 'Opening the Bluetooth link and exchanging device information with your iPhone.', kind: 'busy', step: 0 },
  authenticating: { title: 'Authenticating CarPlay…', detail: 'Your iPhone is verifying PlayPort’s accessory identity.', kind: 'busy', step: 1 },
  awaiting_carplay: { title: 'Waiting for your iPhone…', detail: 'Accept the CarPlay prompt on your iPhone. PlayPort is ready to share the Wi-Fi connection.', kind: 'action', step: 2 },
  wifi_connecting: { title: 'Connecting to Wi-Fi…', detail: 'Wi-Fi details were sent to your iPhone. Waiting for it to connect to PlayPort over the network.', kind: 'busy', step: 2 },
  pairing: { title: 'Pairing with your iPhone…', detail: 'Accept the CarPlay pairing prompt on your iPhone. If asked for a PIN, enter 3939.', kind: 'action', step: 3 },
  starting_carplay: { title: 'Starting CarPlay…', detail: 'Your iPhone reached PlayPort over Wi-Fi. Setting up the CarPlay session.', kind: 'busy', step: 3 },
  connected: { title: 'CarPlay connected', detail: 'Your iPhone is connected and the CarPlay screen is live.', kind: 'live', step: 4 },
  reconnecting: { title: 'Reconnecting your iPhone…', detail: 'The iPhone disconnected. PlayPort will retry automatically. Keep Bluetooth and Wi-Fi turned on.', kind: 'busy', step: -1 },
  error: { title: 'Connection needs attention', detail: 'Wireless setup could not finish. Check Bluetooth, pairing, and the server’s Wi-Fi settings.', kind: 'error', step: -1 },
  waiting: { title: 'Waiting for your iPhone', detail: 'Pair your iPhone over Bluetooth, then accept the CarPlay prompt.', kind: 'idle', step: -1 },
};

/** A session is only shown as live once this viewer has painted its first video frame. */
export function connectionView(status: ConnectionStatus, sessionActive = false, videoLive = false): StatusView {
  if (sessionActive) {
    return videoLive
      ? { ...stages.connected, showSteps: status.wirelessEnabled !== false }
      : { title: 'Waiting for CarPlay video…', detail: 'CarPlay is connected. Waiting for the first video frame from your iPhone.', kind: 'busy', step: 3, showSteps: status.wirelessEnabled !== false };
  }
  // Older/newer servers may not provide a recognized setup stage.
  const view = Object.hasOwn(stages, status.stage) && status.stage !== 'connected' ? stages[status.stage] : stages.waiting;
  const network = status.stage === 'wifi_connecting' && status.wifiSsid ? `Network: ${status.wifiSsid}. ` : '';
  return { ...view, detail: network + (status.detail || view.detail), showSteps: status.wirelessEnabled !== false };
}
