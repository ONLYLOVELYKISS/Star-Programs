import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const parserPackage = process.env.PARSER_PACKAGE_JSON
  ? path.resolve(process.env.PARSER_PACKAGE_JSON)
  : path.resolve('scripts/package.json');
let parseHTML;
try {
  ({ parseHTML } = createRequire(parserPackage)('linkedom'));
} catch (error) {
  throw new Error(`linkedom is unavailable; install it for this collector or set PARSER_PACKAGE_JSON. ${error.message}`);
}

const topN = Math.max(3, Number.parseInt(process.env.TOP_N || '10', 10));
const rankingN = Math.min(100, Math.max(3, Number.parseInt(process.env.RANKING_N || '20', 10)));
const outputRoot = path.resolve(process.env.OUTPUT_ROOT || 'data/github-trending');
const selectionHistoryPath = path.join(outputRoot, 'selection-history.json');
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const capturedAtChinaTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date());
const source = 'https://github.com/trending?since=daily';
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'github-daily-project-collector',
  'X-GitHub-Api-Version': '2022-11-28',
};

const sleep = (ms) => delay(ms);
const text = (element) => element?.textContent?.replace(/\s+/g, ' ').trim() || '';

async function readResponse(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(20000),
        headers: {
          ...headers,
          ...(new URL(url).hostname === 'api.github.com' && process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
          ...options.headers,
        },
      });
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}: ${url}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await sleep(750 * (attempt + 1));
  }
  throw lastError;
}

function parseTrending(html) {
  const { document } = parseHTML(html);
  const articles = [...document.querySelectorAll('article.Box-row')].slice(0, topN);
  if (articles.length < topN) throw new Error(`Trending returned ${articles.length} projects; expected ${topN}.`);
  return articles.map((article, index) => {
    const repoPath = article.querySelector('h2 a')?.getAttribute('href')?.trim().replace(/\/$/, '');
    if (!repoPath || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) {
      throw new Error(`Invalid repository at trending position ${index + 1}.`);
    }
    const todayText = [...article.querySelectorAll('span')].map(text)
      .find((value) => /[\d,.]+\s+stars?\s+today/i.test(value)) || null;
    return {
      rank: index + 1,
      fullName: repoPath.slice(1),
      url: `https://github.com${repoPath}`,
      trendingDescription: text(article.querySelector('p')) || null,
      trendingLanguage: text(article.querySelector('[itemprop="programmingLanguage"]')) || null,
      starsToday: todayText?.match(/[\d,.]+/)?.[0]?.replace(/[,.]/g, '') || null,
      starsTodayText: todayText,
    };
  });
}

async function enrich(item) {
  const [repoResponse, readmeResponse] = await Promise.all([
    readResponse(`https://api.github.com/repos/${item.fullName}`),
    readResponse(`https://api.github.com/repos/${item.fullName}/readme`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    }).catch(() => null),
  ]);
  const repo = await repoResponse.json();
  return {
    ...item,
    repository: {
      description: repo.description,
      language: repo.language,
      stargazersCount: repo.stargazers_count,
      license: repo.license?.spdx_id || repo.license?.name || null,
      topics: repo.topics || [],
      archived: repo.archived,
      updatedAt: repo.updated_at,
      defaultBranch: repo.default_branch,
    },
    readmeExcerpt: readmeResponse ? (await readmeResponse.text()).slice(0, 7000) : null,
  };
}

const rankingDefinitions = [
  { id: 'stars', sort: 'stars', query: 'stars:>0', label: 'Star 数排序' },
  { id: 'forks', sort: 'forks', query: 'forks:>0', label: 'Fork 数排序' },
  { id: 'updated', sort: 'updated', query: 'stars:>0', label: '近期更新排序' },
  { id: 'helpWantedIssues', sort: 'help-wanted-issues', query: 'help-wanted-issues:>0', label: 'Help Wanted issue 排序' },
];

async function searchOfficialRankings() {
  const results = await Promise.all(rankingDefinitions.map(async (definition) => {
    try {
      const url = new URL('https://api.github.com/search/repositories');
      url.searchParams.set('q', definition.query);
      url.searchParams.set('sort', definition.sort);
      url.searchParams.set('order', 'desc');
      url.searchParams.set('per_page', String(rankingN));
      const response = await readResponse(url.toString());
      const payload = await response.json();
      return {
        id: definition.id,
        label: definition.label,
        query: definition.query,
        sort: definition.sort,
        totalCount: payload.total_count,
        incompleteResults: payload.incomplete_results,
        projects: (payload.items || []).map((repo, index) => ({
          rank: index + 1,
          fullName: repo.full_name,
          url: repo.html_url,
          description: repo.description,
          language: repo.language,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          watchers: repo.watchers_count,
          openIssues: repo.open_issues_count,
          pushedAt: repo.pushed_at,
          updatedAt: repo.updated_at,
          license: repo.license?.spdx_id || repo.license?.name || null,
        })),
      };
    } catch (error) {
      return { id: definition.id, label: definition.label, query: definition.query, sort: definition.sort, error: error.message, projects: [] };
    }
  }));
  return results;
}

async function readHistory() {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort().reverse();
  const snapshots = [];
  for (const file of files) {
    if (file === `${date}.json`) continue;
    try { snapshots.push(JSON.parse(await fs.readFile(path.join(outputRoot, file), 'utf8'))); } catch { /* skip malformed history */ }
  }
  const previous = snapshots.find((snapshot) => snapshot.date < date) || null;
  const previouslySelected = new Set();
  const selectionHistory = await fs.readFile(selectionHistoryPath, 'utf8')
    .then((contents) => JSON.parse(contents))
    .catch(() => ({ schemaVersion: 1, selectedProjects: [] }));
  for (const project of selectionHistory.selectedProjects || []) {
    const isExistingArticle = project.selectionSource === 'existing-notion-article';
    if ((project.selectedDate < date || (isExistingArticle && project.selectedDate <= date)) && project.fullName) {
      previouslySelected.add(project.fullName.toLowerCase());
    }
  }
  for (const snapshot of snapshots) {
    const priorSelection = Array.isArray(snapshot.selectedProjects)
      ? snapshot.selectedProjects
      : (snapshot.projects || []).filter((project) => project.rank <= 3);
    for (const project of priorSelection) if (project.fullName) previouslySelected.add(project.fullName.toLowerCase());
  }
  return { previous, previouslySelected, selectionHistory };
}

async function writeSelectionHistory(history, selectedProjects) {
  const retained = (history.selectedProjects || []).filter((project) => (
    project.selectedDate !== date || project.selectionSource === 'existing-notion-article'
  ));
  const todaysProjects = selectedProjects.map((project) => ({
    fullName: project.fullName,
    selectedDate: date,
    selectionSource: project.selectionSource,
  }));
  const byName = new Map();
  for (const project of [...retained, ...todaysProjects]) byName.set(project.fullName.toLowerCase(), project);
  await fs.writeFile(selectionHistoryPath, `${JSON.stringify({
    schemaVersion: 1,
    description: 'Append-only history of projects selected for article drafts; seeded from existing Notion articles.',
    selectedProjects: [...byName.values()].sort((a, b) => a.selectedDate.localeCompare(b.selectedDate) || a.fullName.localeCompare(b.fullName)),
  }, null, 2)}\n`, 'utf8');
}

async function chooseUniqueProjects(projects, rankings, previouslySelected) {
  const selected = [];
  const seen = new Set(previouslySelected);
  const add = (project, selectionSource) => {
    const key = project.fullName.toLowerCase();
    if (seen.has(key) || selected.some((item) => item.fullName.toLowerCase() === key)) return false;
    seen.add(key);
    selected.push({ ...project, selectionRank: selected.length + 1, selectionSource });
    return true;
  };

  for (const project of projects) {
    add(project, 'github-trending-daily');
    if (selected.length === 3) return selected;
  }

  const rankingCandidates = [];
  for (const ranking of rankings) {
    for (const project of ranking.projects || []) {
      if (!seen.has(project.fullName.toLowerCase()) && !rankingCandidates.some((item) => item.fullName === project.fullName)) {
        rankingCandidates.push({ ...project, rankingId: ranking.id, rank: project.rank });
      }
    }
  }
  for (const candidate of rankingCandidates) {
    const item = {
      rank: candidate.rank,
      fullName: candidate.fullName,
      url: candidate.url,
      trendingDescription: null,
      trendingLanguage: candidate.language,
      starsToday: null,
      starsTodayText: null,
      selectionRanking: candidate.rankingId,
    };
    try {
      const enriched = await enrich(item);
      if (add(enriched, `github-search-${candidate.rankingId}`) && selected.length === 3) break;
    } catch { /* preserve the successful Trending collection if an optional fallback repo is unavailable */ }
  }
  return selected;
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const trending = parseTrending(await (await readResponse(source, { headers: { Accept: 'text/html' } })).text());
  const projects = await Promise.all(trending.map(enrich));
  const [history, githubApiSearchRankings] = await Promise.all([readHistory(), searchOfficialRankings()]);
  const previous = history.previous;
  const previousByName = new Map((previous?.projects || []).map((item) => [item.fullName, item]));
  for (const project of projects) {
    const previousStars = previousByName.get(project.fullName)?.repository?.stargazersCount;
    project.estimatedStarsSincePreviousSnapshot = Number.isInteger(previousStars)
      ? project.repository.stargazersCount - previousStars : null;
  }
  const selectedProjects = await chooseUniqueProjects(projects, githubApiSearchRankings, history.previouslySelected);
  await writeSelectionHistory(history.selectionHistory, selectedProjects);
  const result = {
    schemaVersion: 2,
    date,
    capturedAtChinaTime,
    source,
    sourceDescription: 'Trending page values are capture-time daily signals, not a complete Beijing calendar-day total or cumulative-star ranking.',
    topN,
    previousSnapshotDate: previous?.date || null,
    growthDescription: previous ? 'Estimated difference between this snapshot and the latest earlier snapshot; not an official daily Star count.' : null,
    githubApiRankingsDescription: 'GitHub REST Search API results sorted by supported repository metrics at capture time. These are search results, not a separate exhaustive or official daily Trending ranking.',
    githubApiSearchRankings,
    selectionDescription: 'Three article candidates selected in order: unseen GitHub Trending daily projects first, then unseen GitHub REST Search API ranking results. Previously selected article candidates are skipped.',
    selectionShortfall: selectedProjects.length < 3 ? `Only ${selectedProjects.length} unique candidates were available from the collected sources.` : null,
    selectedProjects,
    projects,
  };
  const outputPath = path.join(outputRoot, `${date}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify(result));
}

try {
  await main();
} catch (error) {
  const failure = {
    schemaVersion: 2, date, capturedAtChinaTime, source, topN,
    failureReason: error.message, projects: [], selectedProjects: [], githubApiSearchRankings: [],
  };
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, `${date}.json`), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify(failure));
  process.exitCode = 2;
}
