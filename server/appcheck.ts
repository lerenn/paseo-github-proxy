import { createAppJwt, diagnose, type FetchFn } from "./auth";

export type StepStatus = "ok" | "warn" | "fail" | "skipped";
export interface CheckStep {
  id: "key" | "app" | "installation" | "token" | "api" | "owners";
  title: string;
  status: StepStatus;
  /** What was found. Never contains the key or a token. */
  detail: string;
  /** For a failure: what is most likely wrong and what to do. */
  diagnosis: string;
}
export interface InstallationChoice {
  id: string;
  login: string;
  type: string;
}
export interface AppCheckResult {
  ok: boolean;
  steps: CheckStep[];
  /** The App's real installations, offered when the installation id is wrong. */
  installations: InstallationChoice[];
}
export interface AppCheckInput {
  organization: string;
  appId: string;
  installationId: string;
  owners: string[];
  /** The key to test: the one typed in the form, else the stored one. */
  privateKey: string;
}

interface Deps {
  fetch: FetchFn;
  clock?: () => number;
  apiBase?: string;
}

const step = (id: CheckStep["id"], title: string): CheckStep => ({ id, title, status: "skipped", detail: "", diagnosis: "" });
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * Walks the App connection step by step: key, App, installation, token, a call with the token, owners. Each step
 * reports on its own; one that fails makes the dependent ones skipped. No key or token is returned.
 */
export async function testAppConnection(input: AppCheckInput, deps: Deps): Promise<AppCheckResult> {
  const clock = deps.clock ?? Date.now;
  const base = deps.apiBase ?? "https://api.github.com";
  const steps = [step("key", "Private key signs a JWT"), step("app", "GitHub knows the App"), step("installation", "The installation exists"), step("token", "An installation token is issued"), step("api", "The token works"), step("owners", "Owners match the installation")];
  const [key, app, inst, token, api, owners] = steps as [CheckStep, CheckStep, CheckStep, CheckStep, CheckStep, CheckStep];
  const installations: InstallationChoice[] = [];
  const result = () => ({ ok: steps.every((s) => s.status === "ok" || s.status === "warn"), steps, installations });
  const fail = (s: CheckStep, detail: string, diagnosis: string) => {
    s.status = "fail";
    s.detail = detail;
    s.diagnosis = diagnosis;
  };
  const call = async (method: string, path: string, bearer: string) => {
    const res = await deps.fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, Accept: "application/vnd.github+json", "User-Agent": "paseo-github-proxy" } });
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: obj(body) };
  };
  const network = (error: unknown) => `Could not reach GitHub: ${(error as Error).message}`;

  if (!input.appId.trim() || !input.installationId.trim() || !input.privateKey.trim()) {
    fail(key, "The App ID, installation id or private key is empty.", "Fill the three fields (the key may be the stored one) and test again.");
    return result();
  }
  let jwt: string;
  try {
    jwt = createAppJwt(input.appId.trim(), input.privateKey, clock());
    key.status = "ok";
    key.detail = "The key is a valid PEM RSA key and a JWT was signed.";
  } catch {
    fail(key, "The private key could not be used to sign.", "Paste the whole .pem file GitHub gave you, including the BEGIN and END lines. It must be an RSA key.");
    return result();
  }

  try {
    const r = await call("GET", "/app", jwt);
    if (r.status === 200) {
      const slug = str(r.body.slug);
      const perms = Object.keys(obj(r.body.permissions)).length;
      app.status = "ok";
      app.detail = `App ID ${input.appId.trim()} is "${str(r.body.name) || slug}"${slug ? ` (${slug})` : ""}, ${perms} permission${perms === 1 ? "" : "s"} granted.`;
    } else fail(app, `GET /app answered HTTP ${r.status}.`, diagnose(r.status, "app"));
  } catch (error) {
    fail(app, network(error), "Check the network of the daemon machine.");
  }
  if (app.status !== "ok") return result();

  let account = "";
  try {
    const r = await call("GET", `/app/installations/${encodeURIComponent(input.installationId.trim())}`, jwt);
    if (r.status === 200) {
      const a = obj(r.body.account);
      account = str(a.login);
      const perms = Object.entries(obj(r.body.permissions)).map(([k, v]) => `${k}:${String(v)}`);
      const suspended = !!r.body.suspended_at;
      inst.status = suspended ? "fail" : "ok";
      inst.detail = `Installation ${input.installationId.trim()} is on ${str(a.type).toLowerCase() || "account"} ${account || "?"}, repositories: ${str(r.body.repository_selection) || "?"}. Permissions: ${perms.join(", ") || "none"}.`;
      if (suspended) inst.diagnosis = "The installation is suspended. Unsuspend it in the account's installation settings on GitHub.";
    } else {
      fail(inst, `GET /app/installations/${input.installationId.trim()} answered HTTP ${r.status}.`, diagnose(r.status, "installation"));
    }
  } catch (error) {
    fail(inst, network(error), "Check the network of the daemon machine.");
  }
  if (inst.status === "fail") {
    if (inst.detail.includes("HTTP 404")) await listInstallations(deps, base, jwt, installations);
    return result();
  }
  return finish();

  async function finish(): Promise<AppCheckResult> {
    let installToken = "";
    try {
      const r = await call("POST", `/app/installations/${encodeURIComponent(input.installationId.trim())}/access_tokens`, jwt);
      if (r.status === 201 && str(r.body.token)) {
        installToken = str(r.body.token);
        token.status = "ok";
        token.detail = `A token was issued${str(r.body.expires_at) ? `, it expires ${str(r.body.expires_at)}` : ""}.`;
      } else fail(token, `POST access_tokens answered HTTP ${r.status}.`, diagnose(r.status, "token"));
    } catch (error) {
      fail(token, network(error), "Check the network of the daemon machine.");
    }
    if (token.status !== "ok") return result();

    try {
      const r = await call("GET", "/rate_limit", installToken);
      const core = obj(obj(r.body.resources).core);
      if (r.status === 200) {
        api.status = "ok";
        api.detail = `The token is accepted. Rate limit: ${String(core.remaining ?? "?")} of ${String(core.limit ?? "?")} requests left in this window.`;
      } else fail(api, `GET /rate_limit answered HTTP ${r.status}.`, diagnose(r.status, "token"));
    } catch (error) {
      fail(api, network(error), "Check the network of the daemon machine.");
    }

    const org = input.organization.trim().toLowerCase();
    const extra = input.owners.map((o) => o.trim().toLowerCase()).filter((o) => o && o !== account.toLowerCase());
    const problems: string[] = [];
    if (account && org && org !== account.toLowerCase()) problems.push(`The Organization or user field says "${org}" but the installation is on "${account}".`);
    if (account && extra.length) problems.push(`Also serves ${extra.join(", ")}: an installation reaches the repositories of its own account only (${account}), so calls for these owners will fail with this installation.`);
    if (problems.length) {
      owners.status = "warn";
      owners.detail = problems.join(" ");
      owners.diagnosis = "Set the Organization or user field to the account the installation is on, or use the right installation id.";
    } else {
      owners.status = "ok";
      owners.detail = account ? `The installation is on ${account}${org ? ", which matches the Organization or user field" : ""}.` : "No account to compare.";
    }
    return result();
  }
}

async function listInstallations(deps: Deps, base: string, jwt: string, into: InstallationChoice[]): Promise<void> {
  try {
    const res = await deps.fetch(`${base}/app/installations?per_page=100`, { method: "GET", headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "paseo-github-proxy" } });
    if (res.status !== 200) return;
    const list = JSON.parse(await res.text()) as unknown;
    for (const item of Array.isArray(list) ? list : []) {
      const i = obj(item);
      const a = obj(i.account);
      if (typeof i.id === "number" && str(a.login)) into.push({ id: String(i.id), login: str(a.login), type: str(a.type) });
    }
  } catch {
    /* the list is a convenience */
  }
}
