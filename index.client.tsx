import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GithubProxyScreen, GithubProxySidebarItem, SCREEN_ID } from "./client/screen";
import { githubIcon } from "./client/icons";

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({ id: SCREEN_ID, title: "GitHub Proxy", Component: GithubProxyScreen });
  const sidebar = client.addSidebarHeaderItem({ id: "github-proxy", title: "GitHub Proxy", Component: GithubProxySidebarItem });
  const command = client.addCommandCenterItem({
    id: "open-github-proxy",
    title: "Open GitHub Proxy",
    icon: { svg: githubIcon },
    keywords: ["github", "proxy", "rate limit", "policy", "gh"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  return () => {
    command();
    sidebar();
    screen();
  };
}
