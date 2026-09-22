import { describe, expect, it } from 'vitest';

import {
  buildSocialSharePayload,
  LCT_GITHUB_REPO_URL,
} from '../src/api/social-share';

describe('social-share contract', () => {
  it('builds LCT repository share targets', () => {
    const payload = buildSocialSharePayload({
      kind: 'lct-repo',
      locale: 'zh-CN',
      title: 'LCT GitHub',
      text: '推荐 LCT',
    });

    expect(payload.url).toBe(LCT_GITHUB_REPO_URL);
    expect(payload.locale).toBe('zh-CN');
    expect(payload.platforms.some((target) => target.platform === 'x' && target.shareUrl?.includes('twitter.com/intent/tweet'))).toBe(true);
    expect(payload.platforms.some((target) => target.platform === 'xiaohongshu' && target.mode === 'copy-open')).toBe(true);
  });

  it('keeps deployed project links and the repo recommendation together', () => {
    const payload = buildSocialSharePayload({
      kind: 'project-html',
      locale: 'en',
      url: 'https://example.com/lct-demo',
      title: 'Demo',
      text: `Built with LCT. Repo: ${LCT_GITHUB_REPO_URL}`,
      copyText: `Demo\nhttps://example.com/lct-demo\n${LCT_GITHUB_REPO_URL}`,
    });

    expect(payload.url).toBe('https://example.com/lct-demo');
    expect(payload.githubRepoUrl).toBe(LCT_GITHUB_REPO_URL);
    expect(payload.copyText).toContain(LCT_GITHUB_REPO_URL);
    expect(payload.platforms.find((target) => target.platform === 'telegram')?.shareUrl)
      .toContain('https%3A%2F%2Fexample.com%2Flct-demo');
  });
});
