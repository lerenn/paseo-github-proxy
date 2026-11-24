import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import type { Config, SourceId } from "../shared/config";
import { sourceCheckRpc } from "../shared/contracts";
import { SOURCE_OPTIONS, summarize } from "./format";
import { AppsPanel } from "./apps";
import { Banner, BannerText, Button, Card, Heading, Muted, MultiSelect, Pill, Toggle, type Theme } from "./ui-kit";
import { useOwnerChoices, type useConfigData } from "./data";

type ConfigData = ReturnType<typeof useConfigData>;

function SourceRow({ theme, option, active, onPick }: { theme: Theme; option: (typeof SOURCE_OPTIONS)[number]; active: boolean; onPick(id: SourceId): void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: active }} accessibilityLabel={`Use ${option.title}`} onPress={() => onPick(option.id)} style={{ flexDirection: "row", gap: 10, alignItems: "center", padding: 12, borderRadius: 12, borderWidth: 2, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: active ? theme.colors.accent : theme.colors.foregroundMuted, alignItems: "center", justifyContent: "center" }}>
        {active ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent }} /> : null}
      </View>
      <Icon name={option.icon} size={16} color={theme.colors.foreground} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{option.title}</Text>
        <Muted theme={theme}>{option.text}</Muted>
      </View>
      {active ? <Pill theme={theme} label="Active" tone="info" /> : null}
    </Pressable>
  );
}

function CheckResult({ theme, result }: { theme: Theme; result: { ok: boolean; detail: string; account: string } | undefined }) {
  if (!result) return null;
  return (
    <Banner theme={theme} tone={result.ok ? "good" : "bad"} icon={result.ok ? "CircleCheck" : "CircleX"}>
      <BannerText theme={theme} strong>{result.ok ? (result.account ? `Connected as ${result.account}` : "Connected") : "Not working"}</BannerText>
      <BannerText theme={theme}>{result.detail}</BannerText>
    </Banner>
  );
}

function GhPanel({ theme }: { theme: Theme }) {
  const check = useRpc(sourceCheckRpc);
  const test = useMutation({ mutationFn: () => check({ source: "gh" }) });
  return (
    <View style={{ gap: 12 }}>
      <Muted theme={theme} size={13}>Uses the token of the `gh` CLI that is logged in on the daemon machine (`gh auth login`). Nothing is stored by the plugin.</Muted>
      <View style={{ flexDirection: "row" }}>
        <Button theme={theme} icon="PlugZap" label="Check gh" busy={test.isPending} onPress={() => test.mutate()} />
      </View>
      <CheckResult theme={theme} result={test.data} />
    </View>
  );
}

function Owners({ theme, config, data, apps }: { theme: Theme; config: Config; data: ConfigData; apps: number }) {
  const found = useOwnerChoices(config.activeSource, apps);
  const set = (owners: string[]) => data.change((c) => ({ ...c, allowedOwners: owners }));
  const options = [{ value: "*", label: "All owners (*)", hint: "Every GitHub user and organization." }, ...found.owners.map((o) => ({ value: o, label: o }))];
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="ShieldCheck" title="Allowed owners" hint="A safety net on top of the policy: agents can only reach repositories of these GitHub users or organizations. The default * allows every owner; uncheck it and pick specific owners to restrict. Empty refuses everything." />
      <MultiSelect
        theme={theme}
        label="Allowed owners"
        options={options}
        selected={config.allowedOwners}
        onChange={set}
        exclusive="*"
        allowCustom
        customPlaceholder="Add another owner, then press enter"
        summary={(s) => summarize(s, { none: "None: every call is refused", exclusive: "*", all: "All owners (*)" })}
        loading={found.loading}
        note={found.error ? `Could not list owners from the active source (${found.error}). Type one to add it.` : "Owners come from the active source (every App is asked). Type to add one that is not listed."}
      />
      {config.allowedOwners.length === 0 ? <Pill theme={theme} label="None: every call is refused" tone="warn" /> : null}
    </Card>
  );
}

export function AuthTab({ theme, data }: { theme: Theme; data: ConfigData }) {
  const { config, apps } = data;
  if (!config || !apps) return <Muted theme={theme}>{data.error ? `Could not load: ${data.error.message}` : "Loading…"}</Muted>;
  const other: SourceId = config.activeSource === "gh" ? "app" : "gh";
  const pick = (id: SourceId) => data.change((c) => ({ ...c, activeSource: id }));
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 8 }}>
        <Muted theme={theme} size={13}>Pick the auth source agents use. The selected source is the active one.</Muted>
        <View accessibilityRole="radiogroup" style={{ flexDirection: "column", gap: 8 }}>
          {SOURCE_OPTIONS.map((o) => <SourceRow key={o.id} theme={theme} option={o} active={config.activeSource === o.id} onPick={pick} />)}
        </View>
      </View>
      <Card theme={theme}>
        {config.activeSource === "gh" ? <GhPanel theme={theme} /> : <AppsPanel theme={theme} apps={apps} config={config} data={data} />}
      </Card>
      <Card theme={theme}>
        <Toggle
          theme={theme}
          value={config.fallbackOnRateLimit}
          onChange={(v) => data.change((c) => ({ ...c, fallbackOnRateLimit: v }))}
          label="Fall back to the other source on rate limit"
          hint={`When ${config.activeSource === "gh" ? "the gh CLI" : "the GitHub App serving the owner"} is rate limited, calls use ${other === "gh" ? "the gh CLI" : "the GitHub App serving the owner"} instead (if it is set up) until the limit resets.`}
        />
      </Card>
      <Owners theme={theme} config={config} data={data} apps={apps.length} />
    </View>
  );
}
