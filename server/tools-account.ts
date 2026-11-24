import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { ProxyError } from "./proxy";
import { clip, clipText, need, page, pagination, served, type Call, type Kit } from "./toolkit";

const FIELD_NAME = "... on ProjectV2FieldCommon { id name }";
const PROJECT_FIELDS = `fields(first: 50) { nodes { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name } } ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate } } } } }`;
const PROJECT_QUERY = `query($login: String!, $number: Int!) { owner: repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) { id number title shortDescription url closed public readme ${PROJECT_FIELDS} } } } }`;
const PROJECTS_QUERY = `query($login: String!) { owner: repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: 50) { nodes { id number title shortDescription url closed } } } } }`;
const VALUE = `fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ${FIELD_NAME} } } ... on ProjectV2ItemFieldTextValue { text field { ${FIELD_NAME} } } ... on ProjectV2ItemFieldNumberValue { number field { ${FIELD_NAME} } } ... on ProjectV2ItemFieldDateValue { date field { ${FIELD_NAME} } } ... on ProjectV2ItemFieldIterationValue { title field { ${FIELD_NAME} } } } }`;
const ITEMS_QUERY = `query($login: String!, $number: Int!, $after: String) { owner: repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) { items(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id type content { ... on Issue { number title url state repository { nameWithOwner } } ... on PullRequest { number title url state repository { nameWithOwner } } ... on DraftIssue { title } } ${VALUE} } } } } } }`;

/** Account level reads (users, organizations, notifications), gists and GitHub Projects. */
export function accountTools(kit: Kit): AgentToolDefinition[] {
  const { tool, get, write, gql } = kit;

  const query = async (c: Call, q: string, variables: Record<string, unknown>, owner: string, actions: ("read" | "manage_project")[] = ["read"]) => {
    const r = await gql(c, q, variables, { actions, owner });
    const errors = (r.data as any)?.errors;
    if (errors?.length) throw new ProxyError("http", `GitHub refused: ${errors.map((e: any) => e.message).join("; ")}`);
    return (r.data as any)?.data;
  };

  return [
    tool(
      "github_account",
      "Users, organizations and notifications. operation: user (a profile), org (an organization), list_repos (repositories of owner; owner_type user or org, default org), org_members, org_teams, me (the authenticated account), my_orgs, notifications (unread by default; all=true; repo to narrow), mark_read (a thread_id, or everything, optionally for one repo). my_orgs and notifications without a repo are not tied to an owner, so they work only while the allowed owners include `*`. mark_read is checked as Manage notifications.",
      z.object({
        operation: z.enum(["user", "org", "list_repos", "org_members", "org_teams", "me", "my_orgs", "notifications", "mark_read"]),
        owner: z.string().optional().describe("user, org, list_repos, org_members, org_teams: the login."),
        owner_type: z.enum(["user", "org"]).optional().describe("list_repos."),
        repo: z.string().optional().describe("notifications/mark_read: owner/name to narrow to one repository (no default from the working directory)."),
        all: z.boolean().optional().describe("notifications: include read ones."),
        participating: z.boolean().optional().describe("notifications: only where you take part."),
        thread_id: z.string().optional().describe("mark_read: one notification thread (default: everything)."),
        ...page,
      }),
      async (i, _ctx, c) => {
        const pg = { page: i.page, per_page: i.per_page ?? 30 };
        const owner = () => need(i.owner, "owner", i.operation);
        const person = (u: any) => ({ login: u.login, name: u.name, type: u.type, company: u.company, bio: u.bio, public_repos: u.public_repos, url: u.html_url });
        switch (i.operation) {
          case "user":
            return clip(person((await get(c, `/users/${owner()}`)).data));
          case "org": {
            const d = (await get(c, `/orgs/${owner()}`)).data as any;
            return clip({ login: d.login, name: d.name, description: d.description, public_repos: d.public_repos, url: d.html_url });
          }
          case "list_repos": {
            const slim = (r: any) => ({ full_name: r.full_name, description: r.description, private: r.private, archived: r.archived, fork: r.fork, default_branch: r.default_branch, pushed_at: r.pushed_at });
            const first = i.owner_type === "user" ? "users" : "orgs";
            let r;
            try {
              r = await get(c, `/${first}/${owner()}/repos`, pg);
            } catch (error) {
              if (i.owner_type || !(error instanceof ProxyError) || error.status !== 404) throw error;
              r = await get(c, `/users/${owner()}/repos`, pg);
            }
            return clip((r.data as any[]).map(slim)) + pagination(r) + served(r);
          }
          case "org_members": {
            const r = await get(c, `/orgs/${owner()}/members`, pg);
            return clip((r.data as any[]).map((u) => u.login)) + pagination(r) + served(r);
          }
          case "org_teams": {
            const r = await get(c, `/orgs/${owner()}/teams`, pg);
            return clip((r.data as any[]).map((t) => ({ slug: t.slug, name: t.name, description: t.description, privacy: t.privacy }))) + pagination(r) + served(r);
          }
          case "me":
            return clip(person((await get(c, "/user")).data));
          case "my_orgs": {
            const r = await get(c, "/user/orgs", pg);
            return clip((r.data as any[]).map((o) => o.login)) + pagination(r) + served(r);
          }
          case "notifications": {
            const r = await get(c, i.repo ? `/repos/${i.repo}/notifications` : "/notifications", { all: i.all ? "true" : undefined, participating: i.participating ? "true" : undefined, ...pg });
            return clip((r.data as any[]).map((n) => ({ thread_id: n.id, reason: n.reason, unread: n.unread, repo: n.repository?.full_name, title: n.subject?.title, type: n.subject?.type, url: n.subject?.url, updated_at: n.updated_at }))) + pagination(r) + served(r);
          }
          default: {
            if (i.thread_id) await write(c, "PATCH", `/notifications/threads/${encodeURIComponent(i.thread_id)}`, "manage_notifications");
            else await write(c, "PUT", i.repo ? `/repos/${i.repo}/notifications` : "/notifications", "manage_notifications", {});
            return i.thread_id ? `Marked thread ${i.thread_id} as read.` : `Marked ${i.repo ? `the notifications of ${i.repo}` : "all notifications"} as read.`;
          }
        }
      },
    ),

    tool(
      "github_gists",
      "Gists. operation: list (of a user, or yours), get (files with content), create (files: filename to content; description; public default false), edit (id; description; files: filename to new content, or null to delete the file), delete. Gists belong to an account, not a repository, so they work only while the allowed owners include `*`, except list for a given user. Writes are checked as Manage gists.",
      z.object({
        operation: z.enum(["list", "get", "create", "edit", "delete"]),
        user: z.string().optional().describe("list: the owner of the gists."),
        id: z.string().optional(),
        description: z.string().optional(),
        files: z.record(z.string(), z.string().nullable()).optional(),
        public: z.boolean().optional(),
        ...page,
      }),
      async (i, _ctx, c) => {
        const gist = (g: any) => ({ id: g.id, description: g.description, public: g.public, files: Object.keys(g.files ?? {}), updated_at: g.updated_at, url: g.html_url });
        if (i.operation === "list") {
          const r = await get(c, i.user ? `/users/${i.user}/gists` : "/gists", { page: i.page, per_page: i.per_page ?? 30 });
          return clip((r.data as any[]).map(gist)) + pagination(r) + served(r);
        }
        if (i.operation === "create") {
          const files = Object.fromEntries(Object.entries(need(i.files, "files", "create")).filter(([, v]) => v !== null).map(([k, v]) => [k, { content: v }]));
          return clip(gist((await write(c, "POST", "/gists", "manage_gists", { files, description: i.description ?? "", public: i.public ?? false })).data));
        }
        const id = encodeURIComponent(need(i.id, "id", i.operation));
        if (i.operation === "get") {
          const g = (await get(c, `/gists/${id}`)).data as any;
          return clip({ ...gist(g), contents: Object.fromEntries(Object.entries(g.files ?? {}).map(([k, f]: [string, any]) => [k, clipText(String(f.content ?? ""), 10_000)])) });
        }
        if (i.operation === "delete") {
          await write(c, "DELETE", `/gists/${id}`, "manage_gists");
          return `Deleted gist ${i.id}.`;
        }
        const files = i.files ? Object.fromEntries(Object.entries(i.files).map(([k, v]) => [k, v === null ? null : { content: v }])) : undefined;
        return clip(gist((await write(c, "PATCH", `/gists/${id}`, "manage_gists", { ...(i.description !== undefined ? { description: i.description } : {}), ...(files ? { files } : {}) })).data));
      },
    ),

    tool(
      "github_project",
      "GitHub Projects (v2). Read: list (projects of owner), view (fields and their options), items (cards with field values; after = cursor). Write (checked as Manage projects): add_item (an issue or PR of repo, by issue_number), set_field (item_id, field name, value: the option name for a single select, text, a number or a YYYY-MM-DD date). The token needs the project scope.",
      z.object({
        operation: z.enum(["list", "view", "items", "add_item", "set_field"]),
        owner: z.string().describe("The user or organization that owns the project."),
        number: z.number().int().optional().describe("The project number (from list)."),
        after: z.string().optional().describe("items: the cursor of the next page."),
        repo: z.string().optional().describe("add_item: owner/name of the issue or PR."),
        issue_number: z.number().int().optional().describe("add_item."),
        item_id: z.string().optional().describe("set_field: the item id from items or add_item."),
        field: z.string().optional().describe("set_field: the field name."),
        value: z.union([z.string(), z.number()]).optional().describe("set_field."),
      }),
      async (i, _ctx, c) => {
        if (i.operation === "list") return clip((await query(c, PROJECTS_QUERY, { login: i.owner }, i.owner)).owner?.projectsV2?.nodes ?? []);
        const number = need(i.number, "number", i.operation);
        if (i.operation === "items") {
          const d = (await query(c, ITEMS_QUERY, { login: i.owner, number, after: i.after ?? null }, i.owner)).owner?.projectV2?.items;
          const nodes = (d?.nodes ?? []) as any[];
          return clip({ next: d?.pageInfo?.hasNextPage ? d.pageInfo.endCursor : null, items: nodes.map((n) => ({ id: n.id, type: n.type, ...n.content, repository: n.content?.repository?.nameWithOwner, values: Object.fromEntries((n.fieldValues?.nodes ?? []).filter((v: any) => v?.field).map((v: any) => [v.field.name, v.name ?? v.text ?? v.number ?? v.date ?? v.title])) })) });
        }
        const project = (await query(c, PROJECT_QUERY, { login: i.owner, number }, i.owner)).owner?.projectV2;
        if (!project) throw new ProxyError("invalid", `No project ${i.owner}#${number} (or the token cannot see it).`);
        if (i.operation === "view") return clip({ ...project, fields: project.fields?.nodes });
        if (i.operation === "add_item") {
          const repo = need(i.repo, "repo", "add_item");
          const content = ((await get(c, `/repos/${repo}/issues/${need(i.issue_number, "issue_number", "add_item")}`)).data as any).node_id;
          const d = await query(c, "mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }", { input: { projectId: project.id, contentId: content } }, i.owner, ["manage_project"]);
          return `Added ${repo}#${i.issue_number} to ${i.owner}#${number}: item ${d.addProjectV2ItemById?.item?.id}.`;
        }
        const itemId = need(i.item_id, "item_id", "set_field");
        const field = (project.fields?.nodes as any[]).find((f) => f.name?.toLowerCase() === need(i.field, "field", "set_field").toLowerCase());
        if (!field) throw new ProxyError("invalid", `The project has no field "${i.field}". Fields: ${(project.fields?.nodes as any[]).map((f) => f.name).join(", ")}.`);
        const raw = need(i.value, "value", "set_field");
        let value: Record<string, unknown>;
        if (field.options) {
          const option = (field.options as any[]).find((o) => o.name.toLowerCase() === String(raw).toLowerCase());
          if (!option) throw new ProxyError("invalid", `"${raw}" is not an option of ${field.name}. Options: ${(field.options as any[]).map((o) => o.name).join(", ")}.`);
          value = { singleSelectOptionId: option.id };
        } else if (field.dataType === "NUMBER") value = { number: Number(raw) };
        else if (field.dataType === "DATE") value = { date: String(raw) };
        else value = { text: String(raw) };
        await query(c, "mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }", { input: { projectId: project.id, itemId, fieldId: field.id, value } }, i.owner, ["manage_project"]);
        return `Set ${field.name} of ${itemId} to ${raw}.`;
      },
    ),
  ];
}
