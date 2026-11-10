import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import "@upstream-studio/styles/studio.css";
import "./styles.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("The application root is missing.");

createRoot(root).render(
  <StrictMode>
    <IconContext.Provider value={{ size: 16, weight: "regular" }}>
      <App />
    </IconContext.Provider>
  </StrictMode>,
);
