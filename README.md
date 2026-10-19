# Star-Programs

GitHub Actions daily collector for GitHub Trending snapshots and official GitHub REST API repository rankings.

- Scheduled daily at 09:00 Beijing time; manual runs can set `top_n`.
- Collects Trending repositories and official repository metadata/README excerpts.
- Saves GitHub Search API rankings by stars, forks, recently updated, and help-wanted issue count.
- Selects three projects for the daily article, skipping projects selected in earlier snapshots; official Search API results fill gaps when Trending has fewer than three new candidates.
- Commits dated JSON snapshots and `latest.json` to `master`, and uploads an artifact for each run.

See [the design and data definitions](docs/github-actions-design.md) before interpreting a ranking. Search API results are time-specific sorted search results, not an exhaustive official daily ranking. Trending “stars today” is a capture-time page value, not a complete calendar-day count.
