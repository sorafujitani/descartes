import AppKit
import SwiftUI

private final class PickerSearchFieldCell: NSSearchFieldCell {
  override func searchTextRect(forBounds bounds: NSRect) -> NSRect {
    let rect = super.searchTextRect(forBounds: bounds)
    // drawingRect already delegates here; don't apply a second inset there.
    // Use AppKit's actual button geometry, including the standard clear button.
    let leading = searchButtonCell == nil ? rect.minX
      : max(rect.minX, searchButtonRect(forBounds: bounds).maxX)
    let trailing = cancelButtonCell == nil ? rect.maxX
      : min(rect.maxX, cancelButtonRect(forBounds: bounds).minX)
    let x = min(bounds.maxX, max(bounds.minX, leading))
    return NSRect(x: x, y: rect.minY, width: max(0, trailing - x), height: rect.height)
  }

  override func draw(withFrame cellFrame: NSRect, in controlView: NSView) {
    // Keep native bordered text/editor layout, but let SwiftUI provide the chrome.
    drawInterior(withFrame: cellFrame, in: controlView)
  }
}

private final class PickerSearchField: NSSearchField {
  override class var cellClass: AnyClass? {
    get { PickerSearchFieldCell.self }
    set {}
  }
}

// Handle arrows in the field editor without intercepting IME candidate selection.
struct SearchInput: NSViewRepresentable {
  @Binding var query: String
  var move: (Int) -> Void
  var open: () -> Void
  var cancel: () -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  static func makeField() -> NSSearchField {
    let field = PickerSearchField()
    // Borderless AppKit cells bypass drawingRect when placing the field editor.
    field.isBordered = true
    field.bezelStyle = .roundedBezel
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = .systemFont(ofSize: 17)
    field.textColor = Theme.text
    field.placeholderString = "タイトルで検索"
    field.setAccessibilityLabel("タイトルで検索")
    return field
  }
  func makeNSView(context: Context) -> NSSearchField {
    let field = Self.makeField()
    field.delegate = context.coordinator
    DispatchQueue.main.async { field.window?.makeFirstResponder(field) }
    return field
  }
  func updateNSView(_ field: NSSearchField, context: Context) {
    context.coordinator.parent = self
    if field.stringValue != query { field.stringValue = query }
  }
  final class Coordinator: NSObject, NSSearchFieldDelegate {
    var parent: SearchInput
    init(_ parent: SearchInput) { self.parent = parent }
    func controlTextDidChange(_ notification: Notification) {
      if let field = notification.object as? NSSearchField { parent.query = field.stringValue }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool
    {
      guard !textView.hasMarkedText() else { return false }
      switch command {
      case #selector(NSResponder.moveDown(_:)): parent.move(1)
      case #selector(NSResponder.moveUp(_:)): parent.move(-1)
      case #selector(NSResponder.insertNewline(_:)): parent.open()
      case #selector(NSResponder.cancelOperation(_:)): parent.cancel()
      default: return false
      }
      return true
    }
  }
}

struct PickerSheet: View {
  @ObservedObject var book: Notebook
  @State private var selection: UUID?
  var rows: [Summary] {
    book.items.filter {
      book.query.isEmpty || $0.title.localizedCaseInsensitiveContains(book.query)
    }
  }
  func current(in list: [Summary]) -> UUID? {
    list.first(where: { $0.id == selection })?.id ?? list.first?.id
  }
  func step(_ offset: Int, in list: [Summary]) {
    guard !list.isEmpty else { return }
    let index = list.firstIndex(where: { $0.id == selection }) ?? 0
    selection = list[min(list.count - 1, max(0, index + offset))].id
  }
  var body: some View {
    let rows = self.rows
    let current = self.current(in: rows)
    return VStack(alignment: .leading, spacing: 12) {
      Text("文書を開く").font(.headline).foregroundStyle(Color(nsColor: Theme.text))
      SearchInput(
        query: $book.query, move: { step($0, in: rows) },
        open: { if let id = self.current(in: rows) { book.open(id) } },
        cancel: { book.picking = false }
      )
      .frame(height: 30).padding(6).background(
        Color(nsColor: Theme.code).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 3) {
            ForEach(rows) { row in
              Button {
                book.open(row.id)
              } label: {
                HStack {
                  Image(systemName: "doc.text")
                  Text(row.title).lineLimit(1)
                  Spacer()
                  if row.id == current {
                    Image(systemName: "return").foregroundStyle(Color(nsColor: Theme.accent))
                  }
                }.padding(9).contentShape(Rectangle())
              }
              .buttonStyle(.plain).background(
                row.id == current ? Color(nsColor: Theme.accent).opacity(0.13) : .clear,
                in: RoundedRectangle(cornerRadius: 7)
              ).id(row.id)
            }
            if rows.isEmpty && !book.busy && !book.refreshing {
              Text("該当する文書はありません").font(.callout).foregroundStyle(.secondary).padding()
            }
          }
        }.onChange(of: current) { _, id in if let id { proxy.scrollTo(id) } }
      }
      if !book.message.isEmpty { Text(book.message).font(.caption) }
      HStack {
        Text(book.busy || book.refreshing && book.items.isEmpty ? "通信中…" : "↑ ↓ 選択　↩ 開く")
        Spacer()
        Button("Esc 閉じる") { book.picking = false }.buttonStyle(.plain).keyboardShortcut(
          .cancelAction)
      }
      .font(.caption).foregroundStyle(Color(nsColor: Theme.muted))
    }.padding(18).frame(width: 420, height: 320).foregroundStyle(Color(nsColor: Theme.text))
      .background(GlassSurface()).onChange(of: book.query) { selection = nil }
  }
}
