// Renders the listing images with headless Chrome (no dependency):
//   listing/{overview,auth,policy,activity}.html -> assets/github-proxy-<name>.png (2000x1280)
//   assets/favicon.svg                           -> assets/icon.png (512x512)
//   assets/card.svg                              -> assets/card.png (1600x1000), after the screenshots
// The HTML files are illustrative mockups in the Paseo dark theme with demo data (acme/web, acme/api).
// Usage: node .github/scripts/render-assets.mjs   (CHROME=/path/to/chrome to override)
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const chrome = process.env.CHROME ?? "google-chrome";
const shot = (url, out, size) =>
  execFileSync(chrome, ["--headless=new", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${size}`, `--screenshot=${out}`, url], { stdio: "ignore" });

shot(`file://${root}/assets/favicon.svg`, `${root}/assets/icon.png`, "512,512"); // icon, before the card that embeds it
for (const name of ["overview", "auth", "policy", "activity"]) {
  shot(`file://${root}/listing/${name}.html`, `${root}/assets/github-proxy-${name}.png`, "2000,1280");
}
shot(`file://${root}/assets/card.svg`, `${root}/assets/card.png`, "1600,1000");
