import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTIONS, ACTION_INFO, PRESET_INFO, PRESETS, type Action, type Preset } from "../shared/actions";
import { presetPolicy, type Config, type Policy, type Rule } from "../shared/config";
import { dryRunRpc } from "../shared/contracts";
import { presetOf, splitList, withAlpha } from "./format";
import type { useConfigData } from "./data";
import { Banner, BannerText, Button, Card, Field, Heading, Muted, Pill, Segmented, Toggle, toneColor, type Theme, type Tone } from "./ui-kit";

type ConfigData = ReturnType<typeof useConfigData>;
const RISK_TONE: Record<string, Tone> = { safe: "good", low: "neutral", medium: "warn", high: "bad" };

const presetAllow = Object.fromEntries(PRESETS.map((p) => [p, PRESET_INFO[p].allow])) as Record<Preset, readonly Action[]>;

export function withPolicy(config: Config, policy: Policy): Config {
  return { ...config, policy: { ...policy, preset: presetOf(policy.defaultAllow, presetAllow) as Policy["preset"] } };
}

function Presets({ theme, config, data }: { theme: Theme; config: Config; data: ConfigData }) {
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="ShieldHalf" title="Preset" hint="The default for repositories no rule covers. Read-only is the default: agents can look, not touch." />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {PRESETS.map((p) => {
          const active = config.policy.preset === p;
          return (
            <Pressable key={p} accessibilityRole="radio" accessibilityState={{ selected: active }} accessibilityLabel={PRESET_INFO[p].label} onPress={() => data.change((c) => ({ ...c, policy: presetPolicy(p, c.policy.rules) }))} style={{ flexGrow: 1, flexBasis: 220, gap: 6, padding: 14, borderRadius: 12, borderWidth: 2, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: active ? withAlpha(theme.colors.accent, 0.1) : theme.colors.surface0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon name={p === "read_only" ? "Eye" : p === "pr_workflow" ? "GitPullRequest" : "ShieldOff"} size={15} color={active ? theme.colors.accent : theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>{PRESET_INFO[p].label}</Text>
                {p === "read_only" ? <Pill theme={theme} label="Default" /> : null}
              </View>
              <Muted theme={theme}>{PRESET_INFO[p].hint}</Muted>
            </Pressable>
          );
        })}
      </View>
      {config.policy.preset === "custom" ? <Pill theme={theme} label="Custom: you changed the defaults below" tone="info" icon="SlidersHorizontal" /> : null}
    </Card>
  );
}

function Defaults({ theme, config, data }: { theme: Theme; config: Config; data: ConfigData }) {
  const toggle = (a: Action, on: boolean) =>
    data.change((c) => withPolicy(c, { ...c.policy, defaultAllow: on ? [...new Set([...c.policy.defaultAllow, a])] : c.policy.defaultAllow.filter((x) => x !== a) }));
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="ListChecks" title="Default permissions" hint="What agents may do on any repository (of an allowed owner) that no rule below covers." />
      <View style={{ gap: 12 }}>
        {ACTIONS.map((a) => (
          <View key={a} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Toggle theme={theme} value={config.policy.defaultAllow.includes(a)} onChange={(v) => toggle(a, v)} label={ACTION_INFO[a].label} hint={ACTION_INFO[a].hint} />
            </View>
            <Pill theme={theme} label={ACTION_INFO[a].risk} tone={RISK_TONE[ACTION_INFO[a].risk]!} />
          </View>
        ))}
      </View>
    </Card>
  );
}

function RuleEditor({ theme, rule, index, onChange, onDelete }: { theme: Theme; rule: Rule; index: number; onChange(next: Rule): void; onDelete(): void }) {
  const all = rule.actions.includes("*");
  const color = toneColor(theme, rule.effect === "deny" ? "bad" : "good");
  return (
    <View style={{ gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: withAlpha(color, 0.5), backgroundColor: withAlpha(color, 0.06) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>#{index + 1}</Text>
        <Segmented<"allow" | "deny"> theme={theme} value={rule.effect} onChange={(effect) => onChange({ ...rule, effect })} options={[{ value: "allow", label: "Allow", icon: "Check" }, { value: "deny", label: "Deny", icon: "Ban" }]} />
        <View style={{ flex: 1 }} />
        <Button theme={theme} kind="ghost" icon="Trash2" label="Delete" onPress={onDelete} />
      </View>
      <Field theme={theme} label="Repositories" value={rule.repos.join(", ")} onCommit={(t) => onChange({ ...rule, repos: splitList(t).length ? splitList(t) : ["*"] })} placeholder="acme/*, lerenn/paseo-*, *" hint="owner/name patterns, comma separated. * matches any run of characters inside one part." />
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Actions</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Chip theme={theme} label="All actions" active={all} onPress={() => onChange({ ...rule, actions: all ? ["read"] : ["*"] })} />
          {ACTIONS.map((a) => (
            <Chip key={a} theme={theme} label={ACTION_INFO[a].label} active={!all && rule.actions.includes(a)} disabled={all} onPress={() => onChange({ ...rule, actions: rule.actions.includes(a) ? rule.actions.filter((x) => x !== a) : [...rule.actions, a] })} />
          ))}
        </View>
      </View>
      <Field theme={theme} label="Reason (shown to the agent when it denies)" value={rule.reason} onCommit={(reason) => onChange({ ...rule, reason })} placeholder="e.g. prod is merged by humans only" />
    </View>
  );
}

function Chip({ theme, label, active, onPress, disabled }: { theme: Theme; label: string; active: boolean; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: active, disabled: !!disabled }} accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: active ? withAlpha(theme.colors.accent, 0.16) : "transparent", opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Rules({ theme, config, data }: { theme: Theme; config: Config; data: ConfigData }) {
  const setRules = (rules: Rule[]) => data.change((c) => ({ ...c, policy: { ...c.policy, rules } }));
  const add = (effect: "allow" | "deny") => setRules([...config.policy.rules, { id: `rule-${Date.now().toString(36)}`, effect, repos: ["*"], actions: effect === "deny" ? ["merge", "delete_branch", "force_push"] : ["comment"], reason: "" }]);
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="ListFilter" title="Rules per repository" hint="A deny rule always wins, then an allow rule, then the default permissions." />
      {config.policy.rules.length === 0 ? <Muted theme={theme}>No rules: the default permissions apply everywhere.</Muted> : null}
      {config.policy.rules.map((rule, i) => (
        <RuleEditor key={rule.id} theme={theme} rule={rule} index={i} onChange={(next) => setRules(config.policy.rules.map((r, j) => (j === i ? next : r)))} onDelete={() => setRules(config.policy.rules.filter((_, j) => j !== i))} />
      ))}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button theme={theme} icon="Plus" label="Add allow rule" onPress={() => add("allow")} />
        <Button theme={theme} icon="Ban" label="Add deny rule" onPress={() => add("deny")} />
      </View>
    </Card>
  );
}

function DryRun({ theme }: { theme: Theme }) {
  const run = useRpc(dryRunRpc);
  const [kind, setKind] = useState<"rest" | "graphql">("rest");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/repos/acme/web/pulls");
  const [query, setQuery] = useState("query { repository(owner: \"acme\", name: \"web\") { id } }");
  const [repo, setRepo] = useState("acme/web");
  const test = useMutation({ mutationFn: () => run({ kind, method, path, query, repo }) });
  const r = test.data;
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="FlaskConical" title="Test this call" hint="Check what the policy would say about a github_api call. Nothing is sent to GitHub." />
      <Segmented<"rest" | "graphql"> theme={theme} value={kind} onChange={setKind} options={[{ value: "rest", label: "REST" }, { value: "graphql", label: "GraphQL" }]} />
      {kind === "rest" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Field theme={theme} label="Method" value={method} onCommit={(t) => setMethod(t.toUpperCase())} width={110} mono />
          <Field theme={theme} label="Path" value={path} onCommit={setPath} mono placeholder="/repos/owner/name/pulls/1/merge" />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Field theme={theme} label="Repository" value={repo} onCommit={setRepo} placeholder="owner/name" />
          <Field theme={theme} label="Query" value={query} onCommit={setQuery} multiline mono />
        </View>
      )}
      <View style={{ flexDirection: "row" }}><Button theme={theme} kind="primary" icon="Play" label="Test" busy={test.isPending} onPress={() => test.mutate()} /></View>
      {r ? (
        <Banner theme={theme} tone={r.allowed ? "good" : "bad"} icon={r.allowed ? "CircleCheck" : "ShieldX"}>
          <BannerText theme={theme} strong>{r.allowed ? "Allowed" : "Denied"}{r.repo ? ` on ${r.repo}` : ""}</BannerText>
          <BannerText theme={theme}>Needs: {r.actions.map((a) => ACTION_INFO[a].label).join(" + ") || "nothing"}{r.rule ? ` · decided by ${r.rule}` : ""}</BannerText>
          {!r.allowed ? <BannerText theme={theme}>{r.message}</BannerText> : null}
        </Banner>
      ) : null}
    </Card>
  );
}

export function PolicyTab({ theme, data }: { theme: Theme; data: ConfigData }) {
  const { config } = data;
  if (!config) return <Muted theme={theme}>{data.error ? `Could not load: ${data.error.message}` : "Loading…"}</Muted>;
  return (
    <View style={{ gap: 16 }}>
      <Presets theme={theme} config={config} data={data} />
      <Defaults theme={theme} config={config} data={data} />
      <Rules theme={theme} config={config} data={data} />
      <DryRun theme={theme} />
      <Card theme={theme}>
        <Heading theme={theme} icon="Settings2" title="Behaviour" />
        <Toggle
          theme={theme}
          value={config.forbidRawGithub}
          onChange={(v) => data.change((c) => ({ ...c, forbidRawGithub: v }))}
          label="Forbid direct use of gh, curl and raw GitHub"
          hint="Adds an instruction to every agent's system prompt and to each github_* tool description: use these tools instead of gh or curl. A soft rule, not a sandbox. It applies to agent sessions opened after you change it."
        />
        <Field
          theme={theme}
          label="Cache TTL (seconds)"
          value={String(config.cacheTtlSeconds)}
          onCommit={(t) => {
            const n = Math.round(Number(t));
            if (Number.isFinite(n) && n >= 0 && n <= 3600) data.change((c) => ({ ...c, cacheTtlSeconds: n }));
          }}
          width={160}
          hint="Reads younger than this are served from the cache. After it, GitHub is asked whether the answer changed (an ETag check that costs no rate limit when nothing did). 0 always checks. Max 3600."
        />
      </Card>
    </View>
  );
}
