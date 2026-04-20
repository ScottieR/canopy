import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SlackCompanion } from "./components/Companion/SlackCompanion";
import "./styles/globals.css";

const isCompanion = window.location.search.includes("companion=slack");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCompanion ? <SlackCompanion /> : <App />}
  </React.StrictMode>
);
