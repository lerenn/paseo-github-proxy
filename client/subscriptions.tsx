import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cancelSubscriptionRpc, subscriptionsRpc } from "../shared/rpc";
import { MIN_POLL_SECONDS, proxySettings } from "../shared/subscriptions";

const KEY = ["github-proxy", "subscriptions"];

export function SubscriptionsPanel({ styles }: { styles: Record<string, any> }) {
  const list = useRpc(subscriptionsRpc);
  const cancel = useRpc(cancelSubscriptionRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: () => list({}), refetchInterval: 15_000 });
  const active = query.data?.subscriptions.filter((s) => s.status === "active") ?? [];
  const finished = query.data?.subscriptions.filter((s) => s.status !== "active").slice(0, 10) ?? [];

  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Subscriptions</Text>
      <Text style={styles.muted}>
        Agents ask to be woken when something happens on a pull request. Webhooks give low latency; polling (never faster than {MIN_POLL_SECONDS}s) is the safety net.
      </Text>
      {query.data?.forwarders.map((f) => (
        <Text key={f.repo} style={styles.value}>
          Webhook forwarder {f.repo}: {f.state}{f.detail ? ` (${f.detail})` : ""}
        </Text>
      ))}
      {active.length === 0 ? <Text style={styles.muted}>No active subscriptions.</Text> : null}
      {active.map((s) => (
        <View key={s.id} style={styles.field}>
          <Text style={styles.value}>{s.repo}#{s.number}: {s.events.join(", ")}</Text>
          <Text style={styles.muted}>agent {s.agentId.slice(0, 8)} · times out {new Date(s.deadline).toLocaleTimeString()}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cancel subscription ${s.id}`}
            onPress={() => cancel({ id: s.id }).then(() => queryClient.invalidateQueries({ queryKey: KEY }))}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        </View>
      ))}
      {finished.map((s) => (
        <Text key={s.id} style={styles.muted}>{s.repo}#{s.number} {s.status}: {s.outcome}</Text>
      ))}
      <SubscriptionSettings styles={styles} />
    </View>
  );
}

function SubscriptionSettings({ styles }: { styles: Record<string, any> }) {
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
        label="Lockout scope"
        hint="Opt-in: only agents created with PASEO_GITHUB_PROXY=on get the proxy tools and lose their GitHub token; all others are untouched. All: every new agent, unless it sets PASEO_GITHUB_PROXY=off."
        value={v.lockoutScope}
        options={[{ label: "Opt-in (PASEO_GITHUB_PROXY=on)", value: "opt-in" }, { label: "All agents", value: "all" }]}
        onValueChange={(lockoutScope) => void save({ lockoutScope: lockoutScope as "opt-in" | "all" })}
      />
      <SettingsSelect
        label="Webhook forwarders"
        hint="Auto opens a forwarder for each watched repository when the token has admin rights there. It creates a temporary webhook named cli on the repository, like gh webhook forward."
        value={v.webhooks}
        options={[{ label: "Auto", value: "auto" }, { label: "Off (polling only)", value: "off" }]}
        onValueChange={(webhooks) => void save({ webhooks: webhooks as "auto" | "off" })}
      />
      <SettingsInput label="Poll interval, seconds" hint={`Minimum ${MIN_POLL_SECONDS}. Used while no forwarder is connected.`} initialValue={String(v.pollSeconds)} onChangeText={num("pollSeconds")} />
      <SettingsInput label="Poll interval with webhook, seconds" hint="Safety-net interval while the forwarder is connected." initialValue={String(v.pollSecondsWithWebhook)} onChangeText={num("pollSecondsWithWebhook")} />
      <SettingsInput label="Longest timeout, minutes" initialValue={String(v.maxTimeoutMinutes)} onChangeText={num("maxTimeoutMinutes")} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </View>
  );
}
