import AppKit
import SwiftUI

/// Decorations use UTF-16 source ranges; the backing storage always contains plain Markdown.
final class NoteText: NSTextView {
  static let ink = Theme.text
  static let muted = Theme.muted
  override func insertNewline(_ sender: Any?) {
    if !continueList() { super.insertNewline(sender) }
  }
  override func insertTab(_ sender: Any?) {
    if !indentItem(outdent: false) { super.insertTab(sender) }
  }
  override func insertBacktab(_ sender: Any?) {
    if !indentItem(outdent: true) { super.insertBacktab(sender) }
  }
  static let atomicMarker = NSAttributedString.Key("DescartesAtomicMarker")
  private func deleteMarker(backward: Bool) -> Bool {
    let selection = selectedRange()
    guard isEditable, !hasMarkedText(), selectedRanges.count == 1, let storage = textStorage else {
      return false
    }
    let first = selection.location - (backward && selection.length == 0 ? 1 : 0)
    let last = selection.length == 0 ? first : NSMaxRange(selection) - 1
    var deletion = selection
    for index in [first, last] where index >= 0 && index < storage.length {
      var range = NSRange()
      if storage.attribute(
        Self.atomicMarker, at: index, longestEffectiveRange: &range,
        in: NSRange(location: 0, length: storage.length)) != nil
      {
        deletion = NSUnionRange(deletion, range)
      }
    }
    guard deletion != selection else { return false }
    insertText("", replacementRange: deletion)
    return true
  }
  override func deleteBackward(_ sender: Any?) {
    if !deleteMarker(backward: true) { super.deleteBackward(sender) }
  }
  override func deleteForward(_ sender: Any?) {
    if !deleteMarker(backward: false) { super.deleteForward(sender) }
  }
  enum Mark {
    case task(Bool)
    case bullet, rule
    case image(NSImage, CGFloat)
  }
  struct Decoration {
    let at: Int
    let mark: Mark
  }
  var decorations: [Decoration] = []
  var codeBlocks: [NSRange] = []
  private(set) var lastDrawnCodeBlockCount = 0

  func box(at index: Int) -> NSRect? {
    guard let layout = layoutManager, index < (string as NSString).length else { return nil }
    let glyph = layout.glyphIndexForCharacter(at: index)
    let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    let location = layout.location(forGlyphAt: glyph)
    return NSRect(
      x: textContainerOrigin.x + line.minX + location.x,
      y: textContainerOrigin.y + line.midY - 6, width: 12, height: 12)
  }
  private func drawCodeBlocks(in visible: NSRange) {
    lastDrawnCodeBlockCount = 0
    guard let layout = layoutManager else { return }
    for block in codeBlocks where NSIntersectionRange(block, visible).length > 0 {
      lastDrawnCodeBlockCount += 1
      let glyphs = layout.glyphRange(forCharacterRange: block, actualCharacterRange: nil)
      guard glyphs.length > 0 else { continue }
      var union = NSRect.null
      layout.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, _, _ in
        union = union.union(
          rect.offsetBy(dx: self.textContainerOrigin.x, dy: self.textContainerOrigin.y))
      }
      guard !union.isNull else { continue }
      Theme.code.setFill()
      NSBezierPath(roundedRect: union, xRadius: 8, yRadius: 8).fill()
    }
  }
  override func draw(_ dirtyRect: NSRect) {
    guard let layout = layoutManager, let container = textContainer else {
      super.draw(dirtyRect)
      return
    }
    let visible = layout.characterRange(
      forGlyphRange: layout.glyphRange(
        forBoundingRect: dirtyRect.offsetBy(dx: -textContainerOrigin.x, dy: -textContainerOrigin.y),
        in: container), actualGlyphRange: nil)
    drawCodeBlocks(in: visible)
    super.draw(dirtyRect)
    for decoration in decorations where NSLocationInRange(decoration.at, visible) {
      guard let rect = box(at: decoration.at) else { continue }
      Self.muted.set()
      switch decoration.mark {
      case .task(let checked):
        let shape = NSBezierPath(
          roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3)
        shape.lineWidth = 1.2
        shape.stroke()
        if checked {
          let check = NSBezierPath()
          check.move(to: NSPoint(x: rect.minX + 2, y: rect.midY))
          check.line(to: NSPoint(x: rect.minX + 5, y: rect.maxY - 3))
          check.line(to: NSPoint(x: rect.maxX - 2, y: rect.minY + 3))
          check.lineWidth = 1.4
          check.stroke()
        }
      case .image(let image, let height):
        let available = max(1, bounds.width - textContainerInset.width - rect.minX)
        let scale = min(height / image.size.height, available / image.size.width)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(
          in: NSRect(
            x: rect.minX, y: rect.midY - size.height / 2, width: size.width, height: size.height),
          from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
      case .bullet:
        NSBezierPath(ovalIn: NSRect(x: rect.minX + 3, y: rect.midY - 2, width: 4, height: 4)).fill()
      case .rule:
        Self.muted.withAlphaComponent(0.45).setFill()
        NSRect(
          x: rect.minX, y: rect.midY,
          width: max(1, bounds.width - textContainerInset.width - rect.minX), height: 1
        ).fill()
      }
    }
  }
  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let index = characterIndexForInsertion(at: point)
    let raw = string as NSString
    let line = raw.lineRange(for: NSRange(location: min(index, raw.length), length: 0))
    if isEditable, !hasMarkedText(),
      let decoration = decorations.first(where: { NSLocationInRange($0.at, line) }),
      case .task(let checked) = decoration.mark, let rect = box(at: decoration.at),
      rect.insetBy(dx: -3, dy: -3).contains(point)
    {
      let range = NSRange(location: decoration.at + 3, length: 1)
      insertText(checked ? " " : "x", replacementRange: range)
      return
    }
    super.mouseDown(with: event)
  }
}

struct Editor: NSViewRepresentable {
  @ObservedObject var book: Notebook
  var source = false
  func makeCoordinator() -> Coordinator { Coordinator(book) }
  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    let storage = NSTextStorage()
    let layout = NSLayoutManager()
    let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    storage.addLayoutManager(layout)
    layout.addTextContainer(container)
    let view = NoteText(frame: .zero, textContainer: container)
    view.isVerticallyResizable = true
    view.isHorizontallyResizable = false
    view.autoresizingMask = [.width]
    container.widthTracksTextView = true
    view.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    view.usesFindBar = true
    view.isIncrementalSearchingEnabled = true
    view.isRichText = false
    view.allowsUndo = true
    view.isAutomaticQuoteSubstitutionEnabled = false
    view.isAutomaticDashSubstitutionEnabled = false
    view.isAutomaticTextReplacementEnabled = false
    view.textContainerInset = NSSize(width: 21, height: 10)
    container.lineFragmentPadding = 0
    view.drawsBackground = false
    view.textColor = NoteText.ink
    view.insertionPointColor = NoteText.ink
    view.font = .systemFont(ofSize: 14)
    view.delegate = context.coordinator
    view.setAccessibilityLabel("Markdown本文")
    scroll.documentView = view
    DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
    return scroll
  }
  func updateNSView(_ scroll: NSScrollView, context: Context) {
    guard let view = scroll.documentView as? NoteText else { return }
    let coord = context.coordinator
    view.isEditable = !book.busy && !book.preview
    if coord.focusRequest != book.focusRequest {
      coord.focusRequest = book.focusRequest
      DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
    }
    let changed = coord.revision != book.revision
    if changed {
      view.string = book.text
      view.undoManager?.removeAllActions()
      view.setSelectedRange(NSRange(location: book.base == nil ? 2 : 0, length: 0))
      coord.revision = book.revision
      coord.images = NoteImages()
    }
    if changed || source != coord.source || book.preview != coord.preview || coord.zoom != book.zoom
    {
      coord.zoom = book.zoom
      coord.preview = book.preview
      coord.source = source
      coord.style(view)
    }
  }
  // This text storage belongs exclusively to the main-actor NSTextView.
  @MainActor final class Coordinator: NSObject, NSTextViewDelegate, @preconcurrency NSTextStorageDelegate {
    let book: Notebook
    private static let urls = try? NSRegularExpression(pattern: #"https?://[^\s<>]+"#)
    private static let spans = try? NSRegularExpression(
      pattern:
        #"(?<!\\)(`)([^`]+)`|(\*\*)([^*]+)\*\*|(\*)([^*]+)\*|\[([^\]]+)\]\((https?://[^\s)]+)\)"#
    )
    var images = NoteImages()
    var zoom = 10
    var scale: CGFloat { CGFloat(zoom) / 10 }
    var preview = false
    var focusRequest = 0
    var revision = -1, source = false
    private struct Configuration: Equatable {
      let zoom: Int
      let source, preview: Bool
    }
    private var configuration: Configuration {
      .init(zoom: zoom, source: source, preview: preview)
    }
    private struct StyledLine {
      var range: NSRange
      let contentLength: Int
      let fenceBefore, fenceAfter: String?
      let imageName: String?
      var code: Bool { fenceBefore != nil || fenceAfter != nil }
    }
    private struct Edit {
      let range: NSRange  // NSTextStorage reports the edited range in the new UTF-16 text.
      let delta: Int
    }
    private weak var styledView: NoteText?
    private var lines: [StyledLine] = []
    private var styledLength = 0
    private var styledConfiguration: Configuration?
    private var cacheValid = false
    private var pendingEdit: Edit?
    private var pendingEditCount = 0
    /// Number of source lines parsed/attributed by the most recent styling operation.
    private(set) var lastStyledLineCount = 0

    init(_ book: Notebook) { self.book = book }
    func textStorage(
      _ textStorage: NSTextStorage, willProcessEditing editedMask: NSTextStorageEditActions,
      range editedRange: NSRange, changeInLength delta: Int
    ) {
      guard editedMask.contains(.editedCharacters), styledView?.textStorage === textStorage else {
        return
      }
      pendingEditCount += 1
      pendingEdit = .init(range: editedRange, delta: delta)
    }
    func textDidChange(_ notification: Notification) {
      guard let view = notification.object as? NoteText else { return }
      book.text = view.string
      guard !view.hasMarkedText() else {
        // Composition can make several overlapping replacements. Rebuild only after commit.
        cacheValid = false
        return
      }
      if !styleEditedLine(view) { style(view) }
    }
    private func styleInline(_ line: String, at: Int, in storage: NSTextStorage) {
      if !source, line.contains("://") {
        Self.urls?.enumerateMatches(
          in: line, range: NSRange(location: 0, length: line.utf16.count)
        ) { match, _, _ in
          guard let match else { return }
          storage.addAttributes(
            [
              .underlineStyle: NSUnderlineStyle.single.rawValue,
              .foregroundColor: Theme.accent,
            ], range: NSRange(location: at + match.range.location, length: match.range.length))
        }
      }
      if !source {
        Self.spans?.enumerateMatches(
          in: line, range: NSRange(location: 0, length: line.utf16.count)
        ) { match, _, _ in
          guard let match else { return }
          let groups = [2, 4, 6, 7]
          guard let group = groups.first(where: { match.range(at: $0).location != NSNotFound })
          else { return }
          let inner = match.range(at: group)
          let visible = NSRange(location: at + inner.location, length: inner.length)
          switch group {
          case 2:
            storage.addAttributes(
              [
                .font: NSFont.monospacedSystemFont(ofSize: 13 * self.scale, weight: .regular),
                .foregroundColor: Theme.accent, .backgroundColor: Theme.code,
              ], range: visible)
          case 4:
            storage.addAttribute(
              .font, value: NSFont.boldSystemFont(ofSize: 14 * self.scale), range: visible)
          case 6:
            storage.addAttribute(
              .font,
              value: NSFontManager.shared.convert(
                NSFont.systemFont(ofSize: 14 * self.scale), toHaveTrait: .italicFontMask),
              range: visible)
          default: storage.addAttribute(.foregroundColor, value: Theme.accent, range: visible)
          }
          if self.preview {
            let hidden: [NSAttributedString.Key: Any] = [
              .font: NSFont.systemFont(ofSize: 0.1), .foregroundColor: NSColor.clear,
              .underlineStyle: 0,
            ]
            storage.addAttributes(
              hidden,
              range: NSRange(
                location: at + match.range.location,
                length: inner.location - match.range.location))
            storage.addAttributes(
              hidden,
              range: NSRange(
                location: NSMaxRange(visible),
                length: NSMaxRange(match.range) - NSMaxRange(inner)))
          }
        }
      }

    }
    private func styleFence(
      _ range: NSRange, opened: Bool, closed: Bool, in storage: NSTextStorage
    ) {
      if source {
        storage.addAttribute(
          .font, value: NSFont.monospacedSystemFont(ofSize: 13 * scale, weight: .regular),
          range: range)
        return
      }
      if opened || closed {
        let pad = NSMutableParagraphStyle()
        pad.minimumLineHeight = 16 * scale
        if closed { pad.paragraphSpacing = 24 * scale }
        storage.addAttribute(.paragraphStyle, value: pad, range: range)
        storage.addAttributes(
          [.font: NSFont.systemFont(ofSize: 0.1), .foregroundColor: NSColor.clear], range: range)
        return
      }
      let body = NSMutableParagraphStyle()
      body.minimumLineHeight = 22.4 * scale
      body.headIndent = 16 * scale
      body.firstLineHeadIndent = 16 * scale
      body.tailIndent = -16 * scale
      storage.addAttributes(
        [
          .font: NSFont.monospacedSystemFont(ofSize: 14 * scale, weight: .regular),
          .foregroundColor: Theme.codeText, .paragraphStyle: body,
        ], range: range)
    }
    private struct ProseLine {
      let line: String
      let content: Substring
      let range: NSRange
      let start, offset, at: Int
    }
    private func styleProse(
      _ prose: ProseLine, paragraph: NSParagraphStyle, storage: NSTextStorage, view: NoteText,
      marker: (Int, NoteText.Mark?) -> Void
    ) {
      let line = prose.line
      let content = prose.content
      let range = prose.range
      let start = prose.start
      let offset = prose.offset
      let at = prose.at
      let level = content.prefix(while: { $0 == "#" }).count
      if (1...6).contains(level) && content.dropFirst(level).first == " " {
        storage.addAttribute(
          .font,
          value: NSFont.systemFont(ofSize: (level == 1 ? 18 : 15) * scale, weight: .semibold),
          range: range)
        storage.addAttribute(.foregroundColor, value: Theme.heading, range: range)
        marker(level + 1, nil)
      } else if [
        "- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "* [X] ", "+ [ ] ", "+ [x] ",
        "+ [X] ",
      ].contains(where: { content.hasPrefix($0) }) {
        let checked =
          !content.hasPrefix("- [ ]") && !content.hasPrefix("* [ ]")
          && !content.hasPrefix("+ [ ]")
        marker(6, .task(checked))
        let labelLength = content.utf16.count - 6
        if checked, !source, labelLength > 0 {
          storage.addAttributes(
            [
              .foregroundColor: Theme.muted,
              .strikethroughStyle: NSUnderlineStyle.single.rawValue,
              .strikethroughColor: Theme.muted,
            ], range: NSRange(location: start + 6, length: labelLength))
        }
      } else if content == "---" || content == "***" {
        marker(3, .rule)
      } else if content.hasPrefix("- ") || content.hasPrefix("* ") || content.hasPrefix("+ ") {
        marker(2, .bullet)
      }
      styleInline(line, at: at, in: storage)
      if !source && offset > 0 {
        let indent = NSMutableParagraphStyle()
        indent.setParagraphStyle(paragraph)
        indent.firstLineHeadIndent = CGFloat(min(offset, 24)) * 8
        indent.headIndent = indent.firstLineHeadIndent + 19
        storage.addAttribute(.paragraphStyle, value: indent, range: range)
      }
    }
    private func baseStyle() -> (NSParagraphStyle, [NSAttributedString.Key: Any]) {
      let paragraph = NSMutableParagraphStyle()
      paragraph.minimumLineHeight = 22 * scale
      paragraph.paragraphSpacing = 3
      return (paragraph, [
        .font: NSFont.systemFont(ofSize: 14 * scale), .foregroundColor: NoteText.ink,
        .paragraphStyle: paragraph,
      ])
    }
    private func prose(in raw: NSString, range: NSRange) -> ProseLine {
      let line = raw.substring(with: range).trimmingCharacters(in: .newlines)
      let content = line.drop(while: { $0 == " " || $0 == "\t" })
      let offset = line.utf16.count - content.utf16.count
      return .init(
        line: line, content: content, range: range, start: range.location + offset,
        offset: offset, at: range.location)
    }
    private func record(_ prose: ProseLine, fence: inout Fence) -> StyledLine {
      let before = fence.delimiter.map(String.init)
      let code = fence.consumes(prose.content)
      return .init(
        range: prose.range, contentLength: prose.line.utf16.count,
        fenceBefore: before, fenceAfter: fence.delimiter.map(String.init),
        imageName: !code && prose.line.contains("![") ? NoteImages.name(in: prose.line) : nil)
    }
    private func styleLine(
      _ prose: ProseLine, record: StyledLine, paragraph: NSParagraphStyle,
      storage: NSTextStorage, view: NoteText
    ) {
      func marker(_ length: Int, _ mark: NoteText.Mark? = nil) {
        guard !source else { return }
        let prefixRange = NSRange(location: prose.start, length: length)
        storage.addAttributes(
          [
            .font: NSFont.systemFont(ofSize: 0.1), .foregroundColor: NSColor.clear,
            NoteText.atomicMarker: true,
          ], range: prefixRange)
        if let mark {
          storage.addAttribute(
            .kern, value: 19, range: NSRange(location: NSMaxRange(prefixRange) - 1, length: 1))
          view.decorations.append(.init(at: prose.start, mark: mark))
        }
      }
      if !source, let name = record.imageName,
        let image = images.image(
          name, demo: book.demo,
          refresh: { [weak self, weak view] in
            if let self, let view { self.refreshImage(name, in: view) }
          })
      {
        let height = min(260, image.size.height, 540 * image.size.height / image.size.width) * scale
        let block = NSMutableParagraphStyle()
        block.setParagraphStyle(paragraph)
        block.minimumLineHeight = height + 6
        storage.addAttribute(.paragraphStyle, value: block, range: prose.range)
        marker(prose.content.utf16.count, .image(image, height))
      } else if record.code {
        styleFence(
          prose.range, opened: record.fenceBefore == nil, closed: record.fenceAfter == nil,
          in: storage)
      } else {
        styleProse(
          prose, paragraph: paragraph, storage: storage, view: view, marker: marker)
      }
      lastStyledLineCount += 1
    }
    private func finishStyle(_ view: NoteText, normal: [NSAttributedString.Key: Any]) {
      styledView = view
      styledLength = view.textStorage?.length ?? 0
      styledConfiguration = configuration
      cacheValid = true
      pendingEdit = nil
      pendingEditCount = 0
      view.typingAttributes = normal
      view.needsDisplay = true
    }
    /// Only one character edit wholly inside an unchanged paragraph/fence state is eligible.
    /// Later ranges are shifted as UTF-16 integers, without rescanning their source lines.
    private func styleEditedLine(_ view: NoteText) -> Bool {
      guard cacheValid, styledView === view, styledConfiguration == configuration,
        pendingEditCount == 1, let edit = pendingEdit, let storage = view.textStorage,
        storage.length == styledLength + edit.delta, !lines.isEmpty,
        edit.range.location <= styledLength, edit.range.length >= edit.delta,
        NSMaxRange(edit.range) <= storage.length
      else { return false }
      // Find the last cached line starting at/before the edit (not a prefix scan).
      var low = 0, high = lines.count
      while low < high {
        let mid = (low + high) / 2
        if lines[mid].range.location <= edit.range.location { low = mid + 1 } else { high = mid }
      }
      guard low > 0 else { return false }
      let index = low - 1
      let old = lines[index]
      let oldEditEnd = edit.range.location + edit.range.length - edit.delta
      guard old.fenceBefore == old.fenceAfter,
        oldEditEnd <= old.range.location + old.contentLength
      else { return false }
      let raw = storage.string as NSString
      let range = raw.lineRange(for: .init(location: edit.range.location, length: 0))
      guard range.location == old.range.location, range.length == old.range.length + edit.delta
      else { return false }
      let prose = prose(in: raw, range: range)
      guard prose.line.utf16.count == old.contentLength + edit.delta,
        NSMaxRange(edit.range) <= range.location + prose.line.utf16.count
      else { return false }
      var fence = Fence()
      fence.delimiter = old.fenceBefore.map { $0[...] }
      let updated = record(prose, fence: &fence)
      guard updated.fenceAfter == old.fenceAfter else { return false }

      let (paragraph, normal) = baseStyle()
      lastStyledLineCount = 0
      storage.beginEditing()
      view.decorations = view.decorations.compactMap { decoration in
        if NSLocationInRange(decoration.at, old.range) { return nil }
        return .init(
          at: decoration.at >= NSMaxRange(old.range) ? decoration.at + edit.delta : decoration.at,
          mark: decoration.mark)
      }
      view.codeBlocks = view.codeBlocks.map { block in
        if block.location >= NSMaxRange(old.range) {
          return .init(location: block.location + edit.delta, length: block.length)
        }
        if NSLocationInRange(old.range.location, block) {
          return .init(location: block.location, length: block.length + edit.delta)
        }
        return block
      }
      storage.setAttributes(normal, range: range)
      styleLine(prose, record: updated, paragraph: paragraph, storage: storage, view: view)
      view.decorations.sort { $0.at < $1.at }
      lines[index] = updated
      for next in (index + 1)..<lines.count { lines[next].range.location += edit.delta }
      storage.endEditing()
      finishStyle(view, normal: normal)
      return true
    }
    /// Resolve the current cached positions, not positions captured before asynchronous loading.
    func refreshImage(_ name: String, in view: NoteText) {
      guard styledView === view, !source else { return }
      guard !view.hasMarkedText() else {
        cacheValid = false
        return
      }
      guard cacheValid, pendingEditCount == 0, styledConfiguration == configuration,
        let storage = view.textStorage, storage.length == styledLength
      else {
        style(view)
        return
      }
      let targets = lines.filter { $0.imageName == name }
      guard !targets.isEmpty else { return }
      let raw = storage.string as NSString
      let (paragraph, normal) = baseStyle()
      lastStyledLineCount = 0
      storage.beginEditing()
      for line in targets {
        view.decorations.removeAll { NSLocationInRange($0.at, line.range) }
        storage.setAttributes(normal, range: line.range)
        styleLine(
          prose(in: raw, range: line.range), record: line, paragraph: paragraph,
          storage: storage, view: view)
      }
      view.decorations.sort { $0.at < $1.at }
      storage.endEditing()
      finishStyle(view, normal: normal)
    }
    func style(_ view: NoteText) {
      guard !view.hasMarkedText() else {
        cacheValid = false
        return
      }
      guard let storage = view.textStorage else { return }
      storage.delegate = self
      let raw = storage.string as NSString
      let (paragraph, normal) = baseStyle()
      lastStyledLineCount = 0
      storage.beginEditing()
      view.decorations = []
      view.codeBlocks = []
      lines = []
      storage.setAttributes(normal, range: NSRange(location: 0, length: raw.length))
      var at = 0
      var blockStart: Int?
      var fence = Fence()
      while at < raw.length {
        let range = raw.lineRange(for: NSRange(location: at, length: 0))
        let prose = prose(in: raw, range: range)
        let line = record(prose, fence: &fence)
        lines.append(line)
        if line.code, line.fenceBefore == nil { blockStart = at }
        styleLine(prose, record: line, paragraph: paragraph, storage: storage, view: view)
        if line.code, line.fenceAfter == nil, let start = blockStart, !source {
          view.codeBlocks.append(NSRange(location: start, length: NSMaxRange(range) - start))
          blockStart = nil
        }
        at = NSMaxRange(range)
      }
      if let start = blockStart, !source {
        view.codeBlocks.append(NSRange(location: start, length: raw.length - start))
      }
      storage.endEditing()
      finishStyle(view, normal: normal)
    }
  }
}
