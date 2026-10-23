import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AuditPanel, PolicyPanel } from "./policy";
import type { ResourceBudget } from "../shared/budget";
import { clearTokenRpc, refreshBudgetRpc, setTokenRpc, statusRpc, type OwnerStatus } from "../shared/rpc";

const STATUS_KEY = ["github-proxy", "status"];

export function ProxyScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const status = useRpc(statusRpc);
  const refresh = useRpc(refreshBudgetRpc);
  // The status call only reads the daemon's own counters; GitHub is asked only on Refresh.
  const query = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({}), refetchInterval: 15_000 });
  const refreshMutation = useMutation({
    mutationFn: () => refresh({}),
    onSuccess: (data) => queryClient.setQueryData(STATUS_KEY, data),
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: STATUS_KEY });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={styles.title}>GitHub proxy</Text>
        <Button styles={styles} label={refreshMutation.isPending ? "Refreshing…" : "Refresh budget"} onPress={() => refreshMutation.mutate()} />
      </View>
      <Text style={styles.muted}>
        Agents never see these tokens. The daemon makes every GitHub call with them and shares one rate-limit budget per token.
      </Text>
      {query.data?.endpoint.error ? <Text style={styles.error}>{query.data.endpoint.error}</Text> : null}
      {query.error ? <Text style={styles.error}>{(query.error as Error).message}</Text> : null}
      {refreshMutation.error ? <Text style={styles.error}>{(refreshMutation.error as Error).message}</Text> : null}
      {query.data?.owners.length === 0 ? <Text style={styles.muted}>No tokens yet. Add one per GitHub owner or organization.</Text> : null}
      {query.data?.owners.map((o) => <OwnerCard key={o.owner} owner={o} styles={styles} onChanged={reload} />)}
      <AddOwner styles={styles} onChanged={reload} />
      <PolicyPanel styles={styles} />
      <AuditPanel styles={styles} />
      {query.data ? (
        <Text style={styles.muted}>
          Cache: {query.data.cache.entries} entries, {query.data.cache.hits} revalidated without cost, {query.data.cache.misses} fetched.
        </Text>
      ) : null}
    </ScrollView>
  );
}

function OwnerCard({ owner, styles, onChanged }: { owner: OwnerStatus; styles: Styles; onChanged(): void }) {
  const clear = useRpc(clearTokenRpc);
  const [error, setError] = useState<string | null>(null);
  const b = owner.budget;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.name}>{owner.owner}</Text>
        <Text style={styles.badge}>token set</Text>
      </View>
      {owner.sharesBudgetWith.length > 0 ? <Text style={styles.muted}>Same token as {owner.sharesBudgetWith.join(", ")}: one shared budget.</Text> : null}
      {b.resources.map((r) => <Text key={r.resource} style={styles.value}>{formatBudget(r)}</Text>)}
      <Text style={styles.muted}>{b.inFlight} in flight, {b.queued} queued</Text>
      {b.pausedUntil ? <Text style={styles.error}>Paused until {new Date(b.pausedUntil).toLocaleTimeString()}: {b.pauseReason}</Text> : null}
      {owner.error ? <Text style={styles.error}>{owner.error}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button
        styles={styles}
        label="Remove token"
        onPress={() => clear({ owner: owner.owner }).then(onChanged, (e) => setError((e as Error).message))}
      />
    </View>
  );
}

/** Write-only: the token field is never filled from storage. */
function AddOwner({ styles, onChanged }: { styles: Styles; onChanged(): void }) {
  const setToken = useRpc(setTokenRpc);
  const [owner, setOwner] = useState("");
  const [token, setTokenValue] = useState("");
  const [nonce, setNonce] = useState(0);
  const save = useMutation({
    mutationFn: () => setToken({ owner, token }),
    onSuccess: () => {
      setOwner("");
      setTokenValue("");
      setNonce((n) => n + 1);
      onChanged();
    },
  });
  return (
    <View key={nonce} style={styles.panel}>
      <Text style={styles.heading}>Add or replace a token</Text>
      <SettingsInput label="Owner or organization" hint="For example anyshift-io or lerenn. Replaces the existing token for that owner." initialValue="" onChangeText={setOwner} />
      <SettingsInput
        label="Token"
        hint="Checked against GitHub when saved. Stored on the daemon in a file only its user can read, and never shown again."
        initialValue=""
        secureTextEntry
        onChangeText={setTokenValue}
        placeholder="Paste token"
      />
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <Button styles={styles} primary label={save.isPending ? "Checking…" : "Save token"} onPress={() => owner && token && save.mutate()} />
    </View>
  );
}

function formatBudget(r: ResourceBudget): string {
  if (r.remaining === null || r.limit === null) return `${r.resource}: not observed yet`;
  const reset = r.resetAt ? `, resets ${new Date(r.resetAt).toLocaleTimeString()}` : "";
  return `${r.resource}: ${r.remaining} of ${r.limit} left${reset}`;
}

function Button({ styles, label, onPress, primary }: { styles: Styles; label: string; onPress(): void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[styles.button, primary && styles.buttonPrimary]}>
      <Text style={primary ? styles.buttonPrimaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: PluginScreenProps["theme"], compact: boolean) {
  const pad = compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap: 12 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8, flexWrap: "wrap" as const },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24 },
    heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    name: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    value: { color: theme.colors.foreground, fontSize: 14 },
    error: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
    badge: { color: theme.colors.foregroundMuted, fontSize: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    card: { gap: 4, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    panel: { gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, alignSelf: "flex-start" as const },
    buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    buttonText: { color: theme.colors.foreground, fontSize: 14 },
    buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: 14 },
  };
}
