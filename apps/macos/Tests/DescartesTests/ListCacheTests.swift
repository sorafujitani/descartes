import Network
import XCTest

@testable import Descartes

/// A minimal HTTP server on the loopback interface, so requests go through URLSession's real
/// HTTP stack (including any caching it might apply) rather than a stubbed protocol.
private final class TitleServer: @unchecked Sendable {
  let etag = "\"abc123\""
  let body =
    #"{"items":[{"id":"6f1d3c1e-5f8f-4c47-9d1b-1f1e1a2b3c4d","title":"B"},"#
    + #"{"id":"0b5c2f0e-8f7a-4d6b-9a3e-2c1d0e9f8a7b","title":"A"}],"next":null}"#
  private let listener: NWListener
  private let lock = NSLock()
  private var seen: [String] = []
  var requests: [String] { lock.withLock { seen } }

  init() throws {
    listener = try NWListener(using: .tcp, on: .any)
    listener.newConnectionHandler = { [self] connection in
      connection.start(queue: .global())
      receive(connection, Data())
    }
  }
  func start() async throws -> URL {
    let ready = AsyncStream<NWListener.State> { continuation in
      listener.stateUpdateHandler = { continuation.yield($0) }
    }
    listener.start(queue: .global())
    for await state in ready {
      if case .ready = state, let port = listener.port {
        return URL(string: "http://127.0.0.1:\(port.rawValue)")!
      }
      if case .failed(let error) = state { throw error }
    }
    throw URLError(.cannotConnectToHost)
  }
  func stop() { listener.cancel() }
  private func receive(_ connection: NWConnection, _ buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [self] data, _, _, error in
      let buffer = buffer + (data ?? Data())
      guard let text = String(data: buffer, encoding: .utf8), text.contains("\r\n\r\n") else {
        if error == nil { receive(connection, buffer) }
        return
      }
      lock.withLock { seen.append(text) }
      let fresh = !text.lowercased().contains("if-none-match: " + etag.lowercased())
      let head =
        (fresh
          ? "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
          : "HTTP/1.1 304 Not Modified\r\n")
        + "Cache-Control: private, no-store\r\nETag: \(etag)\r\nConnection: close\r\n"
        + "Content-Length: \(fresh ? body.utf8.count : 0)\r\n\r\n"
      connection.send(
        content: Data((head + (fresh ? body : "")).utf8),
        completion: .contentProcessed { _ in connection.cancel() })
    }
  }
}

final class ListCacheTests: XCTestCase {
  func testConditionalListOverRealHTTP() async throws {
    let server = try TitleServer()
    defer { server.stop() }
    let api = API(origin: try await server.start(), headers: ["CF-Access-Client-Id": "id"])
    let firstResponse = try await api.list()
    let first = try XCTUnwrap(firstResponse)
    XCTAssertEqual(first.etag, server.etag)
    XCTAssertEqual(first.items.map(\.title), ["A", "B"])
    // URLSession must hand back the 304 itself, not a cached 200.
    let again = try await api.list(etag: first.etag)
    XCTAssertNil(again)
    let changedResponse = try await api.list(etag: "\"other\"")
    let changed = try XCTUnwrap(changedResponse)
    XCTAssertEqual(changed.items, first.items)
    let requests = server.requests
    XCTAssertEqual(requests.count, 3)
    XCTAssertFalse(requests[0].lowercased().contains("if-none-match"))
    XCTAssertTrue(requests[1].lowercased().contains("if-none-match: " + server.etag.lowercased()))
    XCTAssertTrue(requests.allSatisfy { $0.lowercased().contains("cf-access-client-id: id") })
    XCTAssertTrue(requests.allSatisfy { $0.contains("GET /api/docs?cursor=0 ") })
  }

  private func temporaryFile() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory.appending(path: "titles.json")
  }
  @MainActor private func settle(_ book: Notebook) async throws {
    let deadline = ContinuousClock.now + .seconds(2)
    while book.refreshing {
      guard ContinuousClock.now < deadline else { return XCTFail("Timed out") }
      try await Task.sleep(for: .milliseconds(5))
    }
  }
  private let first = Summary(id: UUID(), title: "A")
  private let second = Summary(id: UUID(), title: "B")

  @MainActor func testCachedListIsShownAtOnceAndKeptWhenUnchanged() async throws {
    let file = try temporaryFile()
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(TitleList(etag: "\"v1\"", items: [first])).write(to: file)
    var asked: [String?] = []
    let book = Notebook(
      demo: true,
      lister: {
        asked.append($0)
        return nil
      }, listFile: file)
    XCTAssertEqual(book.items, [first], "the cached list is available before any request")
    book.refreshList()
    XCTAssertTrue(book.refreshing)
    XCTAssertFalse(book.busy, "a refresh does not block opening a listed note")
    try await settle(book)
    XCTAssertEqual(asked, ["\"v1\""])
    XCTAssertEqual(book.items, [first])
    XCTAssertEqual(book.message, "")
  }

  @MainActor func testChangedListReplacesAndPersistsTitlesOnly() async throws {
    let file = try temporaryFile()
    var asked: [String?] = []
    let book = Notebook(
      demo: true,
      lister: {
        asked.append($0)
        return TitleList(etag: "\"v2\"", items: [self.first, self.second])
      }, listFile: file)
    XCTAssertEqual(book.items, [])
    book.browse()
    XCTAssertTrue(book.picking)
    try await settle(book)
    XCTAssertEqual(asked, [nil])
    XCTAssertEqual(book.items, [first, second])
    let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
    XCTAssertEqual(stored?["etag"] as? String, "\"v2\"")
    let rows = try XCTUnwrap(stored?["items"] as? [[String: Any]])
    XCTAssertEqual(rows.map { Set($0.keys) }, [["id", "title"], ["id", "title"]])
    let reopened = Notebook(
      demo: true,
      lister: {
        asked.append($0)
        return nil
      }, listFile: file)
    XCTAssertEqual(reopened.items, [first, second])
    reopened.browse()
    try await settle(reopened)
    XCTAssertEqual(asked.last, "\"v2\"")
  }

  @MainActor func testFailedRefreshKeepsTheCachedList() async throws {
    let file = try temporaryFile()
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(TitleList(etag: nil, items: [second])).write(to: file)
    let book = Notebook(demo: true, lister: { _ in throw Problem("offline") }, listFile: file)
    book.browse()
    try await settle(book)
    XCTAssertEqual(book.items, [second])
    XCTAssertEqual(book.message, "offline")
  }
}
