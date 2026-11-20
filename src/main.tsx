import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdateGate } from "./updates/UpdateGate";
import favicon from "./assets/favicon.png";
import "./styles.css";

// The SD logo as the page's icon. Added from code so the build inlines it
// (the page is one file); a host may still show its own icon in the tab.
const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/png";
icon.href = favicon;
document.head.append(icon);

createRoot(document.getElementById("root")!).render(
  <UpdateGate>
    <App />
  </UpdateGate>,
);
