import AppKit
import WebKit
import XCTest

@testable import Descartes

/// The Mac editor is the web app's CodeMirror editor in a WKWebView (its editing behaviour is
/// tested in Chromium and WebKit by the Storybook suite). These tests cover the Mac side: the
/// page loads from the app's scheme, notes and modes reach it, edits and commands come back to
/// the notebook, and images load only through the authenticated asset path.
@MainActor final class EditorHarness {
  let book: Notebook
  let view: WKWebView
  let window: NSWindow
  init(
    _ markdown: String, book existing: Notebook? = nil,
    images: ((String) async throws -> Data)? = nil
  ) async throws {
    _ = NSApplication.shared
    // Saves succeed in memory, so switching notes never needs the discard alert.
    book = existing ?? Notebook(demo: true) { markdown, base in
      Document(id: base?.id ?? UUID(), title: Notebook.title(of: markdown), markdown: markdown, sha: UUID().uuidString)
    }
    book.text = markdown
    book.editor.book = book
    view = book.editor.makeWebView(demo: true, images: images)
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 700, height: 500), styleMask: [.titled],
      backing: .buffered, defer: false)
    window.contentView = view
    try await until("the editor page is ready") { self.book.editor.ready }
    try await until("the note is shown") { try await self.js("window.descartes.text()") as? String == markdown }
  }
  func js(_ script: String) async throws -> Any? { try await view.evaluateJavaScript(script) }
  func count(_ selector: String) async throws -> Int {
    try await js("document.querySelectorAll('\(selector)').length") as? Int ?? -1
  }
  /// Waits for an asynchronous condition (page loads and messages arrive on the run loop).
  func until(
    _ what: String, timeout: Double = 10, _ condition: @escaping () async throws -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if try await condition() { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("Timed out: \(what)")
  }
  /// Types like the keyboard does (a DOM input event in the editor), after placing the caret.
  func type(_ text: String, at caret: Int) async throws {
    _ = try await js(
      "window.descartes.focus(); window.descartes.select(\(caret), \(caret));"
        + "document.execCommand('insertText', false, \(String(reflecting: text)))")
  }
}

final class EditorBridgeTests: XCTestCase {
  @MainActor func testTheNoteIsShownWithLiveMarkdown() async throws {
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
    let editor = try await EditorHarness("# 買い物\n- [ ] 牛乳\n- [x] 卵\n- 箇条書き\n> 引用\n```\ncode\n```")
    let checkboxes = try await editor.count(".cm-task-checkbox")
    let bullets = try await editor.count(".cm-bullet")
    let quotes = try await editor.count(".cm-quote-bar")
    let code = try await editor.count(".cm-code-line")
    XCTAssertEqual([checkboxes, bullets, quotes, code], [2, 1, 1, 3])
    // The page is transparent so the window's glass background shows through.
    let background = try await editor.js("getComputedStyle(document.body).backgroundColor")
    XCTAssertEqual(background as? String, "rgba(0, 0, 0, 0)")
  }

  @MainActor func testTypingAndMenuCommandsReachTheNotebook() async throws {
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
    let editor = try await EditorHarness("# T\n- [ ] 牛乳\n- [ ] 卵")
    let book = editor.book
    // Typing updates the notebook (the shortcuts themselves are covered by the browser tests).
    try await editor.type("\n- [ ] パン", at: (book.text as NSString).length)
    try await editor.until("typed text") { book.text == "# T\n- [ ] 牛乳\n- [ ] 卵\n- [ ] パン" }
    // Menu commands run in the page: check the todo, then undo it.
    _ = try await editor.js("window.descartes.select(6, 6)")
    book.editor.run("task")
    try await editor.until("checked") { book.text.hasPrefix("# T\n- [x] 牛乳") }
    book.editor.run("undo")
    try await editor.until("undone") { book.text.hasPrefix("# T\n- [ ] 牛乳") }
    _ = try await editor.js("window.descartes.select(10, 12)")
    book.editor.run("bold")
    try await editor.until("bold") { book.text.contains("**牛乳**") }
    book.editor.run("move-down")
    try await editor.until("moved") { book.text.hasSuffix("- [ ] **牛乳**\n- [ ] パン") }
    XCTAssertTrue(book.dirty)
  }

  @MainActor func testReadOnlySourceZoomAndNewNotes() async throws {
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
    let editor = try await EditorHarness("# T\n- [ ] 牛乳")
    let book = editor.book
    // Read-only while the notebook is busy (loading or switching notes).
    book.busy = true
    book.editor.sync()
    try await editor.until("read-only") {
      try await editor.js("document.querySelector('.cm-content').contentEditable") as? String
        == "false"
    }
    book.busy = false
    book.source = true
    book.zoom = 15
    book.editor.sync()
    try await editor.until("raw Markdown") { try await editor.count(".cm-task-checkbox") == 0 }
    let size = try await editor.js("getComputedStyle(document.documentElement).fontSize")
    XCTAssertEqual(size as? String, "22.5px")
    book.source = false
    book.new()
    try await editor.until("a new note") {
      try await editor.js("window.descartes.text()") as? String == "# "
    }
  }

  @MainActor func testImagesLoadOnlyThroughTheAssetPath() async throws {
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
    // A solid red 60×40 PNG.
    let png = try XCTUnwrap(
      Data(
        base64Encoded:
          "iVBORw0KGgoAAAANSUhEUgAAADwAAAAoCAIAAAAt2Q6oAAAATUlEQVR4nO3OAQkAMBDEsPNv+iejHRQiILvtO/ygtBg/KC3GD0qL8YPSYvygtBg/KC3GD0qL8YPSYvygtBg/KC3GD0qL8YPSYvygtNgDHypXKIKLo1cAAAAASUVORK5CYII="
      ))
    var requested: [String] = []
    let name = "11111111-1111-1111-1111-111111111111.png"
    let editor = try await EditorHarness("# T\n![画像](../assets/\(name))\n末尾") {
      requested.append($0)
      return png
    }
    try await editor.until("the image is decoded") {
      try await editor.js(
        "(() => { const i = document.querySelector('img.cm-note-image');"
          + " return !!i && i.complete && i.naturalWidth === 60 })()") as? Bool == true
    }
    XCTAssertEqual(requested, [name])
    // Anything other than the editor's own files and valid asset names is refused.
    let scheme = EditorScheme(root: EditorScheme.bundledRoot()!, images: { _ in Data() })
    XCTAssertNotNil(scheme.file(for: "/editor.html"))
    XCTAssertNil(scheme.file(for: "/../macos/Package.swift"))
    XCTAssertNil(scheme.file(for: "/assets/../../package.json"))
    XCTAssertNil(scheme.file(for: "/"))
    XCTAssertEqual(EditorScheme.mimeType("a.js"), "text/javascript; charset=utf-8")
    XCTAssertTrue(EditorScheme.policy.contains("connect-src 'none'"))
  }

  @MainActor func testShortcutsTypedInTheEditorRunOnce() async throws {
    try XCTSkipIf(EditorScheme.bundledRoot() == nil, "Run pnpm test:macos to build the editor.")
    let app = NSApplication.shared
    let previous = app.mainMenu
    let saved = UserDefaults.standard.object(forKey: "noteZoomTenths")
    defer {
      app.mainMenu = previous
      UserDefaults.standard.set(saved, forKey: "noteZoomTenths")
    }
    let delegate = AppDelegate()
    delegate.buildMenus()
    // The menu and the page edit the same notebook, so a shortcut run by both would show.
    let editor = try await EditorHarness("# T\n牛乳", book: delegate.book)
    editor.window.makeFirstResponder(editor.view)
    _ = try await editor.js("window.descartes.focus(); window.descartes.select(4, 6)")
    /// What AppKit does in the key window: the focused view (the web page) first, then the
    /// app menu only if the page did not handle the key equivalent.
    func press(_ key: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) throws {
      let event = try XCTUnwrap(
        NSEvent.keyEvent(
          with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
          windowNumber: editor.window.windowNumber, context: nil, characters: key,
          charactersIgnoringModifiers: key, isARepeat: false, keyCode: code))
      if !editor.window.performKeyEquivalent(with: event) {
        _ = app.mainMenu?.performKeyEquivalent(with: event)
      }
    }
    try press("b", 11, .command)
    try await editor.until("bold") { editor.book.text != "# T\n牛乳" }
    try await Task.sleep(for: .milliseconds(300))
    // Once: a second run (page and menu) would toggle the bold off again.
    XCTAssertEqual(editor.book.text, "# T\n**牛乳**")
    try press("z", 6, .command)
    try await editor.until("undone") { editor.book.text == "# T\n牛乳" }
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(editor.book.text, "# T\n牛乳")
    // Keys the page does not use (zoom) still reach the app menu.
    let zoom = delegate.book.zoom
    try press("-", 27, .command)
    try await editor.until("zoom") { delegate.book.zoom == max(5, zoom - 1) }
  }

  @MainActor func testMenusRouteEditingCommandsToTheEditor() throws {
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
    let items = menu.items.compactMap(\.submenu).flatMap(\.items)
    let commands = Dictionary(
      items.compactMap { item in
        (item.representedObject as? String).map {
          ($0, item.keyEquivalentModifierMask.rawValue.description + item.keyEquivalent)
        }
      }, uniquingKeysWith: { first, _ in first })
    for command in [
      "undo", "redo", "show", "next", "previous", "heading-prev", "heading-next", "task", "link",
      "code", "bold", "italic", "strike", "move-up", "move-down",
    ] {
      XCTAssertNotNil(commands[command], command)
    }
    // Zoom shortcuts still reach the app menu.
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
}
