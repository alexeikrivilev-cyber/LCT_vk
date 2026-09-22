import type { Express } from 'express';
import type {
  LCTDiscordPresenceResponse,
  LCTGithubLatestReleaseResponse,
  LCTGithubRepoResponse,
} from '@lct/contracts';
import type { RouteDeps } from '../server-context.js';
import {
  LCT_DISCORD_INVITE_URL,
  type LCTPublicMetadataService,
} from '../services/lct-public-metadata.js';

export interface RegisterLCTPublicMetadataRoutesDeps extends RouteDeps<'http'> {
  lctPublicMetadata: LCTPublicMetadataService;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerLCTPublicMetadataRoutes(
  app: Express,
  ctx: RegisterLCTPublicMetadataRoutesDeps,
): void {
  const { lctPublicMetadata } = ctx;

  app.get('/api/github/lct', async (_req, res) => {
    try {
      const stats = await lctPublicMetadata.readGithubRepoStats();
      const payload: LCTGithubRepoResponse = {
        repo: 'nexu-io/lct',
        stargazers_count: stats.stargazersCount,
        fetchedAt: stats.fetchedAt,
        stale: stats.stale,
      };
      res.json(payload);
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/github/lct/releases/latest', async (_req, res) => {
    try {
      const release = await lctPublicMetadata.readLatestReleaseInfo();
      const payload: LCTGithubLatestReleaseResponse = {
        repo: 'nexu-io/lct',
        tag_name: release.tagName,
        html_url: release.htmlUrl,
        fetchedAt: release.fetchedAt,
        stale: release.stale,
      };
      res.json(payload);
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/community/discord', async (_req, res) => {
    try {
      const presence = await lctPublicMetadata.readDiscordPresence();
      const payload: LCTDiscordPresenceResponse = {
        inviteCode: 'mHAjSMV6gz',
        inviteUrl: LCT_DISCORD_INVITE_URL,
        onlineCount: presence.onlineCount,
        memberCount: presence.memberCount,
        fetchedAt: presence.fetchedAt,
        stale: presence.stale,
      };
      res.json(payload);
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });
}
