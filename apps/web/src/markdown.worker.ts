import init from "@ox-content/wasm";
import { renderMarkdown } from "./markdown-parser";
import wasmUrl from "@ox-content/wasm/ox_content_wasm_bg.wasm?url";
import { messageOf } from "@descartes/shared";

let ready: ReturnType<typeof init> | undefined;
self.addEventListener("message", async (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  try {
    await (ready ??= init({ module_or_path: wasmUrl }).catch((error) => {
      ready = undefined;
      throw error;
    }));
    self.postMessage({ id, html: renderMarkdown(source) });
  } catch (error) {
    self.postMessage({ id, error: messageOf(error) });
  }
});
