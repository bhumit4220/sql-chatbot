export const AGENT_PORT = 9876;
export const AGENT_HOST = '127.0.0.1';
export const AGENT_BASE_URL = `http://${AGENT_HOST}:${AGENT_PORT}`;

export const SESSION_TOKEN_EXPIRY_HOURS = 4;
export const SESSION_TOKEN_GRACE_SECONDS = 5; // N1 fix: parallel request support
export const RATE_LIMIT_PER_MINUTE = 60;
export const MAX_REQUEST_BODY_KB = 10;
export const MAX_SQL_ROWS = 500;
export const MAX_HISTORY_MESSAGES = 10;

export const CHAT_HISTORY_RETENTION_DAYS = 7;
export const CRAWL_EXPIRY_DAYS = 30;

export const DEFAULT_LLM_PROVIDER = 'openai';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const AGENT_DATA_DIR = '.chatbot-agent';
export const VAULT_FILE = 'vault.enc';
export const CODE_INDEX_DB = 'code-index.db';
export const DISCOVERY_DB = 'discovery.db';
export const LOG_FILE = 'agent.log';
export const LOG_MAX_SIZE_MB = 50;

// Indexed file types (code understanding)
export const INDEXED_EXTENSIONS = new Set([
  '.rb', '.py', '.js', '.ts', '.go', '.java', '.php', '.ex', '.rs', '.cs',
  '.erb', '.html', '.jsx', '.tsx', '.vue', '.blade.php', '.ejs', '.hbs',
  '.sql', '.graphql',
  '.md',
]);

// Never index these files/dirs
export const EXCLUDED_PATHS = [
  '.env', '.env.*', '*.env',
  'credentials.*', 'secrets.*', 'master.key', 'config/master.key',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.cert', '*.crt',
  'id_rsa', 'id_ed25519', 'authorized_keys', 'known_hosts',
  '.git/', 'node_modules/', 'vendor/', 'venv/', '__pycache__/', '.bundle/',
  '*.log', '*.lock', 'package-lock.json', 'yarn.lock',
  'docker-compose*.yml',
  'database.yml', 'database.yml.enc',
  '*.sqlite3', '*.db',
];

// Content patterns that indicate secrets (reject files containing these)
export const SECRET_PATTERNS = [
  /password\s*=/i, /api_key\s*=/i, /secret_key\s*=/i,
  /private_key\s*=/i, /access_token\s*=/i,
  /AWS_SECRET/i, /STRIPE_SECRET/i, /GITHUB_TOKEN/i,
  /BEGIN RSA PRIVATE KEY/, /BEGIN OPENSSH PRIVATE KEY/,
  /connection_string\s*=/i, /DATABASE_URL\s*=/i,
];

// PII column patterns (never sample values from these)
export const PII_COLUMN_PATTERNS = [
  'email', 'phone', 'address', 'first_name', 'last_name', 'name',
  'dob', 'date_of_birth', 'ssn', 'ip_address', 'password', 'token',
  'secret', 'salt', 'bank', 'card', 'stripe',
];

// V3 Cloud
export const CLOUD_API_BASE = process.env.CHATBOT_CLOUD_URL || 'https://api.chatbot-agent.com';
export const CLOUD_TIMEOUT_MS = 30_000;
export const CLOUD_RATE_LIMIT = 100; // per minute per key

// V3 Middleware
export const MIDDLEWARE_VERSION = '1.0.0';
export const SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour
export const CODE_INDEX_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
export const ENUM_SAMPLE_TIMEOUT_MS = 5_000;  // 5s per table
export const ENUM_MAX_TABLES = 100;
export const ENUM_MAX_ROW_COUNT = 1_000_000;  // skip tables > 1M rows
