export interface PresentationImageModel {
  id: string;
  label: string;
  provider: 'openai-compatible';
  supportsReferences: boolean;
}

export interface PresentationImageConfig {
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  configured: boolean;
}

export function presentationImageConfig(env: NodeJS.ProcessEnv = process.env): PresentationImageConfig {
  const baseUrl = env.LCT_IMAGE_BASE_URL?.trim().replace(/\/$/, '') || null;
  const model = env.LCT_IMAGE_MODEL?.trim() || null;
  const apiKey = env.LCT_IMAGE_API_KEY?.trim() || null;
  return { baseUrl, model, apiKey, configured: Boolean(baseUrl && model) };
}

export function presentationImageModels(env: NodeJS.ProcessEnv = process.env): PresentationImageModel[] {
  const config = presentationImageConfig(env);
  if (!config.configured || !config.model) return [];
  return [{ id: config.model, label: config.model, provider: 'openai-compatible', supportsReferences: false }];
}
