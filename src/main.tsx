import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdateGate } from "./updates/UpdateGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <UpdateGate>
    <App />
  </UpdateGate>,
);
