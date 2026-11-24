import AppKit
import XCTest

@testable import Descartes

/// Caret, typing and marker geometry as experienced while editing a styled note.
final class EditorInteractionTests: XCTestCase {
  @MainActor private func editor(_ markdown: String, zoom: Int = 10) -> (
    NoteText, Editor.Coordinator, NSWindow
  ) {
    _ = NSApplication.shared
    let view = NoteText(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let coordinator = Editor.Coordinator(Notebook(demo: true))
    coordinator.zoom = zoom
    view.string = markdown
    view.delegate = coordinator
    let window = NSWindow(
      contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = view
    coordinator.style(view)
    view.setSelectedRange(NSRange(location: markdown.utf16.count, length: 0))
    return (view, coordinator, window)
  }
  @MainActor private func boxes(_ view: NoteText) -> [NSRect] {
    view.layoutManager?.ensureLayout(for: view.textContainer!)
    return view.decorations.compactMap { view.box(at: $0.at) }
  }

  @MainActor func testReturnDoesNotMoveExistingMarkers() throws {
    for item in ["- ", "- [ ] ", "- [x] "] {
      let (view, _, window) = editor("# T\n" + item + "a")
      let before = try XCTUnwrap(boxes(view).first)
      view.insertNewline(nil)
      var after = boxes(view)
      XCTAssertEqual(after.count, 2, item)
      // The previous last line now has paragraph spacing; its marker must stay put.
      XCTAssertEqual(after[0], before, item)
      let empty = after[1]
      view.insertText("日本語b", replacementRange: view.selectedRange())
      after = boxes(view)
      XCTAssertEqual(after[1], empty, "typing must not move a new item's marker: \(item)")
      view.insertNewline(nil)
      let third = boxes(view)
      XCTAssertEqual(Array(third.prefix(2)), after, item)
      // Every item is the same distance apart.
      XCTAssertEqual(third[1].minY - third[0].minY, third[2].minY - third[1].minY, item)
      _ = window
    }
  }

  @MainActor private func type(_ text: String, into view: NoteText) {
    for character in text {
      view.insertText(String(character), replacementRange: view.selectedRange())
    }
  }

  @MainActor func testTypingBracketsCreatesTodo() throws {
    for (typed, expected) in [
      ("- []", "- [ ] "), ("- [] 牛乳", "- [ ] 牛乳"), ("[]牛乳", "- [ ] 牛乳"),
      ("* []", "* [ ] "), ("  - [] 卵", "  - [ ] 卵"), ("［］ パン", "- [ ] パン"),
      ("- [ ] 明示", "- [ ] 明示"), ("a []", "a []"), ("- [x]", "- [x]"),
    ] {
      let (view, _, window) = editor("# T\n")
      type(typed, into: view)
      XCTAssertEqual(view.string, "# T\n" + expected, typed)
      _ = window
    }
    let (view, _, window) = editor("# T\n")
    type("- [] 牛乳", into: view)
    guard case .task(false) = try XCTUnwrap(view.decorations.first).mark else {
      return XCTFail("not a checkbox")
    }
    // Return continues the todo list.
    view.insertNewline(nil)
    type("次", into: view)
    XCTAssertEqual(view.string, "# T\n- [ ] 牛乳\n- [ ] 次")
    // A space only disappears directly after the conversion.
    let (moved, _, movedWindow) = editor("# T\n")
    type("[]", into: moved)
    moved.moveLeft(nil)
    moved.moveRight(nil)
    type(" ", into: moved)
    XCTAssertEqual(moved.string, "# T\n- [ ]  ")
    // Inside code and in Markdown source mode the text stays literal.
    let (code, _, codeWindow) = editor("# T\n```\n")
    type("- []", into: code)
    XCTAssertEqual(code.string, "# T\n```\n- []")
    let (source, _, sourceWindow) = editor("# T\n")
    source.autoFormat = false
    type("- []", into: source)
    XCTAssertEqual(source.string, "# T\n- []")
    _ = (window, movedWindow, codeWindow, sourceWindow)
  }

  @MainActor func testLinesWithFallbackFontsKeepUniformHeightAndMarkers() throws {
    // "[]" and Japanese use Hiragino on Japanese systems, which made those lines taller.
    for zoom in [10, 12, 15] {
      let (view, _, window) = editor(
        "# T\n- [ ] []\n- 日本語\n- abc\n- [x] 「」【】\n- ", zoom: zoom)
      let layout = try XCTUnwrap(view.layoutManager)
      layout.ensureLayout(for: try XCTUnwrap(view.textContainer))
      let marks = boxes(view)
      XCTAssertEqual(marks.count, 5)
      let gaps = zip(marks.dropFirst(), marks).map { $0.minY - $1.minY }
      XCTAssertLessThan(
        (gaps.max() ?? 0) - (gaps.min() ?? 0), 0.01, "zoom \(zoom): \(gaps)")
      // Each marker is centred on its own line's text.
      for decoration in view.decorations {
        let glyph = layout.glyphIndexForCharacter(at: decoration.at)
        let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let baseline =
          view.textContainerOrigin.y + line.minY + layout.location(forGlyphAt: glyph).y
        let box = try XCTUnwrap(view.box(at: decoration.at))
        XCTAssertLessThan(box.midY, baseline)
        XCTAssertGreaterThan(box.midY, baseline - view.bodyFont.capHeight)
      }
      _ = window
    }
  }

  @MainActor func testMarkersAreCentredOnTextAndFollowZoom() throws {
    for zoom in [10, 15] {
      let (view, _, window) = editor("# T\n- [ ] 日本語 text", zoom: zoom)
      let box = try XCTUnwrap(boxes(view).first)
      XCTAssertEqual(box.width, 12 * CGFloat(zoom) / 10, accuracy: 0.01)
      let layout = try XCTUnwrap(view.layoutManager)
      let label = (view.string as NSString).range(of: "日本語").location
      let glyph = layout.glyphIndexForCharacter(at: label)
      let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
      let baseline = view.textContainerOrigin.y + line.minY + layout.location(forGlyphAt: glyph).y
      // The checkbox sits on the text: between cap height and the baseline, not above the text.
      XCTAssertLessThan(box.midY, baseline)
      XCTAssertGreaterThan(box.midY, baseline - view.bodyFont.capHeight)
      // The label starts after the checkbox with a gap.
      let x = view.textContainerOrigin.x + line.minX + layout.location(forGlyphAt: glyph).x
      XCTAssertGreaterThan(x, box.maxX)
      _ = window
    }
  }

  @MainActor func testWrappedItemTextHangsAfterTheMarker() throws {
    let long = String(repeating: "とても長い項目 ", count: 30)
    let (view, _, window) = editor("# T\n- [ ] " + long)
    let layout = try XCTUnwrap(view.layoutManager)
    layout.ensureLayout(for: try XCTUnwrap(view.textContainer))
    let raw = view.string as NSString
    let first = layout.glyphIndexForCharacter(at: raw.range(of: "とても").location)
    var starts: [CGFloat] = []
    layout.enumerateLineFragments(
      forGlyphRange: NSRange(location: first, length: layout.numberOfGlyphs - first)
    ) { rect, _, _, range, _ in
      starts.append(rect.minX + layout.location(forGlyphAt: range.location).x)
    }
    XCTAssertGreaterThan(starts.count, 1)
    XCTAssertEqual(starts[1], layout.location(forGlyphAt: first).x, accuracy: 1)
    _ = window
  }

  @MainActor func testCaretAfterHiddenMarkerTypesVisibleText() throws {
    let (view, coordinator, window) = editor("# T\n- a\n- [ ] ")
    view.setSelectedRange(NSRange(location: 0, length: 0))
    // Clicking or arrowing to an empty item must not inherit the hidden marker's font/kerning.
    view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))
    let font = try XCTUnwrap(view.typingAttributes[.font] as? NSFont)
    XCTAssertEqual(font.pointSize, 14)
    XCTAssertNil(view.typingAttributes[.kern])
    XCTAssertNil(view.typingAttributes[NoteText.atomicMarker])
    // IME composition is shown at the body size even before the line is restyled.
    view.setMarkedText(
      "にゅう", selectedRange: NSRange(location: 3, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0))
    let marked = view.markedRange()
    let storage = try XCTUnwrap(view.textStorage)
    XCTAssertEqual(
      (storage.attribute(.font, at: marked.location, effectiveRange: nil) as? NSFont)?.pointSize,
      14)
    view.insertText("牛乳", replacementRange: marked)
    coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view))
    XCTAssertTrue(view.string.hasSuffix("- [ ] 牛乳"))
    _ = window
  }

  @MainActor func testCaretSkipsHiddenMarkerCharacters() throws {
    let (view, _, window) = editor("# T\n- [ ] 牛乳\n次")
    let raw = view.string as NSString
    let line = raw.range(of: "- [ ]").location
    let label = raw.range(of: "牛乳").location
    // A click/vertical move inside the hidden "- [ ] " lands just before the label.
    for inside in (line + 1)..<label {
      view.setSelectedRange(NSRange(location: inside, length: 0))
      XCTAssertEqual(view.selectedRange().location, label)
    }
    // ← from the label goes straight to the line start, then to the previous line.
    view.setSelectedRange(NSRange(location: label, length: 0))
    view.moveLeft(nil)
    XCTAssertEqual(view.selectedRange().location, line)
    view.moveLeft(nil)
    XCTAssertEqual(view.selectedRange().location, line - 1)
    // → from the line start skips the marker in one step.
    view.moveRight(nil)
    view.moveRight(nil)
    XCTAssertEqual(view.selectedRange().location, label)
    // ⌘← stops after the checkbox first, then reaches the line start.
    view.setSelectedRange(NSRange(location: label + 2, length: 0))
    view.moveToLeftEndOfLine(nil)
    XCTAssertEqual(view.selectedRange().location, label)
    view.moveToLeftEndOfLine(nil)
    XCTAssertEqual(view.selectedRange().location, line)
    // Selections may still include markers (e.g. to delete or copy whole lines).
    view.setSelectedRange(NSRange(location: line + 2, length: 3))
    XCTAssertEqual(view.selectedRange(), NSRange(location: line + 2, length: 3))
    _ = window
  }

  @MainActor func testCheckboxClickTogglesWithoutMovingCaretIncludingPreview() throws {
    let (view, coordinator, window) = editor("# T\n- [ ] 牛乳\n- [x] 卵\n末尾")
    let end = NSRange(location: view.string.utf16.count, length: 0)
    view.setSelectedRange(end)
    var tasks = view.decorations
    let first = try XCTUnwrap(view.box(at: tasks[0].at))
    let hit = try XCTUnwrap(view.task(at: NSPoint(x: first.midX, y: first.midY)))
    view.toggleBox(at: hit.at, checked: hit.checked)
    XCTAssertTrue(view.string.contains("- [x] 牛乳"))
    XCTAssertEqual(view.selectedRange(), end)
    XCTAssertNil(view.task(at: NSPoint(x: first.maxX + 40, y: first.midY)))
    // Preview is read-only for typing, but checkboxes still work there.
    view.isEditable = false
    XCTAssertNil(view.task(at: NSPoint(x: first.midX, y: first.midY)))
    view.togglesTasksWhenReadOnly = true
    tasks = view.decorations
    let second = try XCTUnwrap(view.box(at: tasks[1].at))
    let done = try XCTUnwrap(view.task(at: NSPoint(x: second.midX, y: second.midY)))
    view.toggleBox(at: done.at, checked: done.checked)
    XCTAssertTrue(view.string.contains("- [ ] 卵"))
    XCTAssertFalse(view.isEditable)
    XCTAssertEqual(coordinator.book.text, view.string)
    _ = window
  }
}
