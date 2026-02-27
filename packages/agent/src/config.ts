export type LLMProvider = 'groq' | 'ollama' | 'openai';

export const PROVIDER_PRESETS: Record<LLMProvider, { baseUrl: string; model: string }> = {
  groq:   { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  ollama: { baseUrl: 'http://localhost:11434/v1',       model: 'llama3.1:8b' },
  openai: { baseUrl: 'https://api.openai.com/v1',      model: 'gpt-4o-mini' },
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
    process.env.GROQ_API_KEY;

  // Auto-detect provider: explicit > has key → groq, no key → ollama
  const provider: LLMProvider =
    userConfig.provider ||
    (process.env.LLM_PROVIDER as LLMProvider | undefined) ||
    (llmApiKey ? 'groq' : 'ollama');

  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.groq;

  // For ollama, use a dummy API key if none provided (OpenAI SDK requires one)
  const resolvedApiKey = llmApiKey || (provider === 'ollama' ? 'ollama' : undefined);

  if (!resolvedApiKey) {
    throw new Error(
      'An LLM API key is required. Provide llmApiKey, groqApiKey, or set LLM_API_KEY / GROQ_API_KEY environment variable. Or use provider: "ollama" for local models.'
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
