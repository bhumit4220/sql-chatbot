export interface AgentConfig {
  databaseUrl: string;
  codePaths: string[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export function resolveConfig(
  userConfig: Partial<AgentConfig> & { databaseUrl: string; groqApiKey?: string }
): AgentConfig {
  if (!userConfig.databaseUrl) {
    throw new Error('databaseUrl is required');
  }

  const llmApiKey =
    userConfig.llmApiKey ||
    userConfig.groqApiKey ||
    process.env.LLM_API_KEY ||
    process.env.GROQ_API_KEY;

  if (!llmApiKey) {
    throw new Error(
      'An LLM API key is required. Provide llmApiKey, groqApiKey, or set LLM_API_KEY / GROQ_API_KEY environment variable.'
    );
  }

  return {
    databaseUrl: userConfig.databaseUrl,
    codePaths: userConfig.codePaths || ['./src'],
    llmBaseUrl: userConfig.llmBaseUrl || process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    llmApiKey,
    llmModel: userConfig.llmModel || process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
  };
}
