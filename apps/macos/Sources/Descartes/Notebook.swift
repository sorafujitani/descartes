import AppKit
import SwiftUI

@MainActor final class Notebook: ObservableObject {
  @Published var text = "# "
  @Published private(set) var base: Document?
  @Published private(set) var revision = 0
  @Published var zoom = min(
    20, max(5, UserDefaults.standard.object(forKey: "noteZoomTenths") as? Int ?? 10))
  {
    didSet { UserDefaults.standard.set(zoom, forKey: "noteZoomTenths") }
  }
  @Published var preview = false
  @Published var source = false
  @Published var focusRequest = 0
  @Published var busy = false
  @Published var picking = false
  @Published var message = ""
  @Published var query = ""
  @Published var items: [Summary] = []
  let demo: Bool
  init(demo: Bool) { self.demo = demo }
  var dirty: Bool { text != (base?.markdown ?? "# ") }
  var title: String {
    let first = text.prefix(while: { !$0.isNewline })
    return first.hasPrefix("# ") ? first.dropFirst(2).trimmingCharacters(in: .whitespaces) : ""
  }
  private var lastKey: String { demo ? "last-demo-document" : "last-document" }
  func confirmDiscard() -> Bool {
    guard !busy else {
      NSSound.beep()
      return false
    }
    guard dirty else { return true }
    let alert = NSAlert()
    alert.messageText = "未保存の変更を破棄しますか？"
    alert.addButton(withTitle: "編集に戻る")
    alert.addButton(withTitle: "破棄")
    return alert.runModal() == .alertSecondButtonReturn
  }
  private func load(_ document: Document?) {
    base = document
    text = document?.markdown ?? "# "
    preview = false
    focusRequest += 1
    revision += 1
    UserDefaults.standard.set(document?.id.uuidString, forKey: lastKey)
  }
  func start() {
    if let raw = UserDefaults.standard.string(forKey: lastKey), let id = UUID(uuidString: raw) {
      open(id)
    }
  }
  func new() {
    guard confirmDiscard() else { return }
    picking = false
    message = ""
    load(nil)
  }
  func perform(_ operation: @escaping (API) async throws -> Void) {
    guard !busy else { return }
    busy = true
    message = ""
    Task {
      defer { busy = false }
      do { try await operation(API(demo: demo)) } catch { message = error.localizedDescription }
    }
  }
  func browse() {
    guard !busy else { return }
    query = ""
    picking = true
    perform { self.items = try await $0.list() }
  }
  func open(_ id: UUID) {
    guard confirmDiscard() else { return }
    perform { api in
      let document = try await api.get(id)
      self.load(document)
      self.picking = false
    }
  }
  func save() {
    guard !title.isEmpty else {
      message = "1行目に「# タイトル」を入力してください。"
      return
    }
    guard dirty else { return }
    let draft = text
    let original = base
    perform { api in
      let document = try await api.save(draft, base: original)
      self.base = document
      UserDefaults.standard.set(document.id.uuidString, forKey: self.lastKey)
      self.message = "保存しました"
    }
  }
}
