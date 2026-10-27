import type { LlmProviderProfile, RunProjection } from '@achbit/protocol';

/** Queued messages use the running Provider's frozen input capability. */
export function supportsNativeFileInput(
  mediaType: string,
  profile: LlmProviderProfile | undefined,
  run?: RunProjection | null,
): boolean {
  if (run && ['running', 'waiting'].includes(run.status)) {
    return run.fileInputMediaTypes?.includes(mediaType) === true;
  }
  return profile?.kind === 'openaiCompatible' && profile.fileInputMediaTypes?.includes(mediaType) === true;
}
