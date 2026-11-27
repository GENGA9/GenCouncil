// Dev-only stand-in: a message with six pictures through the real <Attachments>, for looking at the lightbox.
import React from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Attachments } from "./components/Attachments";
import "./styles.css";

const q = new URLSearchParams(location.search);
const COLORS = ["#3b6ea8", "#a83b6e", "#6ea83b", "#a8863b", "#6e3ba8", "#3ba89c"];
const svg = (i: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${COLORS[i]}"/><g stroke="#fff" stroke-width="2" opacity=".5">${Array.from({ length: 24 }, (_, k) => `<line x1="${k * 50}" y1="0" x2="${k * 50}" y2="800"/>`).join("")}</g><text x="600" y="430" font-size="120" fill="#fff" text-anchor="middle">그림 ${i + 1}</text></svg>`,
  )}`;
api.attachmentUrl = (_k: string, id: string) => svg(Number(id));
const items = COLORS.map((_, i) => ({ id: String(i), name: `screenshot-${i + 1}.png`, type: "image/png", size: 1000 }));

createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 16, maxWidth: 760 }}>
    <div className="msg assistant">
      <Attachments agenda="demo" items={items} shown={false} />
    </div>
  </div>,
);
const open = q.get("open");
if (open !== null)
  setTimeout(() => {
    (document.querySelectorAll(".msg-attachments a")[Number(open)] as HTMLElement).click();
    if (q.has("zoom"))
      setTimeout(() => {
        const img = document.querySelector(".lb-img")!;
        img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }, 300);
  }, 300);
