import type { Preview } from "@storybook/react-vite";
import "@sorafujitani/document-design-system/tokens.css";
import "@sorafujitani/document-design-system/theme.css";
import "@sorafujitani/document-design-system/prose.css";
import "../src/style.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        mobile: { name: "Mobile (390)", styles: { width: "390px", height: "844px" } },
        desktop: { name: "Desktop (1280)", styles: { width: "1280px", height: "900px" } },
      },
    },
  },
  beforeEach() {
    // Match index.html as well as its CSS imports; tokens are scoped to .sora-theme.
    document.body.classList.add("sora-theme");
    document.documentElement.lang = "ja";
    localStorage.removeItem("noteZoomTenths");
  },
};
export default preview;
