import React from "react";
import ReactDOM from "react-dom/client";
import App, { CompanionGuide } from "./App";
import { SlackCompanion } from "./components/Companion/SlackCompanion";
import { PasswordsCompanion } from "./components/Companion/PasswordsCompanion";
import { GithubCompanion } from "./components/Companion/GithubCompanion";
import { DiscordCompanion } from "./components/Companion/DiscordCompanion";
import { TelegramCompanion } from "./components/Companion/TelegramCompanion";
import "./styles/globals.css";

const companionType = new URLSearchParams(window.location.search).get("companion");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {companionType === "slack" ? (
      <SlackCompanion />
    ) : companionType === "passwords" ? (
      <PasswordsCompanion />
    ) : companionType === "github" ? (
      <GithubCompanion />
    ) : companionType === "discord" ? (
      <DiscordCompanion />
    ) : companionType === "telegram" ? (
      <TelegramCompanion />
    ) : companionType ? (
      <CompanionGuide type={companionType} />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
