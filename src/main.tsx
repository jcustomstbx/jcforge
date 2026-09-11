import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DockApp } from "./DockApp";
import "./styles/global.css";

const isDockWindow = new URLSearchParams(window.location.search).get(
  "window",
) === "dock";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isDockWindow ? <DockApp /> : <App />}</React.StrictMode>,
);
