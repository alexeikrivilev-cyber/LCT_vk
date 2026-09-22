export interface PresentationImageModel {
  id: string;
  label: string;
  provider: 'openai-compatible';
  supportsReferences: boolean;
}

const DEFAULT_MODELS: PresentationImageModel[] = [
  { id: 'gpt-image-1', label: 'GPT Image 1', provider: 'openai-compatible', supportsReferences: false },
];

export function presentationImageModels(env: NodeJS.ProcessEnv = process.env): PresentationImageModel[] {
  const configured = env.LCT_IMAGE_MODEL?.trim();
  if (!configured || configured === DEFAULT_MODELS[0].id) return DEFAULT_MODELS.map((model) => ({ ...model }));
  return [
    { id: configured, label: configured, provider: 'openai-compatible', supportsReferences: false },
    ...DEFAULT_MODELS.map((model) => ({ ...model })),
  ];
}
