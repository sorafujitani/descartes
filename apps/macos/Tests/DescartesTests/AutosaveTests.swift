import XCTest

@testable import Descartes

/// Records saves and acknowledges each one with a new SHA. Saves can be held open or rejected.
@MainActor private final class FakeStore {
  var saves: [(markdown: String, sha: String?)] = []
  var failure: Error?
  var hold = false
  private var held: [CheckedContinuation<Void, Never>] = []
  let id = UUID()
  func save(_ markdown: String, base: Document?) async throws -> Document {
    saves.append((markdown, base?.sha))
    if hold { await withCheckedContinuation { held.append($0) } }
    if let failure { throw failure }
    return Document(
      id: base?.id ?? id, title: Notebook.title(of: markdown), markdown: markdown,
      sha: String(repeating: String(saves.count), count: 40))
  }
  func release() {
    hold = false
    held.forEach { $0.resume() }
    held = []
  }
}

@MainActor final class AutosaveTests: XCTestCase {
  private func notebook(_ store: FakeStore, idle: Duration = .milliseconds(40)) -> Notebook {
    let book = Notebook(demo: true) { try await store.save($0, base: $1) }
    book.timing = .init(idle: idle, limit: .seconds(10), retry: .milliseconds(60))
    return book
  }
  private func wait(
    _ condition: () -> Bool, timeout: Duration = .seconds(2), file: StaticString = #filePath,
    line: UInt = #line
  ) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
      guard ContinuousClock.now < deadline else { return XCTFail("Timed out", file: file, line: line) }
      try await Task.sleep(for: .milliseconds(5))
    }
  }

  func testTypingIsSavedOnceAfterAPause() async throws {
    let store = FakeStore()
    let book = notebook(store)
    for draft in ["# Memo\na", "# Memo\nab", "# Memo\nabc"] { book.text = draft }
    XCTAssertTrue(store.saves.isEmpty)
    try await wait { !book.dirty && !book.saving }
    XCTAssertEqual(store.saves.map(\.markdown), ["# Memo\nabc"])
    XCTAssertNil(store.saves[0].sha, "the first save creates the document")
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(store.saves.count, 1, "a saved note is not written again")
    book.text += "\nmore"
    try await wait { !book.dirty && !book.saving }
    XCTAssertEqual(store.saves.last?.sha, String(repeating: "1", count: 40))
  }

  func testContinuousTypingIsSavedAtTheLimit() async throws {
    let store = FakeStore()
    let book = notebook(store, idle: .milliseconds(200))
    book.timing.limit = .milliseconds(150)
    let start = ContinuousClock.now
    while ContinuousClock.now - start < .milliseconds(500) {
      book.text += "x"
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertGreaterThanOrEqual(store.saves.count, 1)
    XCTAssertLessThanOrEqual(store.saves.count, 4)
  }

  func testUntitledDraftIsNotAutosaved() async throws {
    let store = FakeStore()
    let book = notebook(store)
    book.text = "# \n本文だけ"
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertTrue(store.saves.isEmpty)
    XCTAssertTrue(book.dirty)
  }

  func testEditsDuringASaveAreSavedNextWithTheAcknowledgedSHA() async throws {
    let store = FakeStore()
    store.hold = true
    let book = notebook(store, idle: .seconds(10))
    book.text = "# Memo\nfirst"
    book.autosave()
    try await wait { store.saves.count == 1 }
    book.text = "# Memo\nsecond"
    let flushed = Task { await book.flush() }
    try await Task.sleep(for: .milliseconds(20))
    store.release()
    let succeeded = await flushed.value
    XCTAssertTrue(succeeded)
    XCTAssertEqual(store.saves.map(\.markdown), ["# Memo\nfirst", "# Memo\nsecond"])
    XCTAssertEqual(store.saves[1].sha, String(repeating: "1", count: 40))
    XCTAssertFalse(book.dirty)
  }

  func testConflictPausesAutosaveUntilAnExplicitSave() async throws {
    let store = FakeStore()
    let book = notebook(store)
    book.text = "# Memo\nbase"
    try await wait { !book.dirty && !book.saving }
    store.failure = Problem("保存が競合しました", status: 409)
    book.text = "# Memo\nlocal"
    try await wait { book.paused }
    XCTAssertTrue(book.message.contains("競合"))
    book.text = "# Memo\nlocal more"
    try await Task.sleep(for: .milliseconds(200))
    XCTAssertEqual(store.saves.count, 2, "autosave does not retry a conflict")
    XCTAssertEqual(book.text, "# Memo\nlocal more")
    store.failure = nil
    book.save()
    try await wait { !book.dirty && !book.saving }
    XCTAssertFalse(book.paused)
    XCTAssertEqual(book.message, "保存しました")
  }

  func testFailedAutosaveIsRetried() async throws {
    let store = FakeStore()
    store.failure = Problem("unavailable", status: 503)
    let book = notebook(store)
    book.text = "# Memo\nretry"
    try await wait { store.saves.count == 1 && !book.saving }
    XCTAssertTrue(book.dirty)
    store.failure = nil
    try await wait { !book.dirty && !book.saving }
    XCTAssertEqual(store.saves.count, 2)
    XCTAssertEqual(book.message, "")
  }

  func testLeavingANoteSavesItWithoutAsking() async throws {
    let store = FakeStore()
    let book = notebook(store, idle: .seconds(10))
    book.text = "# Memo\nunsaved"
    var left = false
    book.whenSaved({ left = true }, otherwise: { XCTFail("Should not ask to discard") })
    XCTAssertTrue(book.busy, "the editor is locked while the switch saves")
    try await wait { left }
    XCTAssertEqual(store.saves.map(\.markdown), ["# Memo\nunsaved"])
    XCTAssertFalse(book.busy)
  }

  func testLeavingWaitsForASaveInFlight() async throws {
    let store = FakeStore()
    store.hold = true
    let book = notebook(store, idle: .seconds(10))
    book.text = "# Memo\nsending"
    book.autosave()
    try await wait { store.saves.count == 1 }
    XCTAssertTrue(book.saving)
    var left = false
    book.whenSaved { left = true }
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertFalse(left)
    store.release()
    try await wait { left }
    XCTAssertFalse(book.dirty)
  }
}
