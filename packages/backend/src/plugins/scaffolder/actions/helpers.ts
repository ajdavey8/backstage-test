import { InputError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  GithubCredentialsProvider,
  ScmIntegrationRegistry,
} from '@backstage/integration';
import { OctokitOptions } from '@octokit/core/dist-types/types';
import { promises as fs } from 'fs';
import globby from 'globby';
import limiterFactory from 'p-limit';
import { resolveSafeChildPath } from '@backstage/backend-common';
import { isError } from '@backstage/errors';
const DEFAULT_TIMEOUT_MS = 60_000;

export type RepoSpec = {
  repo: string;
  host: string;
  owner?: string;
  organization?: string;
  workspace?: string;
  project?: string;
};

export interface SerializedFile {
  path: string;
  content: Buffer;
  executable?: boolean;
  symlink?: boolean;
}

function checkRequiredParams(repoUrl: URL, ...params: string[]) {
  for (let i = 0; i < params.length; i++) {
    if (!repoUrl.searchParams.get(params[i])) {
      throw new InputError(
        `Invalid repo URL passed to publisher: ${repoUrl.toString()}, missing ${
          params[i]
        }`,
      );
    }
  }
}

export const parseRepoUrl = (
  repoUrl: string,
  integrations: ScmIntegrationRegistry,
): RepoSpec => {
  let parsed;
  try {
    parsed = new URL(`https://${repoUrl}`);
  } catch (error) {
    throw new InputError(
      `Invalid repo URL passed to publisher, got ${repoUrl}, ${error}`,
    );
  }
  const host = parsed.host;
  const owner = parsed.searchParams.get('owner') ?? undefined;
  const organization = parsed.searchParams.get('organization') ?? undefined;
  const workspace = parsed.searchParams.get('workspace') ?? undefined;
  const project = parsed.searchParams.get('project') ?? undefined;

  const type = integrations.byHost(host)?.type;

  if (!type) {
    throw new InputError(
      `No matching integration configuration for host ${host}, please check your integrations config`,
    );
  }

  const repo: string = parsed.searchParams.get('repo')!;
  switch (type) {
    case 'bitbucket': {
      if (host === 'www.bitbucket.org') {
        checkRequiredParams(parsed, 'workspace');
      }
      checkRequiredParams(parsed, 'project', 'repo');
      break;
    }
    case 'gitlab': {
      // project is the projectID, and if defined, owner and repo won't be needed.
      if (!project) {
        checkRequiredParams(parsed, 'owner', 'repo');
      }
      break;
    }
    case 'gerrit': {
      checkRequiredParams(parsed, 'repo');
      break;
    }
    default: {
      checkRequiredParams(parsed, 'repo', 'owner');
      break;
    }
  }

  return { host, owner, repo, organization, workspace, project };
};

export async function getOctokitOptions(options: {
  integrations: ScmIntegrationRegistry;
  credentialsProvider?: GithubCredentialsProvider;
  token?: string;
  repoUrl: string;
}): Promise<OctokitOptions> {
  const { integrations, credentialsProvider, repoUrl, token } = options;
  const { owner, repo, host } = parseRepoUrl(repoUrl, integrations);

  const requestOptions = {
    // set timeout to 60 seconds
    timeout: DEFAULT_TIMEOUT_MS,
  };

  if (!owner) {
    throw new InputError(`No owner provided for repo ${repoUrl}`);
  }

  const integrationConfig = integrations.github.byHost(host)?.config;

  if (!integrationConfig) {
    throw new InputError(`No integration for host ${host}`);
  }

  // short circuit the `githubCredentialsProvider` if there is a token provided by the caller already
  if (token) {
    return {
      auth: token,
      baseUrl: integrationConfig.apiBaseUrl,
      previews: ['nebula-preview'],
      request: requestOptions,
    };
  }

  const githubCredentialsProvider =
    credentialsProvider ??
    DefaultGithubCredentialsProvider.fromIntegrations(integrations);

  // TODO(blam): Consider changing this API to take host and repo instead of repoUrl, as we end up parsing in this function
  // and then parsing in the `getCredentials` function too the other side
  const { token: credentialProviderToken } =
    await githubCredentialsProvider.getCredentials({
      url: `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}`,
    });

  if (!credentialProviderToken) {
    throw new InputError(
      `No token available for host: ${host}, with owner ${owner}, and repo ${repo}`,
    );
  }

  return {
    auth: credentialProviderToken,
    baseUrl: integrationConfig.apiBaseUrl,
    previews: ['nebula-preview'],
  };
}

const DEFAULT_GLOB_PATTERNS = ['./**', '!.git'];

export const isExecutable = (fileMode: number | undefined) => {
  if (!fileMode) {
    return false;
  }

  const executeBitMask = 0o000111;
  const res = fileMode & executeBitMask;
  return res > 0;
};

async function asyncFilter<T>(
  array: T[],
  callback: (value: T, index: number, array: T[]) => Promise<boolean>,
): Promise<T[]> {
  const filterMap = await Promise.all(array.map(callback));
  return array.filter((_value, index) => filterMap[index]);
}

export async function serializeDirectoryContents(
  sourcePath: string,
  options?: {
    gitignore?: boolean;
    globPatterns?: string[];
  },
): Promise<SerializedFile[]> {
  const paths = await globby(options?.globPatterns ?? DEFAULT_GLOB_PATTERNS, {
    cwd: sourcePath,
    dot: true,
    gitignore: options?.gitignore,
    followSymbolicLinks: false,
    // In order to pick up 'broken' symlinks, we oxymoronically request files AND folders yet we filter out folders
    // This is because broken symlinks aren't classed as files so we need to glob everything
    onlyFiles: false,
    objectMode: true,
    stats: true,
  });

  const limiter = limiterFactory(10);

  const valid = await asyncFilter(paths, async ({ dirent, path }) => {
    if (dirent.isDirectory()) return false;
    if (!dirent.isSymbolicLink()) return true;

    const safePath = resolveSafeChildPath(sourcePath, path);

    // we only want files that don't exist
    try {
      await fs.stat(safePath);
      return false;
    } catch (e) {
      return isError(e) && e.code === 'ENOENT';
    }
  });

  return Promise.all(
    valid.map(async ({ dirent, path, stats }) => ({
      path,
      content: await limiter(async () => {
        const absFilePath = resolveSafeChildPath(sourcePath, path);
        if (dirent.isSymbolicLink()) {
          return fs.readlink(absFilePath, 'buffer');
        }
        return fs.readFile(absFilePath);
      }),
      executable: isExecutable(stats?.mode),
      symlink: dirent.isSymbolicLink(),
    })),
  );
}
