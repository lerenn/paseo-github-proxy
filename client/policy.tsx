import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { OPERATIONS, policySchema, policySettings, type Operation } from "../shared/policy";
import { auditRpc } from "../shared/rpc";

interface Draft {
  id: number;
  repo: string;
  allow: string;
  deny: string;
}

/** Operation lists are edited as comma-separated text. */
const toList = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
const toText = (ops: readonly Operation[]) => ops.join(", ");

export function PolicyPanel({ styles }: { styles: Record<string, any> }) {
  const settings = useSettings(policySettings);
  const next = useRef(0);
  const [allow, setAllow] = useState<string | null>(null);
  const [deny, setDeny] = useState("");
  const [rules, setRules] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (allow === null && settings.status === "ready") {
      setAllow(toText(settings.values.allow));
      setDeny(toText(settings.values.deny));
      setRules(settings.values.repos.map((r) => ({ id: next.current++, repo: r.repo, allow: toText(r.allow), deny: toText(r.deny) })));
    }
  }, [allow, settings]);

  async function save() {
    if (settings.status !== "ready") return;
    const parsed = policySchema.safeParse({
      allow: toList(allow ?? ""),
      deny: toList(deny),
      repos: rules.map((r) => ({ repo: r.repo, allow: toList(r.allow), deny: toList(r.deny) })),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
      return;
    }
    setError(null);
    await settings.save(parsed.data, settings.revision);
  }

  const edit = (id: number, patch: Partial<Draft>) => setRules((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Write policy</Text>
      <Text style={styles.muted}>
        What agents may write to GitHub. Anything not allowed is refused before it reaches GitHub and recorded below. A deny always
        wins. Operations: {OPERATIONS.join(", ")}.
      </Text>
      {settings.status === "invalid" || settings.status === "error" ? <Text style={styles.error}>{settings.error}</Text> : null}
      {allow !== null ? (
        <>
          <SettingsInput label="Allowed everywhere" hint="Comma-separated operations." initialValue={allow} onChangeText={setAllow} />
          <SettingsInput label="Denied everywhere" hint="Comma-separated. Beats every allow." initialValue={deny} onChangeText={setDeny} />
          {rules.map((r) => (
            <View key={r.id} style={styles.card}>
              <SettingsInput label="Repository" hint="owner/name, owner/* or *. For example anyshift-io/tf-aws." initialValue={r.repo} onChangeText={(repo) => edit(r.id, { repo })} />
              <SettingsInput label="Also allow" hint="For example pr.merge." initialValue={r.allow} onChangeText={(v) => edit(r.id, { allow: v })} />
              <SettingsInput label="Deny" hint="For example pr.merge to never auto-merge here." initialValue={r.deny} onChangeText={(v) => edit(r.id, { deny: v })} />
              <Button styles={styles} label="Remove rule" onPress={() => setRules((list) => list.filter((x) => x.id !== r.id))} />
            </View>
          ))}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {settings.status === "ready" && settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
          <View style={styles.row}>
            <Button styles={styles} label="Add repository rule" onPress={() => setRules((list) => [...list, { id: next.current++, repo: "", allow: "", deny: "" }])} />
            <Button styles={styles} primary label={settings.status === "ready" && settings.saving ? "Saving…" : "Save policy"} onPress={save} />
          </View>
        </>
      ) : null}
    </View>
  );
}

export function AuditPanel({ styles }: { styles: Record<string, any> }) {
  const audit = useRpc(auditRpc);
  const query = useQuery({ queryKey: ["github-proxy", "audit"], queryFn: () => audit({ limit: 50 }), refetchInterval: 30_000 });
  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Recent writes</Text>
      {query.data?.entries.length === 0 ? <Text style={styles.muted}>No write attempts yet.</Text> : null}
      {query.data?.entries.map((e, i) => (
        <View key={`${e.at}-${i}`} style={styles.field}>
          <Text style={styles.value}>
            {e.decision === "refused" ? "Refused" : e.status && e.status >= 400 ? `Failed (${e.status})` : "Sent"}: {e.summary}
          </Text>
          <Text style={styles.muted}>
            {new Date(e.at).toLocaleString()} · {e.repo ?? "unknown repo"} · {e.ops.join(", ")}{e.agentId ? ` · agent ${e.agentId.slice(0, 8)}` : ""}
          </Text>
          {e.detail ? <Text style={styles.muted}>{e.detail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function Button({ styles, label, onPress, primary }: { styles: Record<string, any>; label: string; onPress(): void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[styles.button, primary && styles.buttonPrimary]}>
      <Text style={primary ? styles.buttonPrimaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}
