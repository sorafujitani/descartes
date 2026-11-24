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
      ("- メモ", "- "), ("9. 日本語", "10. "), ("- [X] done", "- [ ] "), ("> quote", "> "),
    ] {
      let view = editor(line)
      view.insertNewline(nil)
      XCTAssertEqual(view.string, line + "\n" + expected)
      view.insertNewline(nil)
      XCTAssertEqual(view.string, line + "\n")
    }
    // An empty nested item first moves out a level, then ends the list.
    for (line, expected, outdented) in [
      ("  * entry", "  * ", "* "), ("  2) 😀", "  3) ", "3) "), ("\t- [ ] a", "\t- [ ] ", "- [ ] "),
    ] {
      let view = editor(line)
      view.insertNewline(nil)
      XCTAssertEqual(view.string, line + "\n" + expected)
      view.insertNewline(nil)
      XCTAssertEqual(view.string, line + "\n" + outdented)
      XCTAssertEqual(view.selectedRange().location, view.string.utf16.count)
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
  @MainActor func testCommandReturnCreatesTodos() {
    // (line, caret offset, result, caret offset after)
    for (line, caret, expected, after) in [
      ("", 0, "- [ ] ", 6), ("買い物", 3, "- [ ] 買い物", 9), ("買い物", 0, "- [ ] 買い物", 6),
      ("- 牛乳", 3, "- [ ] 牛乳", 7), ("- ", 2, "- [ ] ", 6), ("-", 1, "- [ ] ", 6),
      ("  * nested", 10, "  * [ ] nested", 14), ("3. 番号", 5, "3. [ ] 番号", 9),
      ("> 引用", 4, "> - [ ] 引用", 10), ("  字下げ", 5, "  - [ ] 字下げ", 11),
      ("- [ ] open", 4, "- [x] open", 4), ("* [X] done", 10, "* [ ] done", 10),
      ("> - [ ] 引用", 9, "> - [x] 引用", 9), ("#tag", 4, "- [ ] #tag", 10),
    ] {
      let view = editor("# Title\n" + line + "\n次の行")
      view.setSelectedRange(NSRange(location: 8 + caret, length: 0))
      view.toggleTask()
      XCTAssertEqual(view.string, "# Title\n" + expected + "\n次の行", line)
      XCTAssertEqual(view.selectedRange(), NSRange(location: 8 + after, length: 0), line)
    }
    // Headings (including the title) and fenced code are never converted.
    for (markdown, caret) in [("# Title", 3), ("# Title\n## 見出し", 12), ("```\nコード", 6)] {
      let view = editor(markdown)
      view.setSelectedRange(NSRange(location: caret, length: 0))
      view.toggleTask()
      XCTAssertEqual(view.string, markdown)
    }
    // A multi-line selection converts every non-empty line, then checks them together.
    let view = editor("# T\nA\n\n- B\n- [x] C\n```\nD\n```\n")
    let raw = view.string as NSString
    let start = raw.range(of: "A").location
    view.setSelectedRange(
      NSRange(location: start, length: raw.range(of: "C").location + 2 - start))
    view.toggleTask()
    XCTAssertEqual(view.string, "# T\n- [ ] A\n\n- [ ] B\n- [x] C\n```\nD\n```\n")
    XCTAssertEqual(
      (view.string as NSString).substring(with: view.selectedRange()),
      "A\n\n- [ ] B\n- [x] C\n")
    view.toggleTask()
    XCTAssertEqual(view.string, "# T\n- [x] A\n\n- [x] B\n- [x] C\n```\nD\n```\n")
    view.toggleTask()
    XCTAssertEqual(view.string, "# T\n- [ ] A\n\n- [ ] B\n- [ ] C\n```\nD\n```\n")
    // Undo restores the whole conversion in one step.
    let undoable = editor("# T\n牛乳")
    let window = NSWindow(
      contentRect: undoable.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = undoable
    undoable.allowsUndo = true
    undoable.undoManager?.removeAllActions()
    undoable.toggleTask()
    XCTAssertEqual(undoable.string, "# T\n- [ ] 牛乳")
    undoable.undoManager?.undo()
    XCTAssertEqual(undoable.string, "# T\n牛乳")
  }
  @MainActor func testTodoTypedOrCreatedIsStyledAsCheckbox() {
    let coord = Editor.Coordinator(Notebook(demo: true))
    let view = editor("# T\n")
    view.delegate = coord
    coord.style(view)
    for character in "- [ ] 牛乳" {
      view.insertText(String(character), replacementRange: view.selectedRange())
    }
    view.insertNewline(nil)
    view.insertText("卵", replacementRange: view.selectedRange())
    view.insertNewline(nil)
    view.insertNewline(nil)
    view.insertText("パン", replacementRange: view.selectedRange())
    view.toggleTask()
    XCTAssertEqual(view.string, "# T\n- [ ] 牛乳\n- [ ] 卵\n- [ ] パン")
    XCTAssertEqual(view.decorations.count, 3)
    for decoration in view.decorations {
      guard case .task(false) = decoration.mark else { return XCTFail("\(decoration.mark)") }
    }
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
    // Fences are hidden away from the caret, muted on the caret's line, hidden in preview.
    XCTAssertEqual(
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "```").location, effectiveRange: nil)
        as? NSColor, NSColor.clear)
    view.setSelectedRange(NSRange(location: raw.range(of: "```js").location + 5, length: 0))
    coord.style(view)
    XCTAssertEqual(
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "```").location, effectiveRange: nil)
        as? NSColor, Theme.muted)
    coord.preview = true
    coord.style(view)
    XCTAssertEqual(
      view.textStorage?.attribute(
        .foregroundColor, at: raw.range(of: "```").location, effectiveRange: nil)
        as? NSColor, NSColor.clear)
    coord.preview = false
    coord.style(view)
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
