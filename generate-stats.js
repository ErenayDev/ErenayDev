const { Octokit } = require("@octokit/rest");
const fs = require("fs");

class GitHubStatsGenerator {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
    this.username = "ErenayDev";
  }

  async generateStats() {
    const [user, repos, commits, prs, issues] = await Promise.all([
      this.getUserInfo(),
      this.getRepoStats(),
      this.getCommitStats(),
      this.getPRStats(),
      this.getIssueStats(),
    ]);

    return {
      user,
      totalStars: repos.totalStars,
      totalRepos: repos.total,
      commits: commits.commits,
      commitsThisYear: commits.thisYear,
      totalPRs: prs.total,
      totalIssues: issues.total,
      contributedRepos: repos.contributed,
    };
  }

  async getUserInfo() {
    const { data } = await this.octokit.rest.users.getByUsername({
      username: this.username,
    });
    return data;
  }

  async getRepoStats() {
    const { data: repos } = await this.octokit.rest.repos.listForUser({
      username: this.username,
      per_page: 100,
    });

    const totalStars = repos.reduce(
      (sum, repo) => sum + repo.stargazers_count,
      0,
    );

    return {
      total: repos.length,
      totalStars,
      contributed: repos.filter((repo) => !repo.fork).length,
    };
  }

  async getCommitStats() {
    try {
      const currentYear = new Date().getFullYear();
      const { data } = await this.octokit.rest.search.commits({
        q: `author:${this.username} author-date:${currentYear}-01-01..${currentYear}-12-31`,
        per_page: 10,
      });
      return { thisYear: data.total_count, commits: data.items };
    } catch (error) {
      console.log("Commit stats could not be retrieved, using fallback");
      return { thisYear: 0, commits: [] };
    }
  }

  async getPRStats() {
    try {
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        q: `author:${this.username} type:pr`,
        per_page: 1,
      });
      return { total: data.total_count };
    } catch (error) {
      console.log("PR stats could not be retrieved");
      return { total: 0 };
    }
  }

  async getIssueStats() {
    try {
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        q: `author:${this.username} type:issue`,
        per_page: 1,
      });
      return { total: data.total_count };
    } catch (error) {
      console.log("Issue stats could not be retrieved");
      return { total: 0 };
    }
  }

  generateCommitTable(commits) {
    if (!commits || commits.length === 0) {
      return "| Message | Repository | Date |\n|---------|------------|------|\n| No recent commits | - | - |";
    }

    let table =
      "| Message | Repository | Date |\n|---------|------------|------|\n";

    commits.forEach((commit) => {
      const message = commit.commit.message.split("\n")[0].substring(0, 50);
      const commitLink = commit.html_url;
      const repo = commit.repository.full_name.split("/")[1];
      const repoLink = `https://github.com/${commit.repository.full_name}`;
      const date = new Date(commit.commit.author.date).toLocaleDateString(
        "tr-TR",
      );
      table += `| [${message}](${commitLink}) | [${repo}](${repoLink}) | ${date} |\n`;
    });

    return table;
  }

  generateStatsTable(stats) {
    return `| Metric | Count |
|--------|-------|
| Total Stars | ${stats.totalStars} |
| Commits (${new Date().getFullYear()}) | ${stats.commitsThisYear} |
| Pull Requests | ${stats.totalPRs} |
| Issues | ${stats.totalIssues} |
| Contributed Repos | ${stats.contributedRepos} |`;
  }
}

async function main() {
  try {
    const generator = new GitHubStatsGenerator();
    const stats = await generator.generateStats();

    let readme = fs.readFileSync("README.md", "utf8");

    const commitTable = generator.generateCommitTable(stats.commits);
    const statsTable = generator.generateStatsTable(stats);

    const date = new Date();
    const updateTime =
      date.toLocaleDateString("tr-TR") +
      " " +
      String(date.getHours()).padStart(2, "0") +
      ":" +
      String(date.getMinutes()).padStart(2, "0");

readme = readme
  .replace(/<!--START_SECTION:commits-->[\s\S]*?<!--END_SECTION:commits-->/, 
    `<!--START_SECTION:commits-->\n${commitTable}\n<!--END_SECTION:commits-->`)
  .replace(/<!--START_SECTION:stats-->[\s\S]*?<!--END_SECTION:stats-->/, 
    `<!--START_SECTION:stats-->\n${statsTable}\n<!--END_SECTION:stats-->`)
  .replace(/last updated\(UTC\):.*/, `last updated(UTC): ${updateTime}`);

    fs.writeFileSync("README.md", readme);

    console.log("README updated successfully!");
    console.log(
      `Stats: ${stats.totalStars} stars, ${stats.commitsThisYear} commits, ${stats.totalPRs} PRs`,
    );
  } catch (error) {
    console.error("Error generating stats:", error);
    process.exit(1);
  }
}

main();
