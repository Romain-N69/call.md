import Foundation
import CoreAudio
import Darwin

struct Owner: Codable, Equatable {
    let pid: Int32
    let bundleId: String
    let path: String
}

func property<T: FixedWidthInteger>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func processObjects() -> [AudioObjectID] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var values = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    return AudioObjectGetPropertyData(system, &address, 0, nil, &size, &values) == noErr ? values : []
}

func bundleId(_ object: AudioObjectID) -> String {
    var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return "" }
    return value.takeRetainedValue() as String
}

func executable(_ pid: Int32) -> String {
    var buffer = [CChar](repeating: 0, count: 4096)
    return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : ""
}

func owners() -> [Owner] {
    processObjects().compactMap { object in
        guard property(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1,
              let pid = property(object, kAudioProcessPropertyPID, pid_t(-1)), pid >= 0 else { return nil }
        return Owner(pid: Int32(pid), bundleId: bundleId(object), path: executable(Int32(pid)))
    }.sorted { $0.pid < $1.pid }
}

func defaultInputIsRunning() -> Bool {
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard let device = property(system, kAudioHardwarePropertyDefaultInputDevice, AudioDeviceID(0)), device != kAudioObjectUnknown else { return false }
    return property(device, kAudioDevicePropertyDeviceIsRunningSomewhere, UInt32(0)) == 1
}

Thread { while readLine(strippingNewline: false) != nil {}; exit(0) }.start()
setbuf(stdout, nil)
let encoder = JSONEncoder()
var previousOwners: [Owner] = [], previousUse: Bool?
while true {
    let currentOwners = owners(), inUse = defaultInputIsRunning() || !currentOwners.isEmpty
    if previousUse != inUse || previousOwners != currentOwners {
        previousUse = inUse; previousOwners = currentOwners
        let payload: [String: Any] = ["micInUse": inUse, "owners": currentOwners.map { ["pid": $0.pid, "bundleId": $0.bundleId, "path": $0.path] }]
        if let data = try? JSONSerialization.data(withJSONObject: payload), let line = String(data: data, encoding: .utf8) { print(line) }
    }
    Thread.sleep(forTimeInterval: 1)
}
