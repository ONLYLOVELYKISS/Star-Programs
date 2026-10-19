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
const outputRoot = path.resolve(process.env.OUTPUT_ROOT || 'data/github-trending');
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
        headers: { ...headers, ...options.headers },
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

async function readPrevious() {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name).sort().reverse();
  for (const file of files) {
    if (file === `${date}.json`) continue;
    try { return JSON.parse(await fs.readFile(path.join(outputRoot, file), 'utf8')); } catch { /* skip malformed history */ }
  }
  return null;
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const trending = parseTrending(await (await readResponse(source, { headers: { Accept: 'text/html' } })).text());
  const projects = await Promise.all(trending.map(enrich));
  const previous = await readPrevious();
  const previousByName = new Map((previous?.projects || []).map((item) => [item.fullName, item]));
  for (const project of projects) {
    const previousStars = previousByName.get(project.fullName)?.repository?.stargazersCount;
    project.estimatedStarsSincePreviousSnapshot = Number.isInteger(previousStars)
      ? project.repository.stargazersCount - previousStars : null;
  }
  const result = {
    schemaVersion: 1,
    date,
    capturedAtChinaTime,
    source,
    sourceDescription: 'Trending page values are capture-time daily signals, not a complete Beijing calendar-day total or cumulative-star ranking.',
    topN,
    previousSnapshotDate: previous?.date || null,
    growthDescription: previous ? 'Estimated difference between this snapshot and the latest earlier snapshot; not an official daily Star count.' : null,
    projects,
  };
  const outputPath = path.join(outputRoot, `${date}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify(result));
}

try {
  await main();
} catch (error) {
  const failure = { schemaVersion: 1, date, capturedAtChinaTime, source, topN, failureReason: error.message, projects: [] };
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, `${date}.json`), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify(failure));
  process.exitCode = 2;
}
