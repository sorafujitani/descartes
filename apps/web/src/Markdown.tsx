import { memo, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { imagePath, messageOf } from "@descartes/shared";
import { renderer } from "./renderer";

export const Markdown = memo(function Markdown({
  source,
  documentKey = "",
  onToggleTask,
}: {
  source: string;
  documentKey?: string;
  onToggleTask?: (index: number) => void;
}) {
  const container = useRef<HTMLElement>(null);
  const shownKey = useRef(documentKey);
  const toggle = useRef(onToggleTask);
  toggle.current = onToggleTask;
  const [loading, setLoading] = useState(true);
  const interactive = Boolean(onToggleTask);
  useEffect(() => {
    let active = true;
    setLoading(true);
    if (shownKey.current !== documentKey) {
      shownKey.current = documentKey;
      container.current?.replaceChildren();
    }
    async function render() {
      try {
        const html = await renderer.render(source);
        if (!active || !container.current) return;
        const fragment = DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true },
          RETURN_DOM_FRAGMENT: true,
        });
        for (const img of fragment.querySelectorAll("img")) {
          const name = imagePath.exec(img.getAttribute("src") ?? "")?.[1];
          if (name) {
            img.src = "/api/assets/" + name;
            img.loading = "lazy";
            img.decoding = "async";
            img.removeAttribute("srcset");
          } else img.replaceWith(img.alt || "外部画像");
        }
        container.current.replaceChildren(fragment);
        for (const [index, input] of container.current
          .querySelectorAll("input[type=checkbox]")
          .entries()) {
          if (!(input instanceof HTMLInputElement)) continue;
          input.disabled = !interactive;
          input.setAttribute("aria-label", "チェックを切り替える");
          const row = input.closest("li") ?? input;
          row.addEventListener("click", (event) => {
            if (!toggle.current || !(event.target instanceof Element)) return;
            if (row.tagName === "LI" && event.target.closest("li") !== row) return;
            if (event.target.closest("a, button")) return;
            if (event.target !== input && window.getSelection()?.isCollapsed === false) return;
            if (event.target !== input) input.checked = !input.checked;
            toggle.current?.(index);
          });
        }
      } catch (error) {
        if (active && container.current)
          container.current.textContent = "表示できません: " + messageOf(error);
      } finally {
        if (active) setLoading(false);
      }
    }
    void render();
    return () => {
      active = false;
    };
  }, [source, documentKey, interactive]);
  return (
    <>
      <span role="status">{loading ? "描画しています…" : ""}</span>
      <article ref={container} className="sora-prose" aria-busy={loading} />
    </>
  );
});
