import { parseAndRender, WasmParserOptions } from "@ox-content/wasm";

/** Called only after WASM initialization, in the dedicated render Worker. */
export function renderMarkdown(source: string): string {
  const options = new WasmParserOptions();
  options.gfm = true;
  options.sanitize = true;
  options.mdx = false;
  // wasm-bindgen transfers ownership into parseAndRender; calling free() afterwards double-frees.
  return parseAndRender(source, options).html as string;
}
