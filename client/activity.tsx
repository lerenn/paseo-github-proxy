import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ActivityEntry, ActivityStatus } from "../shared/state";
import { clock } from "./format";
import { Button, Card, Heading, Muted, Pill, Segmented, type Theme, type Tone } from "./ui-kit";

const STATUS: Record<ActivityStatus, { label: string; tone: Tone; icon: string }> = {
  allowed: { label: "Allowed", tone: "good", icon: "Check" },
  cached: { label: "Cached", tone: "info", icon: "Database" },
  revalidated: { label: "Revalidated", tone: "info", icon: "RefreshCw" },
  denied: { label: "Denied", tone: "bad", icon: "ShieldX" },
  rate_limited: { label: "Rate limited", tone: "warn", icon: "Clock" },
  error: { label: "Error", tone: "bad", icon: "CircleX" },
};

type Filter = "all" | "allowed" | "cached" | "denied" | "problems";

export function matchesFilter(entry: Pick<ActivityEntry, "status">, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "allowed":
      return entry.status === "allowed";
    case "cached":
      return entry.status === "cached" || entry.status === "revalidated";
    case "denied":
      return entry.status === "denied";
    case "problems":
      return entry.status === "error" || entry.status === "rate_limited";
  }
}

function Row({ theme, entry }: { theme: Theme; entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const s = STATUS[entry.status];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${entry.tool} ${entry.repo} ${s.label}`} onPress={() => setOpen(!open)} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}>{clock(entry.at)}</Text>
        <Pill theme={theme} label={s.label} tone={s.tone} icon={s.icon} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{entry.tool}</Text>
        {entry.repo ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{entry.repo}</Text> : null}
        <View style={{ flex: 1 }} />
        {entry.httpStatus ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>HTTP {entry.httpStatus}</Text> : null}
        {entry.source ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{entry.source === "gh" ? "gh" : "app"}</Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{entry.ms} ms</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Bot" size={12} color={theme.colors.foregroundMuted} />
        <Muted theme={theme}>{entry.agentTitle || entry.agentId} · {entry.action}</Muted>
      </View>
      {entry.detail && (open || entry.status === "denied") ? <Text selectable style={{ color: entry.status === "denied" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{entry.detail}</Text> : null}
    </Pressable>
  );
}

export function ActivityTab({ theme, entries, onClear }: { theme: Theme; entries: ActivityEntry[] | undefined; onClear(): void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = (entries ?? []).filter((e) => matchesFilter(e, filter));
  return (
    <Card theme={theme}>
      <Heading theme={theme} icon="Activity" title="Live activity" hint="Every call an agent makes through the github_* tools, newest first. Tap a row for details." right={<Button theme={theme} kind="ghost" icon="Trash2" label="Clear" onPress={onClear} />} />
      <Segmented<Filter>
        theme={theme}
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "allowed", label: "Sent" },
          { value: "cached", label: "Cached" },
          { value: "denied", label: "Denied" },
          { value: "problems", label: "Problems" },
        ]}
      />
      {entries === undefined ? <Muted theme={theme}>Loading…</Muted> : shown.length === 0 ? <Muted theme={theme}>{entries.length === 0 ? "No calls yet. They appear here as agents use the github_* tools." : "Nothing matches this filter."}</Muted> : shown.map((e) => <Row key={e.id} theme={theme} entry={e} />)}
    </Card>
  );
}
