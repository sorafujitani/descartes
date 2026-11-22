import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@sorafujitani/document-design-system/tokens.css";
import "@sorafujitani/document-design-system/theme.css";
import "@sorafujitani/document-design-system/prose.css";
import "./style.css";

createRoot(document.getElementById("root")!).render(<App />);
