import CoreMedia
import Foundation
import ScreenCaptureKit

final class AudioCapture: NSObject, SCStreamOutput {
    private let folder: URL
    private let startedAt: Int64
    private let queue = DispatchQueue(label: "com.thales.synapse-call.audio")
    private let sampleRate = 16_000
    private let chunkSeconds = 4
    private var stream: SCStream?
    private var fullFile: FileHandle?
    private var fullBytes: UInt32 = 0
    private var chunk = Data()
    private var chunkStartSample: Int64 = 0
    private var totalSamples: Int64 = 0
    private var chunkPeakDb: Float = -160
    private var lastLevelEmission = Date.distantPast

    init(folder: URL, startedAt: Int64) { self.folder = folder; self.startedAt = startedAt }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NSError(domain: "SystemAudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available"]) }
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = sampleRate
        configuration.channelCount = 1
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        let fullURL = folder.appendingPathComponent("system-full.wav")
        FileManager.default.createFile(atPath: fullURL.path, contents: wavHeader(dataBytes: 0))
        fullFile = try FileHandle(forWritingTo: fullURL)
        try fullFile?.seekToEnd()
        try await stream.startCapture()
        emit(["ready": true])
    }

    func stop() async {
        try? await stream?.stopCapture()
        queue.sync {
            flushChunk()
            try? fullFile?.seek(toOffset: 0)
            try? fullFile?.write(contentsOf: wavHeader(dataBytes: fullBytes))
            try? fullFile?.close()
            fullFile = nil
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 0, mData: nil))
        var retained: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: &list, bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, blockBufferOut: &retained)
        guard status == noErr, let pointer = list.mBuffers.mData else { return }
        let byteCount = Int(list.mBuffers.mDataByteSize)
        let sampleCount = byteCount / MemoryLayout<Float>.size
        guard sampleCount > 0 else { return }
        let samples = pointer.assumingMemoryBound(to: Float.self)
        var sum: Float = 0
        for index in 0..<sampleCount { sum += samples[index] * samples[index] }
        let db = 20 * log10(max(sqrt(sum / Float(sampleCount)), 0.00000001))
        chunkPeakDb = max(chunkPeakDb, db)
        if Date().timeIntervalSince(lastLevelEmission) >= 0.1 { emit(["levelDb": db]); lastLevelEmission = Date() }
        let data = Data(bytes: pointer, count: byteCount)
        chunk.append(data)
        try? fullFile?.write(contentsOf: data)
        fullBytes += UInt32(byteCount)
        totalSamples += Int64(sampleCount)
        if chunk.count >= sampleRate * chunkSeconds * MemoryLayout<Float>.size { flushChunk() }
    }

    private func flushChunk() {
        guard !chunk.isEmpty else { return }
        let offsetMs = chunkStartSample * 1000 / Int64(sampleRate)
        let url = folder.appendingPathComponent("system-\(startedAt + offsetMs).wav")
        var file = wavHeader(dataBytes: UInt32(chunk.count)); file.append(chunk)
        do {
            try file.write(to: url, options: .atomic)
            emit(["path": url.path, "startedAt": startedAt + offsetMs, "peakDb": chunkPeakDb])
        } catch { emit(["error": error.localizedDescription]) }
        chunkStartSample = totalSamples
        chunk.removeAll(keepingCapacity: true)
        chunkPeakDb = -160
    }

    private func wavHeader(dataBytes: UInt32) -> Data {
        var data = Data()
        func text(_ value: String) { data.append(value.data(using: .ascii)!) }
        func u16(_ value: UInt16) { var value = value.littleEndian; data.append(Data(bytes: &value, count: 2)) }
        func u32(_ value: UInt32) { var value = value.littleEndian; data.append(Data(bytes: &value, count: 4)) }
        text("RIFF"); u32(36 + dataBytes); text("WAVEfmt "); u32(16); u16(3); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 4)); u16(4); u16(32); text("data"); u32(dataBytes)
        return data
    }

    private func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
        print(line); fflush(stdout)
    }
}

@main struct Main {
    static func main() async {
        guard CommandLine.arguments.count == 3, let startedAt = Int64(CommandLine.arguments[2]) else { exit(2) }
        let capture = AudioCapture(folder: URL(fileURLWithPath: CommandLine.arguments[1]), startedAt: startedAt)
        do { try await capture.start(); _ = readLine(); await capture.stop() }
        catch {
            if let data = try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription]), let line = String(data: data, encoding: .utf8) { print(line) }
            exit(1)
        }
    }
}
