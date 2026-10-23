import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { subscriptionsRpc } from "../shared/rpc";
import { MIN_POLL_SECONDS, proxySettings } from "../shared/subscriptions";

export const SUBSCRIPTIONS_KEY = ["github-proxy", "subscriptions"];

/** Webhook forwarder state per repository. */
export function ForwarderList({ styles }: { styles: Record<string, any> }) {
  const list = useRpc(subscriptionsRpc);
  const query = useQuery({ queryKey: SUBSCRIPTIONS_KEY, queryFn: () => list({}), refetchInterval: 15_000 });
  if (!query.data?.forwarders.length) return <Text style={styles.muted}>No webhook forwarders open.</Text>;
  return (
    <>
      {query.data.forwarders.map((f) => (
        <Text key={f.repo} style={styles.value}>
          Webhook forwarder {f.repo}: {f.state}{f.detail ? ` (${f.detail})` : ""}
        </Text>
      ))}
    </>
  );
}

/** How waiting agents are woken: webhooks and polling. */
export function WakeUpSettings({ styles }: { styles: Record<string, any> }) {
  const settings = useSettings(proxySettings);
  const [error, setError] = useState<string | null>(null);
  if (settings.status !== "ready") {
    return settings.status === "invalid" || settings.status === "error" ? <Text style={styles.error}>{settings.error}</Text> : null;
  }
  const v = settings.values;
  const save = async (patch: Partial<typeof v>) => {
    const parsed = proxySettings.schema.safeParse({ ...v, ...patch });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    setError(null);
    await settings.save(parsed.data, settings.revision);
  };
  const num = (key: "pollSeconds" | "pollSecondsWithWebhook" | "maxTimeoutMinutes") => (text: string) => {
    const n = Number(text);
    if (text.trim() && Number.isInteger(n)) void save({ [key]: n });
  };
  return (
    <View style={styles.startBox}>
      <SettingsSelect
        label="Webhook forwarders"
        hint="Lets GitHub tell the proxy about changes right away. Auto opens a forwarder for each watched repository when the token has admin rights there; it creates a temporary webhook named cli, like gh webhook forward."
        value={v.webhooks}
        options={[{ label: "Auto", value: "auto" }, { label: "Off (check GitHub on a timer only)", value: "off" }]}
        onValueChange={(webhooks) => void save({ webhooks: webhooks as "auto" | "off" })}
      />
      <SettingsInput label="Check GitHub every (seconds)" hint={`Minimum ${MIN_POLL_SECONDS}. Used while no forwarder is connected.`} initialValue={String(v.pollSeconds)} onChangeText={num("pollSeconds")} />
      <SettingsInput label="Check GitHub every, with a forwarder (seconds)" hint="A slower safety net while the forwarder is connected." initialValue={String(v.pollSecondsWithWebhook)} onChangeText={num("pollSecondsWithWebhook")} />
      <SettingsInput label="Longest wait an agent can ask for (minutes)" initialValue={String(v.maxTimeoutMinutes)} onChangeText={num("maxTimeoutMinutes")} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </View>
  );
}
