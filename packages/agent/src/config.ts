export type LLMProvider = 'groq' | 'ollama' | 'openai' | 'openrouter';

export const PROVIDER_PRESETS: Record<LLMProvider, { baseUrl: string; model: string }> = {
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',  model: 'llama-3.3-70b-versatile' },
  ollama:     { baseUrl: 'http://localhost:11434/v1',        model: 'llama3.1:8b' },
  openai:     { baseUrl: 'https://api.openai.com/v1',       model: 'gpt-4o-mini' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',    model: 'openrouter/free' },
};

export interface AgentConfig {
  databaseUrl: string;
  codePaths: string[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  provider?: LLMProvider;
  secret?: string;
}

export function resolveConfig(
  userConfig: Partial<AgentConfig> & { databaseUrl: string; groqApiKey?: string }
): AgentConfig {
  if (!userConfig.databaseUrl) {
    throw new Error('databaseUrl is required');
  }

  // Resolve API key from all sources
  const llmApiKey =
    userConfig.llmApiKey ||
    userConfig.groqApiKey ||
    process.env.LLM_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY;

  // Auto-detect provider: explicit > env > detect from key source > default groq
  const provider: LLMProvider =
    userConfig.provider ||
    (process.env.LLM_PROVIDER as LLMProvider | undefined) ||
    (process.env.OPENROUTER_API_KEY ? 'openrouter' : 'groq');

  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.groq;

  // For ollama, use a dummy key (no auth needed)
  const resolvedApiKey = llmApiKey || (provider === 'ollama' ? 'ollama' : undefined);

  if (!resolvedApiKey) {
    throw new Error(
      'An LLM API key is required. Provide --key flag, set LLM_API_KEY or OPENROUTER_API_KEY env var.\n' +
      'Get a free key at: https://openrouter.ai/keys'
    );
  }

  return {
    databaseUrl: userConfig.databaseUrl,
    codePaths: userConfig.codePaths || ['./src'],
    llmBaseUrl: userConfig.llmBaseUrl || process.env.LLM_BASE_URL || preset.baseUrl,
    llmApiKey: resolvedApiKey,
    llmModel: userConfig.llmModel || process.env.LLM_MODEL || preset.model,
    provider,
    secret: userConfig.secret || process.env.CHATBOT_SECRET || undefined,
  };
}
