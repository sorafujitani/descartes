import AppKit
import ImageIO

/// ImageIO decompression is serialized on an actor, never on the editor's main executor.
actor NoteImageDecoder {
  static let shared = NoteImageDecoder()
  func thumbnail(_ bytes: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(
      src, 0,
      [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 960,
      ] as CFDictionary)
  }
}

/// Only the relative references produced by the notebook's attachment endpoint may carry credentials.
@MainActor final class NoteImages {
  private static let block = try? NSRegularExpression(
    pattern:
      #"^[ \t]*!\[(?:\\.|[^\]\\])*\]\(\.\./assets/("# + API.assetName + #")\)[ \t]*$"#)
  static func name(in line: String) -> String? {
    let raw = line as NSString
    guard let match = block?.firstMatch(in: line, range: .init(location: 0, length: raw.length))
    else { return nil }
    return raw.substring(with: match.range(at: 1))
  }

  private var loaded: [String: NSImage] = [:]
  private var attempted = Set<String>()
  func image(_ name: String, demo: Bool, refresh: @escaping () -> Void) -> NSImage? {
    if let image = loaded[name] { return image }
    if attempted.insert(name).inserted {
      Task { [weak self] in
        guard let bytes = try? await API(demo: demo).imageData(name), self != nil,
          let thumbnail = await NoteImageDecoder.shared.thumbnail(bytes), let self
        else { return }
        loaded[name] = NSImage(
          cgImage: thumbnail, size: .init(width: thumbnail.width, height: thumbnail.height))
        refresh()
      }
    }
    return nil
  }
}
