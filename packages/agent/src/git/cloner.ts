import { simpleGit } from 'simple-git';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_DATA_DIR } from '@chatbot/shared';
import { homedir } from 'node:os';

const REPOS_DIR = join(homedir(), AGENT_DATA_DIR, 'repos');

export async function cloneOrPullRepo(repoUrl: string, token?: string): Promise<string> {
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
  }

  // Generate a safe dir name from the URL
  const repoName = repoUrl
    .replace(/\.git$/, '')
    .split('/')
    .slice(-2)
    .join('_')
    .replace(/[^a-zA-Z0-9_-]/g, '_');

  const repoPath = join(REPOS_DIR, repoName);

  // Inject token into HTTPS URL if provided
  let authUrl = repoUrl;
  if (token && repoUrl.startsWith('https://')) {
    const urlObj = new URL(repoUrl);
    urlObj.username = 'x-access-token';
    urlObj.password = token;
    authUrl = urlObj.toString();
  }

  if (existsSync(join(repoPath, '.git'))) {
    // Already cloned — pull latest
    const git = simpleGit(repoPath);
    await git.pull();
    return repoPath;
  }

  // Shallow clone
  const git = simpleGit();
  await git.clone(authUrl, repoPath, ['--depth', '1']);
  return repoPath;
}
