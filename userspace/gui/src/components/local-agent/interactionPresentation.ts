import type { InteractionProjection, ProjectionMessage } from '@achbit/protocol';

export function interactionResponseLabel(interaction: InteractionProjection | undefined, response: string): string {
  return interaction?.options?.find(option => option.id === response)?.label ?? response;
}

/** Keep the recorded response ID intact; show its human label on every GUI surface. */
export function messageDisplayText(message: ProjectionMessage, interactions: InteractionProjection[]): string {
  if (!message.replyToInteraction) return message.displayContent ?? message.content;
  const question = interactions.find(item => item.interactionId === message.replyToInteraction!.interactionId);
  return interactionResponseLabel(question, message.content);
}
