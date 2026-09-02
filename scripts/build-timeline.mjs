#!/usr/bin/env node
/**
 * Build data/timeline.json from config/catalog.yml + GitHub (releases, repo dates)
 * + optional legacy sources (space.la works/posts). Reads GITHUB_TOKEN / GH_TOKEN.
 *   node scripts/build-timeline.mjs [--legacy ../space-la/content] [--out data/timeline.json]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = join(ROOT, flag("--out", "data/timeline.json"));
const LEGACY = flag("--legacy", existsSync(join(ROOT, "../space-la/content")) ? join(ROOT, "../space-la/content") : null);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const UA = "spacedevin-tracker/1.0 (+https://github.com/spacedevin/tracker)";
const PRERELEASE_TAG = /-(alpha|beta|rc|next|canary|dev|pre|nightly)\.?\d*$/i;

const doc = parseYaml(readFileSync(join(ROOT, "config/catalog.yml"), "utf8"));
const includePrereleases = Boolean(doc.include_prereleases);
const items = doc.items;

async function graphql(query, variables = {}) {
  if (!token) throw new Error("GITHUB_TOKEN is required (GraphQL)");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "user-agent": UA, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    const fatal = json.errors.filter((e) => e.type !== "NOT_FOUND");
    if (fatal.length) throw new Error("GraphQL: " + fatal.map((e) => e.message).join("; "));
  }
  return json.data ?? {};
}

const semver = (tag) => {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(tag || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmpVer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const day = (iso) => (iso ? iso.slice(0, 10) : null);
const firstLine = (s) => {
  const lines = (s || "").replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const clean = (l) => l.replace(/^#+\s*/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "").replace(/^[-*]\s+/, "").trim();
  // skip lines that are just the version/tag or a bare date
  const pick = lines.map(clean).find((l) => l && !/^v?\d+\.\d+\.\d+$/.test(l) && !/^(changes|changelog|release notes?|bug fixes|features|breaking changes|miscellaneous chores|prerelease cut.*)$/i.test(l)) || "";
  return pick.slice(0, 160);
};

async function fetchRepos(repos) {
  const out = {};
  for (let i = 0; i < repos.length; i += 8) {
    const batch = repos.slice(i, i + 8);
    const q = batch.map((r, j) => {
      const [owner, name] = r.split("/");
      return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        nameWithOwner createdAt pushedAt isArchived isPrivate stargazerCount description homepageUrl
        primaryLanguage { name }
        releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor }
          nodes { tagName name isPrerelease isDraft publishedAt url description } }
      }`;
    }).join("\n");
    const data = await graphql(`{ ${q} }`);
    for (let j = 0; j < batch.length; j++) {
      const repo = data[`r${j}`];
      if (!repo || repo.isPrivate) { out[batch[j]] = null; continue; }
      let nodes = repo.releases.nodes;
      let page = repo.releases.pageInfo;
      while (page.hasNextPage) {
        const [owner, name] = batch[j].split("/");
        const more = await graphql(`query($o:String!,$n:String!,$c:String!){ repository(owner:$o,name:$n){ releases(first:100, after:$c, orderBy:{field:CREATED_AT,direction:DESC}){ pageInfo{hasNextPage endCursor} nodes{ tagName name isPrerelease isDraft publishedAt url description } } } }`, { o: owner, n: name, c: page.endCursor });
        nodes = nodes.concat(more.repository.releases.nodes);
        page = more.repository.releases.pageInfo;
      }
      out[batch[j]] = { ...repo, releases: nodes };
    }
    process.stderr.write(`  fetched ${Math.min(i + 8, repos.length)}/${repos.length} repos\n`);
  }
  return out;
}

function releaseEvents(repo, projectId, meta) {
  const kept = meta.releases
    .filter((r) => !r.isDraft && r.publishedAt)
    .filter((r) => includePrereleases || (!r.isPrerelease && !PRERELEASE_TAG.test(r.tagName)))
    .map((r) => ({ ...r, ver: semver(r.tagName), day: day(r.publishedAt) }))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  // collapse same-day bursts: keep the highest version, count the rest
  const byDay = new Map();
  for (const r of kept) {
    const cur = byDay.get(r.day);
    if (!cur) byDay.set(r.day, { ...r, count: 1, all: [r.tagName] });
    else { cur.count++; cur.all.push(r.tagName); if (r.ver && cur.ver && cmpVer(r.ver, cur.ver) > 0) Object.assign(cur, { tagName: r.tagName, name: r.name, url: r.url, description: r.description, ver: r.ver, publishedAt: r.publishedAt }); }
  }
  const events = [];
  let prev = null;
  let first = true;
  for (const r of [...byDay.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    let major = false;
    if (r.ver && prev) major = r.ver[0] > prev[0] || (r.ver[0] === 0 && prev[0] === 0 && r.ver[1] > prev[1]);
    if (!r.ver) major = false;
    events.push({
      projectId, repo, type: first ? "first-release" : "release", tag: r.tagName, name: r.name && r.name !== r.tagName ? r.name : null,
      date: r.day, prerelease: Boolean(r.isPrerelease), major: major || first, count: r.count, tags: r.count > 1 ? r.all : undefined,
      summary: firstLine(r.description) || null, url: r.url,
    });
    if (r.ver) prev = r.ver;
    first = false;
  }
  return events;
}

function legacyEvents() {
  const events = [];
  const legacyProjects = [];
  if (!LEGACY) return { events, legacyProjects };
  const fm = (src) => {
    const m = /^---\n([\s\S]*?)\n---/.exec(src);
    const d = {};
    if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) { let v = line.slice(i + 1).trim(); try { v = JSON.parse(v); } catch {} d[line.slice(0, i).trim()] = v; } }
    return d;
  };
  const worksDir = join(LEGACY, "works");
  if (existsSync(worksDir)) {
    for (const f of readdirSync(worksDir).filter((f) => f.endsWith(".md")).sort()) {
      const d = fm(readFileSync(join(worksDir, f), "utf8"));
      const id = "work-" + f.replace(/^\d+-|\.md$/g, "");
      const start = d.date || null;
      legacyProjects.push({ id, title: d.company || d.title, family: "career", kind: "work", status: "archived", description: d.title, url: null, repos: [], packages: {}, start, end: null, lastActivity: start });
      if (start) events.push({ projectId: id, repo: null, type: "work", tag: null, name: d.title, date: day(start), prerelease: false, major: true, count: 1, summary: `${d.title} at ${d.company}${d.dates ? " (" + d.dates + ")" : ""}`, url: "/me/" });
    }
  }
  for (const coll of ["portfolio", "blog", "drink"]) {
    const dir = join(LEGACY, coll);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const d = fm(readFileSync(join(dir, f), "utf8"));
      if (!d.date) continue;
      const slug = d.slug || f.replace(/^\d{4}-|\.md$/g, "");
      events.push({ projectId: "legacy-" + coll, repo: null, type: coll === "portfolio" ? "project" : "post", tag: null, name: d.title, date: day(String(d.date)), prerelease: false, major: coll === "portfolio" && d.featured === true, count: 1, summary: null, url: `/${coll}/${slug}/`, tags: Array.isArray(d.tags) ? d.tags.slice(0, 5) : undefined });
    }
    legacyProjects.push({ id: "legacy-" + coll, title: coll === "portfolio" ? "Portfolio" : coll === "blog" ? "Blog" : "Drinks", family: "personal", kind: "personal", status: "archived", description: `Legacy ${coll} entries`, url: `/${coll}/`, repos: [], packages: {}, start: null, end: null, lastActivity: null });
  }
  return { events, legacyProjects };
}

async function main() {
  const repos = [...new Set(items.filter((i) => i.github).map((i) => i.github))];
  process.stderr.write(`catalog: ${items.length} items, ${repos.length} repos\n`);
  const meta = await fetchRepos(repos);
  const projects = new Map();
  const events = [];
  for (const it of items) {
    const pid = it.project || it.id;
    if (!projects.has(pid)) projects.set(pid, { id: pid, title: pid, family: it.family, kind: it.kind, status: it.status, description: it.description, url: it.url, repos: [], packages: { npm: [], cargo: [] }, items: [], start: null, end: null, lastActivity: null, stars: 0, languages: [] });
    const p = projects.get(pid);
    if (it.id === pid) { p.title = it.title; p.description = it.description; p.url = it.url; }
    p.items.push(it.id);
    if (it.npm) p.packages.npm.push(it.npm);
    if (it.cargo) p.packages.cargo.push(it.cargo);
    if (it.status === "wip" && p.status !== "wip") p.status = "wip";
    if (it.github && meta[it.github]) {
      const m = meta[it.github];
      if (!p.repos.includes(it.github)) p.repos.push(it.github);
      p.stars += m.stargazerCount;
      if (m.primaryLanguage?.name && !p.languages.includes(m.primaryLanguage.name)) p.languages.push(m.primaryLanguage.name);
      const created = day(m.createdAt);
      if (!p.start || created < p.start) p.start = created;
      const pushed = day(m.pushedAt);
      if (!p.lastActivity || pushed > p.lastActivity) p.lastActivity = pushed;
      events.push({ projectId: pid, repo: it.github, type: "created", tag: null, name: null, date: created, prerelease: false, major: false, count: 1, summary: `${it.github} created`, url: `https://github.com/${it.github}` });
      if (m.isArchived) { events.push({ projectId: pid, repo: it.github, type: "archived", tag: null, name: null, date: pushed, prerelease: false, major: false, count: 1, summary: `${it.github} archived`, url: `https://github.com/${it.github}` }); if (p.repos.length === 1) p.end = pushed; }
      events.push(...releaseEvents(it.github, pid, m));
    }
  }
  for (const p of projects.values()) {
    const rel = events.filter((e) => e.projectId === p.id && (e.type === "release" || e.type === "first-release"));
    p.releases = rel.length;
    p.majors = rel.filter((e) => e.major).length;
    const primary = items.find((i) => i.id === p.id)?.github;
    const relPrimary = rel.filter((e) => !primary || e.repo === primary);
    const last = (relPrimary.length ? relPrimary : rel).slice(-1)[0];
    p.latestRelease = last ? { tag: last.tag, date: last.date, repo: last.repo } : null;
    if (rel.length && rel[rel.length - 1].date > (p.lastActivity || "")) p.lastActivity = rel[rel.length - 1].date;
    if (p.end === null && p.status === "archived") p.end = p.lastActivity;
  }
  const legacy = legacyEvents();
  for (const lp of legacy.legacyProjects) {
    const ev = legacy.events.filter((e) => e.projectId === lp.id).map((e) => e.date).sort();
    if (ev.length) { lp.start = lp.start || ev[0]; lp.lastActivity = ev[ev.length - 1]; if (lp.status === "archived") lp.end = ev[ev.length - 1]; }
    lp.releases = 0; lp.majors = 0; lp.latestRelease = null; lp.stars = 0; lp.languages = []; lp.items = [];
    projects.set(lp.id, lp);
  }
  events.push(...legacy.events);
  events.sort((a, b) => a.date.localeCompare(b.date) || a.projectId.localeCompare(b.projectId) || (a.tag || "").localeCompare(b.tag || ""));
  const out = {
    generatedAt: new Date().toISOString().slice(0, 19) + "Z",
    families: [...new Set([...projects.values()].map((p) => p.family))].sort(),
    projects: [...projects.values()].sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || "") || a.id.localeCompare(b.id)),
    events,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  process.stderr.write(`wrote ${OUT}: ${out.projects.length} projects, ${events.length} events ${JSON.stringify(byType)}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
