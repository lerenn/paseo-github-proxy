import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { WEBHOOK_PATH, type AppCredentialsView, type Config } from "../shared/config";
import { clock } from "./format";
import { Banner, BannerText, Button, Card, Field, Heading, Muted, Pill, Stat, Toggle, type Theme } from "./ui-kit";
import { useSubscriptions, useWebhookStatus, type useConfigData } from "./data";

type ConfigData = ReturnType<typeof useConfigData>;

/** The optional webhook listener: off by default. Settings, state, counters and the URL to give to GitHub. */
export function WebhooksCard({ theme, config, apps, data }: { theme: Theme; config: Config; apps: AppCredentialsView[]; data: ConfigData }) {
  const status = useWebhookStatus().data;
  const hooks = config.webhooks;
  const set = (patch: Partial<Config["webhooks"]>) => data.change((c) => ({ ...c, webhooks: { ...c.webhooks, ...patch } }));
  const localUrl = `http://${hooks.bind}:${hooks.port}${WEBHOOK_PATH}`;
  const c = status?.counters;
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="Webhook" title="Webhooks" hint="Optional. Lets GitHub push events to this plugin, so cached reads are fresh right after a change and agents can ask to be woken by an event (github_subscribe). Off by default: without it everything works as before, on the cache TTL." />
      <Toggle theme={theme} value={hooks.enabled} onChange={(v) => set({ enabled: v })} label="Receive GitHub webhooks" hint="Starts a small HTTP listener on the daemon machine. Every delivery must carry a valid signature from one of your GitHub Apps (set a webhook secret on each App above)." />
      {hooks.enabled ? (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Field theme={theme} label="Port" value={String(hooks.port)} onCommit={(t) => { const n = Number(t); if (Number.isInteger(n) && n >= 1 && n <= 65535) set({ port: n }); }} placeholder="8787" />
            <Field theme={theme} label="Bind address" value={hooks.bind} onCommit={(t) => { if (t.trim()) set({ bind: t.trim() }); }} placeholder="127.0.0.1" hint="127.0.0.1 keeps it on this machine, which is what you want behind a tunnel or reverse proxy on the same host." />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Pill theme={theme} label={status?.listening ? "Listening" : "Not listening"} tone={status?.listening ? "good" : "warn"} />
            <Muted theme={theme}>{status?.lastDeliveryAt ? `Last delivery ${clock(status.lastDeliveryAt)}` : "No delivery yet"}</Muted>
          </View>
          {status?.error ? <Banner theme={theme} tone="bad" icon="CircleX"><BannerText theme={theme}>{`The listener could not start: ${status.error}`}</BannerText></Banner> : null}
          {status && status.appsWithSecret === 0 ? <Banner theme={theme} tone="warn" icon="TriangleAlert"><BannerText theme={theme}>No GitHub App has a webhook secret yet, so every delivery is refused. Open an App above and generate one.</BannerText></Banner> : null}
          {apps.length === 0 ? <Muted theme={theme}>Webhooks are verified against a GitHub App's secret: add a GitHub App first.</Muted> : null}
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Payload URL to give GitHub</Text>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, fontFamily: "monospace" }}>{`https://<your public host>${WEBHOOK_PATH}`}</Text>
            <Muted theme={theme}>{`The listener itself is at ${localUrl} (health check: /healthz). GitHub can only reach a public URL: put a tunnel or reverse proxy (for example cloudflared) in front that forwards to it. The plugin does not create one. In the App's settings set the Webhook URL to that address, the secret to the one generated here, content type application/json, and subscribe to pull requests, reviews, comments, checks and workflow runs.`}</Muted>
          </View>
          {c ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <Stat theme={theme} label="Accepted" value={String(c.accepted)} tone="good" />
              <Stat theme={theme} label="Ignored" value={String(c.ignored)} hint="pings and unused events" />
              <Stat theme={theme} label="Duplicates" value={String(c.duplicate)} />
              <Stat theme={theme} label="Bad signature" value={String(c.badSignature)} tone={c.badSignature ? "warn" : "neutral"} />
              <Stat theme={theme} label="Wrong owner" value={String(c.badOwner)} tone={c.badOwner ? "warn" : "neutral"} />
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** One App's webhook secret in its editor: set or not, generate (shown once) or remove. */
export function WebhookSecretRow({ theme, app, data }: { theme: Theme; app: AppCredentialsView; data: ConfigData }) {
  const [shown, setShown] = useState("");
  const run = (action: "generate" | "clear") => data.webhookSecret.mutate({ id: app.id, action }, { onSuccess: (r) => setShown(r.secret) });
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Icon name="Webhook" size={15} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Webhook secret</Text>
        <Pill theme={theme} label={app.webhookSecretSet ? "Set" : "Not set"} tone={app.webhookSecretSet ? "good" : "neutral"} />
        <Button theme={theme} icon="Dices" label={app.webhookSecretSet ? "Generate a new one" : "Generate"} busy={data.webhookSecret.isPending} onPress={() => run("generate")} />
        {app.webhookSecretSet ? <Button theme={theme} kind="ghost" label="Remove" onPress={() => run("clear")} /> : null}
      </View>
      {shown ? (
        <Banner theme={theme} tone="info" icon="KeyRound">
          <BannerText theme={theme} strong>Copy this secret into the GitHub App's webhook settings now. It is shown once and can not be read again.</BannerText>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}>{shown}</Text>
          <Button theme={theme} kind="ghost" label="Hide" onPress={() => setShown("")} />
        </Banner>
      ) : null}
      <Muted theme={theme}>Stored on the daemon machine in a file only its user can read, never sent back to this screen. Deliveries signed with it are accepted for this App's owners only.</Muted>
    </View>
  );
}

/** The agents' event subscriptions, with unsubscribe. */
export function EventsCard({ theme }: { theme: Theme }) {
  const { subscriptions, unsubscribe } = useSubscriptions();
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="BellRing" title="Event subscriptions" hint="Agents that asked to be woken by a GitHub event (github_subscribe). They fire only while the webhook listener is on (Auth tab)." />
      {subscriptions === undefined ? <Muted theme={theme}>Loading…</Muted> : subscriptions.length === 0 ? <Muted theme={theme}>No subscriptions.</Muted> : subscriptions.map((s) => (
        <View key={s.id} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{s.repo}{s.number ? ` #${s.number}` : ""}{s.sha ? ` @${s.sha.slice(0, 7)}` : ""}</Text>
            <Pill theme={theme} label={s.persistent ? "Persistent" : "One-shot"} tone={s.persistent ? "info" : "neutral"} />
            <View style={{ flex: 1 }} />
            <Button theme={theme} kind="danger" icon="Trash2" label="Unsubscribe" onPress={() => unsubscribe.mutate(s.id)} />
          </View>
          <Muted theme={theme}>{`${s.events.join(", ")}${s.conclusions.length ? ` (${s.conclusions.join(", ")})` : ""} · ${s.agentTitle || s.agentId} · expires ${clock(s.expiresAt)}${s.fired ? ` · fired ${s.fired}x` : ""}`}</Muted>
        </View>
      ))}
    </Card>
  );
}
