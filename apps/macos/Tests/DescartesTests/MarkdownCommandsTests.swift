import AppKit
import XCTest

@testable import Descartes

final class MarkdownCommandsTests: XCTestCase {
  @MainActor private func editor(_ value: String) -> NoteText {
    _ = NSApplication.shared
    let text = NoteText(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    text.string = value
    text.setSelectedRange(NSRange(location: value.utf16.count, length: 0))
    return text
  }
  @MainActor func testReturnContinuesAndExitsLists() {
    for (line, expected) in [
      ("- メモ", "- "), ("  * entry", "  * "), ("9. 日本語", "10. "), ("  2) 😀", "  3) "),
      ("- [X] done", "- [ ] "), ("> quote", "> "),
    ] {
      let view = editor(line)
      view.insertNewline(nil)
      XCTAssertEqual(view.string, line + "\n" + expected)
      view.insertNewline(nil)
      XCTAssertEqual(view.string, line + "\n")
    }
    let split = editor("- abc")
    split.setSelectedRange(NSRange(location: 3, length: 0))
    split.insertNewline(nil)
    XCTAssertEqual(split.string, "- a\n- bc")
    for line in ["plain", "-word", "~~~~swift\n~~~\n- literal", "```\n- literal"] {
      XCTAssertFalse(editor(line).continueList())
    }
  }
  @MainActor func testEditingAndHeadingCommands() {
    let view = editor("- [ ] 日本語")
    view.insertTab(nil)
    XCTAssertEqual(view.string, "  - [ ] 日本語")
    view.toggleTask()
    XCTAssertEqual(view.string, "  - [x] 日本語")
    view.insertBacktab(nil)
    XCTAssertEqual(view.string, "- [x] 日本語")
    let doc = editor("# First\n~~~\n# not a heading\n~~~\n## Second")
    doc.setSelectedRange(.init(location: 0, length: 0))
    doc.nextHeading()
    XCTAssertEqual(
      doc.selectedRange().location, (doc.string as NSString).range(of: "Second").location)
    doc.previousHeading()
    XCTAssertEqual(doc.selectedRange().location, 2)
    let rich = editor("🌙")
    rich.setSelectedRange(.init(location: 0, length: 2))
    rich.boldSelection()
    XCTAssertEqual(rich.string, "**🌙**")
    rich.insertLink()
    XCTAssertEqual(rich.string, "**[🌙](https://)**")
    XCTAssertEqual((rich.string as NSString).substring(with: rich.selectedRange()), "https://")
    rich.isEditable = false
    rich.italicSelection()
    XCTAssertEqual(rich.string, "**[🌙](https://)**")
  }
  @MainActor func testStyledDeleteRemovesWholeMarker() {
    let coord = Editor.Coordinator(Notebook(demo: true))
    for prefix in ["- ", "* ", "- [ ] ", "+ [X] ", "### "] {
      let view = editor("🌙\n  " + prefix + "本文")
      coord.style(view)
      view.setSelectedRange(.init(location: 5 + prefix.utf16.count, length: 0))
      view.deleteBackward(nil)
      XCTAssertEqual(view.string, "🌙\n  本文")
    }
    let view = editor("- [ ] ")
    coord.style(view)
    view.setSelectedRange(.init(location: 0, length: 0))
    view.deleteForward(nil)
    XCTAssertEqual(view.string, "")
    for source in [true, false] {
      let view = editor(source ? "- " : "```\n- ")
      coord.source = source
      coord.style(view)
      view.deleteBackward(nil)
      XCTAssertTrue(view.string.hasSuffix("-"))
    }
  }
  @MainActor func testZoomScalesTextWithoutChangingSelectionOrMarkdown() throws {
    let coord = Editor.Coordinator(Notebook(demo: true))
    let view = editor("🌙 test")
    coord.zoom = 15
    coord.style(view)
    XCTAssertEqual((view.typingAttributes[.font] as? NSFont)?.pointSize, 21)
    XCTAssertEqual(view.string, "🌙 test")
    XCTAssertEqual(view.selectedRange().location, 7)
  }
  @MainActor func testZoomKeyboardEvents() throws {
    let app = NSApplication.shared
    let previous = app.mainMenu
    let saved = UserDefaults.standard.object(forKey: "noteZoomTenths")
    defer {
      app.mainMenu = previous
      UserDefaults.standard.set(saved, forKey: "noteZoomTenths")
    }
    let delegate = AppDelegate()
    delegate.buildMenus()
    let menu = try XCTUnwrap(app.mainMenu)
    delegate.book.zoom = 10
    for (symbol, base, shifted, code, expected) in [
      ("+", "=", true, 24, 11), ("=", "=", false, 24, 12),
      ("-", "-", false, 27, 11), ("0", "0", false, 29, 10),
    ] {
      let event = try XCTUnwrap(
        NSEvent.keyEvent(
          with: .keyDown, location: .zero,
          modifierFlags: shifted ? [.command, .shift] : [.command], timestamp: 0, windowNumber: 0,
          context: nil, characters: symbol, charactersIgnoringModifiers: shifted ? symbol : base,
          isARepeat: false, keyCode: UInt16(code)))
      XCTAssertTrue(menu.performKeyEquivalent(with: event))
      XCTAssertEqual(delegate.book.zoom, expected)
    }
  }
  @MainActor func testCompletedTasksAndCodeBlocksFollowTheDesignSystem() {
    let coord = Editor.Coordinator(Notebook(demo: true))
    let view = editor("- [x] done\n- [ ] open\n```js\nconsole.log(1)\n```")
    coord.style(view)
    let raw = view.string as NSString
    let done = raw.range(of: "done")
    XCTAssertEqual(
      view.textStorage?.attribute(.foregroundColor, at: done.location, effectiveRange: nil)
        as? NSColor, Theme.muted)
    XCTAssertEqual(
      view.textStorage?.attribute(.strikethroughStyle, at: done.location, effectiveRange: nil)
        as? Int, NSUnderlineStyle.single.rawValue)
    let open = raw.range(of: "open")
    XCTAssertEqual(
      view.textStorage?.attribute(.foregroundColor, at: open.location, effectiveRange: nil)
        as? NSColor, Theme.text)
    XCTAssertEqual(view.codeBlocks.count, 1)
    XCTAssertEqual(
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "```").location, effectiveRange: nil)
        as? NSColor, NSColor.clear)
    XCTAssertEqual(
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "console").location, effectiveRange: nil)
        as? NSColor, Theme.codeText)
    XCTAssertEqual(view.string, "- [x] done\n- [ ] open\n```js\nconsole.log(1)\n```")
    coord.source = true
    coord.style(view)
    XCTAssertTrue(view.codeBlocks.isEmpty)
  }
  @MainActor func testPreviewKeepsRawMarkdown() {
    let view = editor("# Demo\n**bold** and [site](https://example.com)")
    let coord = Editor.Coordinator(Notebook(demo: true))
    coord.preview = true
    coord.style(view)
    let raw = view.string as NSString
    let color =
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "**").location, effectiveRange: nil) as? NSColor
    XCTAssertEqual(color, NSColor.clear)
    coord.preview = false
    coord.source = true
    coord.style(view)
    XCTAssertEqual(view.string, raw as String)
    XCTAssertEqual(
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "**").location, effectiveRange: nil) as? NSColor,
      Theme.text)
  }
}
