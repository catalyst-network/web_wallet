import React from "react";
import ReactDOM from "react-dom/client";
import { PopupApp } from "../popup/popupApp.js";
import "../popup/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);

