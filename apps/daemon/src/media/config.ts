// Direct media-provider configuration for the presentation core.
// No account runtime, OAuth broker, workspace billing or sandbox profile.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ProviderConfig = { apiKey?: string; baseUrl?: string; model?: string };
type StoredConfig = { providers?: Record<string, ProviderConfig>; aliases?: Record<string, string> };

const ENV_KEYS: Record<string, string[]> = {
  openai: ['OD_OPENAI_API_KEY', 'OPENAI_API_KEY', 'AZURE_API_KEY', 'AZURE_OPENAI_API_KEY'],
  volcengine: ['OD_VOLCENGINE_API_KEY', 'ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  grok: ['OD_GROK_API_KEY', 'XAI_API_KEY'],
  nanobanana: ['OD_NANOBANANA_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  imagerouter: ['OD_IMAGEROUTER_API_KEY', 'IMAGEROUTER_API_KEY'],
  openrouter: ['OD_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  'custom-image': ['OD_CUSTOM_IMAGE_API_KEY', 'CUSTOM_IMAGE_API_KEY'],
  bfl: ['OD_BFL_API_KEY', 'BFL_API_KEY'],
  fal: ['OD_FAL_KEY', 'FAL_KEY'],
  replicate: ['OD_REPLICATE_API_TOKEN', 'REPLICATE_API_TOKEN'],
  google: ['OD_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  kling: ['OD_KLING_API_KEY', 'KLING_API_KEY'],
  midjourney: ['OD_MIDJOURNEY_API_KEY'],
  minimax: ['OD_MINIMAX_API_KEY', 'MINIMAX_API_KEY'],
  suno: ['OD_SUNO_API_KEY'],
  udio: ['OD_UDIO_API_KEY'],
  elevenlabs: ['OD_ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEY'],
  fishaudio: ['OD_FISHAUDIO_API_KEY', 'FISH_AUDIO_API_KEY'],
  senseaudio: ['OD_SENSEAUDIO_API_KEY', 'SENSEAUDIO_API_KEY'],
  aihubmix: ['OD_AIHUBMIX_API_KEY', 'AIHUBMIX_API_KEY'],
  leonardo: ['OD_LEONARDO_API_KEY', 'LEONARDO_API_KEY'],
};

const BASE_URL_ENV: Record<string, string[]> = {
  openai: ['OD_OPENAI_BASE_URL', 'OPENAI_BASE_URL', 'AZURE_OPENAI_ENDPOINT'],
  grok: ['OD_GROK_BASE_URL', 'XAI_BASE_URL'],
  openrouter: ['OD_OPENROUTER_BASE_URL', 'OPENROUTER_BASE_URL'],
  aihubmix: ['OD_AIHUBMIX_BASE_URL', 'AIHUBMIX_BASE_URL'],
  'custom-image': ['OD_CUSTOM_IMAGE_BASE_URL', 'CUSTOM_IMAGE_BASE_URL'],
};

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function configDir(projectRoot: string): string {
  const raw = process.env.OD_MEDIA_CONFIG_DIR?.trim() || process.env.OD_DATA_DIR?.trim();
  if (!raw) return path.join(projectRoot, '.od');
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

async function readStored(projectRoot: string): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(path.join(configDir(projectRoot), 'media-config.json'), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredConfig : {};
  } catch {
    return {};
  }
}

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export async function resolveProviderConfig(projectRoot: string, providerId: string): Promise<ProviderConfig> {
  const stored = (await readStored(projectRoot)).providers?.[providerId] ?? {};
  const apiKey = firstEnv(ENV_KEYS[providerId] ?? []);
  const baseUrl = firstEnv(BASE_URL_ENV[providerId] ?? []);
  return {
    ...(stored.apiKey ? { apiKey: stored.apiKey } : {}),
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.model ? { model: stored.model } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export async function resolveModelAlias(projectRoot: string, modelId: string): Promise<string> {
  const envAliases = process.env.OD_MEDIA_MODEL_ALIASES?.trim();
  if (envAliases) {
    try {
      const parsed = JSON.parse(envAliases) as Record<string, unknown>;
      const alias = parsed?.[modelId];
      if (typeof alias === 'string' && alias.trim()) return alias.trim();
    } catch {}
  }
  const stored = (await readStored(projectRoot)).aliases?.[modelId];
  return typeof stored === 'string' && stored.trim() ? stored.trim() : modelId;
}
