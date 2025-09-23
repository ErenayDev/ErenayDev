const { Octokit } = require('@octokit/rest');
const fs = require('fs');

class GitHubStatsGenerator {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.username = 'erenay';
  }

  async generateStats() {
    const [user, repos, commits, prs, issues] = await Promise.all([
      this.getUserInfo(),
      this.getRepoStats(),
      this.getCommitStats(),
      this.getPRStats(),
      this.getIssueStats()
    ]);

    return {
      user,
      totalStars: repos.totalStars,
      totalRepos: repos.total,
      commitsThisYear: commits.thisYear,
      totalPRs: prs.total,
      totalIssues: issues.total,
      contributedRepos: repos.contributed
    };
  }

  async getUserInfo() {
    const { data } = await this.octokit.users.getByUsername({
      username: this.username
    });
    return data;
  }

  async getRepoStats() {
    const { data: repos } = await this.octokit.repos.listForUser({
      username: this.username,
      per_page: 100
    });

    const totalStars = repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
    
    return {
      total: repos.length,
      totalStars,
      contributed: repos.filter(repo => !repo.fork).length
    };
  }

  async getCommitStats() {
    const currentYear = new Date().getFullYear();
    const since = `${currentYear}-01-01T00:00:00Z`;
    
    const { data: events } = await this.octokit.activity.listEventsForUser({
      username: this.username,
      per_page: 100
    });

    const pushEvents = events.filter(event => 
      event.type === 'PushEvent' && 
      new Date(event.created_at).getFullYear() === currentYear
    );

    const commitsThisYear = pushEvents.reduce((sum, event) => 
      sum + (event.payload.commits?.length || 0), 0
    );

    return { thisYear: commitsThisYear };
  }

  async getPRStats() {
    const { data: prs } = await this.octokit.search.issuesAndPullRequests({
      q: `author:${this.username} type:pr`,
      per_page: 1
    });

    return { total: prs.total_count };
  }

  async getIssueStats() {
    const { data: issues } = await this.octokit.search.issuesAndPullRequests({
      q: `author:${this.username} type:issue`,
      per_page: 1
    });

    return { total: issues.total_count };
  }
}

async function main() {
  try {
    const generator = new GitHubStatsGenerator();
    const stats = await generator.generateStats();
    
    const template = fs.readFileSync('src/template.md', 'utf8');
    const asciiArt = fs.readFileSync('src/ascii-art.txt', 'utf8');
    
    const readme = template
      .replace('{{ASCII_ART}}', asciiArt)
      .replace('{{TOTAL_STARS}}', stats.totalStars)
      .replace('{{COMMITS_THIS_YEAR}}', stats.commitsThisYear)
      .replace('{{TOTAL_PRS}}', stats.totalPRS)
      .replace('{{TOTAL_ISSUES}}', stats.totalIssues)
      .replace('{{CONTRIBUTED_REPOS}}', stats.contributedRepos)
      .replace('{{LAST_UPDATE}}', new Date().toISOString());

    fs.writeFileSync('README.md', readme);
    console.log('README updated successfully!');
    
  } catch (error) {
    console.error('Error generating stats:', error);
    process.exit(1);
  }
}

main();
