/**
 * The `gh` shim agents get on PATH. Plain Node, no dependencies: it forwards its arguments to the
 * proxy's local endpoint and prints the answer. `--jq` is applied here with the system `jq`.
 */
export const SHIM_VERSION = 1;

export const SHIM_SCRIPT = `#!/usr/bin/env node
// paseo github-proxy gh shim v${SHIM_VERSION}
const { spawnSync } = require("node:child_process");
const url = process.env.PASEO_GITHUB_PROXY_URL;
const capability = process.env.PASEO_GITHUB_PROXY_CAPABILITY;
if (!url || !capability) {
  process.stderr.write("gh: the Paseo GitHub proxy is not configured for this process.\\n");
  process.exit(1);
}
(async () => {
  let res;
  try {
    res = await fetch(url + "/gh", {
      method: "POST",
      headers: { authorization: "Bearer " + capability, "content-type": "application/json" },
      body: JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
    });
  } catch (err) {
    process.stderr.write("gh: cannot reach the Paseo GitHub proxy at " + url + ": " + err.message + "\\n");
    process.exit(1);
  }
  if (!res.ok) {
    process.stderr.write("gh: proxy answered HTTP " + res.status + ": " + (await res.text()) + "\\n");
    process.exit(1);
  }
  const out = await res.json();
  let stdout = out.stdout;
  let code = out.code;
  if (out.jq && code === 0) {
    const r = spawnSync("jq", ["-r", out.jq], { input: stdout, encoding: "utf8" });
    if (r.error) {
      process.stderr.write("gh: --jq needs the jq command on PATH (" + r.error.message + ")\\n");
      process.exit(1);
    }
    stdout = r.stdout;
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status) code = r.status;
  }
  process.stdout.write(stdout);
  process.stderr.write(out.stderr);
  process.exit(code);
})();
`;
