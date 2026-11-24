import AppKit
import XCTest

@testable import Descartes

final class EditorPerformanceTests: XCTestCase {
  @MainActor private func editor(
    _ markdown: String, source: Bool = false, preview: Bool = false, zoom: Int = 10,
    selection: NSRange? = nil
  ) -> (NoteText, Editor.Coordinator) {
    _ = NSApplication.shared
    let view = NoteText(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let coordinator = Editor.Coordinator(Notebook(demo: true))
    coordinator.source = source
    coordinator.preview = preview
    coordinator.zoom = zoom
    view.string = markdown
    if let selection { view.setSelectedRange(selection) }
    view.delegate = coordinator
    coordinator.style(view)
    return (view, coordinator)
  }

  @MainActor private func assertMatchesFullStyle(
    _ view: NoteText, _ coordinator: Editor.Coordinator,
    file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let (expected, _) = editor(
      view.string, source: coordinator.source, preview: coordinator.preview, zoom: coordinator.zoom,
      selection: view.selectedRange())
    let actualStorage = try XCTUnwrap(view.textStorage, file: file, line: line)
    let expectedStorage = try XCTUnwrap(expected.textStorage, file: file, line: line)
    XCTAssertTrue(actualStorage.isEqual(to: expectedStorage), file: file, line: line)
    XCTAssertEqual(view.codeBlocks, expected.codeBlocks, file: file, line: line)
    XCTAssertEqual(
      view.decorations.map(\.at), expected.decorations.map(\.at), file: file, line: line)
    func mark(_ value: NoteText.Mark) -> String {
      switch value {
      case .task(let checked): return "task:\(checked)"
      case .bullet: return "bullet"
      case .rule: return "rule"
      case .image: return "image"
      }
    }
    XCTAssertEqual(
      view.decorations.map { mark($0.mark) }, expected.decorations.map { mark($0.mark) },
      file: file, line: line)
  }

  @MainActor func testSingleLineEditScansOnlyOneLineAndShiftsLaterUTF16Ranges() throws {
    let markdown = "# 見出し🌙\n"
      + (0..<2_000).map { "- [ ] 行\($0) 😀\n" }.joined()
      + "~~~swift\nlet value = 1\n~~~\n---\n"
    let (view, coordinator) = editor(markdown)
    XCTAssertGreaterThan(coordinator.lastStyledLineCount, 2_000)
    let range = (view.string as NSString).range(of: "行500")
    let oldBlock = try XCTUnwrap(view.codeBlocks.first)
    let replacement = "日本語👨‍👩‍👧‍👦"
    let delta = replacement.utf16.count - range.length
    view.insertText(replacement, replacementRange: range)
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    XCTAssertEqual(view.codeBlocks.first?.location, oldBlock.location + delta)
    XCTAssertEqual(view.codeBlocks.first?.length, oldBlock.length)
    XCTAssertEqual(coordinator.book.text, view.string)
    try assertMatchesFullStyle(view, coordinator)
    let inserted = (view.string as NSString).range(of: replacement)
    view.insertText("短い", replacementRange: inserted)
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    try assertMatchesFullStyle(view, coordinator)
  }

  @MainActor func testIncrementalEditsResetOldAttributesAndRebuildMarkers() throws {
    let (view, coordinator) = editor("# 見出し\n- [x] **完了😀**\n- 後続\n---\n")
    for (old, replacement) in [
      ("[x]", "[ ]"), ("**完了😀**", "本文🌙"), ("- [ ] ", "### "),
      ("### ", "- "), ("- 本文🌙", "普通の行"),
    ] {
      let range = (view.string as NSString).range(of: old)
      XCTAssertNotEqual(range.location, NSNotFound)
      view.insertText(replacement, replacementRange: range)
      XCTAssertEqual(coordinator.lastStyledLineCount, 1)
      try assertMatchesFullStyle(view, coordinator)
    }
  }

  @MainActor func testCodeBodyEditsRemainLocalAndResizeContainingBlock() throws {
    let (view, coordinator) = editor(
      "先頭😀\n~~~~swift\n- [ ] コード😀\n~~~\nlet value = 1\n~~~~\n- 後続\n```\n次\n```\n")
    let oldBlocks = view.codeBlocks
    let range = (view.string as NSString).range(of: "コード😀")
    let replacement = "日本語🌙🌙"
    let delta = replacement.utf16.count - range.length
    view.insertText(replacement, replacementRange: range)
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    XCTAssertEqual(view.codeBlocks[0].location, oldBlocks[0].location)
    XCTAssertEqual(view.codeBlocks[0].length, oldBlocks[0].length + delta)
    XCTAssertEqual(view.codeBlocks[1].location, oldBlocks[1].location + delta)
    try assertMatchesFullStyle(view, coordinator)
    // A too-short delimiter is ordinary code and can still use the local path.
    var shortFence = (view.string as NSString).range(of: "~~~\n")
    shortFence.length -= 1
    view.insertText("~~", replacementRange: shortFence)
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    try assertMatchesFullStyle(view, coordinator)
  }

  @MainActor func testNewlinesFenceChangesAndBatchedEditsFallBackToFullStyle() throws {
    for (markdown, old, replacement) in [
      ("先頭\n本文\n末尾", "本文", "本\n文"),
      ("先頭\r\n本文😀\r\n末尾", "\r\n", ""),
      ("先頭\n本文\n末尾", "本文", "```swift"),
      ("先頭\n~~~swift\n本文\n~~~\n末尾", "~~~swift", "~~~text"),
      ("先頭\n~~~swift\n本文\n~~~\n末尾", "本文", "~~~"),
      ("先頭\n~~~swift\n本文\n~~~\n末尾", "~~~swift", "普通"),
      ("先頭\n本文\n末尾", "本文\n末尾", "一行"),
    ] {
      let (view, coordinator) = editor(markdown)
      view.insertText(replacement, replacementRange: (view.string as NSString).range(of: old))
      XCTAssertGreaterThan(coordinator.lastStyledLineCount, 1, "\(old) → \(replacement)")
      try assertMatchesFullStyle(view, coordinator)
    }
    let (view, coordinator) = editor("先頭\n本文\n末尾")
    let storage = try XCTUnwrap(view.textStorage)
    storage.replaceCharacters(in: NSRange(location: 0, length: 1), with: "始")
    storage.replaceCharacters(in: (view.string as NSString).range(of: "本文"), with: "日本語😀")
    view.didChangeText()
    XCTAssertEqual(coordinator.lastStyledLineCount, 3)
    try assertMatchesFullStyle(view, coordinator)
  }

  @MainActor func testLineEndingsAndEmptyDocumentEditsMatchFullStyle() throws {
    for markdown in ["", "\n", "先頭\n", "先頭\r\n本文\r\n末尾", "先頭\r本文\r末尾"] {
      let (view, coordinator) = editor(markdown)
      view.insertText("日本語😀", replacementRange: NSRange(location: markdown.utf16.count, length: 0))
      try assertMatchesFullStyle(view, coordinator)
      view.insertText("🌙", replacementRange: NSRange(location: 0, length: 0))
      XCTAssertEqual(coordinator.lastStyledLineCount, 1)
      try assertMatchesFullStyle(view, coordinator)
    }
  }

  @MainActor func testSourcePreviewAndZoomChangesRebuildBeforeFurtherLocalEdits() throws {
    let (view, coordinator) = editor("# 見出し\n- [x] **本文🌙**\n```\ncode\n```\n")
    for (source, preview, zoom) in [(true, false, 10), (false, true, 15), (false, false, 10)] {
      coordinator.source = source
      coordinator.preview = preview
      coordinator.zoom = zoom
      // Deliberately edit before explicitly restyling: stale configuration must not be reused.
      view.insertText("😀", replacementRange: (view.string as NSString).range(of: "🌙"))
      XCTAssertGreaterThan(coordinator.lastStyledLineCount, 1)
      try assertMatchesFullStyle(view, coordinator)
      view.insertText("🌙", replacementRange: (view.string as NSString).range(of: "😀"))
      XCTAssertEqual(coordinator.lastStyledLineCount, 1)
      try assertMatchesFullStyle(view, coordinator)
    }
  }

  @MainActor func testMarkedTextDefersStylingUntilCommit() throws {
    let (view, coordinator) = editor("# 先頭\n本文🌙\n- 後続\n")
    let replacement = (view.string as NSString).range(of: "本文🌙")
    view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: replacement)
    XCTAssertTrue(view.hasMarkedText())
    coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view))
    let storage = try XCTUnwrap(view.textStorage)
    let snapshot = NSAttributedString(attributedString: storage)
    coordinator.style(view)
    XCTAssertTrue(storage.isEqual(to: snapshot))
    view.setMarkedText(
      "日本語😀", selectedRange: NSRange(location: 5, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0))
    view.insertText("日本語😀", replacementRange: view.markedRange())
    XCTAssertFalse(view.hasMarkedText())
    coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view))
    XCTAssertEqual(view.string, "# 先頭\n日本語😀\n- 後続\n")
    XCTAssertGreaterThan(coordinator.lastStyledLineCount, 1)
    XCTAssertEqual(coordinator.book.text, view.string)
    try assertMatchesFullStyle(view, coordinator)
  }

  @MainActor func testUndoAndRedoPreserveMarkdownSelectionAndStyles() throws {
    let markdown = "# 見出し\n- [x] 日本語🌙\n```\ncode\n```\n"
    let (view, coordinator) = editor(markdown)
    let window = NSWindow(
      contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = view
    view.allowsUndo = true
    let undo = try XCTUnwrap(view.undoManager)
    undo.removeAllActions()
    let range = (markdown as NSString).range(of: "日本語🌙")
    view.setSelectedRange(range)
    view.insertText("編集😀", replacementRange: range)
    view.breakUndoCoalescing()
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    XCTAssertEqual(view.selectedRange(), NSRange(location: range.location + 4, length: 0))
    let edited = view.string
    undo.undo()
    XCTAssertEqual(view.string, markdown)
    XCTAssertEqual(coordinator.book.text, markdown)
    try assertMatchesFullStyle(view, coordinator)
    undo.redo()
    XCTAssertEqual(view.string, edited)
    XCTAssertEqual(coordinator.book.text, edited)
    try assertMatchesFullStyle(view, coordinator)
  }

  @MainActor func testCodeBlockDrawingSkipsOffscreenBlocks() {
    let markdown = (0..<40).map { "```\ncode \($0)\n```\n\n" }.joined()
    let (view, _) = editor(markdown)
    let canvas = NSImage(size: view.bounds.size, flipped: true) { _ in
      view.draw(NSRect(x: 0, y: 0, width: 600, height: 100))
      return true
    }
    // Materialize the drawing handler while this view is alive.
    XCTAssertNotNil(canvas.tiffRepresentation)
    XCTAssertGreaterThan(view.lastDrawnCodeBlockCount, 0)
    XCTAssertLessThan(view.lastDrawnCodeBlockCount, view.codeBlocks.count)
  }

  @MainActor func testImageRefreshOnlyVisitsCurrentMatchingProseLines() throws {
    let name = "11111111-1111-1111-1111-111111111111.png"
    let image = "![画像](../assets/\(name))"
    let markdown = "先頭🌙\n\(image)\n"
      + (0..<200).map { "本文\($0)\n" }.joined()
      + "\(image)\n```\n\(image)\n```\n- 後続\n"
    let (view, coordinator) = editor(markdown)
    view.insertText("追記😀", replacementRange: NSRange(location: 0, length: 0))
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    coordinator.refreshImage(name, in: view)
    XCTAssertEqual(coordinator.lastStyledLineCount, 2)
    try assertMatchesFullStyle(view, coordinator)
    let first = (view.string as NSString).range(of: image)
    view.insertText("画像を削除", replacementRange: first)
    coordinator.refreshImage(name, in: view)
    XCTAssertEqual(coordinator.lastStyledLineCount, 1)
    try assertMatchesFullStyle(view, coordinator)
  }
}
