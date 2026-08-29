#!/usr/bin/env node
/**
 * Sync public catalog → GitHub Project V2 (spacedevin/projects/3).
 * Public GitHub/npm/crates/live checks; Project writes need PROJECT_TOKEN
 * (classic PAT with `project` + `public_repo` for user-owned Projects).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CATALOG_PATH = join(ROOT, "config", "catalog.yml");
const UA = "spacedevin-tracker/1.0 (+https://github.com/spacedevin/tracker)";

const readToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const projectToken = process.env.PROJECT_TOKEN || readToken;
const projectOwner = process.env.PROJECT_OWNER || "spacedevin";
const projectNumber = Number(process.env.PROJECT_NUMBER || "3");

function loadCatalog() {
  const raw = readFileSync(CATALOG_PATH, "utf8");
  const doc = parseYaml(raw);
  if (!doc?.items?.length) throw new Error("catalog.yml has no items");
  return {
    includePrereleases: Boolean(doc.include_prereleases),
    items: doc.items,
  };
}

async function fetchJson(url, { headers = {}, okStatuses = [200] } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", ...headers },
    redirect: "follow",
  });
  if (!okStatuses.includes(res.status)) {
    return { ok: false, status: res.status, data: null };
  }
  return { ok: true, status: res.status, data: await res.json() };
}

async function graphql(query, variables = {}, token = projectToken) {
  if (!token) throw new Error("PROJECT_TOKEN is required to write the Project");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "user-agent": UA,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL: ${msg}`);
  }
  return json.data;
}

async function checkLive(url) {
  if (!url) return false;
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers: { "user-agent": UA },
      redirect: "follow",
    });
    if (head.status >= 200 && head.status < 400) return true;
    const get = await fetch(url, {
      method: "GET",
      headers: { "user-agent": UA },
      redirect: "follow",
    });
    return get.status >= 200 && get.status < 400;
  } catch {
    return false;
  }
}

async function checkGithub(repo) {
  const headers = {};
  if (readToken) headers.authorization = `Bearer ${readToken}`;
  const { ok, data } = await fetchJson(`https://api.github.com/repos/${repo}`, {
    headers,
    okStatuses: [200],
  });
  if (!ok || !data || data.private) return { exists: false };
  return { exists: true };
}

async function latestRelease(repo, includePrereleases) {
  const headers = {};
  if (readToken) headers.authorization = `Bearer ${readToken}`;
  const { ok, data } = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
    { headers, okStatuses: [200] },
  );
  if (!ok || !Array.isArray(data)) return { tag: null, publishedAt: null };
  for (const r of data) {
    if (r.draft) continue;
    if (!includePrereleases && r.prerelease) continue;
    return { tag: r.tag_name || null, publishedAt: r.published_at || null };
  }
  return { tag: null, publishedAt: null };
}

async function checkNpm(pkg) {
  if (!pkg || pkg === false) return { exists: false, version: null };
  const path = pkg.startsWith("@") ? pkg.replace("/", "%2F") : encodeURIComponent(pkg);
  const { ok, data } = await fetchJson(`https://registry.npmjs.org/${path}`, {
    okStatuses: [200],
  });
  if (!ok || !data) return { exists: false, version: null };
  return { exists: true, version: data["dist-tags"]?.latest ?? null };
}

async function checkCargo(name) {
  if (!name || name === false) return { exists: false, version: null };
  const { ok, data } = await fetchJson(
    `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
    { okStatuses: [200] },
  );
  if (!ok || !data?.crate) return { exists: false, version: null };
  return { exists: true, version: data.crate.newest_version || null };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function enrich(item, includePrereleases) {
  const out = {
    ...item,
    githubYes: false,
    npmYes: false,
    cargoYes: false,
    live: false,
    latestRelease: null,
    released: null,
  };
  const tasks = [];
  if (item.url) {
    tasks.push(checkLive(item.url).then((live) => { out.live = live; }));
  }
  if (item.github) {
    tasks.push(
      (async () => {
        const gh = await checkGithub(item.github);
        out.githubYes = gh.exists;
        if (gh.exists) {
          const rel = await latestRelease(item.github, includePrereleases);
          out.latestRelease = rel.tag;
          out.released = rel.publishedAt ? rel.publishedAt.slice(0, 10) : null;
        }
      })(),
    );
  }
  if (item.npm) {
    tasks.push(
      checkNpm(item.npm).then((n) => {
        out.npmYes = n.exists;
      }),
    );
  }
  if (item.cargo) {
    tasks.push(
      checkCargo(item.cargo).then((c) => {
        out.cargoYes = c.exists;
      }),
    );
  }
  await Promise.all(tasks);
  return out;
}

function yesNo(v) {
  return v ? "yes" : "no";
}

async function loadProject() {
  const data = await graphql(
    `query($login: String!, $number: Int!) {
      user(login: $login) {
        projectV2(number: $number) {
          id
          title
          url
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField {
                id name dataType
                options { id name color description }
              }
              ... on ProjectV2IterationField { id name dataType }
            }
          }
          items(first: 100) {
            nodes {
              id
              fieldValues(first: 30) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`,
    { login: projectOwner, number: projectNumber },
  );
  const project = data.user?.projectV2;
  if (!project) {
    throw new Error(
      `Project not found: https://github.com/users/${projectOwner}/projects/${projectNumber}`,
    );
  }
  return project;
}

async function loadAllItems(projectId) {
  const items = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(
      `query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              nodes {
                id
                fieldValues(first: 40) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { id: projectId, cursor },
    );
    const conn = data.node.items;
    items.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return items;
}

function fieldMap(fields) {
  const map = {};
  for (const f of fields) {
    if (f?.name) map[f.name] = f;
  }
  return map;
}

function itemIdFromNode(node) {
  for (const fv of node.fieldValues?.nodes || []) {
    if (fv.__typename === "ProjectV2ItemFieldTextValue" && fv.field?.name === "ID") {
      return fv.text;
    }
  }
  return null;
}

async function ensureTextField(projectId, name, existing) {
  if (existing[name]) return existing[name];
  const data = await graphql(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: TEXT
        name: $name
      }) {
        projectV2Field { ... on ProjectV2Field { id name dataType } }
      }
    }`,
    { projectId, name },
  );
  const field = data.createProjectV2Field.projectV2Field;
  existing[name] = field;
  console.log(`Created field: ${name}`);
  return field;
}

async function ensureDateField(projectId, name, existing) {
  if (existing[name]) return existing[name];
  const data = await graphql(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: DATE
        name: $name
      }) {
        projectV2Field { ... on ProjectV2Field { id name dataType } }
      }
    }`,
    { projectId, name },
  );
  const field = data.createProjectV2Field.projectV2Field;
  existing[name] = field;
  console.log(`Created field: ${name}`);
  return field;
}

async function ensureSingleSelect(projectId, name, optionNames, existing) {
  if (existing[name]?.options?.length) {
    const have = new Set(existing[name].options.map((o) => o.name));
    const missing = optionNames.filter((n) => !have.has(n));
    if (missing.length === 0) return existing[name];
    // Append missing options (e.g. the built-in Status field ships with
    // Todo/In Progress/Done and lacks shipped/wip). updateProjectV2Field
    // REPLACES the option list, so resubmit existing options too.
    const data = await graphql(
      `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: {
          fieldId: $fieldId
          singleSelectOptions: $options
        }) {
          projectV2Field {
            ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
          }
        }
      }`,
      {
        fieldId: existing[name].id,
        options: [
          ...existing[name].options.map((o) => ({
            name: o.name,
            color: o.color || "GRAY",
            description: o.description || "",
          })),
          ...missing.map((n) => ({ name: n, color: "GRAY", description: "" })),
        ],
      },
    );
    existing[name] = data.updateProjectV2Field.projectV2Field;
    console.log(`Added options to ${name}: ${missing.join(", ")}`);
    return existing[name];
  }
  if (!existing[name]) {
    const data = await graphql(
      `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        createProjectV2Field(input: {
          projectId: $projectId
          dataType: SINGLE_SELECT
          name: $name
          singleSelectOptions: $options
        }) {
          projectV2Field {
            ... on ProjectV2SingleSelectField {
              id name dataType
              options { id name color description }
            }
          }
        }
      }`,
      {
        projectId,
        name,
        options: optionNames.map((n) => ({
          name: n,
          color: "GRAY",
          description: "",
        })),
      },
    );
    const field = data.createProjectV2Field.projectV2Field;
    existing[name] = field;
    console.log(`Created field: ${name}`);
    return field;
  }
  return existing[name];
}

async function ensureSchema(projectId, fields) {
  const existing = fieldMap(fields);
  await ensureTextField(projectId, "ID", existing);
  await ensureTextField(projectId, "URL", existing);
  await ensureTextField(projectId, "Github repo", existing);
  await ensureTextField(projectId, "Description", existing);
  await ensureTextField(projectId, "Latest release", existing);
  await ensureDateField(projectId, "Released", existing);
  await ensureSingleSelect(projectId, "Github", ["yes", "no"], existing);
  await ensureSingleSelect(projectId, "NPM", ["yes", "no"], existing);
  await ensureSingleSelect(projectId, "Cargo", ["yes", "no"], existing);
  await ensureSingleSelect(projectId, "Live", ["yes", "no"], existing);
  await ensureSingleSelect(projectId, "Status", ["shipped", "wip"], existing);
  await ensureSingleSelect(
    projectId,
    "Family",
    ["tish", "tish-crates", "schlop", "hypery", "dune", "personal", "other"],
    existing,
  );
  await ensureSingleSelect(projectId, "Kind", ["company", "personal"], existing);

  // reload fields after creates
  const project = await loadProject();
  return fieldMap(project.fields.nodes);
}

async function setText(projectId, itemId, fieldId, text) {
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { text: $value }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, value: text ?? "" },
  );
}

async function setDate(projectId, itemId, fieldId, date) {
  if (!date) return;
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Date!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { date: $value }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, value: date },
  );
}

async function setSelect(projectId, itemId, field, optionName) {
  if (!field?.options) return;
  const opt = field.options.find((o) => o.name === optionName);
  if (!opt) {
    console.warn(`Missing option ${optionName} on ${field.name}`);
    return;
  }
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, optionId: opt.id },
  );
}

async function addDraftItem(projectId, title, body) {
  const data = await graphql(
    `mutation($projectId: ID!, $title: String!, $body: String!) {
      addProjectV2DraftIssue(input: {
        projectId: $projectId
        title: $title
        body: $body
      }) {
        projectItem { id }
      }
    }`,
    { projectId, title, body },
  );
  return data.addProjectV2DraftIssue.projectItem.id;
}

async function updateDraftTitle(itemId, title, body) {
  // Draft issues: update via updateProjectV2DraftIssue
  await graphql(
    `mutation($itemId: ID!, $title: String!, $body: String!) {
      updateProjectV2DraftIssue(input: {
        itemId: $itemId
        title: $title
        body: $body
      }) { draftIssue { id } }
    }`,
    { itemId, title, body: body ?? "" },
  );
}

async function applyItemFields(projectId, itemId, fields, item) {
  const body = [
    item.description || "",
    item.url ? `\n\n${item.url}` : "",
  ].join("").trim();

  try {
    await updateDraftTitle(itemId, item.title, body);
  } catch {
    // item may be linked issue — title update optional
  }

  if (fields.ID) await setText(projectId, itemId, fields.ID.id, item.id);
  if (fields.URL) await setText(projectId, itemId, fields.URL.id, item.url || "");
  if (fields["Github repo"]) {
    await setText(
      projectId,
      itemId,
      fields["Github repo"].id,
      item.github || "",
    );
  }
  if (fields.Description) {
    await setText(projectId, itemId, fields.Description.id, item.description || "");
  }
  if (fields["Latest release"]) {
    await setText(
      projectId,
      itemId,
      fields["Latest release"].id,
      item.latestRelease || "",
    );
  }
  if (fields.Released && item.released) {
    await setDate(projectId, itemId, fields.Released.id, item.released);
  }
  if (fields.Github) await setSelect(projectId, itemId, fields.Github, yesNo(item.githubYes));
  if (fields.NPM) await setSelect(projectId, itemId, fields.NPM, yesNo(item.npmYes));
  if (fields.Cargo) await setSelect(projectId, itemId, fields.Cargo, yesNo(item.cargoYes));
  if (fields.Live) await setSelect(projectId, itemId, fields.Live, yesNo(item.live));
  if (fields.Status) await setSelect(projectId, itemId, fields.Status, item.status || "shipped");
  if (fields.Family) await setSelect(projectId, itemId, fields.Family, item.family || "other");
  if (fields.Kind) await setSelect(projectId, itemId, fields.Kind, item.kind || "company");
}

async function syncToProject(enriched) {
  if (!process.env.PROJECT_TOKEN && !projectToken) {
    throw new Error("Set PROJECT_TOKEN (classic PAT: project + public_repo)");
  }

  console.log(`Project: ${projectOwner}/projects/${projectNumber}`);
  let project = await loadProject();
  console.log(`Loaded ${project.title} (${project.url})`);

  const fields = await ensureSchema(project.id, project.fields.nodes);
  const existingItems = await loadAllItems(project.id);
  const byId = new Map();
  for (const node of existingItems) {
    const id = itemIdFromNode(node);
    if (id) byId.set(id, node.id);
  }
  console.log(`Existing catalog items in Project: ${byId.size}`);

  let created = 0;
  let updated = 0;
  for (const item of enriched) {
    const body = [item.description || "", item.url ? `\n\n${item.url}` : ""]
      .join("")
      .trim();
    let itemId = byId.get(item.id);
    if (!itemId) {
      itemId = await addDraftItem(project.id, item.title, body);
      created++;
      console.log(`+ ${item.id}`);
    } else {
      updated++;
      console.log(`~ ${item.id}`);
    }
    await applyItemFields(project.id, itemId, fields, item);
  }

  console.log(`Done. created=${created} updated=${updated} total=${enriched.length}`);
  console.log(project.url);
}

async function main() {
  const { includePrereleases, items } = loadCatalog();
  console.log(`Catalog: ${items.length} items`);

  const enriched = await mapPool(items, 6, (item) =>
    enrich(item, includePrereleases),
  );

  await syncToProject(enriched);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
