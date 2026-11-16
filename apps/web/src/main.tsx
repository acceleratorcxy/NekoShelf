import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { applyInteractionPreference } from "./interaction";
import "./styles.css";

// 先写 <html data-input>，首帧就使用正确的触摸/鼠标样式
applyInteractionPreference();

const container = document.getElementById("root");

if (!container) {
  throw new Error("找不到 #root 挂载节点，index.html 可能被改坏了");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
