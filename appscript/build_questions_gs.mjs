import { readFileSync, writeFileSync } from "node:fs";
const raw = readFileSync("src/seed/questions.json", "utf8");
// Minify so the Apps Script file isn't huge, but JSON is already compact enough.
const json = JSON.stringify(JSON.parse(raw));
// Escape for embedding in a double-quoted JS string.
const escaped = json
  .replace(/\\/g, "\\\\")
  .replace(/"/g, '\\"');
const out = `/** Auto-generated from src/seed/questions.json. Do not edit by hand. */
function SEED_QUESTIONS_JSON() {
  return "${escaped}";
}
`;
writeFileSync("appscript/Questions.gs", out);
console.log("wrote Questions.gs (" + out.length + " bytes)");
