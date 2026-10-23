import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ResourceBudget } from "../shared/budget";
import {
  activityRpc, clearTokenRpc, refreshBudgetRpc, setTokenRpc, statusRpc, subscriptionsRpc, type OwnerStatus,
} from "../shared/rpc";
import { describeSubscription, statusLine } from "../shared/summary";
import { proxySettings } from "../shared/subscriptions";
import { AuditPanel, PolicyPanel } from "./policy";
import { ForwarderList, SUBSCRIPTIONS_KEY, WakeUpSettings } from "./subscriptions";

const STATUS_KEY = ["github-proxy", "status"];
const ACTIVITY_KEY = ["github-proxy", "activity"];

export function ProxyScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const status = useRpc(statusRpc);
  const settings = useSettings(proxySettings);
  // Reading status only looks at the daemon's own counters. GitHub is asked only on Refresh.
  const query = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({}), refetchInterval: 15_000 });
  const reload = () => queryClient.invalidateQueries({ queryKey: STATUS_KEY });
  const owners = query.data?.owners ?? [];
  const scope = settings.status === "ready" ? settings.values.lockoutScope : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>GitHub proxy</Text>
      <Text style={styles.statusLine} accessibilityRole="header">
        {query.data ? statusLine({ running: Boolean(query.data.endpoint.url), owners, scope }) : "Loading…"}
      </Text>
      {query.data?.endpoint.error ? <Text style={styles.error}>{query.data.endpoint.error}</Text> : null}
      {query.error ? <Text style={styles.error}>{(query.error as Error).message}</Text> : null}

      <Tokens owners={owners} styles={styles} onChanged={reload} />
      <WhoUsesTheProxy styles={styles} />
      <Activity styles={styles} />
      <Advanced styles={styles} owners={owners} cache={query.data?.cache} endpoint={query.data?.endpoint.url ?? null} onChanged={reload} />
    </ScrollView>
  );
}

function Section({ title, hint, styles, children }: { title: string; hint?: string; styles: Styles; children: React.ReactNode }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>{title}</Text>
      {hint ? <Text style={styles.muted}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function Tokens({ owners, styles, onChanged }: { owners: OwnerStatus[]; styles: Styles; onChanged(): void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Tokens"
      styles={styles}
      hint="A GitHub token lets the proxy read and write on GitHub for your agents, so the agents never hold one. Add one per GitHub owner or organization. It is saved on this machine and never shown again."
    >
      <View style={styles.tokenList}>
        {owners.length === 0 ? <Text style={styles.muted}>No tokens yet.</Text> : null}
        {owners.length > 0 ? (
          <View style={styles.rows}>
            {owners.map((o, i) => <TokenRow key={o.owner} owner={o} first={i === 0} styles={styles} onChanged={onChanged} />)}
          </View>
        ) : null}
        {adding ? (
          <TokenForm styles={styles} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />
        ) : (
          <Button styles={styles} label="Add token" onPress={() => setAdding(true)} />
        )}
      </View>
    </Section>
  );
}

function TokenRow({ owner, first, styles, onChanged }: { owner: OwnerStatus; first: boolean; styles: Styles; onChanged(): void }) {
  const clear = useRpc(clearTokenRpc);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={[styles.tokenRow, !first && styles.tokenRowDivider]}>
      <View style={styles.tokenLine}>
        <View style={styles.tokenName}>
          <Text style={styles.name} numberOfLines={1}>{owner.owner}</Text>
          <Text style={styles.badge}>{owner.error ? "Not working" : "Set"}</Text>
        </View>
        <View style={styles.tokenActions}>
          <Button styles={styles} small label={replacing ? "Cancel" : "Replace"} onPress={() => setReplacing((v) => !v)} />
          <Button styles={styles} small label="Remove" onPress={() => clear({ owner: owner.owner }).then(onChanged, (e) => setError((e as Error).message))} />
        </View>
      </View>
      {owner.error ? <Text style={styles.error}>{owner.error}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {replacing ? (
        <TokenForm styles={styles} fixedOwner={owner.owner} onCancel={() => setReplacing(false)} onSaved={() => { setReplacing(false); onChanged(); }} />
      ) : null}
    </View>
  );
}

/**
 * Compact inline form. Write-only: the token field starts empty, is masked, and is cleared after
 * saving. Without `fixedOwner` it also asks for the owner.
 */
function TokenForm({ styles, fixedOwner, onCancel, onSaved }: { styles: Styles; fixedOwner?: string; onCancel(): void; onSaved(): void }) {
  const setToken = useRpc(setTokenRpc);
  const [owner, setOwner] = useState("");
  const [token, setTokenValue] = useState("");
  const who = (fixedOwner ?? owner).trim();
  const ready = who.length > 0 && token.trim().length > 0;
  const save = useMutation({
    mutationFn: () => setToken({ owner: who, token }),
    onSuccess: () => {
      setTokenValue("");
      onSaved();
    },
  });
  return (
    <View style={styles.tokenForm}>
      <View style={styles.tokenInputs}>
        {fixedOwner ? null : (
          <TextInput
            style={[styles.input, styles.inputOwner]}
            value={owner}
            onChangeText={setOwner}
            placeholder="Owner, e.g. lerenn"
            placeholderTextColor={styles.placeholder.color}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="GitHub owner or organization"
          />
        )}
        <TextInput
          style={[styles.input, styles.inputToken]}
          value={token}
          onChangeText={setTokenValue}
          placeholder={fixedOwner ? `New token for ${fixedOwner}` : "Paste token"}
          placeholderTextColor={styles.placeholder.color}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="GitHub token"
        />
      </View>
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.tokenActions}>
        <Button styles={styles} small primary disabled={!ready || save.isPending} label={save.isPending ? "Checking with GitHub…" : "Save"} onPress={() => ready && save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function WhoUsesTheProxy({ styles }: { styles: Styles }) {
  const settings = useSettings(proxySettings);
  if (settings.status !== "ready") {
    return (
      <Section title="Who uses the proxy" styles={styles}>
        <Text style={styles.muted}>{settings.status === "loading" ? "Loading…" : settings.error}</Text>
      </Section>
    );
  }
  const current = settings.values.lockoutScope;
  const choose = (lockoutScope: "opt-in" | "all") => void settings.save({ ...settings.values, lockoutScope }, settings.revision);
  return (
    <Section title="Who uses the proxy" styles={styles}>
      <Choice
        styles={styles}
        selected={current === "opt-in"}
        title="Only agents that ask for it (PASEO_GITHUB_PROXY=on)"
        text="These agents lose their own GitHub token and use the proxy instead. Every other agent is left exactly as it is."
        onPress={() => choose("opt-in")}
      />
      <Choice
        styles={styles}
        selected={current === "all"}
        title="All new agents"
        text="Every new agent loses its own GitHub token and uses the proxy, unless it is created with PASEO_GITHUB_PROXY=off."
        onPress={() => choose("all")}
      />
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </Section>
  );
}

function Choice({ styles, selected, title, text, onPress }: { styles: Styles; selected: boolean; title: string; text: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={title} onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]}>
      <Text style={styles.name}>{selected ? "● " : "○ "}{title}</Text>
      <Text style={styles.muted}>{text}</Text>
    </Pressable>
  );
}

function Activity({ styles }: { styles: Styles }) {
  const activity = useRpc(activityRpc);
  const subscriptions = useRpc(subscriptionsRpc);
  const calls = useQuery({ queryKey: ACTIVITY_KEY, queryFn: () => activity({ limit: 10 }), refetchInterval: 10_000 });
  const subs = useQuery({ queryKey: SUBSCRIPTIONS_KEY, queryFn: () => subscriptions({}), refetchInterval: 15_000 });
  const waiting = subs.data?.subscriptions.filter((s) => s.status === "active") ?? [];
  return (
    <Section title="Activity" styles={styles}>
      <Text style={styles.label}>Latest requests</Text>
      {calls.data?.entries.length === 0 ? <Text style={styles.muted}>Nothing yet. Agents' requests appear here.</Text> : null}
      {calls.data?.entries.map((e, i) => (
        <View key={`${e.at}-${i}`} style={styles.field}>
          <Text style={styles.value}>{e.text}</Text>
          <Text style={styles.muted}>{new Date(e.at).toLocaleTimeString()}{e.outcome === "refused" ? " · nothing was sent to GitHub" : ""}</Text>
          {e.detail ? <Text style={styles.muted}>{e.detail}</Text> : null}
        </View>
      ))}
      <Text style={styles.label}>Agents waiting for something</Text>
      {waiting.length === 0 ? <Text style={styles.muted}>No agent is waiting.</Text> : null}
      {waiting.map((s) => <Text key={s.id} style={styles.value}>{describeSubscription(s)}</Text>)}
    </Section>
  );
}

function Advanced({ styles, owners, cache, endpoint, onChanged }: { styles: Styles; owners: OwnerStatus[]; cache?: { entries: number; hits: number; misses: number }; endpoint: string | null; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const refresh = useRpc(refreshBudgetRpc);
  const refreshMutation = useMutation({
    mutationFn: () => refresh({}),
    onSuccess: (data) => queryClient.setQueryData(STATUS_KEY, data),
  });
  return (
    <View style={styles.panel}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel="Advanced" onPress={() => setOpen((v) => !v)}>
        <Text style={styles.heading}>{open ? "▾ Advanced" : "▸ Advanced"}</Text>
      </Pressable>
      {open ? (
        <View style={styles.advanced}>
          <PolicyPanel styles={styles} />
          <AuditPanel styles={styles} />

          <View style={styles.panel}>
            <View style={styles.row}>
              <Text style={styles.heading}>Request budget per token</Text>
              <Button styles={styles} label={refreshMutation.isPending ? "Refreshing…" : "Refresh from GitHub"} onPress={() => refreshMutation.mutate()} />
            </View>
            <Text style={styles.muted}>Background work and low-priority requests wait first when the budget runs low. Refreshing asks GitHub for the real numbers and does not use any budget.</Text>
            {refreshMutation.error ? <Text style={styles.error}>{(refreshMutation.error as Error).message}</Text> : null}
            {owners.map((o) => (
              <View key={o.owner} style={styles.field}>
                <Text style={styles.name}>{o.owner}</Text>
                {o.sharesBudgetWith.length ? <Text style={styles.muted}>Same token as {o.sharesBudgetWith.join(", ")}: one shared budget.</Text> : null}
                {o.budget.resources.map((r) => <Text key={r.resource} style={styles.value}>{formatBudget(r)}</Text>)}
                <Text style={styles.muted}>{o.budget.inFlight} running, {o.budget.queued} waiting</Text>
                {o.budget.pausedUntil ? <Text style={styles.error}>Paused until {new Date(o.budget.pausedUntil).toLocaleTimeString()}: {o.budget.pauseReason}</Text> : null}
              </View>
            ))}
            {cache ? <Text style={styles.muted}>Saved answers: {cache.entries}. {cache.hits} reused without using budget, {cache.misses} fetched.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.heading}>Waking agents up</Text>
            <ForwarderList styles={styles} />
            <WakeUpSettings styles={styles} />
          </View>

          <Text style={styles.muted}>
            The proxy listens on {endpoint ?? "no address (it could not start)"} on this machine only. To change the port, set GITHUB_PROXY_PORT for the daemon and recreate agents.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function formatBudget(r: ResourceBudget): string {
  const name = r.resource === "core" ? "Standard requests" : r.resource === "graphql" ? "GraphQL requests" : "Search requests";
  if (r.remaining === null || r.limit === null) return `${name}: not known yet`;
  const reset = r.resetAt ? `, refills ${new Date(r.resetAt).toLocaleTimeString()}` : "";
  return `${name}: ${r.remaining.toLocaleString("en-US")} of ${r.limit.toLocaleString("en-US")} left${reset}`;
}

function Button({ styles, label, onPress, primary, small, disabled }: { styles: Styles; label: string; onPress(): void; primary?: boolean; small?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, small && styles.buttonSmall, primary && styles.buttonPrimary, disabled && styles.buttonDisabled]}
    >
      <Text style={[primary ? styles.buttonPrimaryText : styles.buttonText, small && styles.buttonSmallText]}>{label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: PluginScreenProps["theme"], compact: boolean) {
  const pad = compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap: 14 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8, flexWrap: "wrap" as const },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24 },
    statusLine: { color: theme.colors.foreground, fontSize: compact ? 14 : 16 },
    heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    name: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    label: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    value: { color: theme.colors.foreground, fontSize: 14 },
    error: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
    badge: { color: theme.colors.foregroundMuted, fontSize: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    panel: { gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    card: { gap: 4, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    advanced: { gap: 14 },
    field: { gap: 2 },
    placeholder: { color: theme.colors.foregroundMuted },
    tokenList: { gap: 10, maxWidth: 640, alignItems: "stretch" as const },
    rows: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0 },
    tokenRow: { gap: 8, paddingVertical: 10, paddingHorizontal: 12 },
    tokenRowDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
    tokenLine: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 12 },
    tokenName: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexShrink: 1 },
    tokenActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    tokenForm: { gap: 8, paddingTop: 2 },
    tokenInputs: { flexDirection: compact ? ("column" as const) : ("row" as const), gap: 8 },
    input: { minHeight: 36, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, color: theme.colors.foreground, fontSize: 14 },
    inputOwner: { flex: 1 },
    inputToken: { flex: 2 },
    startBox: { gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border },
    choice: { gap: 2, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border },
    choiceSelected: { borderColor: theme.colors.accent },
    button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, alignSelf: "flex-start" as const },
    buttonSmall: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6 },
    buttonSmallText: { fontSize: 13 },
    buttonDisabled: { opacity: 0.5 },
    buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    buttonText: { color: theme.colors.foreground, fontSize: 14 },
    buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: 14 },
  };
}
