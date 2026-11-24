// Fails when client code uses web-only APIs: the plugin must run on desktop and mobile (React Native primitives only).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const BAD = /(document|window|navigator)\.|localStorage|className=|onClick=|<(div|span|button|p|a|img|input|ul|li|h[1-6])[ >/]/;
const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => BAD.test(line) && hits.push(`${file}:${i + 1}: ${line.trim()}`));
    }
  }
};
walk("client");
if (hits.length) {
  console.error(hits.join("\n"));
  console.error("\nclient/ must use React Native primitives only (see the plugin docs: Works on mobile)");
  process.exit(1);
}
console.log("mobile audit ok");
