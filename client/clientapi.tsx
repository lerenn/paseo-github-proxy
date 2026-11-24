import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { isLoopbackAddress, type Config } from "../shared/config";
import { clock } from "./format";
import { Banner, BannerText, Button, Card, Field, Heading, Muted, Pill, Stat, Toggle, type Theme } from "./ui-kit";
import { useClientApi, type useConfigData } from "./data";

type ConfigData = ReturnType<typeof useConfigData>;

/** The bearer token: set or not, generate (shown once) or remove. */
function TokenRow({ theme, api }: { theme: Theme; api: ReturnType<typeof useClientApi> }) {
  const [shown, setShown] = useState("");
  const run = (action: "generate" | "clear") => api.setToken.mutate(action, { onSuccess: (r) => setShown(r.token) });
  const set = api.status?.tokenSet ?? false;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Icon name="KeyRound" size={15} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Bearer token</Text>
        <Pill theme={theme} label={set ? "Set" : "Not set"} tone={set ? "good" : "neutral"} />
        <Button theme={theme} icon="Dices" label={set ? "Generate a new one" : "Generate"} busy={api.setToken.isPending} onPress={() => run("generate")} />
        {set ? <Button theme={theme} kind="ghost" label="Remove" onPress={() => run("clear")} /> : null}
      </View>
      {shown ? (
        <Banner theme={theme} tone="info" icon="KeyRound">
          <BannerText theme={theme} strong>Copy this token now. It is shown once and can not be read again; new agent sessions get it automatically.</BannerText>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}>{shown}</Text>
          <Button theme={theme} kind="ghost" label="Hide" onPress={() => setShown("")} />
        </Banner>
      ) : null}
      <Muted theme={theme}>When set, every call must send it as `Authorization: Bearer`. Without one, only this machine can call and a non-loopback bind is refused. Stored on the daemon machine in a file only its user can read. A new token applies to sessions opened afterwards; open sessions keep the old one and get 401.</Muted>
    </View>
  );
}

/** The optional client API: the `gh` shim and git credential helper endpoint. Off by default, its own port, loopback by default. */
export function ClientApiCard({ theme, config, data }: { theme: Theme; config: Config; data: ConfigData }) {
  const api = useClientApi();
  const status = api.status;
  const c = config.clientApi;
  const set = (patch: Partial<Config["clientApi"]>) => data.change((cur) => ({ ...cur, clientApi: { ...cur.clientApi, ...patch } }));
  const exposed = !isLoopbackAddress(c.bind);
  const k = status?.counters;
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="Terminal" title="Client API (gh and git)" hint="Optional. A local HTTP endpoint for the gh shim (GH_PROXY_URL) and a git credential helper, so agents can use gh and git push over HTTPS with no image change. Every call goes through the same owner allowlist, policy, cache and rate limits as the tools. Off by default." />
      <Toggle theme={theme} value={c.enabled} onChange={(v) => set({ enabled: v })} label="Serve the client API" hint="Starts a second HTTP listener on its own port. It is not the webhook listener and is never reachable through the webhook tunnel." />
      {c.enabled ? (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Field theme={theme} label="Port" value={String(c.port)} onCommit={(t) => { const n = Number(t); if (Number.isInteger(n) && n >= 1 && n <= 65535) set({ port: n }); }} placeholder="8788" />
            <Field theme={theme} label="Bind address" value={c.bind} onCommit={(t) => { if (t.trim()) set({ bind: t.trim() }); }} placeholder="127.0.0.1" hint="127.0.0.1 (default) keeps it on this machine. Use another address only when agents run elsewhere, and then set a token." />
          </View>
          {exposed ? <Banner theme={theme} tone="warn" icon="TriangleAlert"><BannerText theme={theme} strong>{`${c.bind} is not a loopback address.`}</BannerText><BannerText theme={theme}>Anyone who can reach this port and has the token can read and write GitHub through your policy. Do not put it behind the webhook tunnel or a public route; it is refused to start without a token.</BannerText></Banner> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Pill theme={theme} label={status?.listening ? "Listening" : "Not listening"} tone={status?.listening ? "good" : "warn"} />
            <Muted theme={theme}>{status?.lastRequestAt ? `Last request ${clock(status.lastRequestAt)}` : "No request yet"}</Muted>
          </View>
          {status?.error ? <Banner theme={theme} tone="bad" icon="CircleX"><BannerText theme={theme}>{`The client API could not start: ${status.error}`}</BannerText></Banner> : null}
          <TokenRow theme={theme} api={api} />
          <Toggle theme={theme} value={c.injectEnv} onChange={(v) => set({ injectEnv: v })} label="Set it up in every new agent session" hint="Adds GH_PROXY_URL, GH_PROXY_TOKEN and a git credential helper (git config through GIT_CONFIG_*) to the environment of agents. Only sessions opened after you change this (or reload the plugin) are affected." />
          {c.injectEnv && status && !status.helperFound ? <Banner theme={theme} tone="warn" icon="TriangleAlert"><BannerText theme={theme}>The git credential helper could not be written to the plugin data directory{status.helperError ? ` (${status.helperError})` : ""}, so only GH_PROXY_URL and GH_PROXY_TOKEN are set: git push will not use it.</BannerText></Banner> : null}
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>URL agents use (GH_PROXY_URL)</Text>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, fontFamily: "monospace" }}>{status?.url ?? `http://${c.bind}:${c.port}`}</Text>
            <Muted theme={theme}>The soft and hard rules (forbid gh and curl) are about raw access and are independent of this: calls here go through your policy, so they are the supported way to use gh. Git over HTTPS gets a token of the GitHub App serving the owner, read-only unless the policy allows Write file and Create branch for that repository.</Muted>
          </View>
          {k ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <Stat theme={theme} label="Requests" value={String(k.requests)} tone="good" />
              <Stat theme={theme} label="Denied by policy" value={String(k.denied)} tone={k.denied ? "warn" : "neutral"} />
              <Stat theme={theme} label="Unauthorized" value={String(k.unauthorized)} tone={k.unauthorized ? "warn" : "neutral"} />
              <Stat theme={theme} label="Git credentials" value={String(k.gitCredentials)} />
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
