import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import App from "./App";
import "./styles.css";
import "./workbench.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconContext.Provider value={{ "aria-hidden": true }}><App /></IconContext.Provider>
  </StrictMode>,
);
