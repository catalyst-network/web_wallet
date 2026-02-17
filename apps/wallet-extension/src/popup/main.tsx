import React from "react";
import ReactDOM from "react-dom/client";
import { PopupApp } from "./popupApp.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);

