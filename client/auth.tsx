import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AppCredentialsView, Config, SourceId } from "../shared/config";
import { sourceCheckRpc } from "../shared/contracts";
import { summarize } from "./format";
import { Banner, BannerText, Button, Card, Field, Heading, Muted, MultiSelect, Pill, Toggle, type Theme } from "./ui-kit";
import { useOwnerChoices, type useConfigData } from "./data";

type ConfigData = ReturnType<typeof useConfigData>;

function SourceChoice({ theme, id, title, text, icon, active, onPick, children }: { theme: Theme; id: SourceId; title: string; text: string; icon: string; active: boolean; onPick(id: SourceId): void; children: React.ReactNode }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 320, gap: 12, padding: 16, borderRadius: 14, borderWidth: 2, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <Pressable accessibilityRole="radio" accessibilityState={{ selected: active }} accessibilityLabel={`Use ${title}`} onPress={() => onPick(id)} style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: active ? theme.colors.accent : theme.colors.foregroundMuted, alignItems: "center", justifyContent: "center" }}>
          {active ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent }} /> : null}
        </View>
        <Icon name={icon} size={16} color={theme.colors.foreground} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
          <Muted theme={theme}>{text}</Muted>
        </View>
        {active ? <Pill theme={theme} label="Active" tone="info" /> : null}
      </Pressable>
      {children}
    </View>
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

function AppForm({ theme, app, data }: { theme: Theme; app: AppCredentialsView; data: ConfigData }) {
  const [appId, setAppId] = useState(app.appId);
  const [installationId, setInstallationId] = useState(app.installationId);
  const [key, setKey] = useState("");
  const check = useRpc(sourceCheckRpc);
  const test = useMutation({ mutationFn: () => check({ source: "app" }) });
  const dirty = appId.trim() !== app.appId || installationId.trim() !== app.installationId || key.trim() !== "";
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Field theme={theme} label="App ID" value={appId} onCommit={setAppId} placeholder="123456" />
        <Field theme={theme} label="Installation ID" value={installationId} onCommit={setInstallationId} placeholder="78901234" />
      </View>
      <Field
        theme={theme}
        label="Private key (PEM)"
        value={key}
        onCommit={setKey}
        multiline
        mono
        placeholder={app.configured ? `A key is stored (fingerprint ${app.keyFingerprint}). Paste a new one to replace it.` : "-----BEGIN RSA PRIVATE KEY-----"}
        hint="Write-only: it is stored on the daemon machine in a file only its user can read, and never sent back to this screen."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          theme={theme}
          kind="primary"
          icon="Save"
          label="Save credentials"
          disabled={!dirty || !appId.trim() || !installationId.trim() || (!app.configured && !key.trim())}
          busy={data.appSave.isPending}
          onPress={() => data.appSave.mutate({ appId, installationId, privateKey: key }, { onSuccess: () => setKey("") })}
        />
        <Button theme={theme} icon="PlugZap" label="Test connection" disabled={!app.configured || dirty} busy={test.isPending} onPress={() => test.mutate()} />
        {app.configured ? <Button theme={theme} kind="danger" icon="Trash2" label="Remove" onPress={() => data.appClear.mutate()} /> : null}
      </View>
      {app.configured && dirty ? <Muted theme={theme}>Save your changes before testing.</Muted> : null}
      <CheckResult theme={theme} result={test.data} />
    </View>
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

function Owners({ theme, config, data }: { theme: Theme; config: Config; data: ConfigData }) {
  const found = useOwnerChoices(config.activeSource);
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
        note={found.error ? `Could not list owners from the active source (${found.error}). Type one to add it.` : "Owners come from the active source. Type to add one that is not listed."}
      />
      {config.allowedOwners.length === 0 ? <Pill theme={theme} label="None: every call is refused" tone="warn" /> : null}
    </Card>
  );
}

export function AuthTab({ theme, data }: { theme: Theme; data: ConfigData }) {
  const { config, app } = data;
  if (!config || !app) return <Muted theme={theme}>{data.error ? `Could not load: ${data.error.message}` : "Loading…"}</Muted>;
  const other: SourceId = config.activeSource === "gh" ? "app" : "gh";
  const pick = (id: SourceId) => data.change((c) => ({ ...c, activeSource: id }));
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <SourceChoice theme={theme} id="gh" title="Local gh CLI" text="Your own GitHub login on this machine." icon="Terminal" active={config.activeSource === "gh"} onPick={pick}>
          <GhPanel theme={theme} />
        </SourceChoice>
        <SourceChoice theme={theme} id="app" title="GitHub App" text="A dedicated App installation with its own rate limit." icon="KeyRound" active={config.activeSource === "app"} onPick={pick}>
          <AppForm theme={theme} app={app} data={data} />
        </SourceChoice>
      </View>
      <Card theme={theme}>
        <Toggle
          theme={theme}
          value={config.fallbackOnRateLimit}
          onChange={(v) => data.change((c) => ({ ...c, fallbackOnRateLimit: v }))}
          label="Fall back to the other source on rate limit"
          hint={`When ${config.activeSource === "gh" ? "the gh CLI" : "the GitHub App"} is rate limited, calls use ${other === "gh" ? "the gh CLI" : "the GitHub App"} instead (if it is set up) until the limit resets.`}
        />
      </Card>
      <Owners theme={theme} config={config} data={data} />
    </View>
  );
}
