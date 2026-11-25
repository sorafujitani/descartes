import AppKit
import SwiftUI
import WebKit

/// The note editor is the web app's CodeMirror editor (apps/web/editor.html), loaded into a
/// WKWebView, so editing behaves the same in the browser and on the Mac. Swift owns the document
/// (loading, saving, autosave); the page owns editing.
///
/// `descartes-editor://app/…` serves the built editor files and, under `asset/`, note images
/// fetched with the Mac app's Access credentials. Nothing else is loaded into the page.
@MainActor final class EditorScheme: NSObject, WKURLSchemeHandler {
  static let scheme = "descartes-editor"
  static let page = URL(string: "descartes-editor://app/editor.html")!
  /// The page may only load its own files and note images; Markdown is never rendered as HTML.
  static let policy =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; "
    + "font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'"
  let root: URL
  let images: (String) async throws -> Data
  private var stopped = Set<ObjectIdentifier>()

  init(root: URL, images: @escaping (String) async throws -> Data) {
    self.root = root.standardizedFileURL
    self.images = images
  }
  /// The editor built into the app bundle, or the development build next to the sources.
  static func bundledRoot() -> URL? {
    let fileManager = FileManager.default
    if let url = Bundle.main.resourceURL?.appending(path: "Editor"),
      fileManager.fileExists(atPath: url.appending(path: "editor.html").path)
    {
      return url
    }
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<4 { url.deleteLastPathComponent() }  // …/apps
    url = url.appending(path: "web/dist-editor")
    return fileManager.fileExists(atPath: url.appending(path: "editor.html").path) ? url : nil
  }
  static func mimeType(_ path: String) -> String {
    switch (path as NSString).pathExtension.lowercased() {
    case "html": "text/html; charset=utf-8"
    case "js": "text/javascript; charset=utf-8"
    case "css": "text/css; charset=utf-8"
    case "svg": "image/svg+xml"
    case "png": "image/png"
    case "jpg", "jpeg": "image/jpeg"
    case "webp": "image/webp"
    case "woff2": "font/woff2"
    case "wasm": "application/wasm"
    default: "application/octet-stream"
    }
  }
  /// The file for a request path, never outside the editor directory.
  func file(for path: String) -> URL? {
    let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
    guard !relative.isEmpty, !relative.contains("..") else { return nil }
    let url = root.appending(path: relative).standardizedFileURL
    return url.path.hasPrefix(root.path + "/") ? url : nil
  }
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, url.host == "app" else {
      return task.didFailWithError(URLError(.badURL))
    }
    let path = url.path
    if path.hasPrefix("/asset/") {
      // Only names produced by the notebook's attachment endpoint carry credentials.
      let name = String(path.dropFirst("/asset/".count))
      guard name.range(of: "^" + API.assetName + "$", options: .regularExpression) != nil else {
        return task.didFailWithError(URLError(.fileDoesNotExist))
      }
      let id = ObjectIdentifier(task)
      Task { @MainActor in
        let result = await Result { try await self.images(name) }
        guard self.stopped.remove(id) == nil else { return }
        switch result {
        case .success(let data): self.respond(task, url: url, data: data, type: Self.mimeType(name))
        case .failure(let error): task.didFailWithError(error)
        }
      }
      return
    }
    guard let file = file(for: path), let data = try? Data(contentsOf: file) else {
      return task.didFailWithError(URLError(.fileDoesNotExist))
    }
    respond(task, url: url, data: data, type: Self.mimeType(file.path))
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    stopped.insert(ObjectIdentifier(task))
  }
  private func respond(_ task: WKURLSchemeTask, url: URL, data: Data, type: String) {
    var headers = ["Content-Type": type, "Cache-Control": "no-store"]
    if type.hasPrefix("text/html") { headers["Content-Security-Policy"] = Self.policy }
    let response = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }
}

private extension Result where Failure == Error {
  init(catching body: () async throws -> Success) async {
    do { self = .success(try await body()) } catch { self = .failure(error) }
  }
}

/// Connects a Notebook to the editor page. Created once per notebook; menus send commands here.
@MainActor final class EditorBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate,
  WKUIDelegate
{
  private(set) weak var webView: WKWebView?
  weak var book: Notebook?
  /// The page has loaded and `window.descartes` exists.
  private(set) var ready = false
  private var shownRevision = -1
  private var shownOptions: [String: AnyHashable] = [:]
  private var focusRequest = 0
  /// Called with each message for tests.
  var observe: ((String) -> Void)?

  /// `images` loads note images; tests replace it, the app uses the notebook API.
  func makeWebView(demo: Bool, images: ((String) async throws -> Data)? = nil) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    if let root = EditorScheme.bundledRoot() {
      configuration.setURLSchemeHandler(
        EditorScheme(root: root, images: images ?? { try await API(demo: demo).imageData($0) }),
        forURLScheme: EditorScheme.scheme)
    }
    configuration.userContentController.add(WeakHandler(self), name: "descartes")
    configuration.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.setValue(false, forKey: "drawsBackground")
    view.underPageBackgroundColor = .clear
    view.navigationDelegate = self
    view.uiDelegate = self
    view.allowsMagnification = false
    view.setAccessibilityLabel("Markdown本文")
    webView = view
    ready = false
    if EditorScheme.bundledRoot() != nil {
      view.load(URLRequest(url: EditorScheme.page))
    } else {
      view.loadHTMLString(
        "<p style='color:#e1e4e8;font:14px -apple-system;padding:20px'>"
          + "エディタが見つかりません。pnpm build:macos で作り直してください。</p>", baseURL: nil)
    }
    return view
  }

  /// Pushes the notebook's state to the page: a newly opened note, preview/source mode, zoom
  /// and focus requests.
  func sync() {
    guard ready, let book else { return }
    if shownRevision != book.revision {
      shownRevision = book.revision
      call("load", book.text, book.base == nil ? 2 : 0)
    }
    let options: [String: AnyHashable] = [
      "readOnly": book.preview || book.busy, "raw": book.source && !book.preview,
      "zoom": book.zoom,
    ]
    if options != shownOptions {
      shownOptions = options
      call("configure", options)
    }
    if focusRequest != book.focusRequest {
      focusRequest = book.focusRequest
      focus()
    }
  }
  func focus() {
    guard let webView else { return }
    webView.window?.makeFirstResponder(webView)
    call("focus")
  }
  /// Runs an editing command (bold, task, undo, …) in the page.
  func run(_ command: String) { call("command", command) }
  func find(_ action: String) { call("find", action) }
  func evaluate(_ script: String) async throws -> Any? {
    guard let webView else { return nil }
    return try await webView.evaluateJavaScript(script)
  }
  private func call(_ function: String, _ arguments: Any...) {
    guard ready, let webView,
      let data = try? JSONSerialization.data(
        withJSONObject: arguments, options: [.fragmentsAllowed]),
      let json = String(data: data, encoding: .utf8)
    else { return }
    webView.evaluateJavaScript("window.descartes?.\(function)(...\(json))")
  }

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
      return
    }
    switch type {
    case "ready":
      ready = true
      shownRevision = -1
      shownOptions = [:]
      focusRequest = -1
      sync()
    case "change":
      guard let markdown = body["markdown"] as? String, let book else { break }
      book.text = markdown
      // Checking a box saves right away, like the web app.
      if body["persist"] as? Bool == true { book.autosave() }
    default: break
    }
    observe?(type)
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if url.scheme == EditorScheme.scheme || url.scheme == "about" {
      return decisionHandler(.allow)
    }
    // Links (⌘-click) open in the browser; the editor page never navigates away.
    if ["http", "https"].contains(url.scheme) { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url, ["http", "https"].contains(url.scheme) {
      NSWorkspace.shared.open(url)
    }
    return nil
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // Reload the editor and show the notebook's current text again.
    ready = false
    webView.load(URLRequest(url: EditorScheme.page))
  }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: (any WKScriptMessageHandler)?
  init(_ target: any WKScriptMessageHandler) { self.target = target }
  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    target?.userContentController(controller, didReceive: message)
  }
}

struct Editor: NSViewRepresentable {
  @ObservedObject var book: Notebook
  func makeNSView(context: Context) -> WKWebView {
    book.editor.book = book
    return book.editor.makeWebView(demo: book.demo)
  }
  func updateNSView(_ view: WKWebView, context: Context) { book.editor.sync() }
}
