import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import InstallPrompt from "./InstallPrompt.jsx";
import "./styles.css";

// The install prompt and offline support are for club owners and admins only. Member join
// links (/r/…), sign-up and reset pages stay plain web pages.
const adminPage = ["/", "/superadmin"].includes(window.location.pathname);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    {adminPage && <InstallPrompt />}
  </React.StrictMode>
);

if (adminPage && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
