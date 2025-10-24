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
        per_page: 1,
      });
      return { thisYear: data.total_count };
    } catch (error) {
      console.log("Commit stats could not be retrieved, using fallback");
      return { thisYear: 0 };
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
}

async function main() {
  try {
    const generator = new GitHubStatsGenerator();
    const stats = await generator.generateStats();

    let readme = fs.readFileSync("README.md", "utf8");

    let asciiArt = fs.readFileSync("src/ascii-art.txt", "utf8");

    asciiArt = asciiArt
      .replace("{{TOTAL_STARS}}", stats.totalStars)
      .replace("{{COMMITS_THIS_YEAR}}", stats.commitsThisYear)
      .replace("{{TOTAL_PRS}}", stats.totalPRs)
      .replace("{{TOTAL_ISSUES}}", stats.totalIssues)
      .replace("{{CONTRIBUTED_REPOS}}", stats.contributedRepos);

    const codeBlockRegex = /```\n([\s\S]*?)\n```/;
    const match = readme.match(codeBlockRegex);

    if (match) {
      readme = readme.replace(codeBlockRegex, `\`\`\`\n${asciiArt}\n\`\`\``);

      const date = new Date();
      const updateTime =
        date.toLocaleDateString("tr-TR") +
        " " +
        String(date.getHours()).padStart(2, "0") +
        ":" +
        String(date.getMinutes()).padStart(2, "0");

      readme = readme.replace(
        /Last updated: .*/,
        `Last updated: ${updateTime}`,
      );

      fs.writeFileSync("README.md", readme);
      console.log("✅ README ASCII art updated successfully!");
      console.log(
        `📊 Stats: ${stats.totalStars} stars, ${stats.commitsThisYear} commits, ${stats.totalPRs} PRs`,
      );
    } else {
      console.log("❌ Could not find ASCII art code block in README.md");
    }
  } catch (error) {
    console.error("❌ Error generating stats:", error);
    process.exit(1);
  }
}

main();
