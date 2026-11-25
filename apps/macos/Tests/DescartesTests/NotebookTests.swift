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
  @MainActor func testEditorRoundTripWithTheWorker() async throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DESCARTES_TEST_DEMO"] == "1")
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
    _ = NSApplication.shared
    let book = Notebook(demo: true)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 900, height: 650), styleMask: [.titled, .resizable],
      backing: .buffered, defer: false)
    window.contentView = NSHostingView(rootView: NoteWindow(book: book))
    window.displayIfNeeded()
    func until(_ what: String, _ condition: () async throws -> Bool) async throws {
      for _ in 0..<500 {
        if try await condition() { return }
        try await Task.sleep(nanoseconds: 20_000_000)
      }
      XCTFail("Timed out: " + what)
    }
    func settle() async throws { try await until("idle") { !book.busy && !book.saving } }
    func text() async throws -> String? {
      try await book.editor.evaluate("window.descartes.text()") as? String
    }
    try await until("editor ready") { book.editor.ready }
    let view = try XCTUnwrap(book.editor.webView)
    XCTAssertGreaterThan(view.frame.width, 850)
    XCTAssertGreaterThan(view.frame.height, 550)
    let draft = "# Editor round trip\n日本語"
    _ = try await book.editor.evaluate(
      "window.descartes.focus(); window.descartes.select(0, window.descartes.text().length);"
        + "document.execCommand('insertText', false, \(String(reflecting: draft)))")
    try await until("typed") { book.text == draft }
    book.save()
    try await until("saved") { book.base?.markdown == draft }
    try await settle()
    let original = try XCTUnwrap(book.base)
    book.new()
    try await until("new note") { try await text() == "# " }
    book.open(original.id)
    try await settle()
    try await until("reopened") { try await text() == draft }
    let api = try API(demo: true)
    _ = try await api.save(draft + " remote", base: original)
    _ = try await book.editor.evaluate(
      "window.descartes.focus();"
        + "window.descartes.select(window.descartes.text().length, window.descartes.text().length);"
        + "document.execCommand('insertText', false, ' local')")
    try await until("typed") { book.text == draft + " local" }
    book.save()
    try await until("conflict reported") { book.message.contains("競合") }
    try await settle()
    XCTAssertTrue(book.dirty)
    XCTAssertTrue(book.message.contains("競合"))
    let shown = try await text()
    XCTAssertEqual(shown, draft + " local")
  }
  @MainActor func testWorkerImageAppearsInTheEditor() async throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["DESCARTES_TEST_DEMO"] == "1")
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
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
    // The editor fetches it through the app's authenticated asset path (no injected loader).
    let editor = try await EditorHarness("# T\n![スクリーンショット](" + path + ")")
    try await editor.until("the uploaded image is decoded") {
      try await editor.js(
        "(() => { const i = document.querySelector('img.cm-note-image');"
          + " return !!i && i.complete && i.naturalWidth === 60 })()") as? Bool == true
    }
    XCTAssertEqual(editor.book.text, "# T\n![スクリーンショット](" + path + ")")
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
