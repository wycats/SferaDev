/**
 * VS Code API Horizon Scanner
 *
 * Analyzes proposed VS Code APIs by cross-referencing three data sources:
 *   1. Local vscode.proposed.*.d.ts files (interface definitions, versions, TODOs)
 *   2. GitHub Issues API (api-proposal / api-finalization labels, milestones)
 *   3. First-party extension enabledApiProposals (consumer adoption)
 *
 * Produces a dashboard showing stabilization horizon for each proposed API.
 *
 * Usage:
 *   node scripts/vscode-api-horizon.ts [options]
 *
 * Options:
 *   --vscode-path <path>    Path to vscode repo (default: .reference/vscode)
 *   --consumers <paths...>  Comma-separated paths to extension package.json files
 *                           (default: .reference/vscode-copilot-chat/package.json)
 *   --github-token <token>  GitHub PAT for API calls (or GITHUB_TOKEN env var)
 *   --filter <pattern>      Only show proposals matching this pattern (e.g., "chat")
 *   --json                  Output as JSON instead of formatted table
 *   --no-github             Skip GitHub API queries (offline mode)
 *   --sort <field>          Sort by: name, version, consumers, milestone, signals
 *                           (default: signals)
 *
 * See docs/research/VSCODE_API_HORIZON_METHODOLOGY.md for background.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProposalInfo {
  name: string;
  filePath: string;
  version: number | null;
  lineCount: number;
  interfaceCount: number;
  classCount: number;
  enumCount: number;
  todoCount: number;
  todos: string[];
  /** Top-level exported symbols */
  exports: string[];
}

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  milestone: string | null;
  assignees: string[];
  updatedAt: string;
  url: string;
  commentCount: number;
  /** Issue body text (only populated for api-proposal issues, used for matching) */
  body?: string;
}

interface ConsumerInfo {
  extensionName: string;
  packagePath: string;
  /** proposal name with optional @version pin */
  raw: string;
  /** proposal name without version */
  proposal: string;
  /** version pin, if any */
  versionPin: number | null;
}

interface GitActivity {
  /** Number of commits in the last 30 days */
  recentCommitCount: number;
  /** Date of most recent commit */
  latestCommitDate: string | null;
  /** PR numbers extracted from recent commit messages */
  recentPRNumbers: number[];
  /** Total commits ever */
  totalCommitCount: number;
}

interface PRMilestoneInfo {
  prNumber: number;
  title: string;
  milestone: string | null;
  mergedAt: string | null;
}

interface ProposalDashboardEntry {
  proposal: ProposalInfo;
  gitActivity: GitActivity;
  prMilestones: PRMilestoneInfo[];
  finalizationIssues: GitHubIssue[];
  iterationPlanIssues: GitHubIssue[];
  consumers: ConsumerInfo[];
  signals: StabilizationSignals;
  horizonEstimate: string;
}

interface StabilizationSignals {
  hasFinalizationLabel: boolean;
  isMilestonedCurrentOrNext: boolean;
  milestone: string | null;
  /** Proposal appears in current iteration's api-proposal milestone query */
  inCurrentIterationPlan: boolean;
  /** Proposal was in previous iteration's api-proposal milestone but not current, with no new signals */
  droppedFromPreviousPlan: boolean;
  hasMultipleConsumers: boolean;
  consumerCount: number;
  versionChurn: number | null;
  hasTodos: boolean;
  todoCount: number;
  isGrabBag: boolean;
  /** Approximate score 0-100 where higher = closer to stable */
  readinessScore: number;
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

interface Options {
  vscodePath: string;
  consumerPaths: string[];
  githubToken: string | null;
  filter: string | null;
  json: boolean;
  noGithub: boolean;
  sort: "name" | "version" | "consumers" | "milestone" | "signals";
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    vscodePath: ".reference/vscode",
    consumerPaths: [".reference/vscode-copilot-chat/package.json"],
    githubToken: process.env.GITHUB_TOKEN ?? null,
    filter: null,
    json: false,
    noGithub: false,
    sort: "signals",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--vscode-path":
        opts.vscodePath = args[++i]!;
        break;
      case "--consumers":
        opts.consumerPaths = args[++i]!.split(",");
        break;
      case "--github-token":
        opts.githubToken = args[++i]!;
        break;
      case "--filter":
        opts.filter = args[++i]!;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--no-github":
        opts.noGithub = true;
        break;
      case "--sort":
        opts.sort = args[++i] as Options["sort"];
        break;
      case "--help":
      case "-h":
        console.log(
          fs
            .readFileSync(new URL(import.meta.url).pathname, "utf-8")
            .match(/\/\*\*([\s\S]*?)\*\//)?.[1]
            ?.replace(/^ \* ?/gm, "")
            .trim() ?? "See source for usage.",
        );
        process.exit(0);
    }
  }

  return opts;
}

// ─── Step 1: Parse Proposed API Files ────────────────────────────────────────

function scanProposals(vscodePath: string): ProposalInfo[] {
  const dtsDir = path.join(vscodePath, "src", "vscode-dts");

  if (!fs.existsSync(dtsDir)) {
    console.error(`Error: VS Code dts directory not found at ${dtsDir}`);
    console.error(`  Make sure --vscode-path points to the vscode repo root`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(dtsDir)
    .filter((f) => f.startsWith("vscode.proposed.") && f.endsWith(".d.ts"))
    .sort();

  return files.map((file) => {
    const filePath = path.join(dtsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const name = file.replace("vscode.proposed.", "").replace(".d.ts", "");

    // Extract version
    const versionMatch = content.match(/^\/\/ version:\s*(\d+)/m);
    const version = versionMatch ? parseInt(versionMatch[1]!, 10) : null;

    // Count lines
    const lines = content.split("\n");
    const lineCount = lines.length;

    // Count exported interfaces, classes, enums
    const interfaceCount = (content.match(/export\s+interface\s+\w+/g) ?? [])
      .length;
    const classCount = (content.match(/export\s+class\s+\w+/g) ?? []).length;
    const enumCount = (content.match(/export\s+enum\s+\w+/g) ?? []).length;

    // Find TODOs
    const todoMatches = content.match(/TODO@?\w*[^*\n]*/g) ?? [];
    const todoCount = todoMatches.length;
    const todos = todoMatches.map((t) => t.trim()).slice(0, 5);

    // Extract top-level export names
    const exportMatches =
      content.match(
        /export\s+(?:interface|class|enum|type|function|namespace)\s+(\w+)/g,
      ) ?? [];
    const exports = exportMatches.map((m) =>
      m.replace(
        /export\s+(?:interface|class|enum|type|function|namespace)\s+/,
        "",
      ),
    );

    return {
      name,
      filePath,
      version,
      lineCount,
      interfaceCount,
      classCount,
      enumCount,
      todoCount,
      todos,
      exports,
    };
  });
}

// ─── Step 2: Parse Consumer Extensions ───────────────────────────────────────

function scanConsumers(consumerPaths: string[]): ConsumerInfo[] {
  const consumers: ConsumerInfo[] = [];

  for (const pkgPath of consumerPaths) {
    if (!fs.existsSync(pkgPath)) {
      console.error(`Warning: Consumer package.json not found at ${pkgPath}`);
      continue;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const extensionName: string =
      pkg.name || path.basename(path.dirname(pkgPath));
    const proposals: string[] = pkg.enabledApiProposals ?? [];

    for (const raw of proposals) {
      const versionMatch = raw.match(/^(.+)@(\d+)$/);
      consumers.push({
        extensionName,
        packagePath: pkgPath,
        raw,
        proposal: versionMatch ? versionMatch[1]! : raw,
        versionPin: versionMatch ? parseInt(versionMatch[2]!, 10) : null,
      });
    }
  }

  return consumers;
}

// ─── Step 3: Scan Git Activity ───────────────────────────────────────────────

function verifyGitRepo(vscodePath: string): void {
  try {
    execSync("git rev-parse --git-dir", { cwd: vscodePath, stdio: "pipe" });
  } catch {
    console.error(`Error: ${vscodePath} is not a git repository.`);
    console.error(
      `  The scanner requires a full git clone of microsoft/vscode.`,
    );
    console.error(
      `  Run: git clone https://github.com/microsoft/vscode.git ${vscodePath}`,
    );
    process.exit(1);
  }
}

function scanGitActivity(
  vscodePath: string,
  proposals: ProposalInfo[],
): Map<string, GitActivity> {
  const result = new Map<string, GitActivity>();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  // Build a set of proposal names keyed by filename for fast lookup
  const nameByFile = new Map<string, string>();
  const dtsDir = "src/vscode-dts/";
  for (const p of proposals) {
    nameByFile.set(`${dtsDir}vscode.proposed.${p.name}.d.ts`, p.name);
  }

  // Initialize all proposals with empty activity
  for (const p of proposals) {
    result.set(p.name, {
      recentCommitCount: 0,
      latestCommitDate: null,
      recentPRNumbers: [],
      totalCommitCount: 0,
    });
  }

  // ONE git log call for ALL proposal files: use --name-only to see which files each commit touched
  // Use "COMMIT:" prefix to delimit commits (--name-only adds blank lines that break \n\n splitting)
  let fullLog = "";
  try {
    fullLog = execSync(
      `git log --format="COMMIT:%ad %s" --date=short --name-only -- "${dtsDir}vscode.proposed.*.d.ts"`,
      { cwd: vscodePath, stdio: "pipe", maxBuffer: 50 * 1024 * 1024 },
    )
      .toString()
      .trim();
  } catch {
    // No commits or git error
    return result;
  }

  if (!fullLog) return result;

  // Parse line-by-line: "COMMIT:date subject" lines start a new commit, non-blank lines are filenames
  let currentDate: string | null = null;
  let currentPR: number | null = null;
  let isRecent = false;

  for (const rawLine of fullLog.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("COMMIT:")) {
      const header = line.slice(7); // strip "COMMIT:" prefix
      currentDate = header.slice(0, 10);
      const prMatch = header.match(/\(#(\d+)\)/);
      currentPR = prMatch ? parseInt(prMatch[1]!, 10) : null;
      isRecent = currentDate >= thirtyDaysAgo!;
      continue;
    }

    // It's a filename — associate with current commit
    if (!currentDate) continue;
    const name = nameByFile.get(line);
    if (!name) continue;

    const activity = result.get(name)!;
    activity.totalCommitCount++;
    if (!activity.latestCommitDate || currentDate > activity.latestCommitDate) {
      activity.latestCommitDate = currentDate;
    }
    if (isRecent) {
      activity.recentCommitCount++;
      if (currentPR && !activity.recentPRNumbers.includes(currentPR)) {
        activity.recentPRNumbers.push(currentPR);
      }
    }
  }

  return result;
}

// ─── Step 4: Query GitHub API ────────────────────────────────────────────────

function makeHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "vscode-api-horizon-scanner",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch milestone data for a single PR */
async function fetchPRMilestone(
  prNumber: number,
  token: string | null,
): Promise<PRMilestoneInfo | null> {
  const url = `https://api.github.com/repos/microsoft/vscode/pulls/${prNumber}`;
  try {
    const r = await fetch(url, { headers: makeHeaders(token) });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      number: number;
      title: string;
      milestone: { title: string } | null;
      merged_at: string | null;
    };
    return {
      prNumber: data.number,
      title: data.title,
      milestone: data.milestone?.title ?? null,
      mergedAt: data.merged_at,
    };
  } catch {
    return null;
  }
}

/** Fetch all open api-finalization issues (single API call via Issues list endpoint) */
async function fetchFinalizationIssues(
  token: string | null,
): Promise<GitHubIssue[]> {
  const url =
    "https://api.github.com/repos/microsoft/vscode/issues?labels=api-finalization&state=open&per_page=100&sort=updated&direction=desc";
  try {
    const r = await fetch(url, { headers: makeHeaders(token) });
    if (!r.ok) {
      if (r.status === 403 || r.status === 429) {
        console.error(
          "GitHub API rate limited. Use --github-token or set GITHUB_TOKEN.",
        );
      } else {
        console.error(`GitHub API error: ${r.status} ${r.statusText}`);
      }
      return [];
    }
    const items = (await r.json()) as Array<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      milestone: { title: string } | null;
      assignees: Array<{ login: string }>;
      updated_at: string;
      html_url: string;
      comments: number;
    }>;
    return items.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      labels: item.labels.map((l) => l.name),
      milestone: item.milestone?.title ?? null,
      assignees: item.assignees.map((a) => a.login),
      updatedAt: item.updated_at,
      url: item.html_url,
      commentCount: item.comments,
    }));
  } catch (error) {
    console.error(`GitHub API request failed: ${error}`);
    return [];
  }
}

/** Fetch api-proposal issues for a specific milestone (1 API call via search endpoint).
 *  These are the issues the VS Code team explicitly plans to work on in that iteration.
 *  The iteration plan's "### API" section links to exactly this query. */
async function fetchApiProposalIssues(
  token: string | null,
  milestone: string,
): Promise<GitHubIssue[]> {
  const q = encodeURIComponent(
    `repo:microsoft/vscode label:api-proposal milestone:"${milestone}" is:issue`,
  );
  const url = `https://api.github.com/search/issues?q=${q}&per_page=50`;
  try {
    const r = await fetch(url, { headers: makeHeaders(token) });
    if (!r.ok) {
      if (r.status === 403 || r.status === 429) {
        console.error("GitHub API rate limited for api-proposal search.");
      } else {
        console.error(
          `GitHub API error (api-proposal search): ${r.status} ${r.statusText}`,
        );
      }
      return [];
    }
    const data = (await r.json()) as {
      total_count: number;
      items: Array<{
        number: number;
        title: string;
        state: string;
        body: string | null;
        labels: Array<{ name: string }>;
        milestone: { title: string } | null;
        assignees: Array<{ login: string }>;
        updated_at: string;
        html_url: string;
        comments: number;
      }>;
    };
    return data.items.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      labels: item.labels.map((l) => l.name),
      milestone: item.milestone?.title ?? null,
      assignees: item.assignees.map((a) => a.login),
      updatedAt: item.updated_at,
      url: item.html_url,
      commentCount: item.comments,
      body: item.body ?? undefined,
    }));
  } catch (error) {
    console.error(`GitHub API request failed (api-proposal search): ${error}`);
    return [];
  }
}

/**
 * Match an issue to a proposal name using title, label, and body heuristics.
 * Works for both api-finalization issues ("Finalize textDocumentChangeReason API")
 * and api-proposal issues (which may reference "proposed.chatPromptFiles" in body).
 */
function issueMatchesProposal(
  issue: GitHubIssue,
  proposalName: string,
): boolean {
  const lower = proposalName.toLowerCase();
  const titleLower = issue.title.toLowerCase();

  // Direct substring match (e.g., "chatPromptFiles" in title)
  if (titleLower.includes(lower)) return true;

  // Spaced camelCase (e.g., "chat Prompt Files" → "chat prompt files")
  const spacedName = proposalName
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();
  if (titleLower.includes(spacedName)) return true;

  // Kebab-case (e.g., "chat-Prompt-Files" → "chat-prompt-files")
  const kebabName = proposalName
    .replace(/([A-Z])/g, "-$1")
    .trim()
    .toLowerCase();
  if (titleLower.includes(kebabName)) return true;

  // Label match
  if (issue.labels.some((l) => l.toLowerCase().includes(lower))) return true;

  // All-words match: split camelCase into words, check if ALL appear in title+body
  // e.g., "extensionAffinity" → ["extension", "affinity"] — both in "Allow extensions to declare their runtime affinity..."
  // Only use for words >= 4 chars to avoid false positives from short words
  // Require at least one word in the TITLE to prevent body-only false positives
  // (e.g., "language", "model", "capabilities" appearing in an MCP issue body)
  const words = proposalName
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (words.length >= 2) {
    const bodyLowerText = issue.body?.toLowerCase() ?? "";
    const searchText = titleLower + " " + bodyLowerText;
    const hasWordInTitle = words.some((w) => titleLower.includes(w));
    if (hasWordInTitle && words.every((w) => searchText.includes(w)))
      return true;
  }

  // Check body for "proposed.<name>" or "enabledApiProposals" references
  if (issue.body) {
    const bodyLower = issue.body.toLowerCase();
    if (bodyLower.includes(`proposed.${lower}`)) return true;
    if (bodyLower.includes(`"${lower}"`)) return true;
  }

  return false;
}

async function fetchGitHubData(
  token: string | null,
  proposals: ProposalInfo[],
  gitActivityMap: Map<string, GitActivity>,
): Promise<{
  prMilestones: Map<string, PRMilestoneInfo[]>;
  finalizationIssues: Map<string, GitHubIssue[]>;
  iterationPlanCurrent: Map<string, GitHubIssue[]>;
  iterationPlanPrevious: Map<string, GitHubIssue[]>;
}> {
  // 1. Fetch finalization issues (1 API call)
  console.error("  Fetching api-finalization issues...");
  const allFinalization = await fetchFinalizationIssues(token);
  console.error(`  Found ${allFinalization.length} api-finalization issues`);

  const finalizationIssues = new Map<string, GitHubIssue[]>();
  for (const p of proposals) {
    finalizationIssues.set(
      p.name,
      allFinalization.filter((issue) => issueMatchesProposal(issue, p.name)),
    );
  }

  // 2. Fetch iteration plan issues (api-proposal label + current/previous milestones, 2 API calls)
  console.error("  Fetching iteration plan (api-proposal) issues...");
  const currentMs = getCurrentMilestone();
  const previousMs = getPreviousMilestone();

  const [currentPlanIssues, previousPlanIssues] = await Promise.all([
    fetchApiProposalIssues(token, currentMs),
    fetchApiProposalIssues(token, previousMs),
  ]);
  console.error(
    `  Found ${currentPlanIssues.length} api-proposal issues for ${currentMs}, ${previousPlanIssues.length} for ${previousMs}`,
  );

  const iterationPlanCurrent = new Map<string, GitHubIssue[]>();
  const iterationPlanPrevious = new Map<string, GitHubIssue[]>();
  for (const p of proposals) {
    iterationPlanCurrent.set(
      p.name,
      currentPlanIssues.filter((issue) => issueMatchesProposal(issue, p.name)),
    );
    iterationPlanPrevious.set(
      p.name,
      previousPlanIssues.filter((issue) => issueMatchesProposal(issue, p.name)),
    );
  }

  // Log unmatched api-proposal issues so we can improve matching
  const matchedCurrentIssues = new Set<number>();
  for (const issues of iterationPlanCurrent.values()) {
    for (const i of issues) matchedCurrentIssues.add(i.number);
  }
  const unmatchedCurrent = currentPlanIssues.filter(
    (i) => !matchedCurrentIssues.has(i.number),
  );
  if (unmatchedCurrent.length > 0) {
    console.error(
      `  ⚠ ${unmatchedCurrent.length} api-proposal issues could not be matched to proposals:`,
    );
    for (const i of unmatchedCurrent) {
      console.error(`    #${i.number}: ${i.title}`);
    }
  }

  // 3. Collect unique PR numbers from proposals with recent activity
  const prToProposals = new Map<number, string[]>();
  for (const p of proposals) {
    const activity = gitActivityMap.get(p.name);
    if (!activity) continue;
    // Only check the most recent PR per proposal to save API calls
    const topPR = activity.recentPRNumbers[0];
    if (topPR !== undefined) {
      const existing = prToProposals.get(topPR) ?? [];
      existing.push(p.name);
      prToProposals.set(topPR, existing);
    }
  }

  console.error(
    `  Fetching milestone data for ${prToProposals.size} recent PRs...`,
  );

  // 4. Fetch PR milestones (1 API call per unique PR)
  const prResults = new Map<number, PRMilestoneInfo>();
  const prNumbers = [...prToProposals.keys()];

  // Fetch in batches of 10 to be nice to the API
  for (let i = 0; i < prNumbers.length; i += 10) {
    const batch = prNumbers.slice(i, i + 10);
    const results = await Promise.all(
      batch.map((pr) => fetchPRMilestone(pr, token)),
    );
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result) prResults.set(batch[j]!, result);
    }
  }

  console.error(`  Got milestone data for ${prResults.size} PRs`);

  // 5. Map PR milestones back to proposals
  const prMilestones = new Map<string, PRMilestoneInfo[]>();
  for (const p of proposals) {
    const activity = gitActivityMap.get(p.name);
    if (!activity) continue;
    const milestones: PRMilestoneInfo[] = [];
    for (const prNum of activity.recentPRNumbers) {
      const info = prResults.get(prNum);
      if (info) milestones.push(info);
    }
    prMilestones.set(p.name, milestones);
  }

  return {
    prMilestones,
    finalizationIssues,
    iterationPlanCurrent,
    iterationPlanPrevious,
  };
}

// ─── Step 4: Analyze Signals ─────────────────────────────────────────────────

function getCurrentMilestone(): string {
  const now = new Date();
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

function getNextMilestone(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[next.getMonth()]} ${next.getFullYear()}`;
}

function getPreviousMilestone(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[prev.getMonth()]} ${prev.getFullYear()}`;
}

function analyzeSignals(
  proposal: ProposalInfo,
  gitActivity: GitActivity,
  prMilestones: PRMilestoneInfo[],
  finalizationIssues: GitHubIssue[],
  iterationPlanCurrent: GitHubIssue[],
  iterationPlanPrevious: GitHubIssue[],
  consumers: ConsumerInfo[],
): StabilizationSignals {
  const currentMs = getCurrentMilestone();
  const nextMs = getNextMilestone();

  const hasFinalizationLabel = finalizationIssues.length > 0;

  // Milestones from PR data (primary) and finalization issues (secondary)
  const allMilestones = [
    ...prMilestones.map((pr) => pr.milestone),
    ...finalizationIssues.map((i) => i.milestone),
  ].filter((m): m is string => m !== null);
  const milestone = allMilestones[0] ?? null;
  const isMilestonedCurrentOrNext = allMilestones.some(
    (m) => m === currentMs || m === nextMs,
  );

  // Iteration plan signals: api-proposal issues milestoned for current/previous iteration
  const inCurrentIterationPlan = iterationPlanCurrent.length > 0;
  // "Dropped" = was in previous iteration plan but not in current, and has no new signals
  const wasInPreviousPlan = iterationPlanPrevious.length > 0;
  const hasNewSignals =
    hasFinalizationLabel || isMilestonedCurrentOrNext || inCurrentIterationPlan;
  const droppedFromPreviousPlan = wasInPreviousPlan && !hasNewSignals;

  const consumerCount = consumers.length;
  const hasMultipleConsumers = consumerCount > 1;

  const hasTodos = proposal.todoCount > 0;
  const totalExports =
    proposal.interfaceCount + proposal.classCount + proposal.enumCount;
  const isGrabBag = totalExports > 15;

  // Calculate readiness score (0-100)
  let score = 50; // baseline

  if (hasFinalizationLabel) score += 30;
  if (isMilestonedCurrentOrNext) score += 15;
  if (inCurrentIterationPlan) score += 20;
  if (droppedFromPreviousPlan) score -= 10;
  if (hasMultipleConsumers) score += 5;
  if (consumerCount > 0) score += 5;
  if (proposal.version !== null && proposal.version >= 3) score -= 10;
  if (hasTodos) score -= proposal.todoCount * 3;
  if (isGrabBag) score -= 15;
  if (proposal.lineCount > 500) score -= 5;
  if (proposal.lineCount < 50) score += 5;

  // Recent git activity is a positive signal (from local git log, always available)
  if (gitActivity.recentCommitCount > 0) score += 5;
  if (gitActivity.recentCommitCount >= 5) score += 5;

  score = Math.max(0, Math.min(100, score));

  return {
    hasFinalizationLabel,
    isMilestonedCurrentOrNext,
    milestone,
    inCurrentIterationPlan,
    droppedFromPreviousPlan,
    hasMultipleConsumers,
    consumerCount,
    versionChurn: proposal.version,
    hasTodos,
    todoCount: proposal.todoCount,
    isGrabBag,
    readinessScore: score,
  };
}

function estimateHorizon(signals: StabilizationSignals): string {
  if (signals.hasFinalizationLabel) return "Imminent (1-2 releases)";
  if (signals.readinessScore >= 70) return "Near-term (1-3 months)";
  if (signals.readinessScore >= 55) return "Mid-term (3-6 months)";
  if (signals.readinessScore >= 40) return "Long-term (6-12 months)";
  return "Indefinite / Internal-only";
}

// ─── Step 5: Build Dashboard ─────────────────────────────────────────────────

async function buildDashboard(
  opts: Options,
): Promise<ProposalDashboardEntry[]> {
  // Step 1: Scan local files
  console.error("Scanning proposed API files...");
  let proposals = scanProposals(opts.vscodePath);

  if (opts.filter) {
    const pattern = opts.filter.toLowerCase();
    proposals = proposals.filter((p) => p.name.toLowerCase().includes(pattern));
  }
  console.error(`  Found ${proposals.length} proposals`);

  // Step 2: Scan consumers
  console.error("Scanning consumer extensions...");
  const allConsumers = scanConsumers(opts.consumerPaths);
  console.error(
    `  Found ${allConsumers.length} proposal references across ${new Set(allConsumers.map((c) => c.extensionName)).size} extensions`,
  );

  // Step 3: Scan git activity (local, free)
  console.error("Scanning git activity...");
  verifyGitRepo(opts.vscodePath);
  const gitActivityMap = scanGitActivity(opts.vscodePath, proposals);
  const activeCount = [...gitActivityMap.values()].filter(
    (a) => a.recentCommitCount > 0,
  ).length;
  console.error(
    `  ${activeCount} proposals with recent activity (last 30 days)`,
  );

  // Step 4: Query GitHub (if enabled)
  let prMilestonesMap = new Map<string, PRMilestoneInfo[]>();
  let finalizationMap = new Map<string, GitHubIssue[]>();
  let iterationPlanCurrentMap = new Map<string, GitHubIssue[]>();
  let iterationPlanPreviousMap = new Map<string, GitHubIssue[]>();

  if (!opts.noGithub) {
    console.error("Querying GitHub API...");
    const githubData = await fetchGitHubData(
      opts.githubToken,
      proposals,
      gitActivityMap,
    );
    prMilestonesMap = githubData.prMilestones;
    finalizationMap = githubData.finalizationIssues;
    iterationPlanCurrentMap = githubData.iterationPlanCurrent;
    iterationPlanPreviousMap = githubData.iterationPlanPrevious;
  } else {
    console.error("Skipping GitHub queries (--no-github)");
  }

  // Step 5: Analyze and build entries
  const entries: ProposalDashboardEntry[] = proposals.map((proposal) => {
    const consumers = allConsumers.filter((c) => c.proposal === proposal.name);
    const gitActivity = gitActivityMap.get(proposal.name) ?? {
      recentCommitCount: 0,
      latestCommitDate: null,
      recentPRNumbers: [],
      totalCommitCount: 0,
    };
    const prMilestones = prMilestonesMap.get(proposal.name) ?? [];
    const finalization = finalizationMap.get(proposal.name) ?? [];
    const iterCurrent = iterationPlanCurrentMap.get(proposal.name) ?? [];
    const iterPrevious = iterationPlanPreviousMap.get(proposal.name) ?? [];
    const signals = analyzeSignals(
      proposal,
      gitActivity,
      prMilestones,
      finalization,
      iterCurrent,
      iterPrevious,
      consumers,
    );

    return {
      proposal,
      gitActivity,
      prMilestones,
      finalizationIssues: finalization,
      iterationPlanIssues: iterCurrent,
      consumers,
      signals,
      horizonEstimate: estimateHorizon(signals),
    };
  });

  // Sort
  switch (opts.sort) {
    case "name":
      entries.sort((a, b) => a.proposal.name.localeCompare(b.proposal.name));
      break;
    case "version":
      entries.sort(
        (a, b) => (b.proposal.version ?? 0) - (a.proposal.version ?? 0),
      );
      break;
    case "consumers":
      entries.sort((a, b) => b.consumers.length - a.consumers.length);
      break;
    case "milestone":
      entries.sort((a, b) => {
        if (a.signals.milestone && !b.signals.milestone) return -1;
        if (!a.signals.milestone && b.signals.milestone) return 1;
        return (a.signals.milestone ?? "").localeCompare(
          b.signals.milestone ?? "",
        );
      });
      break;
    case "signals":
    default:
      entries.sort(
        (a, b) => b.signals.readinessScore - a.signals.readinessScore,
      );
      break;
  }

  return entries;
}

// ─── Output Formatting ──────────────────────────────────────────────────────

function formatTable(entries: ProposalDashboardEntry[]): string {
  const lines: string[] = [];

  lines.push(
    "╔══════════════════════════════════════════════════════════════════════════════╗",
  );
  lines.push(
    "║                    VS Code Proposed API Horizon Dashboard                   ║",
  );
  lines.push(
    "╠══════════════════════════════════════════════════════════════════════════════╣",
  );
  lines.push(
    `║  Scanned: ${entries.length} proposals  │  Date: ${new Date().toISOString().split("T")[0]}                              ║`,
  );
  lines.push(
    "╚══════════════════════════════════════════════════════════════════════════════╝",
  );
  lines.push("");

  // Summary by horizon
  const horizonGroups = new Map<string, ProposalDashboardEntry[]>();
  for (const entry of entries) {
    const group = horizonGroups.get(entry.horizonEstimate) ?? [];
    group.push(entry);
    horizonGroups.set(entry.horizonEstimate, group);
  }

  const horizonOrder = [
    "Imminent (1-2 releases)",
    "Near-term (1-3 months)",
    "Mid-term (3-6 months)",
    "Long-term (6-12 months)",
    "Indefinite / Internal-only",
  ];

  for (const horizon of horizonOrder) {
    const group = horizonGroups.get(horizon);
    if (!group?.length) continue;

    const icon =
      horizon === "Imminent (1-2 releases)"
        ? "🟢"
        : horizon === "Near-term (1-3 months)"
          ? "🔵"
          : horizon === "Mid-term (3-6 months)"
            ? "🟡"
            : horizon === "Long-term (6-12 months)"
              ? "🟠"
              : "⚪";

    lines.push(`${icon} ${horizon} (${group.length})`);
    lines.push("─".repeat(78));

    for (const entry of group) {
      const p = entry.proposal;
      const s = entry.signals;

      // Main line
      const versionStr = p.version !== null ? `v${p.version}` : "   ";
      const consumers =
        s.consumerCount > 0 ? `${s.consumerCount} consumer(s)` : "no consumers";
      const lines2 = `${p.lineCount} lines`;
      const exports = `${p.interfaceCount}i/${p.classCount}c/${p.enumCount}e`;
      const scoreBar = renderScoreBar(s.readinessScore);

      lines.push(
        `  ${padRight(p.name, 40)} ${padRight(versionStr, 5)} ${padRight(lines2, 10)} ${padRight(exports, 10)} ${scoreBar}`,
      );

      // Signal flags
      const flags: string[] = [];
      if (s.hasFinalizationLabel) flags.push("🏁 FINALIZING");
      if (s.inCurrentIterationPlan) flags.push(`📌 IN ITERATION PLAN`);
      if (s.droppedFromPreviousPlan) flags.push(`⏬ DROPPED FROM PLAN`);
      if (s.isMilestonedCurrentOrNext) flags.push(`📅 ${s.milestone}`);
      if (s.hasTodos) flags.push(`⚠️  ${s.todoCount} TODOs`);
      if (s.isGrabBag) flags.push("📦 grab-bag");
      if (s.consumerCount > 0) flags.push(`👥 ${consumers}`);

      if (flags.length > 0) {
        lines.push(`    ${flags.join("  │  ")}`);
      }

      // Iteration plan issues
      for (const issue of entry.iterationPlanIssues.slice(0, 2)) {
        lines.push(
          `    📌 #${issue.number}: ${truncate(issue.title, 55)} [${issue.milestone ?? ""}]`,
        );
      }

      // PR milestones
      for (const pr of entry.prMilestones.slice(0, 2)) {
        if (pr.milestone) {
          lines.push(
            `    📋 PR #${pr.prNumber}: ${truncate(pr.title, 50)} [${pr.milestone}]`,
          );
        }
      }
      for (const issue of entry.finalizationIssues.slice(0, 2)) {
        lines.push(
          `    🏁 #${issue.number}: ${truncate(issue.title, 55)} ${issue.milestone ? `[${issue.milestone}]` : ""}`,
        );
      }

      // Git activity
      if (entry.gitActivity.recentCommitCount > 0) {
        lines.push(
          `    🔨 ${entry.gitActivity.recentCommitCount} commits in last 30d (latest: ${entry.gitActivity.latestCommitDate})`,
        );
      }

      lines.push("");
    }
  }

  // Legend
  lines.push("─".repeat(78));
  lines.push("Legend:");
  lines.push(
    "  Score bar: [████████░░] = readiness (0-100)  │  i/c/e = interfaces/classes/enums",
  );
  lines.push(
    "  🏁 = api-finalization label  │  � = in current iteration plan  │  ⏬ = dropped from plan",
  );
  lines.push(
    "  📅 = milestoned  │  📦 = grab-bag (>15 exports)  │  ⚠️  = has TODO@API comments",
  );
  lines.push("  👥 = consumed by first-party extensions");

  return lines.join("\n");
}

function renderScoreBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  return `[${"\u2588".repeat(filled)}${"\u2591".repeat(empty)}] ${String(score).padStart(3)}`;
}

function padRight(str: string, len: number): string {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}

function truncate(str: string, len: number): string {
  return str.length <= len ? str : str.slice(0, len - 1) + "…";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const entries = await buildDashboard(opts);

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    console.log(formatTable(entries));
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
