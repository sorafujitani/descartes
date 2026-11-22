import SwiftUI
import XCTest

@testable import Descartes

final class NotebookTests: XCTestCase {
  @MainActor func testTitleAndNewDraft() {
    let book = Notebook(demo: true)
    XCTAssertFalse(book.dirty)
    book.text = "# メモ\n\n## Notes\n"
    XCTAssertEqual(book.title, "メモ")
    XCTAssertTrue(book.dirty)
  }
  @MainActor func testNativeEditorRoundTrip() async throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DESCARTES_TEST_DEMO"] == "1")
    _ = NSApplication.shared
    let book = Notebook(demo: true)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 900, height: 650), styleMask: [.titled, .resizable],
      backing: .buffered, defer: false)
    window.contentView = NSHostingView(rootView: NoteWindow(book: book))
    window.displayIfNeeded()
    func findEditor(_ view: NSView) -> NSTextView? {
      if let text = view as? NSTextView { return text }
      for child in view.subviews { if let text = findEditor(child) { return text } }
      return nil
    }
    func settle() async throws {
      for _ in 0..<100 {
        try await Task.sleep(nanoseconds: 20_000_000)
        if !book.busy { return }
      }
      XCTFail("Timed out")
    }
    try await settle()
    let editor = try XCTUnwrap(findEditor(window.contentView!))
    let scroll = try XCTUnwrap(editor.enclosingScrollView)
    XCTAssertGreaterThan(scroll.frame.width, 850)
    XCTAssertGreaterThan(scroll.frame.height, 550)
    let draft = "# Editor round trip\n日本語"
    editor.insertText(
      draft, replacementRange: NSRange(location: 0, length: (editor.string as NSString).length))
    XCTAssertEqual(book.text, draft)
    book.save()
    try await settle()
    let original = try XCTUnwrap(book.base)
    book.new()
    book.open(original.id)
    try await settle()
    XCTAssertEqual(editor.string, draft)
    let api = try API(demo: true)
    _ = try await api.save(draft + " remote", base: original)
    editor.insertText(
      " local", replacementRange: NSRange(location: (editor.string as NSString).length, length: 0))
    book.save()
    try await settle()
    XCTAssertTrue(book.dirty)
    XCTAssertTrue(book.message.contains("競合"))
    XCTAssertEqual(editor.string, draft + " local")
  }
  @MainActor func testNoteDecorationsEditSource() throws {
    _ = NSApplication.shared
    let book = Notebook(demo: true)
    let text = NoteText(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    let coordinator = Editor.Coordinator(book)
    text.delegate = coordinator
    let markdown =
      "# task\n- [ ] example\n  - child\n---\nhttps://example.com\n```\n- [ ] code\n```"
    text.string = markdown
    coordinator.style(text)
    XCTAssertEqual(text.string, markdown)
    XCTAssertEqual(text.decorations.count, 3)
    let task = try XCTUnwrap(text.decorations.first)
    let box = try XCTUnwrap(text.box(at: task.at))
    let label = try XCTUnwrap(text.box(at: task.at + 6))
    XCTAssertGreaterThan(label.minX - box.minX, box.width)
    let window = NSWindow(
      contentRect: text.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = text
    let point = text.convert(NSPoint(x: box.midX, y: box.midY), to: nil)
    let event = try XCTUnwrap(
      NSEvent.mouseEvent(
        with: .leftMouseDown, location: point, modifierFlags: [], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)
    )
    text.mouseDown(with: event)
    XCTAssertEqual(book.text, markdown.replacingOccurrences(of: "[ ] example", with: "[x] example"))
    coordinator.source = true
    coordinator.style(text)
    XCTAssertTrue(text.decorations.isEmpty)
    XCTAssertEqual(text.string, book.text)
  }
  @MainActor func testWorkerImageAppearsWithoutChangingMarkdown() async throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DESCARTES_TEST_DEMO"] == "1")
    _ = NSApplication.shared
    // A solid red 60×40 PNG, independent of the system appearance and screen color space.
    let data = try XCTUnwrap(
      Data(
        base64Encoded:
          "iVBORw0KGgoAAAANSUhEUgAAADwAAAAoCAIAAAAt2Q6oAAAATUlEQVR4nO3OAQkAMBDEsPNv+iejHRQiILvtO/ygtBg/KC3GD0qL8YPSYvygtBg/KC3GD0qL8YPSYvygtBg/KC3GD0qL8YPSYvygtNgDHypXKIKLo1cAAAAASUVORK5CYII="
      ))
    let api = try API(demo: true)
    var upload = URLRequest(url: api.origin.appending(path: "api/assets"))
    upload.httpMethod = "POST"
    upload.httpBody = data
    upload.setValue("1", forHTTPHeaderField: "X-Descartes-Write")
    let (body, _) = try await URLSession.shared.data(for: upload)
    let path = try XCTUnwrap(JSONDecoder().decode([String: String].self, from: body)["path"])
    let markdown = "![スクリーンショット](" + path + ")"
    XCTAssertNotNil(NoteImages.name(in: markdown))
    XCTAssertNil(
      NoteImages.name(
        in: markdown.replacingOccurrences(of: "../assets/", with: "https://example.org/")))
    let view = NoteText(frame: NSRect(x: 0, y: 0, width: 300, height: 180))
    let window = NSWindow(
      contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = view
    let coord = Editor.Coordinator(Notebook(demo: true))
    view.string = markdown
    coord.style(view)
    for _ in 0..<100 where view.decorations.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
    for preview in [false, true] {
      coord.preview = preview
      coord.style(view)
      guard case .image = view.decorations.first?.mark else {
        return XCTFail("Missing image block")
      }
      let canvas = NSImage(size: view.bounds.size, flipped: true) { bounds in
        view.draw(bounds)
        return true
      }
      let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(canvas.tiffRepresentation)))
      let pixel = try XCTUnwrap(bitmap.colorAt(x: 15, y: 20))
      XCTAssertGreaterThan(pixel.redComponent, 0.95)
      XCTAssertLessThan(pixel.greenComponent, 0.05)
      XCTAssertLessThan(pixel.blueComponent, 0.05)
      XCTAssertGreaterThan(pixel.alphaComponent, 0.95)
      XCTAssertEqual(view.string, markdown)
    }
    coord.source = true
    coord.style(view)
    XCTAssertTrue(view.decorations.isEmpty)
    coord.source = false
    view.string = "```\n" + markdown + "\n```"
    coord.style(view)
    XCTAssertTrue(view.decorations.isEmpty)
  }

  func testWorkerRoundTrip() async throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["DESCARTES_TEST_DEMO"] == "1",
      "Requires local in-memory Worker on port 8788.")
    let api = try API(demo: true)
    let text = "# macOS test \(UUID())\n\n日本語"
    let created = try await api.save(text, base: nil)
    let list = try await api.list()
    XCTAssertTrue(list.contains(where: { $0.id == created.id }))
    let read = try await api.get(created.id)
    XCTAssertEqual(read.markdown, text)
    let edited = try await api.save(text + "\n追記", base: read)
    XCTAssertNotEqual(edited.sha, read.sha)
    do {
      _ = try await api.save("stale", base: read)
      XCTFail("Expected rejection")
    } catch {
      let saved = try await api.get(created.id)
      XCTAssertEqual(saved.markdown, edited.markdown)
    }
    do {
      _ = try await api.save(text + " stale", base: read)
      XCTFail("Expected conflict")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains("競合"))
    }
  }
}
