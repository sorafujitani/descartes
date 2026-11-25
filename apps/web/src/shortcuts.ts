export type Action =
  | "new"
  | "save"
  | "search"
  | "edit"
  | "help"
  | "find"
  | "find-next"
  | "find-prev"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "continue"
  | "indent"
  | "outdent"
  | "task"
  | "bold"
  | "strike"
  | "italic"
  | "code"
  | "link"
  | "heading-prev"
  | "heading-next";

export function actionFor(event: KeyboardEvent): Action | null {
  if (event.isComposing || event.key === "Process") return null;
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;
  if (meta && event.altKey && key === "[") return "heading-prev";
  if (meta && event.altKey && key === "]") return "heading-next";
  if (meta && event.shiftKey && key === "`") return "code";
  if (meta && event.shiftKey && key.toLowerCase() === "x") return "strike";
  if (meta && event.shiftKey && key.toLowerCase() === "g") return "find-prev";
  if (!meta) {
    if (key === "Enter" && !event.shiftKey && !event.altKey) return "continue";
    if (key === "Tab") return event.shiftKey ? "outdent" : "indent";
    return null;
  }
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-") return "zoom-out";
  if (key === "0") return "zoom-reset";
  if (key === "Enter") return "task";
  const named: Record<string, Action> = {
    n: "new",
    s: "save",
    p: "search",
    e: "edit",
    k: "help",
    f: "find",
    g: "find-next",
    b: "bold",
    i: "italic",
    l: "link",
  };
  return named[key.toLowerCase()] ?? null;
}
