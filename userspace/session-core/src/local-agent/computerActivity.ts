import type { ActivityProjection, ArtifactProjection, ComputerActivityProjection, JsonObject, ToolExecutionRecord } from '@achbit/protocol';

const tools = new Set(['computer.control', 'browser.open', 'browser.page', 'browser.observe', 'browser.capture']);
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function computerRequest(toolName: string, input: JsonObject): ComputerActivityProjection | undefined {
  if (!tools.has(toolName)) return undefined;
  const action = typeof input.action === 'string' ? input.action : toolName.slice(toolName.indexOf('.') + 1);
  return { action: action === 'act' && typeof input.operation === 'string' ? input.operation : action,
    input: structuredClone(input), ...(typeof input.app === 'string' ? { app: input.app } : {}) };
}

export function projectComputerActivity(record: ToolExecutionRecord, artifacts: ArtifactProjection[],
  activities: Record<string, ActivityProjection>): ComputerActivityProjection | undefined {
  const detail = computerRequest(record.toolName, record.preparedEffect.canonicalInvocation.arguments);
  if (!detail) return undefined;
  const input = detail.input;
  // An element label belongs to the exact observation used for input, never to a later frame.
  if (typeof input.observationId === 'string') {
    const previous = Object.values(activities).find(activity => activity.runId === record.runId
      && activity.tool?.computer?.app === detail.app
      && activity.tool?.computer?.observation?.observationId === input.observationId)?.tool?.computer;
    if (previous?.observation) {
      const elements = previous.observation.interface?.elements;
      const element = Array.isArray(elements) && typeof input.elementId === 'string'
        ? elements.find(item => object(item) && item.elementId === input.elementId) : undefined;
      detail.inputObservation = { observationId: input.observationId,
        artifactIds: [...previous.observation.artifactIds], ...(object(element) ? { element: structuredClone(element) } : {}) };
      if (previous.window) detail.window = structuredClone(previous.window);
    }
  }
  const output = 'output' in record && object(record.output) ? record.output : undefined;
  if (!output) return detail;
  if (typeof output.app === 'string') detail.app = output.app;
  if (object(output.window)) detail.window = structuredClone(output.window);
  const page = object(output.sourcePage) ? output.sourcePage : object(output.page) ? output.page : undefined;
  if (page) detail.page = structuredClone(page);
  else if (typeof output.previewId === 'string') {
    detail.page = { previewId: output.previewId };
    for (const key of ['url', 'title', 'status']) {
      if (output[key] !== undefined) detail.page[key] = structuredClone(output[key]);
    }
  }
  if (typeof output.dispatched === 'boolean') detail.dispatched = output.dispatched;
  let interfaceSnapshot: JsonObject | undefined;
  if (Array.isArray(output.elements)) {
    interfaceSnapshot = { elements: structuredClone(output.elements),
      ...(object(output.accessibility) ? { accessibility: structuredClone(output.accessibility) } : {}) };
  } else if (object(output.observation)) {
    interfaceSnapshot = structuredClone(output.observation);
  } else if (detail.action === 'inspect' && object(output.result)) {
    interfaceSnapshot = structuredClone(output.result);
  }
  const artifactIds = artifacts.filter(item => item.contentMode === 'fixed' && item.contentType.startsWith('image/'))
    .map(item => item.artifactId);
  if (artifactIds.length || interfaceSnapshot || typeof output.observationId === 'string') {
    detail.observation = { artifactIds,
      ...(typeof output.observationId === 'string' ? { observationId: output.observationId } : {}),
      ...(interfaceSnapshot ? { interface: interfaceSnapshot } : {}) };
  }
  const result: JsonObject = {};
  for (const key of ['apps', 'windows', 'pages', 'executor', 'permissions', 'capabilities', 'status', 'mode', 'coordinateSpace', 'width', 'height', 'capturedAt', 'readiness', 'valueVerification', 'actionError', 'observationError']) {
    if (output[key] !== undefined) result[key] = structuredClone(output[key]);
  }
  if (detail.action !== 'inspect' && output.result !== undefined) result.result = structuredClone(output.result);
  if (Object.keys(result).length) detail.result = result;
  return detail;
}
