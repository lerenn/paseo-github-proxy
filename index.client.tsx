import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ProxyScreen } from "./client/screen";

function ProxyItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
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
