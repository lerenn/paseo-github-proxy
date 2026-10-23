import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { hostBadgeComponent } from "./client/host-badge";
import { ProxyScreen } from "./client/screen";

const HostBadge = hostBadgeComponent();

function ProxyItem({ currentScreen, openScreen, host }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      // `subtitle` is newer than the pinned plugin types, hence the spread.
      {...(HostBadge ? { subtitle: <HostBadge hostId={host.id} /> } : {})}
      icon="GitPullRequest"
      active={currentScreen?.screenId === "proxy"}
      onPress={() => openScreen({ screenId: "proxy" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "proxy", title: "GitHub Proxy", Component: ProxyScreen });
  client.addSidebarHeaderItem({ id: "proxy", title: "GitHub Proxy", Component: ProxyItem });
  return () => {};
}
