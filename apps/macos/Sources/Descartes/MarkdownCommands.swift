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

/// A line as ⌘Return sees it: quote/indent prefix, optional list marker and optional checkbox.
struct TaskLine {
  static let pattern = try? NSRegularExpression(
    pattern: #"^((?:[ \t]*>)*[ \t]*)(?:([-*+]|[0-9]{1,9}[.)])(?=[ \t]|$))?([ \t]*)(\[[ xX]\])?"#)
  let prefix: String, marker: String?, gap: String, boxText: String?, rest: String
  /// `nil` when the line is not a todo, otherwise whether it is checked.
  var box: Bool? { boxText.map { $0 != "[ ]" } }
  /// UTF-16 length of the prefix, marker and gap, plus the checkbox and one following space.
  var prefixLength: Int {
    (prefix + (marker ?? "") + gap + (box == nil ? "" : "[ ]")).utf16.count
      + (box != nil && rest.hasPrefix(" ") ? 1 : 0)
  }
  init?(_ line: String) {
    let raw = line as NSString
    guard
      let match = Self.pattern?.firstMatch(
        in: line, range: NSRange(location: 0, length: raw.length))
    else { return nil }
    func group(_ index: Int) -> String? {
      let range = match.range(at: index)
      return range.location == NSNotFound ? nil : raw.substring(with: range)
    }
    let marker = group(2)
    let gap = group(3) ?? ""
    let boxText = marker != nil && !gap.isEmpty ? group(4) : nil
    let prefix = group(1) ?? ""
    let rest = raw.substring(from: (prefix + (marker ?? "") + gap + (boxText ?? "")).utf16.count)
    // Headings (including the title line) stay headings.
    let level = rest.prefix(while: { $0 == "#" }).count
    if marker == nil, (1...6).contains(level), rest.dropFirst(level).first ?? " " == " " {
      return nil
    }
    self.init(prefix: prefix, marker: marker, gap: gap, boxText: boxText, rest: rest)
  }
  private init(prefix: String, marker: String?, gap: String, boxText: String?, rest: String) {
    self.prefix = prefix
    self.marker = marker
    self.gap = gap
    self.boxText = boxText
    self.rest = rest
  }
  var line: String { prefix + (marker ?? "") + gap + (boxText ?? "") + rest }
  /// Todos already in the requested state keep their exact text (e.g. "[X]").
  func toggled(_ checked: Bool) -> TaskLine {
    guard box != checked else { return self }
    return .init(
      prefix: prefix, marker: marker, gap: gap, boxText: checked ? "[x]" : "[ ]", rest: rest)
  }
  /// Bullets and numbers keep their marker; anything else becomes a "- " item.
  var converted: TaskLine {
    let body = rest.hasPrefix(" ") || rest.hasPrefix("\t") ? rest : " " + rest
    return .init(prefix: prefix, marker: marker ?? "-", gap: " ", boxText: "[ ]", rest: body)
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
  private static let todoShortcut = try? NSRegularExpression(
    pattern: #"^([ \t]*)(?:([-*+])[ \t]+)?(?:\[\]|［］)$"#)
  /// "[]" (or full-width "［］") typed at the start of a line or bullet becomes "- [ ] ".
  /// A space typed right after it is absorbed, so typing "- [] 牛乳" gives "- [ ] 牛乳".
  func completeTodoShortcut() {
    guard isEditable, !hasMarkedText(), selectedRange().length == 0 else { return }
    let raw = string as NSString
    let caret = selectedRange().location
    let range = raw.lineRange(for: NSRange(location: caret, length: 0))
    let before = raw.substring(
      with: NSRange(location: range.location, length: caret - range.location)) as NSString
    guard
      let match = Self.todoShortcut?.firstMatch(
        in: before as String, range: NSRange(location: 0, length: before.length)),
      !currentLine.code
    else { return }
    let marker =
      match.range(at: 2).location == NSNotFound ? "-" : before.substring(with: match.range(at: 2))
    let todo = before.substring(with: match.range(at: 1)) + marker + " [ ] "
    let next = caret < NSMaxRange(range) ? raw.character(at: caret) : 10
    let separated = next == 32 || next == 9
    breakUndoCoalescing()
    insertText(
      separated ? String(todo.dropLast()) : todo,
      replacementRange: NSRange(location: range.location, length: before.length))
    if !separated { swallowSpaceAt = selectedRange().location }
  }
  func continueList() -> Bool {
    guard isEditable, !hasMarkedText(), selectedRange().length == 0 else { return false }
    let (range, line, code) = currentLine
    guard !code, let item = ListLine(line), selectedRange().location >= range.location + item.length
    else { return false }
    if item.length == line.utf16.count {
      // An empty nested item moves out one level first; at the top level it ends the list.
      if !item.indent.isEmpty { return indentItem(outdent: true) }
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
  /// ⌘Return: turns the current line (or every selected line) into a todo, or toggles its
  /// checkbox when it already is one. Bullets and numbered items keep their marker; plain text
  /// gains "- [ ] ". Headings and fenced code are left alone.
  @objc func toggleTask() {
    guard isEditable, !hasMarkedText() else { return }
    let raw = string as NSString
    let selection = selectedRange()
    var covered = selection
    if covered.length > 0, raw.character(at: NSMaxRange(covered) - 1) == 10 { covered.length -= 1 }
    let block = raw.lineRange(for: covered)
    var fence = Fence()
    raw.substring(to: block.location).enumerateLines { line, _ in _ = fence.consumes(line[...]) }
    var lines: [(range: NSRange, line: String, task: TaskLine?)] = []
    var at = block.location
    repeat {
      let range = raw.lineRange(for: NSRange(location: at, length: 0))
      let line = raw.substring(with: range).trimmingCharacters(in: .newlines)
      let code = fence.consumes(line[...])
      let eligible = !code && (block.length == range.length || !line.allSatisfy(\.isWhitespace))
      lines.append((range, line, eligible ? TaskLine(line) : nil))
      at = NSMaxRange(range)
    } while at < NSMaxRange(block)
    let targets = lines.compactMap(\.task)
    guard !targets.isEmpty else {
      NSSound.beep()
      return
    }
    let toggling = targets.allSatisfy { $0.box != nil }
    // Several todos are checked together unless all of them already are.
    let check = targets.contains { $0.box == false }
    var replacement = ""
    // Each rewritten line: where it started, its old/new prefix ends and the shift before it.
    var moves: [(line: Int, oldPrefix: Int, newPrefix: Int, before: Int, delta: Int)] = []
    var shift = 0
    for entry in lines {
      let terminator = raw.substring(
        with: NSRange(
          location: entry.range.location + entry.line.utf16.count,
          length: entry.range.length - entry.line.utf16.count))
      let updated = entry.task.map { task in
        // Converting leaves existing todos alone; toggling leaves other lines alone.
        toggling ? task.toggled(check) : task.box == nil ? task.converted : task
      }
      guard let task = entry.task, let updated, updated.line != entry.line else {
        replacement += entry.line + terminator
        continue
      }
      let start = block.location + replacement.utf16.count
      let delta = updated.line.utf16.count - entry.line.utf16.count
      moves.append(
        (
          entry.range.location, entry.range.location + (toggling ? 0 : task.prefixLength),
          start + (toggling ? 0 : updated.prefixLength), shift, delta
        ))
      shift += delta
      replacement += updated.line + terminator
    }
    guard !moves.isEmpty else { return }
    // Positions inside a rewritten prefix move to just after the new checkbox; other positions
    // keep their place in the text.
    func map(_ location: Int) -> Int {
      guard let move = moves.last(where: { $0.line <= location }) else { return location }
      return location < move.oldPrefix ? move.newPrefix : location + move.before + move.delta
    }
    let start = map(selection.location)
    let end = selection.length == 0 ? start : map(NSMaxRange(selection))
    // Leave the final line break untouched so a one-line change stays an incremental restyle.
    let last = lines[lines.count - 1]
    let tail = last.range.length - last.line.utf16.count
    insertText(
      String(replacement.utf16.dropLast(tail)) ?? replacement,
      replacementRange: NSRange(location: block.location, length: block.length - tail))
    setSelectedRange(NSRange(location: start, length: max(0, end - start)))
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
