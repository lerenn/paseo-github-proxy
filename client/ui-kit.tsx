import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { toggleChecked, withAlpha } from "./format";

export type Theme = PluginTheme;
export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export function toneColor(theme: Theme, tone: Tone): string {
  switch (tone) {
    case "good":
      return theme.colors.statusSuccess;
    case "warn":
      return theme.colors.statusWarning;
    case "bad":
      return theme.colors.statusDanger;
    case "info":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/** Re-renders every `ms`, to keep countdowns live. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function Card({ theme, children, style, tone }: { theme: Theme; children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone }) {
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface1,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: tone && tone !== "neutral" ? withAlpha(toneColor(theme, tone), 0.55) : theme.colors.border,
          padding: 16,
          gap: 12,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Heading({ theme, title, hint, right, icon }: { theme: Theme; title: string; hint?: string; right?: ReactNode; icon?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {icon ? <Icon name={icon} size={16} color={theme.colors.foregroundMuted} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Pill({ theme, label, tone = "neutral", icon }: { theme: Theme; label: string; tone?: Tone; icon?: string }) {
  const color = toneColor(theme, tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: withAlpha(color, 0.16) }}>
      {icon ? <Icon name={icon} size={11} color={color} /> : null}
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Button({
  theme, label, onPress, icon, kind = "secondary", disabled, busy,
}: { theme: Theme; label: string; onPress(): void; icon?: string; kind?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; busy?: boolean }) {
  const bg = kind === "primary" ? theme.colors.accent : kind === "danger" ? withAlpha(theme.colors.statusDanger, 0.14) : kind === "ghost" ? "transparent" : theme.colors.surface2;
  const fg = kind === "primary" ? theme.colors.accentForeground : kind === "danger" ? theme.colors.statusDanger : theme.colors.foreground;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9,
        backgroundColor: bg, borderWidth: kind === "ghost" ? 1 : 0, borderColor: theme.colors.border, opacity: off ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={busy ? "Loader" : icon} size={14} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{busy ? `${label}…` : label}</Text>
    </Pressable>
  );
}

export function Toggle({ theme, value, onChange, label, hint, disabled }: { theme: Theme; value: boolean; onChange(next: boolean): void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ width: 38, height: 22, borderRadius: 11, padding: 2, backgroundColor: value ? theme.colors.accent : theme.colors.surface2, borderWidth: 1, borderColor: value ? theme.colors.accent : theme.colors.border, justifyContent: "center" }}>
        <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? theme.colors.accentForeground : theme.colors.foregroundMuted, alignSelf: value ? "flex-end" : "flex-start" }} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "500" }}>{label}</Text>
        {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Segmented<T extends string>({ theme, value, options, onChange }: { theme: Theme; value: T; options: { value: T; label: string; icon?: string }[]; onChange(next: T): void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: active ? withAlpha(theme.colors.accent, 0.16) : "transparent" }}
          >
            {o.icon ? <Icon name={o.icon} size={13} color={active ? theme.colors.accent : theme.colors.foregroundMuted} /> : null}
            <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A text field that keeps its own draft and commits on blur or submit. */
export function Field({
  theme, label, value, onCommit, placeholder, hint, multiline, mono, secure, width,
}: { theme: Theme; label?: string; value: string; onCommit(next: string): void; placeholder?: string; hint?: string; multiline?: boolean; mono?: boolean; secure?: boolean; width?: DimensionValue }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <View style={{ gap: 5, ...(width !== undefined ? { width } : { flex: 1, minWidth: 140 }) }}>
      {label ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text> : null}
      <TextInput
        accessibilityLabel={label ?? placeholder}
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={multiline ? undefined : commit}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={multiline}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 9,
          paddingHorizontal: 11, paddingVertical: 9, fontSize: 13, fontFamily: mono ? "monospace" : undefined, minHeight: multiline ? 110 : undefined, textAlignVertical: multiline ? "top" : "center",
        }}
      />
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{hint}</Text> : null}
    </View>
  );
}

export function Bar({ theme, ratio, tone = "good", height = 8 }: { theme: Theme; ratio: number; tone?: Tone; height?: number }) {
  const pct = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` as DimensionValue;
  return (
    <View accessibilityRole="progressbar" style={{ height, borderRadius: height / 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: pct, height, borderRadius: height / 2, backgroundColor: toneColor(theme, tone) }} />
    </View>
  );
}

/** Stacked bars, oldest first: upstream calls (accent) under cache hits (success). */
export function Sparkline({ theme, series, height = 56 }: { theme: Theme; series: { upstream: number; cached: number }[]; height?: number }) {
  const max = Math.max(1, ...series.map((p) => p.upstream + p.cached));
  return (
    <View accessibilityLabel={`Requests per minute over the last ${series.length} minutes`} style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height }}>
      {series.map((p, i) => {
        const total = p.upstream + p.cached;
        const h = total === 0 ? 2 : Math.max(3, (total / max) * height);
        return (
          <View key={i} style={{ flex: 1, height: h, borderRadius: 2, overflow: "hidden", backgroundColor: total === 0 ? theme.colors.surface2 : theme.colors.statusSuccess, justifyContent: "flex-start" }}>
            {total > 0 ? <View style={{ height: (p.upstream / total) * h, backgroundColor: theme.colors.accent }} /> : null}
          </View>
        );
      })}
    </View>
  );
}

export function Stat({ theme, label, value, hint, tone = "neutral" }: { theme: Theme; label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 140, gap: 3, padding: 14, borderRadius: 12, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</Text>
      <Text style={{ color: tone === "neutral" ? theme.colors.foreground : toneColor(theme, tone), fontSize: 26, fontWeight: "700" }}>{value}</Text>
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export function Banner({ theme, tone, icon, children }: { theme: Theme; tone: Tone; icon: string; children: ReactNode }) {
  const color = toneColor(theme, tone);
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", padding: 12, borderRadius: 12, borderWidth: 1, borderColor: withAlpha(color, 0.5), backgroundColor: withAlpha(color, 0.12) }}>
      <Icon name={icon} size={16} color={color} />
      <View style={{ flex: 1, gap: 4 }}>{children}</View>
    </View>
  );
}

export function BannerText({ theme, children, strong }: { theme: Theme; children: ReactNode; strong?: boolean }) {
  return <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19, fontWeight: strong ? "600" : "400" }}>{children}</Text>;
}

export function Muted({ theme, children, size = 12 }: { theme: Theme; children: ReactNode; size?: number }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: size, lineHeight: size + 5 }}>{children}</Text>;
}

export interface MultiOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A dropdown whose options are checkable. The trigger shows a summary; it opens a sheet (a Modal, so it works on mobile) with a
 * checkbox per option, an optional text box to add a custom value, and closes on Done or a tap outside.
 * `exclusive` is a value that, once checked, clears every other one (such as `*`), and is cleared when another is checked.
 */
export function MultiSelect({
  theme, label, options, selected, onChange, summary, exclusive, allowCustom, customPlaceholder, emptyText, loading, note, disabled,
}: {
  theme: Theme;
  label?: string;
  options: MultiOption[];
  selected: string[];
  onChange(next: string[]): void;
  summary(selected: string[]): string;
  exclusive?: string;
  allowCustom?: boolean;
  customPlaceholder?: string;
  emptyText?: string;
  loading?: boolean;
  note?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // Values that are selected but not in the options (typed by hand, or saved earlier) stay listed so they can be unchecked.
  const known = new Set(options.map((o) => o.value));
  const all: MultiOption[] = [...options, ...selected.filter((s) => !known.has(s)).map((value) => ({ value, label: value }))];
  const toggle = (value: string) => onChange(toggleChecked(selected, value, exclusive));
  const addCustom = () => {
    const values = draft.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    setDraft("");
    if (values.length) onChange(values.reduce((acc, v) => (acc.includes(v) ? acc : toggleChecked(acc, v, exclusive)), selected));
  };
  return (
    <View style={{ gap: 5 }}>
      {label ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label ?? "Choose"}: ${summary(selected)}`}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 9, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, opacity: disabled ? 0.5 : 1 }}
      >
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }}>{summary(selected)}</Text>
        <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close" onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <Pressable onPress={() => undefined} accessible={false} style={{ width: "100%", maxWidth: 460, maxHeight: "85%", borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 14, gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{label ?? "Choose"}</Text>
              <Button theme={theme} kind="primary" label="Done" onPress={() => setOpen(false)} />
            </View>
            {note ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{note}</Text> : null}
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 2 }} keyboardShouldPersistTaps="handled">
              {loading ? <Muted theme={theme}>Loading…</Muted> : null}
              {!loading && all.length === 0 ? <Muted theme={theme}>{emptyText ?? "Nothing to choose from."}</Muted> : null}
              {all.map((o) => {
                const checked = selected.includes(o.value);
                const blocked = !!exclusive && o.value !== exclusive && selected.includes(exclusive);
                return (
                  <Pressable key={o.value} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={o.label} onPress={() => toggle(o.value)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 8, opacity: blocked ? 0.45 : 1 }}>
                    <View style={{ width: 18, height: 18, borderRadius: 5, borderWidth: 2, borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted, backgroundColor: checked ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                      {checked ? <Icon name="Check" size={12} color={theme.colors.surface1} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{o.label}</Text>
                      {o.hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{o.hint}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            {allowCustom ? (
              <TextInput
                accessibilityLabel={customPlaceholder ?? "Add a value"}
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={addCustom}
                onBlur={addCustom}
                placeholder={customPlaceholder ?? "Type a value, then press enter"}
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, fontSize: 13 }}
              />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
