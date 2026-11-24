import Foundation

struct Summary: Decodable, Identifiable {
  let id: UUID
  let title: String
}
struct Document: Codable {
  let id: UUID
  let title, markdown, sha: String
}
struct Problem: LocalizedError {
  let message: String
  /// HTTP status of a rejected request, when there was one (409 means a SHA conflict).
  let status: Int?
  init(_ message: String, status: Int? = nil) {
    self.message = message
    self.status = status
  }
  var errorDescription: String? { message }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

struct API {
  let origin: URL
  private let headers: [String: String]
  private static let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.timeoutIntervalForRequest = 20
    return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
  }()
  private struct Credentials: Decodable {
    let origin, clientID, clientSecret: String
    enum CodingKeys: String, CodingKey {
      case origin
      case clientID = "client_id"
      case clientSecret = "client_secret"
    }
  }
  init(demo: Bool) throws {
    if demo {
      origin = URL(string: "http://127.0.0.1:8788")!
      headers = [:]
      return
    }
    let file = FileManager.default.homeDirectoryForCurrentUser.appending(
      path: ".config/descartes/desktop-access.json")
    guard let data = try? Data(contentsOf: file),
      let credentials = try? JSONDecoder().decode(Credentials.self, from: data),
      let components = URLComponents(string: credentials.origin), components.scheme == "https",
      components.host != nil,
      components.user == nil, components.password == nil, components.query == nil,
      components.fragment == nil,
      ["", "/"].contains(components.path), let url = components.url, !credentials.clientID.isEmpty,
      !credentials.clientSecret.isEmpty
    else { throw Problem("接続設定を確認してください: ~/.config/descartes/desktop-access.json") }
    origin = url
    headers = [
      "CF-Access-Client-Id": credentials.clientID,
      "CF-Access-Client-Secret": credentials.clientSecret,
    ]
  }
  private func request<T: Decodable>(
    _ path: String, method: String = "GET", body: Data? = nil, cursor: Int? = nil
  ) async throws -> T {
    var url = origin.appending(path: "api/" + path)
    if let cursor { url.append(queryItems: [.init(name: "cursor", value: String(cursor))]) }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.allHTTPHeaderFields = headers
    req.setValue("Descartes-macOS/1", forHTTPHeaderField: "User-Agent")
    if let body {
      req.httpBody = body
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.setValue("1", forHTTPHeaderField: "X-Descartes-Write")
    }
    let (data, response) = try await Self.session.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw Problem("Invalid response.") }
    guard (200..<300).contains(http.statusCode) else {
      let reason = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
      throw Problem(reason ?? "接続できませんでした (HTTP \(http.statusCode))。", status: http.statusCode)
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
  static let assetName =
    #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)"#
  func imageData(_ name: String) async throws -> Data {
    guard
      name.range(of: Self.assetName, options: .regularExpression) == name.startIndex..<name.endIndex
    else {
      throw Problem("画像の参照先が正しくありません。")
    }
    var req = URLRequest(url: origin.appending(path: "api/assets/" + name))
    req.allHTTPHeaderFields = headers
    let (data, response) = try await Self.session.data(for: req)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      ["image/png", "image/jpeg", "image/webp"].contains(http.mimeType ?? ""),
      data.count <= 4 * 1024 * 1024
    else { throw Problem("画像を読み込めませんでした。") }
    return data
  }
  func list() async throws -> [Summary] {
    struct Page: Decodable {
      let items: [Summary]
      let next: Int?
    }
    var items = [Summary]()
    var cursor = 0
    while true {
      let page: Page = try await request("docs", cursor: cursor)
      items += page.items
      guard let next = page.next else { break }
      guard next > cursor else { throw Problem("Invalid cursor.") }
      cursor = next
    }
    return items.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
  }
  func get(_ id: UUID) async throws -> Document {
    try await request("docs/" + id.uuidString.lowercased())
  }
  func save(_ markdown: String, base: Document?) async throws -> Document {
    struct Edit: Encodable {
      let markdown: String
      let sha: String?
    }
    return try await request(
      base.map { "docs/" + $0.id.uuidString.lowercased() } ?? "docs",
      method: base == nil ? "POST" : "PUT",
      body: JSONEncoder().encode(Edit(markdown: markdown, sha: base?.sha)))
  }
}
