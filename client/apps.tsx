import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { appName, appOwners, isOwnerName, type AppCredentialsView, type Config } from "../shared/config";
import { sourceCheckRpc } from "../shared/contracts";
import { appSummary, summarize, toggleOpen } from "./format";
import { Banner, BannerText, Button, Card, Field, Heading, Muted, MultiSelect, Pill, Toggle, type Theme } from "./ui-kit";
import { useOwnerChoices, type useConfigData } from "./data";

type ConfigData = ReturnType<typeof useConfigData>;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** One GitHub App: identity, private key (write-only), the owners it serves and whether it is the default. `app` is null for a new one. */
function AppEditor({ theme, app, apps, config, data, open, onToggle, onDone }: { theme: Theme; app: AppCredentialsView | null; apps: AppCredentialsView[]; config: Config; data: ConfigData; open: boolean; onToggle(): void; onDone(): void }) {
  const [organization, setOrganization] = useState(app?.organization ?? "");
  const [appId, setAppId] = useState(app?.appId ?? "");
  const [installationId, setInstallationId] = useState(app?.installationId ?? "");
  const [key, setKey] = useState("");
  const [owners, setOwners] = useState(app?.owners ?? []);
  const [isDefault, setDefault] = useState(app?.default ?? apps.length === 0);
  // Another App taking the default turns this one off: follow the saved state.
  useEffect(() => { if (app) setDefault(app.default); }, [app?.default]);
  const found = useOwnerChoices(config.activeSource, apps.length);
  const check = useRpc(sourceCheckRpc);
  const test = useMutation({ mutationFn: () => check({ source: "app", app: app!.id }) });

  const claimedBy = new Map(apps.filter((a) => a.id !== app?.id).flatMap((a) => appOwners(a).map((o): [string, string] => [o, appName(a)])));
  const primary = organization.trim().toLowerCase();
  const names = [...new Set([...found.owners, ...config.allowedOwners.filter((o) => o !== "*"), ...owners])].filter((o) => o !== primary).sort();
  const options = names.map((o) => ({ value: o, label: o, ...(claimedBy.has(o) ? { hint: `Already served by ${claimedBy.get(o)}` } : {}) }));
  const dirty = !app || organization.trim().toLowerCase() !== app.organization || appId.trim() !== app.appId || installationId.trim() !== app.installationId || key.trim() !== "" || isDefault !== app.default || !sameSet(owners, app.owners);
  const orgValid = organization.trim() === "" ? !!app?.label : isOwnerName(organization);
  const ready = orgValid && appId.trim() && installationId.trim() && (app?.configured || key.trim());
  const clash = [primary, ...owners].find((o) => o && claimedBy.has(o));
  const others = apps.filter((a) => a.id !== app?.id && a.default);

  return (
    <Card theme={theme} style={{ backgroundColor: theme.colors.surface0 }}>
      {app ? (
        <Pressable accessibilityRole="button" accessibilityLabel={appName(app)} accessibilityState={{ expanded: open }} onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="KeyRound" size={16} color={theme.colors.foregroundMuted} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{appName(app)}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{appSummary(app)}</Text>
          </View>
          {app.default ? <Pill theme={theme} label="Default" tone="info" /> : null}
          {!app.configured ? <Pill theme={theme} label="Incomplete" tone="warn" /> : null}
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : (
        <Heading theme={theme} icon="KeyRound" title="New GitHub App" />
      )}
      {open ? <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Field theme={theme} label="Organization or user" value={organization} onCommit={setOrganization} placeholder="acme" hint={app && !app.organization && app.label ? `Shown as "${app.label}" until you enter the account this App is installed on.` : "The GitHub account this App is installed on. It is served by this App automatically."} />
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
        placeholder={app?.configured ? `A key is stored (fingerprint ${app.keyFingerprint}). Paste a new one to replace it.` : "-----BEGIN RSA PRIVATE KEY-----"}
        hint="Write-only: it is stored on the daemon machine in a file only its user can read, and never sent back to this screen."
      />
      <MultiSelect
        theme={theme}
        label="Also serves"
        options={options}
        selected={owners}
        onChange={setOwners}
        allowCustom
        customPlaceholder="Add another owner, then press enter"
        summary={(s) => summarize(s, { none: "None" })}
        loading={found.loading}
        note="Optional: other organizations or users covered by the same installation. The organization above is always served; an owner belongs to one App only."
      />
      <Toggle theme={theme} value={isDefault} onChange={setDefault} label="Default App" hint={others.length && isDefault ? `Serves every allowed owner that no App claims, and calls that name no owner. Saving makes ${appName(others[0]!)} stop being the default.` : "Catch-all for owners no App claims, and calls that name no owner. Only one App is the default."} />
      {clash ? <Banner theme={theme} tone="warn" icon="TriangleAlert"><BannerText theme={theme}>{`"${clash}" is already served by ${claimedBy.get(clash)}: saving will be refused.`}</BannerText></Banner> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          theme={theme}
          kind="primary"
          icon="Save"
          label={app ? "Save App" : "Add App"}
          disabled={!dirty || !ready || !!clash}
          busy={data.appSave.isPending}
          onPress={() => data.appSave.mutate({ id: app?.id ?? "", organization, label: app?.label ?? "", appId, installationId, owners, default: isDefault, privateKey: key }, { onSuccess: () => { setKey(""); onDone(); } })}
        />
        {app ? <Button theme={theme} icon="PlugZap" label="Test connection" disabled={!app.configured || dirty} busy={test.isPending} onPress={() => test.mutate()} /> : null}
        {app ? <Button theme={theme} kind="danger" icon="Trash2" label="Remove" onPress={() => data.appClear.mutate(app.id)} /> : <Button theme={theme} kind="ghost" label="Cancel" onPress={onDone} />}
      </View>
      {app?.configured && dirty ? <Muted theme={theme}>Save your changes before testing.</Muted> : null}
      {test.data ? (
        <Banner theme={theme} tone={test.data.ok ? "good" : "bad"} icon={test.data.ok ? "CircleCheck" : "CircleX"}>
          <BannerText theme={theme} strong>{test.data.ok ? `Connected as ${test.data.account}` : "Not working"}</BannerText>
          <BannerText theme={theme}>{test.data.detail}</BannerText>
        </Banner>
      ) : null}
      </View> : null}
    </Card>
  );
}

/** The list of GitHub Apps with add, edit and remove. */
export function AppsPanel({ theme, apps, config, data }: { theme: Theme; apps: AppCredentialsView[]; config: Config; data: ConfigData }) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string[]>([]); // local UI state: every entry starts closed
  return (
    <View style={{ gap: 12 }}>
      <Muted theme={theme} size={13}>
        {apps.length === 0 ? "Add a GitHub App and the organization or user it is installed on. Add one App per organization or user." : "Each call uses the App that serves its owner; each App serves its organization (and any extra owners); the default App serves the owners no App claims. Every App has its own rate limit."}
      </Muted>
      {apps.map((a) => <AppEditor key={a.id} theme={theme} app={a} apps={apps} config={config} data={data} open={open.includes(a.id)} onToggle={() => setOpen((o) => toggleOpen(o, a.id))} onDone={() => setOpen((o) => o.filter((x) => x !== a.id))} />)}
      {adding || apps.length === 0 ? <AppEditor key="new" theme={theme} app={null} apps={apps} config={config} data={data} open onToggle={() => undefined} onDone={() => setAdding(false)} /> : null}
      {!adding && apps.length > 0 ? <View style={{ flexDirection: "row" }}><Button theme={theme} icon="Plus" label="Add a GitHub App" onPress={() => setAdding(true)} /></View> : null}
    </View>
  );
}
