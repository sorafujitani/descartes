import AppKit
import XCTest

@testable import Descartes

/// Drives the real NSTextView one keystroke at a time and checks editor invariants after every
/// step, so a bug shows up at the key that caused it instead of only in the final Markdown:
///
/// 1. Everything on the caret's line that is not a styled marker (bullet/checkbox/heading `#`)
///    is visible: you can always see what you are typing, including IME composition.
/// 2. Typing attributes are visible (the next character will not be hidden or spaced out).
/// 3. The caret is never inside a hidden marker.
/// 4. The incrementally styled text equals a fresh full styling of the same Markdown.
/// 5. The notebook's text mirrors the view.
@MainActor final class Scenario {
  let view: NoteText
  let coordinator: Editor.Coordinator
  private let window: NSWindow
  private let file: StaticString
  private let line: UInt
  private(set) var step = "start"

  init(
    _ markdown: String = "# T\n", caret: Int? = nil, source: Bool = false, zoom: Int = 10,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    _ = NSApplication.shared
    self.file = file
    self.line = line
    let storage = NSTextStorage()
    let layout = NSLayoutManager()
    let container = NSTextContainer(
      size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    storage.addLayoutManager(layout)
    layout.addTextContainer(container)
    // Same configuration as Editor.makeNSView.
    view = NoteText(frame: NSRect(x: 0, y: 0, width: 600, height: 400), textContainer: container)
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    view.textContainerInset = NSSize(width: 21, height: 10)
    view.isRichText = false
    view.drawsBackground = false
    view.allowsUndo = true
    view.isAutomaticQuoteSubstitutionEnabled = false
    view.isAutomaticDashSubstitutionEnabled = false
    view.isAutomaticTextReplacementEnabled = false
    view.font = .systemFont(ofSize: 14)
    coordinator = Editor.Coordinator(Notebook(demo: true))
    coordinator.source = source
    coordinator.zoom = zoom
    view.autoFormat = !source
    view.delegate = coordinator
    window = NSWindow(
      contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = view
    view.string = markdown
    coordinator.book.text = markdown
    coordinator.style(view)
    // A real key press is one run-loop event and one undo group; tests have no event loop.
    view.undoManager?.groupsByEvent = false
    view.undoManager?.removeAllActions()
    view.setSelectedRange(NSRange(location: caret ?? markdown.utf16.count, length: 0))
    check()
  }

  var text: String { view.string }
  var caret: Int { view.selectedRange().location }

  @discardableResult func type(_ text: String) -> Self {
    for character in text {
      step = "type \(String(character).debugDescription)"
      event {
        if character == "\n" {
          view.insertNewline(nil)
        } else {
          view.insertText(String(character), replacementRange: view.selectedRange())
        }
      }
      check()
    }
    return self
  }
  /// Runs one simulated key event inside its own undo group.
  func event(_ body: () -> Void) {
    guard let undo = view.undoManager else { return body() }
    undo.beginUndoGrouping()
    body()
    undo.endUndoGrouping()
  }
  @discardableResult func key(_ name: String) -> Self {
    step = name
    if name == "undo" || name == "redo" {
      if name == "undo" { view.undoManager?.undo() } else { view.undoManager?.redo() }
      check()
      return self
    }
    // Moving the caret or a non-typing command ends typing coalescing, as in AppKit.
    view.breakUndoCoalescing()
    event { perform(name) }
    check()
    return self
  }
  private func perform(_ name: String) {
    switch name {
    case "return": view.insertNewline(nil)
    case "tab": view.insertTab(nil)
    case "backtab": view.insertBacktab(nil)
    case "backspace": view.deleteBackward(nil)
    case "delete": view.deleteForward(nil)
    case "left": view.moveLeft(nil)
    case "right": view.moveRight(nil)
    case "up": view.moveUp(nil)
    case "down": view.moveDown(nil)
    case "home": view.moveToLeftEndOfLine(nil)
    case "end": view.moveToRightEndOfLine(nil)
    case "cmd-return": view.toggleTask()
    case "alt-up": view.moveLinesUp()
    case "alt-down": view.moveLinesDown()
    default: XCTFail("unknown key \(name)", file: file, line: line)
    }
  }
  /// Pastes plain text the way ⌘V does, without touching the user's clipboard.
  @discardableResult func paste(_ text: String) -> Self {
    step = "paste \(text)"
    view.breakUndoCoalescing()
    event {
      if !view.pasteLink(text) { view.insertText(text, replacementRange: view.selectedRange()) }
    }
    check()
    return self
  }
  /// IME: composes each reading, then commits `commit` (e.g. "にほんご" → "日本語").
  @discardableResult func compose(_ readings: [String], commit: String) -> Self {
    for reading in readings {
      step = "compose \(reading)"
      let replace = view.hasMarkedText() ? view.markedRange() : view.selectedRange()
      event {
        view.setMarkedText(
          reading, selectedRange: NSRange(location: reading.utf16.count, length: 0),
          replacementRange: replace)
      }
      coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view))
      check()
    }
    step = "commit \(commit)"
    event {
      view.insertText(commit, replacementRange: view.markedRange())
      view.unmarkText()
    }
    check()
    return self
  }
  @discardableResult func select(_ location: Int, _ length: Int = 0) -> Self {
    step = "select \(location),\(length)"
    view.setSelectedRange(NSRange(location: location, length: length))
    check()
    return self
  }
  /// Places the caret just after the first occurrence of `marker`.
  @discardableResult func caret(after marker: String) -> Self {
    let range = (view.string as NSString).range(of: marker)
    XCTAssertNotEqual(range.location, NSNotFound, "no \(marker)", file: file, line: line)
    return select(NSMaxRange(range))
  }
  func expect(_ markdown: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(view.string, markdown, file: file, line: line)
  }

  // MARK: Invariants

  private func fail(_ message: String) {
    XCTFail("[\(step)] \(message) — text: \(view.string.debugDescription)", file: file, line: line)
  }
  private static func visible(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
    let size = (attributes[.font] as? NSFont)?.pointSize ?? 14
    let alpha = (attributes[.foregroundColor] as? NSColor)?.alphaComponent ?? 1
    return size >= 1 && alpha > 0
  }
  func check() {
    guard let storage = view.textStorage else { return fail("no storage") }
    let raw = view.string as NSString
    let selection = view.selectedRange()
    if coordinator.book.text != view.string { fail("notebook text is stale") }
    if selection.length == 0, view.atomicRange(around: selection.location) != nil {
      fail("caret inside a hidden marker at \(selection.location)")
    }
    if !Self.visible(view.typingAttributes) { fail("typing attributes are hidden") }
    // What you are typing must be visible, including uncommitted IME text.
    let lineRange = raw.lineRange(for: NSRange(location: selection.location, length: 0))
    var checked = lineRange
    if view.hasMarkedText() { checked = NSUnionRange(checked, view.markedRange()) }
    var index = checked.location
    while index < NSMaxRange(checked) && index < storage.length {
      let character = raw.character(at: index)
      let attributes = storage.attributes(at: index, effectiveRange: nil)
      if character != 10, character != 13, attributes[NoteText.atomicMarker] == nil,
        !Self.visible(attributes)
      {
        let glyph = raw.substring(with: raw.rangeOfComposedCharacterSequence(at: index))
        fail("\(glyph.debugDescription) at \(index) on the caret line is hidden")
        break
      }
      index += 1
    }
    if view.hasMarkedText() {
      // Styling waits for the composition to be committed, but markers and code blocks on other
      // lines must already be drawn where a full restyle would put them.
      let composing = raw.lineRange(for: view.markedRange())
      let fresh = Scenario.styled(
        view.string, source: coordinator.source, preview: coordinator.preview,
        zoom: coordinator.zoom, selection: selection)
      let mine = view.decorations.map(\.at).filter { !NSLocationInRange($0, composing) }
      let theirs = fresh.decorations.map(\.at).filter { !NSLocationInRange($0, composing) }
      if mine != theirs { fail("markers during composition \(mine) vs \(theirs)") }
      let blocks = { (blocks: [NSRange]) in
        blocks.filter { NSIntersectionRange($0, composing).length == 0 }
      }
      if blocks(view.codeBlocks) != blocks(fresh.codeBlocks) {
        fail("code blocks during composition \(view.codeBlocks) vs \(fresh.codeBlocks)")
      }
      return
    }
    // Incremental styling must be indistinguishable from styling the whole document again.
    let fresh = Scenario.styled(
      view.string, source: coordinator.source, preview: coordinator.preview,
      zoom: coordinator.zoom, selection: selection)
    if let expected = fresh.textStorage, !storage.isEqual(to: expected) {
      var at = 0
      while at < storage.length {
        var mine = NSRange(), theirs = NSRange()
        let a = storage.attributes(at: at, effectiveRange: &mine)
        let b = expected.attributes(at: at, effectiveRange: &theirs)
        if !NSDictionary(dictionary: a).isEqual(to: b) {
          fail("styling differs from a full restyle at \(at): \(a) vs \(b)")
          break
        }
        at = min(NSMaxRange(mine), NSMaxRange(theirs))
      }
    }
    if view.decorations.map(\.at) != fresh.decorations.map(\.at) {
      fail("decorations \(view.decorations.map(\.at)) vs \(fresh.decorations.map(\.at))")
    }
    if view.codeBlocks != fresh.codeBlocks {
      fail("code blocks \(view.codeBlocks) vs \(fresh.codeBlocks)")
    }
  }
  /// A fresh full styling, with the same selection (fences on the caret's line are shown).
  static func styled(
    _ markdown: String, source: Bool, preview: Bool, zoom: Int, selection: NSRange
  ) -> NoteText {
    let view = NoteText(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let coordinator = Editor.Coordinator(Notebook(demo: true))
    coordinator.source = source
    coordinator.preview = preview
    coordinator.zoom = zoom
    view.string = markdown
    view.setSelectedRange(selection)
    coordinator.style(view)
    return view
  }
}

/// tests/fixtures/editing-scenarios.json, shared with the web editor's Storybook scenarios.
struct SharedScenario: Decodable {
  enum Position: Decodable {
    case index(Int)
    case after(String)
    init(from decoder: Decoder) throws {
      let container = try decoder.singleValueContainer()
      if let index = try? container.decode(Int.self) {
        self = .index(index)
      } else {
        self = .after(try container.decode([String: String].self)["after"] ?? "")
      }
    }
  }
  let name, doc, keys, expect: String
  let caret: Position?
  let select, caretAfter: String?
  static func load() throws -> [SharedScenario] {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url = url.deletingLastPathComponent() }
    url = url.appendingPathComponent("tests/fixtures/editing-scenarios.json")
    struct File: Decodable { let scenarios: [SharedScenario] }
    return try JSONDecoder().decode(File.self, from: Data(contentsOf: url)).scenarios
  }
  /// Splits "ab{return}c" into ["a", "b", "{return}", "c"].
  var tokens: [String] {
    var result: [String] = []
    var rest = Substring(keys)
    while let first = rest.first {
      if first == "{", let close = rest.firstIndex(of: "}") {
        result.append(String(rest[...close]))
        rest = rest[rest.index(after: close)...]
      } else {
        result.append(String(first))
        rest = rest.dropFirst()
      }
    }
    return result
  }
}

final class EditorScenarioTests: XCTestCase {
  @MainActor func testSharedScenariosMatchTheWebEditor() throws {
    let scenarios = try SharedScenario.load()
    XCTAssertGreaterThan(scenarios.count, 10)
    for scenario in scenarios {
      let s = Scenario(scenario.doc)
      switch scenario.caret {
      case .index(let index): s.select(index)
      case .after(let text): s.caret(after: text)
      case nil: break
      }
      if let select = scenario.select {
        let range = (s.text as NSString).range(of: select)
        s.select(range.location, range.length)
      }
      for token in scenario.tokens {
        if token.hasPrefix("{paste:") {
          s.paste(String(token.dropFirst(7).dropLast()))
        } else if token.hasPrefix("{") {
          s.key(String(token.dropFirst().dropLast()))
        } else {
          s.type(token)
        }
      }
      XCTAssertEqual(s.text, scenario.expect, scenario.name)
      if let caretAfter = scenario.caretAfter {
        let range = (s.text as NSString).range(of: caretAfter)
        XCTAssertEqual(s.caret, NSMaxRange(range), "caret: \(scenario.name)")
      }
    }
  }

  // MARK: Code blocks

  @MainActor func testTypingACodeBlockKeepsEverythingVisible() {
    let s = Scenario()
    s.type("```swift\nlet a = 1\nlet b = 2\n```\n後の段落")
    s.expect("# T\n```swift\nlet a = 1\nlet b = 2\n```\n後の段落")
    XCTAssertEqual(s.view.codeBlocks.count, 1)
    // Tilde fences, a longer delimiter and an unclosed block at the end of the note.
    Scenario().type("~~~~\n~~~\ncode\n~~~~\n\n```\nopen").expect(
      "# T\n~~~~\n~~~\ncode\n~~~~\n\n```\nopen\n```")
  }
  @MainActor func testCodeBlockBodyIsLiteral() {
    // List syntax inside code: Return does not continue it, Tab inserts a tab, [] stays.
    let s = Scenario("# T\n```\n- item\n```\n")
    s.caret(after: "- item").key("return").type("[]").key("tab").type("x")
    s.expect("# T\n```\n- item\n[]\tx\n```\n")
    // Backspace at the start of a code line joins lines; it never eats list markers.
    s.key("home").key("backspace")
    s.expect("# T\n```\n- item[]\tx\n```\n")
    // Japanese input inside code.
    s.key("end").compose(["に", "にほ", "にほん"], commit: "日本")
    s.expect("# T\n```\n- item[]\tx日本\n```\n")
  }
  @MainActor func testEditingFencesRestylesTheWholeBlock() {
    let s = Scenario("# T\n```\ncode\n```\nafter")
    // Removing a backtick of the opening fence turns the block back into prose, and back.
    s.caret(after: "# T\n```").key("backspace").type("`")
    s.expect("# T\n```\ncode\n```\nafter")
    XCTAssertEqual(s.view.codeBlocks.count, 1)
    s.caret(after: "code\n```").key("backspace")
    XCTAssertEqual(s.view.codeBlocks.count, 1, "unclosed block runs to the end")
    s.type("`")
    s.expect("# T\n```\ncode\n```\nafter")
  }
  @MainActor func testNewMarkdownElementsRenderLikeTheWeb() throws {
    let s = Scenario("# T\n1. [ ] 一\n2. [x] 二\n> 引用\n~~消す~~ と _slanted_ と snake_case_name\n3. 番号")
    let marks = s.view.decorations.map { "\($0.mark)" }
    XCTAssertEqual(marks, ["task(false)", "task(true)", "quote"])
    let storage = try XCTUnwrap(s.view.textStorage)
    let raw = s.text as NSString
    XCTAssertEqual(
      storage.attribute(.strikethroughStyle, at: raw.range(of: "消す").location, effectiveRange: nil)
        as? Int, NSUnderlineStyle.single.rawValue)
    // Japanese falls back to Hiragino, which has no italic; Latin text shows the emphasis.
    let italic = storage.attribute(
      .font, at: raw.range(of: "slanted").location, effectiveRange: nil)
    XCTAssertTrue(
      (italic as? NSFont).map { NSFontManager.shared.traits(of: $0).contains(.italicFontMask) }
        ?? false)
    let snake = storage.attribute(.font, at: raw.range(of: "case").location, effectiveRange: nil)
    XCTAssertFalse(
      (snake as? NSFont).map { NSFontManager.shared.traits(of: $0).contains(.italicFontMask) }
        ?? true, "underscores inside words are not emphasis")
    // Clicking a numbered todo's checkbox toggles its box.
    let box = try XCTUnwrap(s.view.box(at: s.view.decorations[0].at))
    let hit = try XCTUnwrap(s.view.task(at: NSPoint(x: box.midX, y: box.midY)))
    s.event { s.view.toggleBox(at: hit.at, checked: hit.checked) }
    XCTAssertTrue(s.text.contains("1. [x] 一"))
  }

  @MainActor func testLinkDetectionAndMoveLineMenuKeys() throws {
    let s = Scenario("# T\n[サイト](https://example.com/a) と https://x.org/p")
    let raw = s.text as NSString
    XCTAssertEqual(s.view.link(at: raw.range(of: "サイト").location)?.absoluteString,
      "https://example.com/a")
    XCTAssertEqual(s.view.link(at: raw.range(of: "x.org").location)?.absoluteString,
      "https://x.org/p")
    XCTAssertNil(s.view.link(at: raw.range(of: "と").location))
    // ⌥↑ reaches the text view through the Note menu, as typed in the app.
    let app = NSApplication.shared
    let previous = app.mainMenu
    defer { app.mainMenu = previous }
    AppDelegate().buildMenus()
    let lines = Scenario("# T\n一\n二")
    lines.view.window?.makeFirstResponder(lines.view)
    let up = String(Character(UnicodeScalar(NSUpArrowFunctionKey)!))
    let event = try XCTUnwrap(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [.option, .function], timestamp: 0,
        windowNumber: lines.view.window?.windowNumber ?? 0, context: nil, characters: up,
        charactersIgnoringModifiers: up, isARepeat: false, keyCode: 126))
    let item = try XCTUnwrap(
      app.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first {
        $0.action == #selector(NoteText.moveLinesUp)
      })
    XCTAssertEqual(item.keyEquivalent, up)
    XCTAssertEqual(item.keyEquivalentModifierMask, [.option])
    _ = event
    lines.event { lines.view.moveLinesUp() }
    lines.expect("# T\n二\n一")
  }

  @MainActor func testFencesShowOnlyOnTheCaretLine() {
    let s = Scenario("# T\n```js\nconsole.log(1)\n```\n後")
    func shown(_ marker: String, after: Bool = false) -> Bool {
      let raw = s.text as NSString
      let range = after ? raw.range(of: marker, options: .backwards) : raw.range(of: marker)
      let color = s.view.textStorage?.attribute(
        .foregroundColor, at: range.location, effectiveRange: nil)
      return color as? NSColor != NSColor.clear
    }
    XCTAssertFalse(shown("```js"))
    XCTAssertFalse(shown("```", after: true))
    // Arrowing onto a fence shows just that fence (check() verifies the caret line is visible).
    s.key("up")
    XCTAssertTrue(shown("```", after: true))
    XCTAssertFalse(shown("```js"))
    s.key("up").key("up")
    XCTAssertTrue(shown("```js"))
    XCTAssertFalse(shown("```", after: true))
    // Editing the language on the fence line keeps it visible; leaving hides it again.
    s.key("end").key("backspace").key("backspace").type("swift")
    s.expect("# T\n```swift\nconsole.log(1)\n```\n後")
    s.key("down")
    XCTAssertFalse(shown("```swift"))
    // A selection across the block shows both fences.
    s.select(4, (s.text as NSString).range(of: "後").location - 4)
    XCTAssertTrue(shown("```swift"))
    XCTAssertTrue(shown("```", after: true))
  }

  @MainActor func testReturnOnAnOpeningFenceClosesTheBlock() {
    // Return after ``` (or ```lang / ~~~) adds the closing fence and puts the caret inside,
    // so the rest of the note does not turn into code.
    let s = Scenario("# T\n\n後の段落")
    s.caret(after: "# T\n").type("```js\nconsole.log(1)")
    s.expect("# T\n```js\nconsole.log(1)\n```\n後の段落")
    XCTAssertEqual(s.view.codeBlocks.count, 1)
    Scenario().type("~~~\nx").expect("# T\n~~~\nx\n~~~")
    // An already closed block, or Return in the middle of the fence line, is left alone.
    Scenario("# T\n```\na\n```").caret(after: "# T\n```").type("\nb").expect(
      "# T\n```\nb\na\n```")
    Scenario("# T\n```js").caret(after: "# T\n``").type("\n").expect("# T\n``\n`js")
  }

  @MainActor func testPasteReplaceAndReturnAtEveryPositionOfAnItem() {
    let s = Scenario("# T\n- a")
    s.event {
      s.view.insertText("b\n- [ ] c\n```\nd\n```\n", replacementRange: s.view.selectedRange())
    }
    s.check()
    s.expect("# T\n- ab\n- [ ] c\n```\nd\n```\n")
    // Replacing a selection that spans markers and lines.
    let range = (s.text as NSString).range(of: "b\n- [ ] c")
    s.select(range.location, range.length).type("X")
    s.expect("# T\n- aX\n```\nd\n```\n")
    // Return at the start of the item text inserts an empty item above it.
    let item = Scenario("# T\n- [ ] a")
    item.caret(after: "- [ ] ").key("return")
    item.expect("# T\n- [ ] \n- [ ] a")
    // Return before the marker moves the whole item down.
    let before = Scenario("# T\n- a")
    before.select(4).key("return")
    before.expect("# T\n\n- a")
    // Return inside a heading splits it.
    Scenario("# タイトル").caret(after: "# タイ").key("return").expect("# タイ\nトル")
  }

  @MainActor func testMarkersAppearAsYouTypeAndArrowsSkipThem() {
    let s = Scenario()
    s.type("##x").key("left").type(" ")
    s.expect("# T\n## x")
    XCTAssertEqual(s.caret, 7)
    // Up/Down into items lands after their markers, never inside them.
    let items = Scenario("# T\n## x\n- [ ] one\n- two\nplain")
    items.key("up").key("up").key("down").key("home").key("up").key("up").key("down")
    items.expect("# T\n## x\n- [ ] one\n- two\nplain")
  }

  @MainActor func testHeadingMarkersCannotBeTypedInFrontOf() {
    // Opening a note puts the caret at 0; a click at the far left of a heading does the same.
    // Both are visually identical to "after the hidden # ", so typing must not break the heading.
    let s = Scenario("# タイトル\n## 節\n本文", caret: 0)
    XCTAssertEqual(s.caret, 2)
    s.type("新しい")
    s.expect("# 新しいタイトル\n## 節\n本文")
    s.caret(after: "\n").select(s.caret)
    XCTAssertEqual(s.caret, (s.text as NSString).range(of: "節").location)
    // ← from the heading text goes to the end of the previous line, not into the marker.
    s.key("left")
    XCTAssertEqual(s.caret, (s.text as NSString).range(of: "\n## ").location)
    // → back lands after the marker again.
    s.key("right")
    XCTAssertEqual(s.caret, (s.text as NSString).range(of: "節").location)
  }

  @MainActor func testEveryCommandUndoesInOneStepAndRedoes() {
    for (doc, keys, after) in [
      ("# T\n```js", ["return"], "# T\n```js\n\n```"),
      ("# T\n- a", ["return"], "# T\n- a\n- "),
      ("# T\n- ", ["return"], "# T\n"),
      ("# T\n  - ", ["return"], "# T\n- "),
      ("# T\n- a", ["cmd-return"], "# T\n- [ ] a"),
      ("# T\n- [ ] a", ["cmd-return"], "# T\n- [x] a"),
      ("# T\n- a", ["tab"], "# T\n  - a"),
      ("# T\n- [ ] a", ["home", "backspace"], "# T\na"),
    ] {
      let s = Scenario(doc)
      for key in keys { s.key(key) }
      s.expect(after)
      s.key("undo")
      s.expect(doc)
      s.key("redo")
      s.expect(after)
    }
    // Shortcuts that rewrite what was just typed undo back to the typed text.
    let todo = Scenario("# T\n").type("- [")
    todo.type("]")
    todo.expect("# T\n- [ ] ")
    todo.key("undo")
    XCTAssertTrue(["# T\n- [", "# T\n- []"].contains(todo.text), todo.text)
    let heading = Scenario("# T\n## 節").caret(after: "## ")
    heading.key("return")
    heading.expect("# T\n\n## 節")
    heading.key("undo")
    heading.expect("# T\n## 節")
  }

  // MARK: Lists and todos

  @MainActor func testListsContinueIndentOutdentAndExit() {
    let s = Scenario()
    s.type("- a\n").key("tab").type("b\n\n")
    s.expect("# T\n- a\n  - b\n- ")
    s.type("c\n\nd")
    s.expect("# T\n- a\n  - b\n- c\nd")
    let numbered = Scenario().type("1. 一\n二\n\n> 引用\n続き\n\n")
    numbered.expect("# T\n1. 一\n2. 二\n> 引用\n> 続き\n")
  }
  @MainActor func testTodosByTypingAndCommandReturn() {
    let s = Scenario()
    s.type("[] 牛乳\n卵\n\nパン").key("cmd-return")
    s.expect("# T\n- [ ] 牛乳\n- [ ] 卵\n- [ ] パン")
    s.key("cmd-return")
    s.expect("# T\n- [ ] 牛乳\n- [ ] 卵\n- [x] パン")
    XCTAssertEqual(s.view.decorations.count, 3)
    // Backspace right after a checkbox removes the whole marker in one step.
    s.caret(after: "卵").key("home").key("backspace")
    s.expect("# T\n- [ ] 牛乳\n卵\n- [x] パン")
    s.key("undo")
    s.expect("# T\n- [ ] 牛乳\n- [ ] 卵\n- [x] パン")
  }
  @MainActor func testComposingANewTodoBetweenTodosKeepsLaterCheckboxesInPlace() {
    // Return after the first todo, then Japanese input: the later checkboxes must not be drawn
    // inside the text being composed (they were drawn at their old offsets until commit).
    let s = Scenario("# T\n- [ ] base-web 画像\n- [ ] lean 全部読む\n- [ ] 本を読む\n```\ncode\n```")
    s.caret(after: "画像").key("return")
    s.compose(["い", "いち", "いちご"], commit: "苺")
    s.expect("# T\n- [ ] base-web 画像\n- [ ] 苺\n- [ ] lean 全部読む\n- [ ] 本を読む\n```\ncode\n```")
    // Composing in the middle of an existing todo and at the start of the next one.
    s.caret(after: "全部").compose(["よ", "よん"], commit: "四")
    s.caret(after: "- [ ] 本").select(s.caret - 1).compose(["え", "えほ", "えほん"], commit: "絵")
    s.expect("# T\n- [ ] base-web 画像\n- [ ] 苺\n- [ ] lean 全部四読む\n- [ ] 絵本を読む\n```\ncode\n```")
  }

  @MainActor func testJapaneseInputOnEmptyItemsAndHeadings() {
    let s = Scenario()
    s.type("- ").compose(["ぎ", "ぎゅ", "ぎゅう"], commit: "牛").type("\n")
    s.compose(["た", "たま"], commit: "卵")
    s.expect("# T\n- 牛\n- 卵")
    let todo = Scenario().type("[]")
    todo.compose(["ぱ", "ぱん"], commit: "パン")
    todo.expect("# T\n- [ ] パン")
    let heading = Scenario().type("## ")
    heading.compose(["み", "みだ", "みだし"], commit: "見出し")
    heading.expect("# T\n## 見出し")
  }

  // MARK: Headings, quotes and inline Markdown

  @MainActor func testHeadingsAndInlineMarkupTypedCharacterByCharacter() {
    let s = Scenario("# ")
    s.type("タイトル\n## 節\n本文 **太字** と `code` と *斜体* と [リンク](https://example.com) 😀")
    s.expect(
      "# タイトル\n## 節\n本文 **太字** と `code` と *斜体* と [リンク](https://example.com) 😀")
    // Backspace at the start of heading text removes the whole "## " marker.
    s.caret(after: "## ").key("backspace")
    s.expect("# タイトル\n節\n本文 **太字** と `code` と *斜体* と [リンク](https://example.com) 😀")
  }

  // MARK: Line endings, zoom and source mode

  @MainActor func testCRLFZoomAndSourceModeScenarios() {
    Scenario("# T\r\n- a\r\n", zoom: 15).type("```\r\nx").expect("# T\r\n- a\r\n```\r\nx")
    // Every Return keeps a CRLF note's line endings: lists, fences, headings and plain lines.
    let crlf = Scenario("# T\r\n- a", zoom: 12)
    crlf.key("return").type("b").key("return").key("return").type("```\n").type("x")
    crlf.caret(after: "x\r\n```").key("return").type("## 節").key("home").key("return")
    crlf.key("end").type("\n本文")
    crlf.expect("# T\r\n- a\r\n- b\r\n```\r\nx\r\n```\r\n\r\n## 節\r\n本文")
    // Source mode shows raw Markdown: shortcuts are off and nothing is hidden.
    Scenario(source: true).type("- []\n\n```\ncode\n```\n## h").expect(
      "# T\n- []\n```\ncode\n```\n## h")
  }
}
