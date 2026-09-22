type ProgressFn = (message: string) => void;

export type VelaMediaImageRef = { abs: string };

export interface VelaImageRenderInput {
  aspect: string | undefined;
  imageRefs: VelaMediaImageRef[];
  model: string;
  prompt: string;
  quality: string | undefined;
  resolution: string | undefined;
  wireModel: string;
  workspaceId: string | undefined;
}

export interface VelaVideoRenderInput extends VelaImageRenderInput {
  length: number | undefined;
  onProgress: ProgressFn | undefined;
}

export interface VelaRenderResult {
  bytes: Buffer;
  providerNote: string;
  suggestedExt?: string;
}

export const VELA_MEDIA_CLI_INCOMPATIBLE_CODE = 'MEDIA_PROVIDER_REMOVED';
export const VELA_SAFETY_REJECTION_CODE = 'safety_rejection';
export type VelaSafetySubject = 'prompt' | 'input_image' | 'output_image';

export class VelaMediaError extends Error {
  readonly code: string;
  readonly subject: VelaSafetySubject | undefined;
  readonly retryable: boolean | undefined;

  constructor(
    message: string,
    detail: { code: string; subject?: VelaSafetySubject; retryable?: boolean },
  ) {
    super(message);
    this.name = 'VelaMediaError';
    this.code = detail.code;
    this.subject = detail.subject;
    this.retryable = detail.retryable;
  }
}

export function velaMediaErrorFromFailure(): VelaMediaError | undefined {
  return undefined;
}

function removed(): never {
  throw new VelaMediaError(
    'The Vela/AMR media adapter was removed with the generic OpenDesign account runtime. Use a direct media provider in the presentation core.',
    { code: VELA_MEDIA_CLI_INCOMPATIBLE_CODE, retryable: false },
  );
}

export async function renderVelaImage(_input: VelaImageRenderInput): Promise<VelaRenderResult> {
  return removed();
}

export async function renderVelaVideo(_input: VelaVideoRenderInput): Promise<VelaRenderResult> {
  return removed();
}
