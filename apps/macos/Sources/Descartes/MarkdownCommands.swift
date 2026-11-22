import AppKit

struct Fence {
  var delimiter: Substring?
  mutating func consumes(_ content: Substring) -> Bool {
    let line = content.drop(while: { $0 == " " || $0 == "\t" })
    if let delimiter {
      let run = line.prefix(while: { $0 == delimiter.first })
      if run.count >= delimiter.count && line.dropFirst(run.count).allSatisfy({ $0.isWhitespace }) {
        self.delimiter = nil
      }
      return true
    }
    guard let first = line.first, first == "`" || first == "~" else { return false }
    let run = line.prefix(while: { $0 == first })
    guard run.count >= 3 else { return false }
    delimiter = run
    return true
  }
}

private struct ListLine {
  static let pattern = try? NSRegularExpression(
    pattern: #"^([ \t]*)([-*+]|[0-9]{1,9}[.)]|>)(?:[ \t]+(\[[ xX]\])?)?(?:[ \t]*)"#)
  let indent: String, marker: String, task: Bool, length: Int
  init?(_ line: String) {
    let raw = line as NSString
    guard
      let match = Self.pattern?.firstMatch(
        in: line, range: NSRange(location: 0, length: raw.length))
    else { return nil }
    let end = NSMaxRange(match.range(at: 2))
    guard end == raw.length || [9, 32].contains(Int(raw.character(at: end))) else { return nil }
    indent = raw.substring(with: match.range(at: 1))
    marker = raw.substring(with: match.range(at: 2))
    task = match.range(at: 3).location != NSNotFound
    length = match.range.length
  }
  var next: String {
    var bullet = marker
    if let number = Int(marker.dropLast()), let suffix = marker.last {
      bullet = String(number + 1) + String(suffix)
    }
    return indent + bullet + (task ? " [ ] " : " ")
  }
}

extension NoteText {
  private var currentLine: (range: NSRange, line: String, code: Bool) {
    let raw = string as NSString
    let range = raw.lineRange(for: NSRange(location: selectedRange().location, length: 0))
    var fence = Fence()
    raw.substring(to: range.location).enumerateLines { line, _ in _ = fence.consumes(line[...]) }
    let line = raw.substring(with: range).trimmingCharacters(in: .newlines)
    return (range, line, fence.consumes(line[...]))
  }
  func continueList() -> Bool {
    guard isEditable, !hasMarkedText(), selectedRange().length == 0 else { return false }
    let (range, line, code) = currentLine
    guard !code, let item = ListLine(line), selectedRange().location >= range.location + item.length
    else { return false }
    if item.length == line.utf16.count {
      insertText("", replacementRange: NSRange(location: range.location, length: item.length))
    } else {
      insertText("\n" + item.next, replacementRange: selectedRange())
    }
    return true
  }
  func indentItem(outdent: Bool) -> Bool {
    guard isEditable, !hasMarkedText(), selectedRange().length == 0 else { return false }
    let (range, line, code) = currentLine
    guard !code, let item = ListLine(line) else { return false }
    let remove = outdent ? (item.indent.hasSuffix("\t") ? 1 : min(2, item.indent.utf16.count)) : 0
    if outdent && remove == 0 { return true }
    let caret = selectedRange().location
    insertText(
      outdent ? "" : "  ", replacementRange: NSRange(location: range.location, length: remove))
    setSelectedRange(
      NSRange(location: max(range.location, caret + (outdent ? -remove : 2)), length: 0))
    return true
  }
  @objc func toggleTask() {
    guard isEditable, !hasMarkedText() else { return }
    let (range, line, code) = currentLine
    guard !code, let item = ListLine(line), item.task, let box = line.firstIndex(of: "[") else {
      return
    }
    let at = line[..<box].utf16.count + 1
    let raw = line as NSString
    let before = selectedRange()
    insertText(
      raw.character(at: at) == 32 ? "x" : " ",
      replacementRange: NSRange(location: range.location + at, length: 1))
    setSelectedRange(before)
  }
  private func wrap(_ delimiter: String) {
    guard isEditable, !hasMarkedText() else { return }
    let range = selectedRange()
    let text = (string as NSString).substring(with: range)
    insertText(delimiter + text + delimiter, replacementRange: range)
    setSelectedRange(
      NSRange(location: range.location + delimiter.utf16.count, length: range.length))
  }
  @objc func boldSelection() { wrap("**") }
  @objc func italicSelection() { wrap("*") }
  @objc func inlineCode() { wrap("`") }
  @objc func insertLink() {
    guard isEditable, !hasMarkedText() else { return }
    let range = selectedRange()
    let label = range.length == 0 ? "リンク" : (string as NSString).substring(with: range)
    insertText("[" + label + "](https://)", replacementRange: range)
    setSelectedRange(NSRange(location: range.location + label.utf16.count + 3, length: 8))
  }
  @objc func previousHeading() { jump(forward: false) }
  @objc func nextHeading() { jump(forward: true) }
  private func jump(forward: Bool) {
    guard !hasMarkedText() else { return }
    let raw = string as NSString
    var fence = Fence()
    var at = 0
    var found: Int?
    let start = raw.lineRange(for: NSRange(location: selectedRange().location, length: 0)).location
    while at < raw.length {
      let range = raw.lineRange(for: NSRange(location: at, length: 0))
      let line = raw.substring(with: range)
      let level = line.prefix(while: { $0 == "#" }).count
      if !fence.consumes(line[...]), (1...6).contains(level), line.dropFirst(level).first == " " {
        if forward && at > start {
          found = at + level + 1
          break
        }
        if !forward && at < start { found = at + level + 1 }
      }
      at = NSMaxRange(range)
    }
    if let found {
      let range = NSRange(location: found, length: 0)
      setSelectedRange(range)
      scrollRangeToVisible(range)
    }
  }
}
