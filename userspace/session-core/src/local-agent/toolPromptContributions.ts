import type {
  PluginUri,
  PreparedToolDescriptor,
  PreparedToolPromptContribution,
  ProviderRequest,
  ProviderToolAlias,
  SelectedPluginSnapshot,
  ToolPromptContribution,
  ToolPromptProviderSnapshot,
} from '@achbit/protocol';
import { LoopFailure } from './loopFailure.js';
import { CORE_TOOL_ORDER } from './providerToolCodec.js';

const MAX_TOOL_PROMPT_GUIDELINES = 8;
const MAX_PROMPT_SNIPPET_LENGTH = 512;
const MAX_PROMPT_GUIDELINE_LENGTH = 1_024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u;
const CANONICAL_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const PLUGIN_URI_PATTERN = /^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function decodeToolPromptProviderSnapshots(
  value: unknown,
): readonly ToolPromptProviderSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error('tool_prompt_providers_invalid');
  }
  const seenProviders = new Set<string>();
  const seenContributions = new Set<string>();
  return Object.freeze(value.map((candidate): ToolPromptProviderSnapshot => {
    const fields = ['providerRef', 'origin', 'contributions'];
    if (isRecord(candidate) && Object.hasOwn(candidate, 'pluginUri')) fields.push('pluginUri');
    if (
      !isExactRecord(candidate, fields)
      || !isIdentifier(candidate.providerRef)
      || seenProviders.has(candidate.providerRef)
      || candidate.origin !== 'coreBuiltin' && candidate.origin !== 'extension'
      || !Array.isArray(candidate.contributions)
      || candidate.origin === 'coreBuiltin' && candidate.pluginUri !== undefined
      || candidate.origin === 'extension'
        && (typeof candidate.pluginUri !== 'string'
          || !PLUGIN_URI_PATTERN.test(candidate.pluginUri))
    ) throw new Error('tool_prompt_providers_invalid');
    seenProviders.add(candidate.providerRef);
    const contributions = Object.freeze(candidate.contributions.map((contribution) => {
      const decoded = decodeToolPromptContribution(contribution);
      if (seenContributions.has(decoded.contributionRef)) {
        throw new Error('tool_prompt_contribution_duplicate');
      }
      seenContributions.add(decoded.contributionRef);
      return decoded;
    }));
    return Object.freeze(candidate.origin === 'coreBuiltin'
      ? {
          providerRef: candidate.providerRef,
          origin: 'coreBuiltin' as const,
          contributions: contributions as unknown as ToolPromptContribution[],
        }
      : {
          providerRef: candidate.providerRef,
          origin: 'extension' as const,
          pluginUri: candidate.pluginUri as PluginUri,
          contributions: contributions as unknown as ToolPromptContribution[],
        });
  }));
}

export function prepareToolPromptContributions(
  providers: readonly ToolPromptProviderSnapshot[],
  tools: readonly PreparedToolDescriptor[],
  selectedPlugins: SelectedPluginSnapshot,
): readonly PreparedToolPromptContribution[] {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const selectedPluginUris = new Set(selectedPlugins.plugins.map((plugin) => plugin.uri));
  const seenContributionRefs = new Set<string>();
  const seenToolNames = new Set<string>();
  const seenBindingRefs = new Set<string>();
  const prepared: PreparedToolPromptContribution[] = [];

  for (const provider of providers) {
    if (provider.origin === 'extension' && !selectedPluginUris.has(provider.pluginUri)) {
      throw new Error(`tool_prompt_provider_plugin_unselected:${provider.pluginUri}`);
    }
    for (const contribution of provider.contributions) {
      if (seenContributionRefs.has(contribution.contributionRef)) {
        throw new Error(`tool_prompt_contribution_duplicate:${contribution.contributionRef}`);
      }
      seenContributionRefs.add(contribution.contributionRef);
      if (seenToolNames.has(contribution.canonicalToolName)) {
        throw new Error(`tool_prompt_owner_conflict:${contribution.canonicalToolName}`);
      }
      seenToolNames.add(contribution.canonicalToolName);
      const tool = toolsByName.get(contribution.canonicalToolName);
      if (!tool) {
        throw new Error(`tool_prompt_target_missing:${contribution.canonicalToolName}`);
      }
      if (tool.origin !== provider.origin) {
        throw new Error(`tool_prompt_origin_mismatch:${contribution.canonicalToolName}`);
      }
      if (
        provider.origin === 'extension'
        && (tool.origin !== 'extension' || tool.pluginUri !== provider.pluginUri)
      ) {
        throw new Error(`tool_prompt_plugin_mismatch:${contribution.canonicalToolName}`);
      }
      if (tool.availability === 'blocked') continue;
      if (seenBindingRefs.has(tool.toolBindingRef)) {
        throw new Error(`tool_prompt_binding_conflict:${tool.toolBindingRef}`);
      }
      seenBindingRefs.add(tool.toolBindingRef);
      prepared.push(Object.freeze(provider.origin === 'coreBuiltin'
        ? {
            ...cloneContribution(contribution),
            preparedToolBindingRef: tool.toolBindingRef,
            origin: 'coreBuiltin' as const,
          }
        : {
            ...cloneContribution(contribution),
            preparedToolBindingRef: tool.toolBindingRef,
            origin: 'extension' as const,
            pluginUri: provider.pluginUri,
          }));
    }
  }

  return Object.freeze(prepared.sort(comparePreparedContributions));
}

export function renderActiveToolGuidance(
  contributions: readonly PreparedToolPromptContribution[],
  aliases: readonly ProviderToolAlias[],
  effectiveTools: readonly PreparedToolDescriptor[],
  hostedTools: ProviderRequest['hostedTools'],
): string | null {
  const toolsByName = new Map(effectiveTools
    .filter((tool) => tool.availability === 'callable')
    .map((tool) => [tool.name, tool]));
  const aliasesByCanonical = new Map(aliases.map((alias) => [alias.canonicalName, alias.wireName]));
  const snippets: string[] = [];
  const guidelines: string[] = [];

  for (const contribution of contributions) {
    const tool = toolsByName.get(contribution.canonicalToolName);
    if (!tool) continue;
    if (tool.toolBindingRef !== contribution.preparedToolBindingRef) {
      throw new LoopFailure(
        'tool_prompt_binding_stale',
        `工具指导与当前 binding 不一致：${contribution.canonicalToolName}`,
      );
    }
    const wireName = aliasesByCanonical.get(contribution.canonicalToolName);
    if (!wireName) {
      throw new LoopFailure(
        'tool_prompt_alias_missing',
        `工具指导缺少 Provider alias：${contribution.canonicalToolName}`,
      );
    }
    // The tool definition already carries its description in the same request.
    if (contribution.promptSnippet && contribution.promptSnippet !== tool.description) {
      snippets.push(`- ${wireName}: ${contribution.promptSnippet}`);
    }
    for (const guideline of contribution.usageGuidelines) {
      guidelines.push(`- ${wireName}: ${guideline}`);
    }
  }

  for (const tool of hostedTools) {
    snippets.push(`- ${tool.providerToolType}: Search by keyword; fetch reads known URLs. Cite sources and report search errors.`);
  }

  const sections: string[] = [];
  if (snippets.length > 0) sections.push(`Active tool guidance:\n${snippets.join('\n')}`);
  if (guidelines.length > 0) sections.push(`Guidelines:\n${guidelines.join('\n')}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function decodeToolPromptContribution(value: unknown): Readonly<ToolPromptContribution> {
  const fields = ['contributionRef', 'canonicalToolName', 'usageGuidelines'];
  if (isRecord(value) && Object.hasOwn(value, 'promptSnippet')) fields.push('promptSnippet');
  if (
    !isExactRecord(value, fields)
    || !isIdentifier(value.contributionRef)
    || typeof value.canonicalToolName !== 'string'
    || value.canonicalToolName.length > 128
    || !CANONICAL_TOOL_NAME_PATTERN.test(value.canonicalToolName)
    || value.promptSnippet !== undefined
      && !isPromptLine(value.promptSnippet, MAX_PROMPT_SNIPPET_LENGTH)
    || !Array.isArray(value.usageGuidelines)
    || value.usageGuidelines.length > MAX_TOOL_PROMPT_GUIDELINES
    || value.usageGuidelines.some((guideline) => (
      !isPromptLine(guideline, MAX_PROMPT_GUIDELINE_LENGTH)
    ))
    || value.promptSnippet === undefined && value.usageGuidelines.length === 0
  ) throw new Error('tool_prompt_contribution_invalid');
  return Object.freeze({
    contributionRef: value.contributionRef,
    canonicalToolName: value.canonicalToolName,
    ...(value.promptSnippet === undefined ? {} : { promptSnippet: value.promptSnippet }),
    usageGuidelines: Object.freeze([...value.usageGuidelines]) as unknown as string[],
  });
}

function cloneContribution(
  contribution: ToolPromptContribution,
): ToolPromptContribution {
  return {
    contributionRef: contribution.contributionRef,
    canonicalToolName: contribution.canonicalToolName,
    ...(contribution.promptSnippet === undefined
      ? {}
      : { promptSnippet: contribution.promptSnippet }),
    usageGuidelines: Object.freeze([
      ...contribution.usageGuidelines,
    ]) as unknown as string[],
  };
}

function comparePreparedContributions(
  left: PreparedToolPromptContribution,
  right: PreparedToolPromptContribution,
): number {
  if (left.origin !== right.origin) return left.origin === 'coreBuiltin' ? -1 : 1;
  if (left.origin === 'coreBuiltin' && right.origin === 'coreBuiltin') {
    const leftIndex = CORE_TOOL_ORDER.indexOf(
      left.canonicalToolName as typeof CORE_TOOL_ORDER[number],
    );
    const rightIndex = CORE_TOOL_ORDER.indexOf(
      right.canonicalToolName as typeof CORE_TOOL_ORDER[number],
    );
    return leftIndex - rightIndex
      || left.canonicalToolName.localeCompare(right.canonicalToolName, 'en')
      || left.contributionRef.localeCompare(right.contributionRef, 'en');
  }
  if (left.origin === 'extension' && right.origin === 'extension') {
    return left.pluginUri.localeCompare(right.pluginUri, 'en')
      || left.canonicalToolName.localeCompare(right.canonicalToolName, 'en')
      || left.contributionRef.localeCompare(right.contributionRef, 'en');
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && value.trim() === value
    && IDENTIFIER_PATTERN.test(value);
}

function isPromptLine(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && Array.from(value).length <= maxLength
    && value.trim() === value
    && Boolean(value)
    && !CONTROL_CHARACTER_PATTERN.test(value);
}
