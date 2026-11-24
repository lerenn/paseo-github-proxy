import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { Overview, RateLimitView, SourceStatus } from "../shared/state";
import { clock, countdown, percent, rejectedBreakdown, visibleSources } from "./format";
import { Banner, BannerText, Bar, Button, Card, EventBars, Heading, Muted, Pill, Sparkline, Stat, useNow, type Theme, type Tone } from "./ui-kit";

const sourceLabel = (s: SourceStatus): string => (s.source === "gh" ? "gh CLI" : `GitHub App${s.key === "app:" ? "" : ` "${s.label}"`}`);
const SOURCE_ICON = { gh: "Terminal", app: "KeyRound" } as const;

function ratioTone(ratio: number): Tone {
  return ratio <= 0.1 ? "bad" : ratio <= 0.3 ? "warn" : "good";
}

function LimitRow({ theme, limit, now }: { theme: Theme; limit: RateLimitView; now: number }) {
  const ratio = limit.limit > 0 ? limit.remaining / limit.limit : 1;
  return (
    <View style={{ gap: 5 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", textTransform: "capitalize" }}>{limit.resource}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {limit.remaining.toLocaleString()} <Text style={{ color: theme.colors.foregroundMuted }}>/ {limit.limit.toLocaleString()}</Text>
        </Text>
      </View>
      <Bar theme={theme} ratio={ratio} tone={ratioTone(ratio)} />
      <Muted theme={theme}>{limit.resetAt > now ? `Resets ${countdown(limit.resetAt, now)} (${clock(limit.resetAt).slice(0, 5)})` : "Window reset"}</Muted>
    </View>
  );
}

function SourceCard({ theme, source, now }: { theme: Theme; source: SourceStatus; now: number }) {
  const blocked = source.blockedUntil !== null;
  return (
    <Card theme={theme} tone={blocked ? "bad" : undefined}>
      <Heading
        theme={theme}
        icon={SOURCE_ICON[source.source]}
        title={sourceLabel(source)}
        right={
          <View style={{ flexDirection: "row", gap: 6 }}>
            {source.active ? <Pill theme={theme} label="Active" tone="info" /> : null}
            {source.default ? <Pill theme={theme} label="Default" /> : null}
            {!source.configured ? <Pill theme={theme} label="Not configured" tone="warn" /> : null}
            {blocked ? <Pill theme={theme} label={`Limited until ${clock(source.blockedUntil!).slice(0, 5)}`} tone="bad" icon="Clock" /> : null}
          </View>
        }
      />
      {source.source === "app" && source.key !== "app:" ? <Muted theme={theme}>{source.owners.length ? `Serves ${source.owners.join(", ")}${source.default ? " and every owner no other App claims" : ""}` : source.default ? "Serves every owner no other App claims" : "Serves no owner yet"}</Muted> : null}
      {source.limits.length === 0 ? (
        <Muted theme={theme}>{source.configured ? "No request has used this source yet: its limits show after the first call." : "Set it up in Auth to use it."}</Muted>
      ) : (
        source.limits.map((l) => <LimitRow key={l.resource} theme={theme} limit={l} now={now} />)
      )}
    </Card>
  );
}

export function OverviewTab({ theme, data, onClearCache, onOpenAuth, fallback }: { theme: Theme; data: Overview | undefined; fallback: boolean; onClearCache(): void; onOpenAuth(): void }) {
  const now = useNow();
  if (!data) return <Muted theme={theme}>Loading…</Muted>;
  const exhausted = data.sources.filter((s) => s.blockedUntil !== null);
  const others = data.warnings.filter((w) => !w.startsWith("No allowed owner"));
  const { stats } = data;
  return (
    <View style={{ gap: 16 }}>
      {exhausted.map((s) => (
        <Banner key={s.key} theme={theme} tone="bad" icon="OctagonAlert">
          <BannerText theme={theme} strong>{sourceLabel(s)} is rate limited until {clock(s.blockedUntil!).slice(0, 5)} ({countdown(s.blockedUntil!, now)}).</BannerText>
          <BannerText theme={theme}>Agents get a "retry at" error and cached answers where they exist. Turn on the fallback in Auth to use the other source meanwhile; the other Apps are not affected.</BannerText>
        </Banner>
      ))}
      {others.length > 0 ? (
        <Banner theme={theme} tone="warn" icon="TriangleAlert">
          {others.map((w) => <BannerText key={w} theme={theme}>{w}</BannerText>)}
        </Banner>
      ) : null}
      {data.allowedOwnersEmpty ? (
        <Banner theme={theme} tone="warn" icon="ShieldAlert">
          <BannerText theme={theme} strong>No owner is allowed yet.</BannerText>
          <BannerText theme={theme}>Every call is refused until you list the GitHub users or organizations agents may act on.</BannerText>
          <View style={{ flexDirection: "row" }}><Button theme={theme} label="Open Auth" icon="ArrowRight" onPress={onOpenAuth} /></View>
        </Banner>
      ) : null}

      <View style={{ gap: 12 }}>
        {visibleSources(data.sources, fallback).map((s) => <SourceCard key={s.key} theme={theme} source={s} now={now} />)}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <Stat theme={theme} label="Requests" value={stats.requests.toLocaleString()} hint={`${stats.denied} denied · ${stats.errors} failed`} />
        <Stat theme={theme} label="Cache hit rate" value={percent(stats.hitRate)} hint={`${stats.cacheHits} fresh · ${stats.revalidated} revalidated (free)`} tone={stats.requests > 0 && stats.hitRate >= 0.5 ? "good" : "neutral"} />
        <Stat theme={theme} label="Sent to GitHub" value={stats.upstream.toLocaleString()} hint="Counted against the rate limit unless revalidated" />
        <Stat theme={theme} label="Cached responses" value={stats.cacheEntries.toLocaleString()} hint="In memory and on disk" />
      </View>

      <Card theme={theme}>
        <Heading
          theme={theme}
          icon="ChartColumn"
          title="Requests per minute"
          hint="Last 30 minutes. Blue: sent to GitHub. Green: answered from the cache."
          right={<Button theme={theme} kind="ghost" icon="Trash2" label="Clear cache" onPress={onClearCache} />}
        />
        <Sparkline theme={theme} series={stats.series} />
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Muted theme={theme}>30 min ago</Muted>
          <Muted theme={theme}>now</Muted>
        </View>
      </Card>
      {data.events.enabled ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            <Stat theme={theme} label="Events received" value={data.events.stats.received.toLocaleString()} hint="Webhook deliveries" />
            <Stat theme={theme} label="Delivered to subscribers" value={data.events.stats.delivered.toLocaleString()} hint="Woke at least one agent" tone={data.events.stats.delivered > 0 ? "good" : "neutral"} />
            <Stat theme={theme} label="Ignored" value={data.events.stats.ignored.toLocaleString()} hint="No subscriber, pings, unused types" />
            <Stat theme={theme} label="Rejected" value={data.events.stats.badSignature + data.events.stats.badOwner + data.events.stats.duplicate > 0 ? (data.events.stats.badSignature + data.events.stats.badOwner + data.events.stats.duplicate).toLocaleString() : "0"} hint={rejectedBreakdown(data.events.stats)} tone={data.events.stats.badSignature + data.events.stats.badOwner > 0 ? "bad" : "neutral"} />
          </View>
          <Card theme={theme}>
            <Heading theme={theme} icon="Webhook" title="Webhook events per minute" hint="Last 30 minutes. Green: delivered to a subscriber. Grey: ignored (no subscriber). Red: rejected." />
            <EventBars theme={theme} series={data.events.stats.series} />
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Muted theme={theme}>30 min ago</Muted>
              <Muted theme={theme}>now</Muted>
            </View>
          </Card>
        </>
      ) : (
        <Muted theme={theme}>Webhook events are not shown: turn on the webhook listener in the Auth tab to see them here.</Muted>
      )}
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <Icon name="Info" size={12} color={theme.colors.foregroundMuted} />
        <Muted theme={theme}>Counters since the plugin last started.</Muted>
      </View>
    </View>
  );
}
