import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sourceRoot = resolve(projectRoot, "node_modules", "pdfjs-dist");
const outputRoot = resolve(projectRoot, "public", "pdfjs");

const targets = [
  { from: "build/pdf.mjs", to: "build/pdf.mjs" },
  { from: "build/pdf.worker.mjs", to: "build/pdf.worker.mjs" },
  { from: "web/pdf_viewer.mjs", to: "web/pdf_viewer.mjs" },
  { from: "web/pdf_viewer.css", to: "web/pdf_viewer.css" },
  { from: "web/images", to: "web/images" },
  { from: "cmaps", to: "cmaps" },
  { from: "standard_fonts", to: "standard_fonts" },
];

if (!existsSync(sourceRoot)) {
  throw new Error(`pdfjs-dist not found at ${sourceRoot}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

for (const target of targets) {
  cpSync(resolve(sourceRoot, target.from), resolve(outputRoot, target.to), {
    recursive: true,
  });
}

console.log(`[sync-pdfjs-assets] copied assets to ${outputRoot}`); 
