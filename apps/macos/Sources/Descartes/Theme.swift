import AppKit
import SwiftUI

// Native counterparts of document-design-system/tokens.css and theme.css.
enum Theme {
  static func rgb(_ value: Int) -> NSColor {
    NSColor(
      srgbRed: CGFloat(value >> 16 & 255) / 255, green: CGFloat(value >> 8 & 255) / 255,
      blue: CGFloat(value & 255) / 255, alpha: 1)
  }
  static let text = rgb(0xe1e4e8), muted = rgb(0x8b949e), heading = rgb(0xffffff)
  static let accent = rgb(0x00d8ff), border = rgb(0x2d333b), panel = rgb(0x21262d)
  static let code = rgb(0x0d1117), codeText = rgb(0xe6edf3)
}
private struct Frost: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .hudWindow
    view.blendingMode = .behindWindow
    view.state = .active
    return view
  }
  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}
struct GlassSurface: View {
  @AppStorage("windowTransparency") private var transparency = 0.28
  @Environment(\.accessibilityReduceTransparency) private var reduce
  var body: some View {
    let amount = reduce ? 0 : min(0.8, max(0, transparency))
    ZStack {
      if amount > 0 { Frost() }
      LinearGradient(
        colors: [Color(nsColor: Theme.code), Color(nsColor: Theme.rgb(0x161b22))], startPoint: .top,
        endPoint: .bottomTrailing
      ).opacity(1 - amount)
      RadialGradient(
        colors: [Color(nsColor: Theme.rgb(0x0088cc)).opacity(0.15), .clear], center: .topLeading,
        startRadius: 0, endRadius: 420)
    }.accessibilityHidden(true)
  }
}
