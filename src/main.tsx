import React from "react";
import ReactDOM from "react-dom/client";
import App, { CompanionGuide } from "./App";
import { SlackCompanion } from "./components/Companion/SlackCompanion";
import "./styles/globals.css";

const companionType = new URLSearchParams(window.location.search).get("companion");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {companionType === "slack" ? (
      <SlackCompanion />
    ) : companionType ? (
      <CompanionGuide type={companionType} />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
