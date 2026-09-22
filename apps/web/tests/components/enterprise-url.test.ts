import { describe, expect, it } from 'vitest';

import { enterpriseUrl } from '../../src/components/enterpriseUrl';

describe('enterpriseUrl', () => {
  it('uses the deployed marketing origin in every environment', () => {
    expect(enterpriseUrl('en')).toBe('https://github.com/alexeikrivilev-cyber/LCT_vk/enterprise/');
    expect(enterpriseUrl('zh-CN')).not.toContain('127.0.0.1');
  });

  it('points active landing locales at their localized enterprise pages', () => {
    expect(enterpriseUrl('zh-CN')).toBe('https://github.com/alexeikrivilev-cyber/LCT_vk/zh/enterprise/');
    expect(enterpriseUrl('ja')).toBe('https://github.com/alexeikrivilev-cyber/LCT_vk/ja/enterprise/');
    expect(enterpriseUrl('pt-BR')).toBe('https://github.com/alexeikrivilev-cyber/LCT_vk/pt-br/enterprise/');
  });

  it('falls retired landing locales back to the default enterprise page', () => {
    for (const locale of ['zh-TW', 'pl', 'id', 'ar', 'uk']) {
      expect(enterpriseUrl(locale)).toBe('https://github.com/alexeikrivilev-cyber/LCT_vk/enterprise/');
    }
  });
});
