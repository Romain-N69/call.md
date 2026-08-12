import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class AudioCapture: NSObject, SCStreamOutput {
    private let folder: URL
    private let startedAt: Int64
    private let queue = DispatchQueue(label: "com.thales.synapse-call.audio")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var captureStart: CMTime?
    private var segmentStart: CMTime?
    private var segmentURL: URL?
    private var stopping = false

    init(folder: URL, startedAt: Int64) {
        self.folder = folder
        self.startedAt = startedAt
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NSError(domain: "SystemAudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available"]) }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 16_000
        configuration.channelCount = 1
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
        emit(["ready": true])
    }

    func stop() async {
        stopping = true
        try? await stream?.stopCapture()
        await finishWriter()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if captureStart == nil { captureStart = timestamp }
        if writer == nil { startWriter(at: timestamp) }
        if let start = segmentStart, CMTimeGetSeconds(timestamp - start) >= 20 {
            finishWriterSync()
            startWriter(at: timestamp)
        }
        if input?.isReadyForMoreMediaData == true { input?.append(sampleBuffer) }
    }

    private func startWriter(at timestamp: CMTime) {
        let offset = max(0, Int64(CMTimeGetSeconds(timestamp - (captureStart ?? timestamp)) * 1000))
        let url = folder.appendingPathComponent("system-\(startedAt + offset).m4a")
        do {
            let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000,
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw NSError(domain: "SystemAudioCapture", code: 2) }
            writer.add(input)
            writer.startWriting()
            writer.startSession(atSourceTime: timestamp)
            self.writer = writer
            self.input = input
            segmentStart = timestamp
            segmentURL = url
        } catch { emit(["error": error.localizedDescription]) }
    }

    private func finishWriterSync() {
        guard let writer, let input, let url = segmentURL, let start = segmentStart else { return }
        self.writer = nil; self.input = nil; segmentURL = nil; segmentStart = nil
        input.markAsFinished()
        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting {
            if writer.status == .completed {
                let offset = Int64(CMTimeGetSeconds(start - (self.captureStart ?? start)) * 1000)
                self.emit(["path": url.path, "startedAt": self.startedAt + max(0, offset)])
            } else if let error = writer.error { self.emit(["error": error.localizedDescription]) }
            semaphore.signal()
        }
        semaphore.wait()
    }

    private func finishWriter() async { queue.sync { finishWriterSync() } }

    private func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
        print(line); fflush(stdout)
    }
}

@main struct Main {
    static func main() async {
        guard CommandLine.arguments.count == 3, let startedAt = Int64(CommandLine.arguments[2]) else {
            fputs("usage: SystemAudioCapture <folder> <startedAt>\n", stderr); exit(2)
        }
        let capture = AudioCapture(folder: URL(fileURLWithPath: CommandLine.arguments[1]), startedAt: startedAt)
        do {
            try await capture.start()
            _ = readLine()
            await capture.stop()
        } catch {
            let data = try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])
            if let data, let line = String(data: data, encoding: .utf8) { print(line) }
            exit(1)
        }
    }
}
