import AppKit
import SwiftUI

/// Gives every body line the same height and baseline. With Japanese preferred languages AppKit
/// draws characters such as "[]" with Hiragino; a line mixing it with the system font grows
/// taller than its paragraph's line height (even with `maximumLineHeight`), so line spacing and
/// bullet positions varied with the line's content.
final class UniformLines: NSObject, NSLayoutManagerDelegate {
  func layoutManager(
    _ layoutManager: NSLayoutManager,
    shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>,
    lineFragmentUsedRect: UnsafeMutablePointer<NSRect>,
    baselineOffset: UnsafeMutablePointer<CGFloat>, in textContainer: NSTextContainer,
    forGlyphRange glyphRange: NSRange
  ) -> Bool {
    guard let storage = layoutManager.textStorage, glyphRange.length > 0 else { return false }
    let index = layoutManager.characterIndexForGlyph(at: glyphRange.location)
    guard index < storage.length,
      let font = storage.attribute(NoteText.uniformLine, at: index, effectiveRange: nil)
        as? NSFont,
      let paragraph = storage.attribute(.paragraphStyle, at: index, effectiveRange: nil)
        as? NSParagraphStyle, paragraph.minimumLineHeight > 0
    else { return false }
    let height = paragraph.minimumLineHeight
    let used = lineFragmentUsedRect.pointee
    // Whatever TextKit added beyond the used height is paragraph spacing; keep it.
    let spacing = max(0, lineFragmentRect.pointee.height - used.height)
    lineFragmentUsedRect.pointee.size.height = height
    lineFragmentRect.pointee.size.height = height + spacing
    baselineOffset.pointee = (height + font.descender).rounded()
    return true
  }
}

/// Decorations use UTF-16 source ranges; the backing storage always contains plain Markdown.
final class NoteText: NSTextView {
  static let ink = Theme.text
  static let muted = Theme.muted
  /// Marks body text whose lines use uniform metrics; the value is the body font.
  static let uniformLine = NSAttributedString.Key("DescartesUniformLine")
  /// Width reserved for a bullet or checkbox before the item text, at 100% zoom.
  static let markerWidth: CGFloat = 19
  /// Set by each styling pass so markers, hit targets and typing follow the zoom level.
  var markScale: CGFloat = 1
  var bodyFont = NSFont.systemFont(ofSize: 14)
  var normalAttributes: [NSAttributedString.Key: Any]?
  let uniformLines = UniformLines()
  /// Preview is read-only, but its checkboxes can still be toggled (as on the web).
  var togglesTasksWhenReadOnly = false
  /// Typing shortcuts such as "[]" → "- [ ] " (off in Markdown source mode).
  var autoFormat = true
  /// After "[]" becomes "- [ ] ", the space typed next would double the separator.
  var swallowSpaceAt: Int?
  private var movingBackward = false
  /// Set while a command applies its own edit, so typing shortcuts do not re-run on it.
  var applyingCommand = false

  override func insertText(_ insertString: Any, replacementRange: NSRange) {
    let typed = (insertString as? NSAttributedString)?.string ?? insertString as? String ?? ""
    let pending = swallowSpaceAt
    swallowSpaceAt = nil
    if typed == " ", let pending, selectedRange() == NSRange(location: pending, length: 0),
      replacementRange.location == NSNotFound || replacementRange == selectedRange()
    {
      return
    }
    if autoFormat, !applyingCommand, typed.utf16.count == 1,
      replacementRange.location == NSNotFound || replacementRange == selectedRange(),
      wrapOnType(typed)
    {
      return
    }
    super.insertText(insertString, replacementRange: replacementRange)
    if autoFormat, !applyingCommand, ["]", "］", "」"].contains(where: { typed.hasSuffix($0) }) {
      completeTodoShortcut()
    }
  }

  override var typingAttributes: [NSAttributedString.Key: Any] {
    get { super.typingAttributes }
    set {
      // A caret after hidden Markdown would otherwise inherit its 0.1pt clear font and marker
      // kerning, making IME composition invisible and widely spaced until the line is restyled.
      let hidden =
        newValue[Self.atomicMarker] != nil || ((newValue[.font] as? NSFont)?.pointSize ?? 14) < 1
      if hidden, let normalAttributes {
        super.typingAttributes = normalAttributes
      } else {
        super.typingAttributes = newValue
      }
    }
  }
  /// The hidden marker strictly surrounding `index`, if any.
  func atomicRange(around index: Int) -> NSRange? {
    guard let storage = textStorage, index > 0, index < storage.length else { return nil }
    var range = NSRange()
    guard
      storage.attribute(
        Self.atomicMarker, at: index - 1, longestEffectiveRange: &range,
        in: NSRange(location: 0, length: storage.length)) != nil,
      range.location < index, index < NSMaxRange(range)
    else { return nil }
    return range
  }
  override func setSelectedRanges(
    _ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool
  ) {
    var ranges = ranges
    if let pending = swallowSpaceAt,
      ranges.first?.rangeValue != NSRange(location: pending, length: 0)
    {
      swallowSpaceAt = nil
    }
    // Hidden marker characters have no visible width. Keep a caret out of them so arrow keys
    // and clicks never need invisible extra steps or split "- [ ] " while typing.
    if ranges.count == 1, !hasMarkedText(), ranges[0].rangeValue.length == 0 {
      let location = ranges[0].rangeValue.location
      if let marker = invisibleMarker(startingAt: location) {
        // A heading's hidden "# " has no dot or checkbox, so a caret before it looks exactly
        // like one after it, and typing there broke the heading ("x# Title"). Only the end of
        // the marker is a caret stop; ← from it continues to the previous line.
        ranges = [NSValue(range: NSRange(location: NSMaxRange(marker), length: 0))]
      } else if let marker = atomicRange(around: location) {
        var target = movingBackward ? marker.location : NSMaxRange(marker)
        if movingBackward, invisibleMarker(startingAt: marker.location) != nil {
          target =
            marker.location > 0
            ? (string as NSString).rangeOfComposedCharacterSequence(at: marker.location - 1)
              .location : NSMaxRange(marker)
        }
        ranges = [NSValue(range: NSRange(location: target, length: 0))]
      }
    }
    super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
  }
  /// A hidden marker without a drawn decoration (a heading's "# ") that starts at `location`.
  private func invisibleMarker(startingAt location: Int) -> NSRange? {
    guard let storage = textStorage, location < storage.length else { return nil }
    var range = NSRange()
    guard
      storage.attribute(
        Self.atomicMarker, at: location, longestEffectiveRange: &range,
        in: NSRange(location: 0, length: storage.length)) != nil,
      range.location == location, !decorations.contains(where: { $0.at == location })
    else { return nil }
    return range
  }
  private func backward(_ move: () -> Void) {
    movingBackward = true
    defer { movingBackward = false }
    move()
  }
  override func moveLeft(_ sender: Any?) { backward { super.moveLeft(sender) } }
  override func moveBackward(_ sender: Any?) { backward { super.moveBackward(sender) } }
  override func moveWordLeft(_ sender: Any?) { backward { super.moveWordLeft(sender) } }
  override func moveWordBackward(_ sender: Any?) { backward { super.moveWordBackward(sender) } }
  /// ⌘← first stops after a bullet/checkbox, like other note editors; a second press reaches
  /// the true line start.
  private func smartLineStart(_ move: () -> Void) {
    let before = selectedRange()
    move()
    let after = selectedRange()
    guard let storage = textStorage, after.length == 0, after.location < storage.length,
      before.location > after.location
    else { return }
    var marker = NSRange()
    guard
      storage.attribute(
        Self.atomicMarker, at: after.location, longestEffectiveRange: &marker,
        in: NSRange(location: 0, length: storage.length)) != nil,
      marker.location == after.location, before.location > NSMaxRange(marker)
    else { return }
    setSelectedRange(NSRange(location: NSMaxRange(marker), length: 0))
  }
  override func moveToBeginningOfLine(_ sender: Any?) {
    smartLineStart { super.moveToBeginningOfLine(sender) }
  }
  override func moveToLeftEndOfLine(_ sender: Any?) {
    smartLineStart { super.moveToLeftEndOfLine(sender) }
  }
  override func moveToBeginningOfParagraph(_ sender: Any?) {
    smartLineStart { super.moveToBeginningOfParagraph(sender) }
  }
  override func insertNewline(_ sender: Any?) {
    guard !closeFence(), !breakBeforeHeading(), !continueList() else { return }
    if isEditable, !hasMarkedText(), lineBreak == "\r\n" {
      insertText(lineBreak, replacementRange: selectedRange())
    } else {
      super.insertNewline(sender)
    }
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
    case bullet, rule, quote
    case image(NSImage, CGFloat)
  }
  struct Decoration {
    let at: Int
    let mark: Mark
  }
  var decorations: [Decoration] = []
  var codeBlocks: [NSRange] = []
  private(set) var lastDrawnCodeBlockCount = 0

  /// The line box for the marker at `index`. TextKit adds paragraph spacing to every line
  /// fragment except the final paragraph's, so the full fragment's midpoint moved whenever
  /// Return turned the last line into an earlier one. The used rectangle excludes that spacing.
  private func markerLine(at index: Int) -> (x: CGFloat, baseline: CGFloat, used: NSRect)? {
    guard let layout = layoutManager, index < (string as NSString).length else { return nil }
    let glyph = layout.glyphIndexForCharacter(at: index)
    let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    let used = layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
    let location = layout.location(forGlyphAt: glyph)
    return (
      textContainerOrigin.x + line.minX + location.x,
      textContainerOrigin.y + line.minY + location.y,
      used.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
    )
  }
  /// Bullets and checkboxes are centred on the body text's cap height above the line's
  /// baseline, which `UniformLines` keeps identical for empty, Latin and Japanese items.
  func box(at index: Int) -> NSRect? {
    guard let (x, baseline, _) = markerLine(at: index) else { return nil }
    let side = 12 * markScale
    let center = (baseline - bodyFont.capHeight / 2).rounded()
    return NSRect(x: x, y: center - side / 2, width: side, height: side)
  }
  /// Rules and images fill the line, so they stay centred in its used rectangle.
  private func block(at index: Int) -> NSRect? {
    guard let (x, _, used) = markerLine(at: index) else { return nil }
    return NSRect(x: x, y: used.minY, width: max(1, used.maxX - x), height: used.height)
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
    let s = markScale
    for decoration in decorations where NSLocationInRange(decoration.at, visible) {
      Self.muted.set()
      switch decoration.mark {
      case .task(let checked):
        guard let rect = box(at: decoration.at) else { continue }
        let shape = NSBezierPath(
          roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 3 * s, yRadius: 3 * s)
        shape.lineWidth = 1.2 * s
        shape.stroke()
        if checked {
          let check = NSBezierPath()
          check.move(to: NSPoint(x: rect.minX + 2 * s, y: rect.midY))
          check.line(to: NSPoint(x: rect.minX + 5 * s, y: rect.maxY - 3 * s))
          check.line(to: NSPoint(x: rect.maxX - 2 * s, y: rect.minY + 3 * s))
          check.lineWidth = 1.4 * s
          check.stroke()
        }
      case .image(let image, let height):
        guard let line = block(at: decoration.at) else { continue }
        let available = max(1, bounds.width - textContainerInset.width - line.minX)
        let scale = min(height / image.size.height, available / image.size.width)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(
          in: NSRect(
            x: line.minX, y: line.midY - size.height / 2, width: size.width, height: size.height),
          from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
      case .bullet:
        guard let rect = box(at: decoration.at) else { continue }
        let dot = 4 * s
        NSBezierPath(
          ovalIn: NSRect(x: rect.minX + 3 * s, y: rect.midY - dot / 2, width: dot, height: dot)
        ).fill()
      case .quote:
        guard let line = block(at: decoration.at) else { continue }
        Theme.border.setFill()
        NSBezierPath(
          roundedRect: NSRect(x: line.minX + 1 * s, y: line.minY + 2 * s, width: 3 * s,
            height: max(1, line.height - 4 * s)), xRadius: 1.5 * s, yRadius: 1.5 * s
        ).fill()
      case .rule:
        guard let line = block(at: decoration.at) else { continue }
        Self.muted.withAlphaComponent(0.45).setFill()
        NSRect(
          x: line.minX, y: line.midY.rounded(),
          width: max(1, bounds.width - textContainerInset.width - line.minX), height: 1
        ).fill()
      }
    }
  }
  /// The task whose checkbox (with a small margin) is under `point`.
  func task(at point: NSPoint) -> (at: Int, checked: Bool)? {
    guard isEditable || togglesTasksWhenReadOnly, !hasMarkedText() else { return nil }
    let index = characterIndexForInsertion(at: point)
    let raw = string as NSString
    let line = raw.lineRange(for: NSRange(location: min(index, raw.length), length: 0))
    guard let decoration = decorations.first(where: { NSLocationInRange($0.at, line) }),
      case .task(let checked) = decoration.mark, let rect = box(at: decoration.at),
      rect.insetBy(dx: -4 * markScale, dy: -4 * markScale).contains(point)
    else { return nil }
    return (decoration.at, checked)
  }
  /// Toggles the box without moving the caret or selection, as ⌘Return does.
  func toggleBox(at marker: Int, checked: Bool) {
    let selection = selectedRanges
    let readOnly = !isEditable
    if readOnly { isEditable = true }
    // "- [ ] " and "1. [ ] " both: the box is the character after the first "[".
    let raw = string as NSString
    let line = raw.lineRange(for: NSRange(location: marker, length: 0))
    let bracket = raw.range(
      of: "[", range: NSRange(location: marker, length: NSMaxRange(line) - marker))
    guard bracket.location != NSNotFound else { return }
    insertText(
      checked ? " " : "x", replacementRange: NSRange(location: bracket.location + 1, length: 1))
    selectedRanges = selection
    if readOnly { isEditable = false }
  }
  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    // ⌘-click opens a link, as on the web.
    if event.modifierFlags.contains(.command), let url = link(at: characterIndexForInsertion(at: point)) {
      NSWorkspace.shared.open(url)
      return
    }
    if let task = task(at: point) {
      toggleBox(at: task.at, checked: task.checked)
      return
    }
    super.mouseDown(with: event)
  }
  override func mouseMoved(with event: NSEvent) {
    super.mouseMoved(with: event)
    if task(at: convert(event.locationInWindow, from: nil)) != nil { NSCursor.pointingHand.set() }
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
    view.autoFormat = !source
    view.togglesTasksWhenReadOnly = book.preview && !book.busy
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
        #"(?<!\\)(`)([^`]+)`|(\*\*)([^*]+)\*\*|(\*)([^*]+)\*|\[([^\]]+)\]\((https?://[^\s)]+)\)|(~~)([^~]+)~~|(?<![\p{L}\p{N}_])(_)([^_]+)_(?![\p{L}\p{N}_])"#
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
      syncFences(view)
    }
    func textViewDidChangeSelection(_ notification: Notification) {
      guard let view = notification.object as? NoteText else { return }
      syncFences(view)
    }
    /// Fences (```` ``` ````, the language and the closing fence) are shown only while the caret
    /// or selection is on that line, so you can still edit them; otherwise only the block shows.
    private func revealsFence(_ line: StyledLine, in view: NoteText) -> Bool {
      let selection = view.selectedRange()
      return selection.location <= line.range.location + line.contentLength
        && NSMaxRange(selection) >= line.range.location
    }
    private func isFence(_ line: StyledLine) -> Bool {
      line.code && (line.fenceBefore == nil || line.fenceAfter == nil) && line.contentLength > 0
    }
    /// Shows or hides the fence lines whose state no longer matches the caret. Only those lines
    /// are restyled; `lastStyledLineCount` keeps describing the last edit.
    func syncFences(_ view: NoteText) {
      guard !source, !preview, styledView === view, cacheValid, pendingEditCount == 0,
        !view.hasMarkedText(), styledConfiguration == configuration,
        let storage = view.textStorage, storage.length == styledLength
      else { return }
      let stale = lines.filter { line in
        guard isFence(line) else { return false }
        let shown =
          storage.attribute(.foregroundColor, at: line.range.location, effectiveRange: nil)
          as? NSColor != NSColor.clear
        return shown != revealsFence(line, in: view)
      }
      guard !stale.isEmpty else { return }
      let count = lastStyledLineCount
      restyle(stale, in: view)
      lastStyledLineCount = count
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
          let groups = [2, 4, 6, 7, 10, 12]
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
          case 10:
            storage.addAttributes(
              [
                .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                .strikethroughColor: Theme.muted, .foregroundColor: Theme.muted,
              ], range: visible)
          case 6, 12:
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
      _ range: NSRange, opened: Bool, closed: Bool, revealed: Bool, in storage: NSTextStorage
    ) {
      storage.removeAttribute(NoteText.uniformLine, range: range)
      if source {
        storage.addAttribute(
          .font, value: NSFont.monospacedSystemFont(ofSize: 13 * scale, weight: .regular),
          range: range)
        return
      }
      let body = NSMutableParagraphStyle()
      body.headIndent = 16 * scale
      body.firstLineHeadIndent = 16 * scale
      body.tailIndent = -16 * scale
      if opened || closed {
        if closed { body.paragraphSpacing = 12 * scale }
        if preview || !revealed {
          // Away from the caret (and always in preview) only the block shows; the delimiters
          // become thin padding.
          body.minimumLineHeight = 16 * scale
          storage.addAttributes(
            [
              .font: NSFont.systemFont(ofSize: 0.1), .foregroundColor: NSColor.clear,
              .paragraphStyle: body,
            ], range: range)
          return
        }
        // On the caret's line the fence (and the language after ```) is visible but quiet, so
        // what you type there is never hidden.
        body.minimumLineHeight = 20 * scale
        storage.addAttributes(
          [
            .font: NSFont.monospacedSystemFont(ofSize: 12 * scale, weight: .regular),
            .foregroundColor: Theme.muted, .paragraphStyle: body,
          ], range: range)
        return
      }
      body.minimumLineHeight = 22.4 * scale
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
      var hanging = false
      var hangingWidth: CGFloat?
      if (1...6).contains(level) && content.dropFirst(level).first == " " {
        storage.addAttribute(
          .font,
          value: NSFont.systemFont(ofSize: (level == 1 ? 18 : 15) * scale, weight: .semibold),
          range: range)
        storage.addAttribute(.foregroundColor, value: Theme.heading, range: range)
        storage.removeAttribute(NoteText.uniformLine, range: range)
        marker(level + 1, nil)
      } else if let task = content.range(
        of: #"^(?:[-*+]|[0-9]{1,9}[.)]) \[[ xX]\] "#, options: .regularExpression)
      {
        // Bullet and numbered todos ("- [ ] ", "1. [ ] ") both show only the checkbox, as on
        // the web.
        let prefix = content[task]
        let length = prefix.utf16.count
        let checked = !prefix.contains("[ ]")
        marker(length, .task(checked))
        let labelLength = content.utf16.count - length
        if checked, !source, labelLength > 0 {
          storage.addAttributes(
            [
              .foregroundColor: Theme.muted,
              .strikethroughStyle: NSUnderlineStyle.single.rawValue,
              .strikethroughColor: Theme.muted,
            ], range: NSRange(location: start + length, length: labelLength))
        }
        hanging = true
      } else if content.hasPrefix("> ") || content == ">" {
        // The first "> " becomes a quote bar; the quoted text is quieter.
        let length = content == ">" ? 1 : 2
        marker(length, .quote)
        if !source, content.utf16.count > length {
          storage.addAttribute(
            .foregroundColor, value: Theme.muted,
            range: NSRange(location: start + length, length: content.utf16.count - length))
        }
        hanging = true
      } else if let number = content.range(
        of: #"^[0-9]{1,9}[.)] "#, options: .regularExpression), !source
      {
        // Wrapped text of a numbered item lines up after its number.
        let font = NSFont.systemFont(ofSize: 14 * scale)
        hangingWidth = (String(content[number]) as NSString).size(withAttributes: [.font: font])
          .width
      } else if content == "---" || content == "***" {
        marker(3, .rule)
      } else if content.hasPrefix("- ") || content.hasPrefix("* ") || content.hasPrefix("+ ") {
        marker(2, .bullet)
        hanging = true
      }
      styleInline(line, at: at, in: storage)
      if !source && (offset > 0 || hanging || hangingWidth != nil) {
        // Wrapped item text lines up after its bullet/checkbox instead of under it.
        let indent = NSMutableParagraphStyle()
        indent.setParagraphStyle(paragraph)
        indent.firstLineHeadIndent = CGFloat(min(offset, 24)) * 8 * scale
        indent.headIndent =
          indent.firstLineHeadIndent + (hangingWidth ?? (hanging ? NoteText.markerWidth * scale : 0))
        storage.addAttribute(.paragraphStyle, value: indent, range: range)
      }
    }
    private func baseStyle() -> (NSParagraphStyle, [NSAttributedString.Key: Any]) {
      let paragraph = NSMutableParagraphStyle()
      // Whole points keep every line, and the markers centred on them, on the same pixel grid.
      paragraph.minimumLineHeight = (22 * scale).rounded()
      paragraph.paragraphSpacing = (3 * scale).rounded()
      let font = NSFont.systemFont(ofSize: 14 * scale)
      return (paragraph, [
        .font: font, .foregroundColor: NoteText.ink, .paragraphStyle: paragraph,
        NoteText.uniformLine: font,
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
            .kern, value: NoteText.markerWidth * scale,
            range: NSRange(location: NSMaxRange(prefixRange) - 1, length: 1))
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
        storage.removeAttribute(NoteText.uniformLine, range: prose.range)
        storage.addAttribute(.paragraphStyle, value: block, range: prose.range)
        marker(prose.content.utf16.count, .image(image, height))
      } else if record.code {
        styleFence(
          prose.range, opened: record.fenceBefore == nil, closed: record.fenceAfter == nil,
          revealed: revealsFence(record, in: view), in: storage)
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
      view.markScale = scale
      view.bodyFont = NSFont.systemFont(ofSize: 14 * scale)
      view.normalAttributes = normal
      if view.layoutManager?.delegate !== view.uniformLines {
        view.layoutManager?.delegate = view.uniformLines
        view.layoutManager?.invalidateLayout(
          forCharacterRange: NSRange(location: 0, length: styledLength), actualCharacterRange: nil)
      }
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
      restyle(targets, in: view)
    }
    private func restyle(_ targets: [StyledLine], in view: NoteText) {
      guard let storage = view.textStorage else { return }
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
