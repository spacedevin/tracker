#!/usr/bin/env node
/**
 * Sync public catalog → markdown spreadsheet views.
 * Uses GITHUB_TOKEN when present (Actions); public APIs otherwise.
 * Never touches private repos — only items with public github: in catalog.yml.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CATALOG_PATH = join(ROOT, "config", "catalog.yml");
const UA = "spacedevin-tracker/1.0 (+https://github.com/spacedevin/tracker)";

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

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
  const data = await res.json();
  return { ok: true, status: res.status, data };
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
    // Some hosts reject HEAD
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
  if (token) headers.authorization = `Bearer ${token}`;
  const { ok, data } = await fetchJson(`https://api.github.com/repos/${repo}`, {
    headers,
    okStatuses: [200],
  });
  if (!ok || !data) return { exists: false, private: false };
  if (data.private) {
    // Should never appear in catalog; treat as absent for public table
    return { exists: false, private: true };
  }
  return { exists: true, private: false };
}

async function latestRelease(repo, includePrereleases) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const { ok, data } = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
    { headers, okStatuses: [200] },
  );
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return { tag: null, publishedAt: null };
  }
  for (const r of data) {
    if (r.draft) continue;
    if (!includePrereleases && r.prerelease) continue;
    return { tag: r.tag_name || null, publishedAt: r.published_at || null };
  }
  return { tag: null, publishedAt: null };
}

async function checkNpm(pkg) {
  if (!pkg || pkg === false) return { exists: false, version: null };
  // npm wants @scope%2Fname (keep @, encode slash)
  const path = pkg.startsWith("@") ? pkg.replace("/", "%2F") : encodeURIComponent(pkg);
  const { ok, data } = await fetchJson(`https://registry.npmjs.org/${path}`, {
    okStatuses: [200],
  });
  if (!ok || !data) return { exists: false, version: null };
  const version = data["dist-tags"]?.latest ?? null;
  return { exists: true, version };
}

async function checkCargo(name) {
  if (!name || name === false) return { exists: false, version: null };
  const { ok, data } = await fetchJson(
    `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
    { okStatuses: [200] },
  );
  if (!ok || !data?.crate) return { exists: false, version: null };
  return {
    exists: true,
    version: data.crate.newest_version || null,
  };
}

function mark(yes) {
  return yes ? "✅" : "";
}

function escCell(v) {
  if (v == null || v === "") return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function linkOrText(url, text) {
  if (!url) return escCell(text || "");
  const label = escCell(text || url);
  return `[${label}](${url})`;
}

function rowCells(item) {
  const ghUrl = item.github ? `https://github.com/${item.github}` : "";
  return [
    escCell(item.id),
    escCell(item.title),
    item.url ? linkOrText(item.url, item.url.replace(/^https?:\/\//, "")) : "",
    item.githubYes ? linkOrText(ghUrl, item.github) : "",
    mark(item.npmYes),
    mark(item.cargoYes),
    mark(item.live),
    escCell(item.description),
    escCell(item.status),
    escCell(item.family),
    escCell(item.latestRelease || ""),
    escCell(item.released || ""),
  ];
}

const HEADERS = [
  "ID",
  "Title",
  "URL",
  "Github",
  "NPM",
  "Cargo",
  "Live",
  "Description",
  "Status",
  "Family",
  "Latest release",
  "Released",
];

function tableMarkdown(items) {
  const header = `| ${HEADERS.join(" | ")} |`;
  const sep = `| ${HEADERS.map(() => "---").join(" | ")} |`;
  const rows = items.map((it) => `| ${rowCells(it).join(" | ")} |`);
  return [header, sep, ...rows].join("\n");
}

function writeViews(items) {
  const now = new Date().toISOString();
  const banner = `<!-- Generated by scripts/sync-catalog.mjs — do not edit by hand. ${now} -->\n`;

  mkdirSync(join(ROOT, "docs"), { recursive: true });

  const full = `${banner}
# Tracker

Public portfolio catalog. Source: [\`config/catalog.yml\`](config/catalog.yml). Synced hourly by GitHub Actions (\`GITHUB_TOKEN\` only; public artifacts only).

${tableMarkdown(items)}
`;
  writeFileSync(join(ROOT, "TRACKER.md"), full);

  const shipped = items.filter((i) => i.status === "shipped");
  writeFileSync(
    join(ROOT, "docs", "shipped.md"),
    `${banner}\n# Shipped\n\n${tableMarkdown(shipped)}\n`,
  );

  const wip = items.filter((i) => i.status === "wip");
  writeFileSync(
    join(ROOT, "docs", "wip.md"),
    `${banner}\n# WIP\n\n${tableMarkdown(wip)}\n`,
  );

  const families = [...new Set(items.map((i) => i.family))].sort();
  let byFamily = `${banner}\n# By family\n\n`;
  for (const f of families) {
    const group = items.filter((i) => i.family === f);
    byFamily += `## ${f}\n\n${tableMarkdown(group)}\n\n`;
  }
  writeFileSync(join(ROOT, "docs", "by-family.md"), byFamily);

  const recent = items
    .filter((i) => i.released)
    .slice()
    .sort((a, b) => String(b.released).localeCompare(String(a.released)));
  writeFileSync(
    join(ROOT, "docs", "recent-releases.md"),
    `${banner}\n# Recent releases\n\n${tableMarkdown(recent)}\n`,
  );
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
    npmVersion: null,
    cargoVersion: null,
  };

  const tasks = [];

  if (item.url) {
    tasks.push(
      checkLive(item.url).then((live) => {
        out.live = live;
      }),
    );
  }

  if (item.github) {
    tasks.push(
      (async () => {
        const gh = await checkGithub(item.github);
        out.githubYes = gh.exists;
        if (gh.exists) {
          const rel = await latestRelease(item.github, includePrereleases);
          out.latestRelease = rel.tag;
          out.released = rel.publishedAt
            ? rel.publishedAt.slice(0, 10)
            : null;
        }
      })(),
    );
  }

  if (item.npm) {
    tasks.push(
      checkNpm(item.npm).then((n) => {
        out.npmYes = n.exists;
        out.npmVersion = n.version;
      }),
    );
  }

  if (item.cargo) {
    tasks.push(
      checkCargo(item.cargo).then((c) => {
        out.cargoYes = c.exists;
        out.cargoVersion = c.version;
      }),
    );
  }

  await Promise.all(tasks);
  return out;
}

async function main() {
  const { includePrereleases, items } = loadCatalog();
  console.log(`Catalog: ${items.length} items (prereleases=${includePrereleases})`);

  const enriched = await mapPool(items, 6, (item) =>
    enrich(item, includePrereleases),
  );

  writeViews(enriched);

  const withRel = enriched.filter((i) => i.latestRelease).length;
  const live = enriched.filter((i) => i.live).length;
  console.log(
    `Wrote TRACKER.md + docs/* — live=${live}/${enriched.length} releases=${withRel}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
