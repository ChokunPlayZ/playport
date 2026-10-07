// playport macOS Bluetooth bridge.
//
// Opens an RFCOMM channel to a paired iPhone's iAP2 service and pipes raw bytes between the
// channel and stdin/stdout, so the JVM server can speak the wireless iAP2 bootstrap over a local
// process instead of native code.
//
// Usage:
//   bt-bridge --print-address          print the local Bluetooth adapter address
//   bt-bridge --list                   list paired devices as "AA:BB:CC:DD:EE:FF Name"
//   bt-bridge --unpair <addr>          forget this device's saved Mac bond
//   bt-bridge --force-pair <addr>      forget the saved Mac bond and pair again
//   bt-bridge --address <addr>         open RFCOMM to the device and pump stdio
//
// The iPhone must already be paired in System Settings > Bluetooth.

import Foundation
import IOBluetooth
import Darwin

let iap2UUIDString = "00000000-deca-fade-deca-deafdecacafe"

// macOS TCC stops processes that touch Bluetooth without permission via SIGABRT.
// Turn that silent abort into actionable advice.
signal(SIGABRT) { _ in
    let hint = """
    bt-bridge was stopped by macOS: this process does not have Bluetooth permission.
    Open System Settings > Privacy & Security > Bluetooth and enable your terminal app
    (Terminal, iTerm2, VS Code, Warp, ...), then run the command again.

    """
    FileHandle.standardError.write(hint.data(using: .utf8)!)
    exit(134)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("bt-bridge: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

func normalize(_ address: String) -> String {
    address.replacingOccurrences(of: ":", with: "-").lowercased()
}

func formatStatus(_ status: IOReturn) -> String {
    "0x" + String(UInt32(bitPattern: status), radix: 16)
}

/// IOBluetooth has no public unpair API. This guarded selector is also used by blueutil.
/// Verify removal instead of assuming that sending the private message succeeded.
func forgetDevice(_ device: IOBluetoothDevice) {
    let address = normalize(device.addressString ?? "")
    guard !address.isEmpty else { fail("cannot forget a device without an address") }
    guard device.isPaired() else { return }
    let remove = NSSelectorFromString("remove")
    guard device.responds(to: remove) else {
        fail("this macOS version cannot forget the device through IOBluetooth; use Forget This Device in Bluetooth settings")
    }
    if device.isConnected() {
        let status = device.closeConnection()
        guard status == kIOReturnSuccess else {
            fail("could not disconnect before forgetting the device (status \(formatStatus(status)))")
        }
    }
    _ = device.perform(remove)
    let deadline = Date().addingTimeInterval(10)
    repeat {
        // pairedDevices() can retain a cloud-linked iPhone after its Classic bond is
        // removed. Check the bond flag on the target instead of membership in that list.
        if !device.isPaired() {
            print("forgot saved Mac pairing for \(address)")
            fflush(stdout)
            return
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    } while Date() < deadline
    fail("the device is still paired after the removal request; use Forget This Device in Bluetooth settings")
}

func unpair(address: String) {
    guard let device = IOBluetoothDevice(addressString: normalize(address)) else {
        fail("invalid Bluetooth address: \(address)")
    }
    if !device.isPaired() {
        print("\(address) has no saved Mac pairing")
        return
    }
    forgetDevice(device)
}

/// Runs a blocking IOBluetooth call with a watchdog so missing permissions never hang the helper.
func withTimeout<T>(_ seconds: Double, _ label: String, _ operation: @escaping () -> T?) -> T? {
    let semaphore = DispatchSemaphore(value: 0)
    var result: T?
    DispatchQueue.global().async {
        result = operation()
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + seconds) == .timedOut {
        FileHandle.standardError.write("bt-bridge: \(label) timed out; grant Bluetooth permission to your terminal in System Settings > Privacy & Security > Bluetooth\n".data(using: .utf8)!)
        return nil
    }
    return result
}

func printAddress() {
    let address = withTimeout(3.0, "address lookup") {
        IOBluetoothHostController.default()?.addressAsString()
    }
    guard let address = address else {
        fail("local Bluetooth address unavailable")
    }
    print(address.uppercased().replacingOccurrences(of: "-", with: ":"))
}

func listPaired() {
    let paired = withTimeout(3.0, "paired-device lookup") {
        IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]
    }
    guard let devices = paired else {
        fail("paired device list unavailable")
    }
    for device in devices {
        let address = (device.addressString ?? "").uppercased().replacingOccurrences(of: "-", with: ":")
        let name = device.name ?? ""
        print("\(address) \(name)")
    }
}

final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    private var channel: IOBluetoothRFCOMMChannel?
    private var openTimer: Timer?
    private var channelOpened = false

    func start(address: String) {
        // Enumerating pairedDevices can mark a cloud-linked iPhone as paired even
        // after its Classic bond was removed. Query the addressed device directly.
        guard let device = IOBluetoothDevice(addressString: normalize(address)), device.isPaired() else {
            fail("device \(address) has no saved pairing; run --pair \(address) with the iPhone's Bluetooth settings open")
        }
        let uuid = IOBluetoothSDPUUID(data: Data(hexUUID: iap2UUIDString))
        let queried = withTimeout(12.0, "SDP query") { device.getServiceRecord(for: uuid) }
        guard let record = queried else {
            fail("the device does not expose the iAP2 service; is it paired and in range?")
        }
        var channelID: BluetoothRFCOMMChannelID = 0
        let channelStatus = record.getRFCOMMChannelID(&channelID)
        guard channelStatus == kIOReturnSuccess else {
            fail("could not read the RFCOMM channel id (status \(formatStatus(channelStatus)))")
        }
        var rfcommChannel: IOBluetoothRFCOMMChannel?
        let openStatus = device.openRFCOMMChannelAsync(&rfcommChannel, withChannelID: channelID, delegate: self)
        guard openStatus == kIOReturnSuccess, let opened = rfcommChannel else {
            fail("could not open the RFCOMM channel (status \(formatStatus(openStatus)))")
        }
        channel = opened
        FileHandle.standardError.write("bt-bridge: RFCOMM channel \(channelID) opening to \(address)\n".data(using: .utf8)!)
        // The open callback may run before openRFCOMMChannelAsync returns.
        if !channelOpened {
            openTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in
                fail("RFCOMM did not open within 30s; if the saved pairing keys differ, forget the Mac on the iPhone and run --force-pair \(address)")
            }
        }
        // IOBluetooth does not retain its delegate. Keep it alive while waiting to
        // install the stdin handler, which will retain it after the channel opens.
        withExtendedLifetime(self) { RunLoop.main.run() }
    }

    private func pumpStdin() {
        let input = FileHandle.standardInput
        input.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                FileHandle.standardError.write("bt-bridge: stdin closed\n".data(using: .utf8)!)
                exit(0)
            }
            guard let channel = self.channel, channel.isOpen() else {
                fail("RFCOMM write failed: channel is not open (kIOReturnNotOpen, \(formatStatus(kIOReturnNotOpen)))")
            }
            var buffer = [UInt8](data)
            let mtu = Int(channel.getMTU())
            guard mtu > 0 else { fail("RFCOMM has no negotiated MTU") }
            buffer.withUnsafeMutableBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let count = min(mtu, bytes.count - offset, Int(UInt16.max))
                    let status = channel.writeSync(bytes.baseAddress!.advanced(by: offset), length: UInt16(count))
                    guard status == kIOReturnSuccess else {
                        fail("RFCOMM write failed (status \(formatStatus(status))); stopping the bridge")
                    }
                    offset += count
                }
            }
        }
    }

    func rfcommChannelOpenComplete(_ sender: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        openTimer?.invalidate()
        openTimer = nil
        if error == kIOReturnSuccess, let sender = sender, sender.isOpen() {
            guard !channelOpened else { return }
            channelOpened = true
            channel = sender
            FileHandle.standardError.write("bt-bridge: RFCOMM channel open\n".data(using: .utf8)!)
            pumpStdin()
        } else {
            fail("RFCOMM open failed (status \(formatStatus(error))); the channel is not open")
        }
    }

    func rfcommChannelData(_ sender: IOBluetoothRFCOMMChannel!, data dataPointer: UnsafeMutableRawPointer!, length dataLength: Int) {
        let data = Data(bytes: dataPointer, count: dataLength)
        FileHandle.standardOutput.write(data)
    }

    func rfcommChannelClosed(_ sender: IOBluetoothRFCOMMChannel!) {
        FileHandle.standardError.write("bt-bridge: RFCOMM channel closed\n".data(using: .utf8)!)
        exit(0)
    }
}

extension Data {
    init(hexUUID: String) {
        var bytes = [UInt8]()
        var hex = hexUUID.replacingOccurrences(of: "-", with: "")
        if hex.count == 4 {
            hex = "0000" + hex + "00001000800000805F9B34FB"
        }
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0)
            index = next
        }
        self.init(bytes)
    }
}

// MARK: - Inquiry and pairing
//
// macOS hides iPhones from the Bluetooth settings UI (they pair via Continuity), so the helper
// discovers and pairs them through the IOBluetooth API instead. Keep the iPhone's
// Settings > Bluetooth page open while scanning: that is what makes it discoverable.

final class Scanner: NSObject, IOBluetoothDeviceInquiryDelegate {
    private var inquiry: IOBluetoothDeviceInquiry?
    private var seen = Set<String>()

    func start(seconds: UInt8) {
        guard let inquiry = IOBluetoothDeviceInquiry(delegate: self) else {
            fail("could not create a device inquiry")
        }
        self.inquiry = inquiry
        inquiry.inquiryLength = seconds
        inquiry.updateNewDeviceNames = true
        let status = inquiry.start()
        guard status == kIOReturnSuccess else {
            fail("inquiry failed to start (status 0x\(String(status, radix: 16))); grant Bluetooth permission to your terminal")
        }
        FileHandle.standardError.write("bt-bridge: scanning for \(seconds)s — keep the iPhone's Bluetooth settings page open\n".data(using: .utf8)!)
        RunLoop.main.run()
    }

    func deviceInquiryDeviceFound(_ sender: IOBluetoothDeviceInquiry!, device: IOBluetoothDevice!) {
        let address = (device.addressString ?? "").uppercased().replacingOccurrences(of: "-", with: ":")
        guard !address.isEmpty, seen.insert(address).inserted else { return }
        let name = device.name ?? ""
        let kind = device.isPaired() ? "paired" : "new"
        print("\(address) \(name) [\(kind)]")
        fflush(stdout)
    }

    func deviceInquiryComplete(_ sender: IOBluetoothDeviceInquiry!, error: IOReturn, aborted: Bool) {
        if error != kIOReturnSuccess && !aborted {
            fail("inquiry ended with status 0x\(String(error, radix: 16))")
        }
        exit(0)
    }
}

final class Pairer: NSObject, IOBluetoothDevicePairDelegate, IOBluetoothDeviceInquiryDelegate {
    private let target: String
    private let force: Bool
    private var inquiry: IOBluetoothDeviceInquiry?
    private var pairing: IOBluetoothDevicePair?
    private var pairingStarted = false
    private var finished = false

    init(target: String, force: Bool) {
        self.target = target
        self.force = force
    }

    func run() {
        guard let device = IOBluetoothDevice(addressString: normalize(target)) else {
            fail("invalid Bluetooth address: \(target)")
        }
        if device.isPaired() {
            if !force {
                print("\(target) is already paired; nothing to do.")
                print("Start the server with --wireless and it will find the iPhone (or check --list).")
                exit(0)
            }
            forgetDevice(device)
            guard let freshDevice = IOBluetoothDevice(addressString: normalize(target)) else {
                fail("could not recreate the device after forgetting its saved pairing")
            }
            beginPairing(with: freshDevice)
            return
        }
        if force {
            beginPairing(with: device)
            return
        }
        FileHandle.standardError.write(
            "bt-bridge: \(target) is not paired yet; scanning — keep the iPhone's Bluetooth settings page open\n"
                .data(using: .utf8)!,
        )
        guard let inquiry = IOBluetoothDeviceInquiry(delegate: self) else {
            fail("could not create a device inquiry")
        }
        self.inquiry = inquiry
        inquiry.inquiryLength = 20
        inquiry.updateNewDeviceNames = true
        guard inquiry.start() == kIOReturnSuccess else {
            fail("inquiry failed to start; grant Bluetooth permission to your terminal")
        }
        RunLoop.main.run()
    }

    private func beginPairing(with device: IOBluetoothDevice) {
        guard !pairingStarted else { return }
        pairingStarted = true
        inquiry?.stop()
        inquiry = nil
        if #available(macOS 27.0, *) {
            // On macOS 27, IOBluetoothDevicePair can retrieve a dual-mode iPhone as an LE
            // peripheral and stall there. Authenticate its Classic baseband connection directly.
            pairClassic(with: device)
            return
        }
        guard let pairing = IOBluetoothDevicePair(device: device) else {
            fail("could not create a pairing session")
        }
        self.pairing = pairing
        pairing.delegate = self
        let status = pairing.start()
        guard status == kIOReturnSuccess else {
            fail("pairing failed to start (status 0x\(String(status, radix: 16)))")
        }
        FileHandle.standardError.write("bt-bridge: pairing with \(device.addressString ?? target)…\n".data(using: .utf8)!)
        let watchdog = DispatchQueue.global()
        watchdog.asyncAfter(deadline: .now() + 45) {
            if !self.finished {
                fail("pairing timed out after 45s; make sure the iPhone is awake and unlocked with Settings > Bluetooth open, then retry")
            }
        }
        RunLoop.main.run()
    }

    private func pairClassic(with device: IOBluetoothDevice) {
        FileHandle.standardError.write("bt-bridge: starting Bluetooth Classic pairing with \(target); confirm any pairing request on the Mac and iPhone\n".data(using: .utf8)!)
        let watchdog = DispatchWorkItem {
            fail("Classic pairing timed out after 60s; keep the iPhone unlocked with Bluetooth settings open and check for a pairing request on both devices")
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: watchdog)
        defer { watchdog.cancel() }
        if !device.isConnected() {
            let status = device.openConnection()
            guard status == kIOReturnSuccess || device.isConnected() else {
                fail("Classic connection failed (status \(formatStatus(status)))")
            }
        }
        FileHandle.standardError.write("bt-bridge: Classic connection established; requesting authentication\n".data(using: .utf8)!)
        let status = device.requestAuthentication()
        guard status == kIOReturnSuccess else {
            fail("Classic authentication failed (status \(formatStatus(status))); forget this Mac on the iPhone, then retry --force-pair \(target)")
        }
        // The macOS 27 compatibility layer may return before its numeric-comparison
        // request has been confirmed. Keep the process and run loop alive until bonded.
        if !device.isPaired() {
            FileHandle.standardError.write("bt-bridge: waiting for pairing confirmation on the Mac and iPhone\n".data(using: .utf8)!)
        }
        while !device.isPaired() {
            guard device.isConnected() else {
                fail("Classic pairing ended without a saved pairing; check the pairing request on both devices and retry")
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        print("paired with \(target)")
        exit(0)
    }

    func devicePairingStarted(_ sender: Any!) {
        FileHandle.standardError.write("bt-bridge: pairing started; waiting for connection and a confirmation request\n".data(using: .utf8)!)
    }

    func devicePairingConnecting(_ sender: Any!) {
        FileHandle.standardError.write("bt-bridge: link connecting…\n".data(using: .utf8)!)
    }

    func deviceInquiryDeviceFound(_ sender: IOBluetoothDeviceInquiry!, device: IOBluetoothDevice!) {
        guard normalize(device.addressString ?? "") == normalize(target) else { return }
        beginPairing(with: device)
    }

    func deviceInquiryComplete(_ sender: IOBluetoothDeviceInquiry!, error: IOReturn, aborted: Bool) {
        if !pairingStarted {
            fail("device \(target) was not found; make sure it is discoverable (Bluetooth settings open) and try again")
        }
    }

    func devicePairingUserConfirmationRequest(_ sender: Any!, numericValue: BluetoothNumericValue) {
        let code = String(format: "%06u", numericValue)
        print("confirm this code on the iPhone: \(code)")
        fflush(stdout)
        pairing?.replyUserConfirmation(true)
    }

    func devicePairingUserPasskeyNotification(_ sender: Any!, passkey: BluetoothPasskey) {
        print("enter this passkey on the iPhone: \(String(format: "%06u", passkey))")
        fflush(stdout)
    }

    func devicePairingPINCodeRequest(_ sender: Any!) {
        // Legacy PIN path; modern iPhones use numeric comparison and never reach this.
        fail("the device requested a legacy PIN code; this helper supports numeric pairing only")
    }

    func devicePairingFinished(_ sender: Any!, error: IOReturn) {
        finished = true
        if error == kIOReturnSuccess {
            print("paired with \(target)")
            exit(0)
        }
        fail("pairing finished with status 0x\(String(error, radix: 16)); remove any stale pairing and retry")
    }
}

let args = CommandLine.arguments
if args.contains("--print-address") {
    printAddress()
} else if args.contains("--list") {
    listPaired()
} else if args.contains("--scan") {
    Scanner().start(seconds: 10)
} else if let index = args.firstIndex(of: "--unpair"), index + 1 < args.count {
    unpair(address: args[index + 1])
} else if let index = args.firstIndex(of: "--pair"), index + 1 < args.count {
    Pairer(target: args[index + 1], force: false).run()
} else if let index = args.firstIndex(of: "--force-pair"), index + 1 < args.count {
    Pairer(target: args[index + 1], force: true).run()
} else if let index = args.firstIndex(of: "--address"), index + 1 < args.count {
    Bridge().start(address: args[index + 1])
} else {
    fail("usage: bt-bridge --print-address | --list | --scan | --unpair <addr> | --pair <addr> | --force-pair <addr> | --address <addr>")
}
