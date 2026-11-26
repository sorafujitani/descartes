import AppKit
import SwiftUI

@MainActor final class Notebook: ObservableObject {
  /// Autosave waits for a pause in typing, but never leaves continuous typing unsaved for longer
  /// than `limit`. Every save is a Git commit, and GitHub limits content-creating requests (roughly
  /// 80 per minute and 500 per hour), so keystrokes are coalesced instead of saved one by one.
  struct Timing {
    var idle: Duration = .seconds(4)
    var limit: Duration = .seconds(45)
    var retry: Duration = .seconds(30)
  }
  typealias Store = (_ markdown: String, _ base: Document?) async throws -> Document
  /// Fetches the title list; `nil` means the list with the given ETag is still current.
  typealias Lister = (_ etag: String?) async throws -> TitleList?

  @Published var text = "# " {
    didSet { if text != oldValue { scheduleAutosave() } }
  }
  @Published private(set) var base: Document?
  @Published private(set) var revision = 0
  @Published var zoom = min(
    20, max(5, UserDefaults.standard.object(forKey: "noteZoomTenths") as? Int ?? 10))
  {
    didSet { UserDefaults.standard.set(zoom, forKey: "noteZoomTenths") }
  }
  @Published var source = false
  @Published var focusRequest = 0
  /// Blocking work (loading, switching documents). Saving never blocks typing.
  @Published var busy = false
  @Published private(set) var saving = false
  /// A conflict stops autosave until an explicit save succeeds or another document is opened.
  @Published private(set) var paused = false
  @Published var picking = false
  @Published var message = ""
  @Published var query = ""
  @Published var items: [Summary] = []
  /// A background title refresh; unlike `busy`, it never blocks opening a listed note.
  @Published private(set) var refreshing = false
  let demo: Bool
  /// The editor page showing this notebook (see Editor.swift).
  let editor = EditorBridge()
  var timing = Timing()
  private let store: Store
  private let lister: Lister
  private let listFile: URL
  private var listETag: String?
  private var refreshTask: Task<Void, Never>?
  private var saveTask: Task<Bool, Never>?
  private var inFlight: String?
  private var again = false
  private var autosaveTimer: Task<Void, Never>?
  private var dirtySince: ContinuousClock.Instant?

  /// `listFile` keeps the last complete title list (ids and titles only, never note bodies) so
  /// the picker has something to show before the network answers.
  init(demo: Bool, store: Store? = nil, lister: Lister? = nil, listFile: URL? = nil) {
    self.demo = demo
    self.store = store ?? { try await API(demo: demo).save($0, base: $1) }
    self.lister = lister ?? { try await API(demo: demo).list(etag: $0) }
    self.listFile =
      listFile
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appending(path: "Descartes/" + (demo ? "titles-demo.json" : "titles.json"))
    if let data = try? Data(contentsOf: self.listFile),
      let cached = try? JSONDecoder().decode(TitleList.self, from: data)
    {
      items = cached.items
      listETag = cached.etag
    }
  }
  var dirty: Bool { text != (base?.markdown ?? "# ") }
  static func title(of text: String) -> String {
    let first = text.prefix(while: { !$0.isNewline })
    return first.hasPrefix("# ") ? first.dropFirst(2).trimmingCharacters(in: .whitespaces) : ""
  }
  var title: String { Self.title(of: text) }
  private var lastKey: String { demo ? "last-demo-document" : "last-document" }
  func confirmDiscard() -> Bool {
    let alert = NSAlert()
    alert.messageText = "保存できなかった変更を破棄しますか？"
    if !message.isEmpty { alert.informativeText = message }
    alert.addButton(withTitle: "編集に戻る")
    alert.addButton(withTitle: "破棄")
    return alert.runModal() == .alertSecondButtonReturn
  }
  /// Saves the current note first, then runs `action`. Asks before discarding only when the
  /// latest text could not be saved (untitled, conflicting or offline); `otherwise` runs on cancel.
  func whenSaved(_ action: @escaping () -> Void, otherwise: @escaping () -> Void = {}) {
    guard !busy else {
      NSSound.beep()
      otherwise()
      return
    }
    guard dirty || saveTask != nil else { return action() }
    busy = true
    Task {
      await flush()
      busy = false
      if !dirty || confirmDiscard() { action() } else { otherwise() }
    }
  }
  private func load(_ document: Document?) {
    autosaveTimer?.cancel()
    dirtySince = nil
    paused = false
    base = document
    text = document?.markdown ?? "# "
    focusRequest += 1
    revision += 1
    UserDefaults.standard.set(document?.id.uuidString, forKey: lastKey)
    // Show it in the editor page now, not only when SwiftUI next updates the view.
    editor.sync()
  }
  func start() {
    refreshList()
    if let raw = UserDefaults.standard.string(forKey: lastKey), let id = UUID(uuidString: raw) {
      open(id)
    }
  }
  func new() {
    whenSaved { [self] in
      picking = false
      message = ""
      load(nil)
    }
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
    message = ""
    picking = true
    refreshList()
  }
  /// Revalidates the title list in the background. An unchanged list costs an empty 304.
  func refreshList() {
    guard refreshTask == nil else { return }
    refreshing = true
    refreshTask = Task { [self] in
      defer {
        refreshing = false
        refreshTask = nil
      }
      do {
        guard let fresh = try await lister(listETag) else { return }
        items = fresh.items
        listETag = fresh.etag
        try? FileManager.default.createDirectory(
          at: listFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        // The cache is only a head start, so failing to write it is not worth reporting.
        try? JSONEncoder().encode(fresh).write(to: listFile, options: .atomic)
      } catch {
        message = error.localizedDescription
      }
    }
  }
  func open(_ id: UUID) {
    whenSaved { [self] in
      perform { api in
        let document = try await api.get(id)
        self.load(document)
        self.picking = false
      }
    }
  }
  /// Explicit save (⌘S). It also retries after a conflict or a failed autosave.
  func save() {
    guard !title.isEmpty else {
      message = "1行目に「# タイトル」を入力してください。"
      return
    }
    guard dirty, !busy else { return }
    paused = false
    Task {
      if await flush() { message = dirty ? "保存しました。続きの変更は未保存です" : "保存しました" }
    }
  }
  /// Saves quietly when allowed: untitled drafts and paused (conflicting) notes are left alone.
  func autosave() {
    dirtySince = nil
    guard !paused, !busy, dirty, !title.isEmpty else { return }
    Task { await flush() }
  }
  private func scheduleAutosave(after delay: Duration? = nil) {
    autosaveTimer?.cancel()
    guard dirty else {
      dirtySince = nil
      return
    }
    let now = ContinuousClock.now
    let since = dirtySince ?? now
    dirtySince = since
    let wait = delay ?? min(timing.idle, max(.zero, since + timing.limit - now))
    autosaveTimer = Task { [weak self] in
      do { try await Task.sleep(for: wait) } catch { return }
      self?.autosave()
    }
  }
  /// Saves the latest text, one request at a time, each based on the SHA acknowledged by the
  /// previous one. A call during a save joins it and, if the text changed since that save started,
  /// queues exactly one more save of the newest text. Returns `false` when saving failed.
  @discardableResult func flush() async -> Bool {
    if let active = saveTask {
      if text != inFlight { again = true }
      return await active.value
    }
    guard dirty else { return true }
    let task = Task { [self] () -> Bool in
      defer {
        saveTask = nil
        inFlight = nil
        saving = false
      }
      let owner = revision
      while true {
        let draft = text
        let original = base
        guard draft != (original?.markdown ?? "# ") else { return true }
        guard !Self.title(of: draft).isEmpty else { return false }
        inFlight = draft
        again = false
        do {
          let document = try await store(draft, original)
          guard owner == revision else { return true }
          // The response acknowledges only the submitted snapshot, never newer keystrokes.
          base = document
          message = ""
          UserDefaults.standard.set(document.id.uuidString, forKey: lastKey)
          if !dirty {
            autosaveTimer?.cancel()
            dirtySince = nil
          }
        } catch {
          guard owner == revision else { return false }
          message = error.localizedDescription
          if (error as? Problem)?.status == 409 {
            // Retrying cannot resolve a conflict; keep the draft and wait for the user.
            paused = true
          } else {
            scheduleAutosave(after: timing.retry)
          }
          return false
        }
        if !again { return true }
      }
    }
    saving = true
    saveTask = task
    return await task.value
  }
}
