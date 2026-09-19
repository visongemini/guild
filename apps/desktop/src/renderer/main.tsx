import { GuildApp } from "@guild/ui";
import "@guild/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root === null) throw new Error("Guild renderer root is missing");
if (window.guild === undefined) throw new Error("Guild preload API is unavailable");

createRoot(root).render(
  <StrictMode>
    <GuildApp api={window.guild} />
  </StrictMode>,
);
