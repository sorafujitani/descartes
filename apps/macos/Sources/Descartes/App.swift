import AppKit
import SwiftUI

struct NoteWindow: View {
  @ObservedObject var book: Notebook
  var showActions: () -> Void = {}
  @AppStorage("windowTransparency") private var transparency = 0.28
  @State private var appearanceOpen = false
  @State private var hovering = false
  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        Text(book.title.isEmpty ? "新規ノート" : book.title)
          .lineLimit(1).truncationMode(.tail).padding(.horizontal, 110)
          .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
        HStack(spacing: 8) {
          Spacer()
          Button {
            NSApp.sendAction(#selector(NoteText.toggleTask), to: nil, from: nil)
          } label: {
            Image(systemName: "checklist")
          }
          .help("ToDoにする／チェックを切り替える (⌘Return)").accessibilityLabel("ToDoにする")
          .disabled(book.preview)
          Button(action: showActions) { Image(systemName: "command") }
            .help("操作とショートカット (⌘K)").accessibilityLabel("操作とショートカット")
          Button {
            appearanceOpen.toggle()
          } label: {
            Image(systemName: "slider.horizontal.3")
          }
          .help("ウィンドウの透明度").accessibilityLabel("ウィンドウの透明度")
          .popover(isPresented: $appearanceOpen) {
            VStack(alignment: .leading) {
              Text("背景の透明度").font(.headline)
              Slider(value: $transparency, in: 0...0.8, step: 0.05).accessibilityLabel("背景の透明度")
              Text("0% は不透明 · " + String(Int((transparency * 100).rounded())) + "%").font(.caption)
            }.padding().frame(width: 230).background(GlassSurface()).tint(
              Color(nsColor: Theme.accent))
          }
          if book.dirty {
            Button {
              book.save()
            } label: {
              Image(systemName: "square.and.arrow.down")
            }.help("今すぐ保存 (⌘S) · 入力が止まると自動保存します").accessibilityLabel("保存")
          }
          Button {
            book.browse()
          } label: {
            Image(systemName: "square.on.square")
          }.help("文書を検索 (⌘P)").accessibilityLabel("文書を検索")
          Button {
            book.new()
          } label: {
            Image(systemName: "plus")
          }.help("新規 (⌘N)").accessibilityLabel("新規")
        }.padding(.trailing, 14).opacity(hovering || book.dirty ? 1 : 0.45).disabled(book.busy)
      }.frame(height: 38).onHover { hovering = $0 }
      Editor(book: book, source: book.source && !book.preview).frame(
        maxWidth: .infinity, maxHeight: .infinity)
      HStack {
        Text(
          book.busy
            ? "通信中…"
            : book.saving
              ? "保存中…"
              : !book.message.isEmpty
                ? book.message
                : book.preview
                  ? "プレビュー · ⌘E で編集"
                  : !book.dirty
                    ? ""
                    : book.paused
                      ? "自動保存を停止中 · 内容を控えて開き直すか ⌘S で再試行"
                      : book.title.isEmpty ? "1行目に「# タイトル」を書くと自動保存します" : "未保存 · 自動保存します"
        )
        .lineLimit(2).help(book.message).frame(maxWidth: .infinity, alignment: .leading)
        Text("\(book.text.count) characters").monospacedDigit().foregroundStyle(.secondary)
        HStack {
          Spacer()
          Button {
            book.preview = false
            book.source.toggle()
          } label: {
            Image(systemName: book.source ? "textformat" : "textformat.size")
          }
          .help(book.source ? "ノート表示に戻る" : "Markdown記号を表示").accessibilityLabel("Markdown記号の表示を切り替え")
        }
        .frame(maxWidth: .infinity)
      }.font(.system(size: 11)).padding(.horizontal, 14).frame(minHeight: 25)
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color(nsColor: NoteText.ink))
    .background(GlassSurface()).tint(Color(nsColor: Theme.accent))
    .ignoresSafeArea()
    .sheet(isPresented: $book.picking) { PickerSheet(book: book).presentationBackground(.clear) }
  }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let book = Notebook(demo: CommandLine.arguments.contains("--demo"))
  var window: NSWindow!
  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenus()
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 990, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false
    )
    window.title = book.demo ? "Descartes — Demo" : "Descartes"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.isOpaque = false
    window.backgroundColor = .clear
    window.appearance = NSAppearance(named: .darkAqua)
    window.minSize = NSSize(width: 420, height: 300)
    window.isReleasedWhenClosed = false
    window.center()
    window.setFrameAutosaveName(book.demo ? "DescartesDemo" : "DescartesNotebook")
    window.contentView = NSHostingView(
      rootView: NoteWindow(book: book, showActions: { [weak self] in self?.showActions() }))
    window.delegate = self
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    book.start()
  }
  @objc func newNote() { book.new() }
  @objc func searchNotes() { book.browse() }
  @objc func saveNote() { book.save() }
  @objc func togglePreview() {
    guard !book.picking else { return }
    book.preview.toggle()
  }
  @objc func editBody() {
    guard !book.picking else { return }
    book.preview = false
    book.focusRequest += 1
  }
  @objc func codeOrEdit() {
    if book.preview {
      editBody()
    } else {
      NSApp.sendAction(#selector(NoteText.inlineCode), to: nil, from: nil)
    }
  }
  @objc func zoomIn() { book.zoom = min(20, book.zoom + 1) }
  @objc func zoomOut() { book.zoom = max(5, book.zoom - 1) }
  @objc func actualSize() { book.zoom = 10 }

  @objc func showActions() {
    guard let view = window?.contentView, window.attachedSheet == nil,
      let main = NSApp.mainMenu
    else { return }
    let panel = NSMenu(title: "操作とショートカット")
    for section in main.items.compactMap(\.submenu)
    where ["File", "Edit", "Note", "View"].contains(section.title) {
      panel.addItem(.sectionHeader(title: section.title))
      for item in section.items where !item.isHidden {
        if let copy = item.copy() as? NSMenuItem { panel.addItem(copy) }
      }
    }
    let tips = NSMenu()
    for tip in [
      "Return：リストを続ける／空の項目で字下げを戻す・終了", "Tab / ⇧Tab：リストの字下げ／戻す",
      "⌘Return：行をToDoにする（選択した複数行もまとめて）／チェックを切り替える",
      "[] / 「」：行頭や箇条書きの後に入力するとToDo（- [ ] ）になる",
      "Return（```の後）：コードブロックを閉じて中に入力",
      "Return（見出しの先頭）：見出しの上に空行を入れる",
      "チェックボックスをクリック：チェックを切り替える（プレビュー中も可）",
      "⌘←：箇条書き・チェックの直後へ、もう一度で行頭へ",
      "選択して * _ ` ~ [：選択した文字を記号で囲む（[ はリンク）",
      "URLを選択した文字に貼り付け：リンク [文字](URL) にする",
      "⌘クリック：リンクを開く",
      "⌫：行頭の箇条書き・チェック記号をまとめて削除",
      "文書検索：↑↓で選択、Returnで開く、Escで閉じる",
    ] {
      tips.addItem(withTitle: tip, action: nil, keyEquivalent: "")
    }
    panel.addItem(withTitle: "入力・検索のキー操作", action: nil, keyEquivalent: "").submenu = tips
    panel.popUp(
      positioning: nil,
      at: NSPoint(
        x: max(8, view.bounds.width - 330), y: view.isFlipped ? 35 : view.bounds.height - 35),
      in: view)
  }
  func buildMenus() {
    let main = NSMenu()
    func submenu(_ title: String) -> NSMenu {
      let item = NSMenuItem()
      main.addItem(item)
      let menu = NSMenu(title: title)
      item.submenu = menu
      return menu
    }
    let app = submenu("Descartes")
    app.addItem(
      withTitle: "Quit Descartes", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    let file = submenu("File")
    for (name, key, action) in [
      ("新規ノート", "n", #selector(newNote)), ("ノートを検索…", "p", #selector(searchNotes)),
      ("保存", "s", #selector(saveNote)),
    ] {
      file.addItem(withTitle: name, action: action, keyEquivalent: key).target = self
    }
    file.addItem(
      withTitle: "ウィンドウを閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    let edit = submenu("Edit")
    for (title, action, key) in [
      ("取り消す", "undo:", "z"), ("やり直す", "redo:", "Z"), ("カット", "cut:", "x"), ("コピー", "copy:", "c"),
      ("ペースト", "paste:", "v"), ("すべてを選択", "selectAll:", "a"),
    ] {
      edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
    }
    for (name, key, action) in [
      ("本文内を検索…", "f", NSTextFinder.Action.showFindInterface),
      ("次の一致", "g", .nextMatch), ("前の一致", "G", .previousMatch),
    ] {
      edit.addItem(
        withTitle: name, action: #selector(NSTextView.performTextFinderAction(_:)),
        keyEquivalent: key
      ).tag = action.rawValue
    }
    let note = submenu("Note")
    note.addItem(withTitle: "プレビューと編集を切り替える", action: #selector(togglePreview), keyEquivalent: "P")
      .target = self
    note.addItem(
      withTitle: "インラインコード（プレビュー中は編集に戻る）", action: #selector(codeOrEdit), keyEquivalent: "e"
    ).target = self
    for (name, key, action, flags) in [
      (
        "前の見出し", "[", #selector(NoteText.previousHeading),
        NSEvent.ModifierFlags([.command, .option])
      ),
      ("次の見出し", "]", #selector(NoteText.nextHeading), [.command, .option]),
      ("ToDoにする／チェックを切り替える", "\r", #selector(NoteText.toggleTask), [.command]),
      ("リンクを挿入", "l", #selector(NoteText.insertLink), [.command]),
      ("インラインコード", "`", #selector(NoteText.inlineCode), [.command, .shift]),
      ("太字", "b", #selector(NoteText.boldSelection), [.command]),
      ("取り消し線", "x", #selector(NoteText.strikeSelection), [.command, .shift]),
      (
        "行を上へ移動", String(Character(UnicodeScalar(NSUpArrowFunctionKey)!)),
        #selector(NoteText.moveLinesUp), [.option]
      ),
      (
        "行を下へ移動", String(Character(UnicodeScalar(NSDownArrowFunctionKey)!)),
        #selector(NoteText.moveLinesDown), [.option]
      ),
      ("斜体", "i", #selector(NoteText.italicSelection), [.command]),
    ] {
      note.addItem(withTitle: name, action: action, keyEquivalent: key).keyEquivalentModifierMask =
        flags
    }
    let view = submenu("View")
    for (title, key, action) in [
      ("拡大", "+", #selector(zoomIn)), ("拡大", "=", #selector(zoomIn)),
      ("縮小", "-", #selector(zoomOut)), ("実際のサイズ", "0", #selector(actualSize)),
    ] {
      let item = view.addItem(withTitle: title, action: action, keyEquivalent: key)
      item.target = self
      if key == "=" {
        item.isHidden = true
        item.allowsKeyEquivalentWhenHidden = true
      }
    }
    let help = submenu("Help")
    help.addItem(withTitle: "操作とショートカット…", action: #selector(showActions), keyEquivalent: "k")
      .target = self
    NSApp.mainMenu = main
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // Termination saves (and, if that fails, prompts) once, including Cmd-W and the red button.
    NSApp.terminate(nil)
    return false
  }
  func applicationDidResignActive(_ notification: Notification) {
    // Switching to another app saves at once instead of waiting for the idle delay.
    book.autosave()
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if book.busy {
      NSSound.beep()
      return .terminateCancel
    }
    guard book.dirty || book.saving else { return .terminateNow }
    // Finish the pending save first; ask before discarding only if it could not be saved.
    book.whenSaved(
      { DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) } },
      otherwise: { DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: false) } })
    return .terminateLater
  }
}
@main struct Descartes {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
