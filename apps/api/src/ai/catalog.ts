import type { Embedder } from './embeddings.js';
import type { AiChoice, Gateway } from './gateway.js';
import { PROVIDER_IDS, type ProviderId } from './types.js';

/** Every vendor LEANA knows, configured or not (the UI lists them all). */
export type AiCatalog = Record<
  ProviderId,
  { label: string; models: readonly string[]; defaultModel: string }
>;

/** What /ai/config returns: availability per provider, never any key. */
export function describeAi(
  catalog: AiCatalog,
  gateway: Gateway | null,
  embedder: Embedder | null = null,
) {
  return {
    configured: gateway !== null,
    default: gateway?.defaultChoice ?? null,
    // null = memory recall is lexical only (no embeddings provider configured).
    embeddings: embedder && { provider: embedder.provider, model: embedder.model },
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: catalog[id].label,
      configured: !!gateway?.providers[id],
      models: catalog[id].models,
      default_model: catalog[id].defaultModel,
    })),
  };
}

export type AiPreference = { ai_provider: ProviderId | null; ai_model: string | null };

/**
 * The stored preference as it applies today: dropped if its provider lost its key or the
 * model left the allowlist (the user then falls back to defaults, and sees it).
 */
export function effectivePreference(settings: unknown, gateway: Gateway | null): AiPreference {
  const s = (settings ?? {}) as { ai_provider?: unknown; ai_model?: unknown };
  const provider = s.ai_provider as ProviderId;
  if (!gateway || !gateway.providers[provider]) return { ai_provider: null, ai_model: null };
  const model = typeof s.ai_model === 'string' ? s.ai_model : null;
  const choice: Partial<AiChoice> = { provider, model: model ?? undefined };
  return { ai_provider: provider, ai_model: model && gateway.isAllowed(choice) ? model : null };
}
