import React from "react";
import { createRoot } from "react-dom/client";
import CherryCanvas from "./CherryCanvasPro.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CherryCanvas />
  </React.StrictMode>
);
