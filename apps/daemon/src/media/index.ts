import path from 'node:path';
import { writePresentationFile } from '../presentation-files.js';

export interface GeneratePresentationImageInput {
  projectsRoot: string;
  projectId: string;
  prompt: string;
  model?: string;
  output?: string;
  aspect?: string;
  quality?: string;
}

type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

function imageSize(aspect?: string): string {
  switch (aspect?.trim()) {
    case '16:9':
    case '3:2':
      return '1536x1024';
    case '9:16':
    case '2:3':
      return '1024x1536';
    default:
      return '1024x1024';
  }
}

function imageConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.LCT_IMAGE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || '';
  const baseUrl = (env.LCT_IMAGE_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = env.LCT_IMAGE_MODEL?.trim() || 'gpt-image-1';
  return { apiKey, baseUrl, model };
}

function safeOutput(value?: string): string {
  const raw = value?.trim() || `media/generated-${Date.now()}.png`;
  const ext = path.extname(raw).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return `${raw}.png`;
  return raw;
}

async function responseBytes(item: NonNullable<ImageResponse['data']>[number]): Promise<Buffer> {
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`generated image download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('image provider returned no image bytes');
}

export async function generatePresentationImage(input: GeneratePresentationImageInput) {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('image prompt is required');

  const config = imageConfig();
  if (!config.apiKey) {
    const error = new Error('image generation is not configured; set LCT_IMAGE_API_KEY or OPENAI_API_KEY') as Error & { status?: number };
    error.status = 503;
    throw error;
  }

  const model = input.model?.trim() || config.model;
  const response = await fetch(`${config.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: imageSize(input.aspect),
      ...(input.quality?.trim() ? { quality: input.quality.trim() } : {}),
    }),
  });

  const payload = await response.json().catch(() => ({})) as ImageResponse;
  if (!response.ok) {
    const error = new Error(payload.error?.message || `image provider failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const item = payload.data?.[0];
  if (!item) throw new Error('image provider returned an empty result');
  const bytes = await responseBytes(item);
  const output = safeOutput(input.output);
  const file = await writePresentationFile(input.projectsRoot, input.projectId, output, bytes);

  return {
    file,
    model,
    surface: 'image' as const,
    revisedPrompt: item.revised_prompt ?? null,
  };
}
