import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ActivityTab } from "./activity";
import { AuthTab } from "./auth";
import { useActivityData, useConfigData, useOverviewData } from "./data";
import { githubIcon } from "./icons";
import { OverviewTab } from "./overview";
import { PolicyTab } from "./policy";

export const SCREEN_ID = "github-proxy";
const TABS = [
  { id: "overview", label: "Overview", icon: "Gauge" },
  { id: "auth", label: "Auth", icon: "KeyRound" },
  { id: "policy", label: "Policy", icon: "ShieldCheck" },
  { id: "activity", label: "Activity", icon: "Activity" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function GithubProxySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={{ svg: githubIcon }} label="GitHub Proxy" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />;
}

export function GithubProxyScreen({ theme, layout }: PluginScreenProps) {
  const [tab, setTab] = useState<TabId>("overview");
  const overview = useOverviewData();
  const activity = useActivityData();
  const config = useConfigData();
  const pad = layout.compact ? 16 : 28;
  const blocked = overview.data?.sources.some((s) => s.blockedUntil !== null) ?? false;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: pad, paddingTop: pad, gap: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: "#2F68EE", alignItems: "center", justifyContent: "center" }}>
            <Icon icon={{ svg: githubIcon }} size={26} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>GitHub Proxy</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>One policy-controlled, cached, rate-limit-aware way for every agent to reach GitHub.</Text>
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={t.label} onPress={() => setTab(t.id)} style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: active ? theme.colors.accent : "transparent" }}>
                <Icon name={t.icon} size={15} color={active ? theme.colors.accent : theme.colors.foregroundMuted} />
                <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 14, fontWeight: "600" }}>{t.label}</Text>
                {t.id === "overview" && (blocked || overview.data?.allowedOwnersEmpty) ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: blocked ? theme.colors.statusDanger : theme.colors.statusWarning }} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, paddingBottom: pad * 2, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
        {tab === "overview" ? <OverviewTab theme={theme} data={overview.data} fallback={config.config?.fallbackOnRateLimit ?? false} onClearCache={() => config.clearData.mutate("cache")} onOpenAuth={() => setTab("auth")} /> : null}
        {tab === "auth" ? <AuthTab theme={theme} data={config} /> : null}
        {tab === "policy" ? <PolicyTab theme={theme} data={config} /> : null}
        {tab === "activity" ? <ActivityTab theme={theme} entries={activity.data?.entries} onClear={() => config.clearData.mutate("activity")} /> : null}
      </ScrollView>
    </View>
  );
}

