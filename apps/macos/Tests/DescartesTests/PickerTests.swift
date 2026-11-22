import AppKit
import SwiftUI
import XCTest

@testable import Descartes

final class PickerTests: XCTestCase {
  private final class RecordingButtonCell: NSButtonCell {
    var drawnFrame: NSRect?
    override func draw(withFrame cellFrame: NSRect, in controlView: NSView) {
      drawnFrame = cellFrame
    }
  }

  @MainActor private func searchWindow() -> (NSSearchField, NSWindow) {
    _ = NSApplication.shared
    let field = SearchInput.makeField()
    field.frame = NSRect(x: 10, y: 10, width: 372, height: 30)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 700, height: 60),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView?.addSubview(field)
    return (field, window)
  }

  @MainActor private func assertSeparated(
    _ rect: NSRect, cell: NSSearchFieldCell, bounds: NSRect,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertGreaterThanOrEqual(rect.width, 0, file: file, line: line)
    XCTAssertGreaterThanOrEqual(rect.minX, bounds.minX, file: file, line: line)
    XCTAssertLessThanOrEqual(rect.maxX, bounds.maxX, file: file, line: line)
    XCTAssertGreaterThanOrEqual(rect.minY, bounds.minY, file: file, line: line)
    XCTAssertLessThanOrEqual(rect.maxY, bounds.maxY, file: file, line: line)
    if !rect.isEmpty {
      XCTAssertFalse(
        rect.intersects(cell.searchButtonRect(forBounds: bounds)), file: file, line: line)
      XCTAssertFalse(
        rect.intersects(cell.cancelButtonRect(forBounds: bounds)), file: file, line: line)
    }
  }

  @MainActor func testPlaceholderTextAndLiveEditorStayBetweenNativeButtons() throws {
    let (field, window) = searchWindow()
    defer {
      window.makeFirstResponder(nil)
      window.close()
    }
    let cell = try XCTUnwrap(field.cell as? NSSearchFieldCell)
    XCTAssertEqual(field.placeholderString, "タイトルで検索")
    for value in ["", "日本語のタイトルと長い検索入力 " + String(repeating: "検索", count: 50)] {
      window.makeFirstResponder(nil)
      field.stringValue = value
      for width in [80.0, 180, 372, 640] {
        // Subsequent sizes also exercise resizing an already-active field editor.
        field.setFrameSize(NSSize(width: width, height: 30))
        field.layoutSubtreeIfNeeded()
        let text = cell.searchTextRect(forBounds: field.bounds)
        XCTAssertGreaterThan(text.width, 0)
        assertSeparated(text, cell: cell, bounds: field.bounds)
        // AppKit's drawingRect already delegates to searchTextRect; don't inset it twice.
        XCTAssertEqual(cell.drawingRect(forBounds: field.bounds), text)
        XCTAssertEqual(cell.titleRect(forBounds: field.bounds), text)
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        XCTAssertTrue(editor.isFieldEditor)
        XCTAssertEqual(editor.string, value)
        // Long input may scroll internally. Test its clipped viewport in field coordinates.
        let viewport = field.convert(editor.visibleRect, from: editor)
        assertSeparated(viewport, cell: cell, bounds: field.bounds)
        XCTAssertEqual(viewport.minX, text.minX, accuracy: 0.5)
        XCTAssertEqual(viewport.maxX, text.maxX, accuracy: 0.5)
      }
    }
  }

  @MainActor func testCellGeometryUsesBoundsAndCollapsesWhenTooNarrow() throws {
    _ = NSApplication.shared
    let field = SearchInput.makeField()
    let cell = try XCTUnwrap(field.cell as? NSSearchFieldCell)
    for value in ["", "入力中"] {
      field.stringValue = value
      for width in [20.0, 40, 80, 372, 640] {
        let bounds = NSRect(x: 13, y: 7, width: width, height: 30)
        let text = cell.searchTextRect(forBounds: bounds)
        assertSeparated(text, cell: cell, bounds: bounds)
        XCTAssertEqual(cell.drawingRect(forBounds: bounds), text)
        if width >= 80 { XCTAssertGreaterThan(text.width, 0) }
      }
    }
  }

  @MainActor func testCustomDrawingKeepsNativeSearchAndClearButtons() throws {
    _ = NSApplication.shared
    let field = SearchInput.makeField()
    field.frame = NSRect(x: 0, y: 0, width: 372, height: 30)
    field.stringValue = "検索"
    let cell = try XCTUnwrap(field.cell as? NSSearchFieldCell)
    let search = RecordingButtonCell(textCell: "")
    let clear = RecordingButtonCell(textCell: "")
    cell.searchButtonCell = search
    cell.cancelButtonCell = clear
    let image = NSImage(size: field.bounds.size)
    image.lockFocus()
    defer { image.unlockFocus() }
    cell.draw(withFrame: field.bounds, in: field)
    XCTAssertEqual(search.drawnFrame, cell.searchButtonRect(forBounds: field.bounds))
    XCTAssertEqual(clear.drawnFrame, cell.cancelButtonRect(forBounds: field.bounds))
  }

  @MainActor func testNativeClearAccessibilityIMEAndNavigationArePreserved() throws {
    let (field, window) = searchWindow()
    defer {
      window.makeFirstResponder(nil)
      window.close()
    }
    var query = ""
    var moves: [Int] = []
    var opens = 0
    var cancels = 0
    let input = SearchInput(
      query: Binding(get: { query }, set: { query = $0 }),
      move: { moves.append($0) }, open: { opens += 1 }, cancel: { cancels += 1 })
    let coordinator = input.makeCoordinator()
    field.delegate = coordinator
    XCTAssertEqual(field.accessibilityLabel(), "タイトルで検索")
    XCTAssertFalse(field.drawsBackground)
    XCTAssertTrue(window.makeFirstResponder(field))
    let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
    let cell = try XCTUnwrap(field.cell as? NSSearchFieldCell)
    let commands = [
      #selector(NSResponder.moveDown(_:)), #selector(NSResponder.moveUp(_:)),
      #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.cancelOperation(_:)),
    ]
    editor.setMarkedText(
      "にほん", selectedRange: NSRange(location: 3, length: 0),
      replacementRange: NSRange(location: 0, length: 0))
    XCTAssertTrue(editor.hasMarkedText())
    assertSeparated(
      field.convert(editor.visibleRect, from: editor), cell: cell, bounds: field.bounds)
    for command in commands {
      XCTAssertFalse(coordinator.control(field, textView: editor, doCommandBy: command))
    }
    XCTAssertTrue(moves.isEmpty)
    XCTAssertEqual(opens, 0)
    XCTAssertEqual(cancels, 0)
    XCTAssertTrue(editor.hasMarkedText())
    editor.unmarkText()
    for command in commands {
      XCTAssertTrue(coordinator.control(field, textView: editor, doCommandBy: command))
    }
    XCTAssertEqual(moves, [1, -1])
    XCTAssertEqual(opens, 1)
    XCTAssertEqual(cancels, 1)
    XCTAssertFalse(
      coordinator.control(
        field, textView: editor, doCommandBy: #selector(NSResponder.deleteBackward(_:))))
    editor.insertText(
      "日本語", replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    XCTAssertEqual(query, "日本語")
    let clear = try XCTUnwrap(cell.cancelButtonCell)
    XCTAssertNotNil(clear.image)
    XCTAssertNotNil(clear.action)
    clear.performClick(field)
    XCTAssertEqual(field.stringValue, "")
    XCTAssertEqual(editor.string, "")
    XCTAssertEqual(query, "")
  }
}
