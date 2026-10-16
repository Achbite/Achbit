import type { ModelMessage, SessionEvent } from '@deepcode/protocol';
import type { ContextMessageContribution } from './plugins.js';

type ImageReference = {
  imageId: string;
  label: string;
  sequence: number;
  transient?: boolean;
} & (
  | { image: NonNullable<ModelMessage['images']>[number]; toolImage?: never }
  | { image?: never; toolImage: NonNullable<ModelMessage['toolImages']>[number] }
);

export function eventImages(event: SessionEvent): ImageReference[] {
  if (event.type === 'message.committed' && event.payload.role === 'user') {
    return (event.payload.filesystemReferences ?? []).flatMap(reference => (
      reference.kind === 'file' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(reference.mediaType)
        ? [{ imageId: reference.referenceId, label: reference.displayName, sequence: event.sequence,
          image: { workspaceId: reference.workspaceId, logicalPath: reference.logicalPath, mediaType: reference.mediaType } }]
        : []
    ));
  }
  if (event.type !== 'tool.completed' || event.payload.record.outcome !== 'completed') return [];
  const output = event.payload.record.output;
  if (!output || typeof output !== 'object' || Array.isArray(output) || !('modelImages' in output)) return [];
  if (!Array.isArray(output.modelImages)) throw new Error('Tool modelImages must be an array');
  return output.modelImages.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image) || typeof image.artifactId !== 'string') {
      throw new Error('Tool image artifactId is required');
    }
    if (image.purpose !== undefined && image.purpose !== 'observation') {
      throw new Error('Tool image purpose is invalid');
    }
    return { imageId: image.artifactId, label: image.artifactId, sequence: event.sequence,
      transient: image.purpose === 'observation',
      toolImage: { callId: event.callId, artifactId: image.artifactId } };
  });
}

export function imageCatalog(events: readonly SessionEvent[]): Map<string, ImageReference> {
  return new Map(events.flatMap(event => eventImages(event).map(image => [image.imageId, image] as const)));
}

export function readImageReferences(events: readonly SessionEvent[], imageIds: readonly string[]): ImageReference[] {
  const catalog = imageCatalog(events);
  return imageIds.map(id => {
    const image = catalog.get(id);
    if (!image) throw new Error(`session_image_not_found: ${id}`);
    return image;
  });
}

export function visualContextInstruction(sessionId: string, readerName: string): string {
  return `Historical image references contain no pixels. The final Current visual inputs messages identify the images attached to this request. User attachments, GUI observations and explicitly reopened images are attached for one successful model request, then archived references remain without pixels. Use ${readerName} with view=images, sessionId=${sessionId} and imageIds to reopen exact references or compare images; do not infer omitted visual details. Fresh tool images replace the preceding batch. Release unneeded pixels with imageIds=[].`;
}

/** Selection is replayed from existing input and tool facts; retries reuse the prepared request. */
export function visualContextMessages(events: readonly SessionEvent[], runId: string): ContextMessageContribution[] {
  const input = events.find(event => event.type === 'run.started' && event.runId === runId);
  const inputMessageId = input?.type === 'run.started' ? input.payload.inputMessageId : undefined;
  let attachments: ImageReference[] = [];
  let observations: ImageReference[] = [];
  let nextObservationBatch = true;
  const requests = new Map<string, Set<string>>();
  for (const event of events) {
    const currentInput = event.type === 'message.committed' && event.payload.messageId === inputMessageId;
    if (!currentInput && (!('runId' in event) || event.runId !== runId)) continue;
    if (event.type === 'run.host.rebound') {
      observations = [];
      nextObservationBatch = true;
    }
    if (event.type === 'context.composed' && event.payload.purpose === 'agent') {
      nextObservationBatch = true;
      requests.set(event.payload.providerRequestId, new Set(event.payload.messages.flatMap(message => (
        message.contributionId.startsWith('visual-input:') ? [message.contributionId.slice('visual-input:'.length)] : []
      ))));
    }
    if (event.type === 'provider.turn.settled' && event.payload.purpose === 'agent' && event.payload.outcome === 'completed') {
      const consumed = requests.get(event.payload.providerRequestId);
      attachments = attachments.filter(image => !consumed?.has(image.imageId));
      observations = observations.filter(image => !image.transient || !consumed?.has(image.imageId));
    }
    if (event.type === 'message.committed' && event.payload.role === 'user') {
      attachments.push(...eventImages(event));
    } else if (event.type === 'tool.completed' && event.payload.record.outcome === 'completed') {
      const record = event.payload.record;
      if (record.toolName === 'session.read' && record.input.view === 'images' && record.input.sessionId === event.sessionId && Array.isArray(record.input.imageIds)) {
        attachments = [];
        observations = readImageReferences(events, record.input.imageIds as string[]).map(image => ({ ...image, transient: true }));
        nextObservationBatch = true;
      } else {
        const images = eventImages(event);
        if (images.length) {
          if (nextObservationBatch) observations = [];
          observations.push(...images);
          nextObservationBatch = false;
        }
      }
    }
  }
  const selected = new Map([...attachments, ...observations].map(image => [image.imageId, image]));
  return [...selected.values()].map(image => ({
    contributionId: `visual-input:${image.imageId}`,
    contributionKind: 'contextProviders',
    label: image.label,
    message: {
      role: 'user',
      content: `Current visual inputs: ${JSON.stringify({ imageId: image.imageId, label: image.label })}`,
      ...(image.image ? { images: [image.image] } : { toolImages: [image.toolImage] }),
    },
  }));
}
