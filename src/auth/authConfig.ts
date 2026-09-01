import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Aligné sur `shai-core` / `ShaiConfig` (ovh/shai). */
export interface ProviderConfig {
    provider: string;
    env_vars: Record<string, string>;
    model: string;
    tool_method: 'FunctionCall' | 'Auto' | 'FunctionCallRequired' | 'StructuredOutput' | 'Parsing';
}

export interface ShaiAuthConfig {
    providers: ProviderConfig[];
    selected_provider: number;
    mcp_configs?: Record<string, unknown>;
}

export type EnvField = {
    key: string;
    label: string;
    secret?: boolean;
    optional?: boolean;
    placeholder?: string;
    /** One-line inline explanation of what this field expects. (Req 1.1, 1.2) */
    help?: string;
    /** Realistic sample value used as the input placeholder. (Req 1.1, 1.3) */
    example?: string;
};

/** Champs attendus par `LlmClient::create_provider` (shai-llm). */
export const PROVIDER_ENV_FIELDS: Record<string, EnvField[]> = {
    anthropic: [
        {
            key: 'ANTHROPIC_API_KEY',
            label: 'ANTHROPIC_API_KEY',
            secret: true,
            help: 'Your Anthropic API key. Create one in the Anthropic Console.',
            example: 'sk-ant-api03-...',
        },
    ],
    openai: [
        {
            key: 'OPENAI_API_KEY',
            label: 'OPENAI_API_KEY',
            secret: true,
            help: 'Your OpenAI API key. Create one in the OpenAI platform dashboard.',
            example: 'sk-...',
        },
    ],
    mistral: [
        {
            key: 'MISTRAL_API_KEY',
            label: 'MISTRAL_API_KEY',
            secret: true,
            help: 'Your Mistral API key. Create one in the Mistral console.',
            example: 'your-mistral-api-key',
        },
    ],
    openrouter: [
        {
            key: 'OPENROUTER_API_KEY',
            label: 'OPENROUTER_API_KEY',
            secret: true,
            help: 'Your OpenRouter API key. Create one in the OpenRouter dashboard.',
            example: 'sk-or-v1-...',
        },
    ],
    ollama: [
        {
            key: 'OLLAMA_BASE_URL',
            label: 'OLLAMA_BASE_URL',
            optional: true,
            placeholder: 'http://localhost:11434/v1',
            help: 'Base URL of your local Ollama server (OpenAI-compatible endpoint).',
            example: 'http://localhost:11434/v1',
        },
    ],
    ovhcloud: [
        {
            key: 'OVH_API_KEY',
            label: 'OVH_API_KEY',
            optional: true,
            secret: true,
            help: 'Your OVHcloud AI Endpoints API key.',
            example: 'your-ovh-api-key',
        },
        {
            key: 'OVH_BASE_URL',
            label: 'OVH_BASE_URL',
            optional: true,
            placeholder: 'https://…/v1',
            help: 'Base URL of your OVHcloud AI Endpoints (OpenAI-compatible endpoint).',
            example: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
        },
    ],
    openai_compatible: [
        {
            key: 'OPENAI_COMPATIBLE_API_KEY',
            label: 'OPENAI_COMPATIBLE_API_KEY',
            secret: true,
            help: 'API key for your OpenAI-compatible provider.',
            example: 'your-api-key',
        },
        {
            key: 'OPENAI_COMPATIBLE_BASE_URL',
            label: 'OPENAI_COMPATIBLE_BASE_URL',
            help: 'Base URL of your OpenAI-compatible provider endpoint.',
            example: 'https://api.example.com/v1',
        },
    ],
};

/** Per-provider guidance for the model field. (Req 2.1, 2.2) */
export const MODEL_HELP: Record<string, string> = {
    anthropic: 'Enter a Claude model id, e.g. claude-sonnet-4-20250514.',
    openai: 'Enter an OpenAI model id, e.g. gpt-4o.',
    mistral: 'Enter a Mistral model id, e.g. mistral-large-latest.',
    openrouter: 'Enter an OpenRouter model id, e.g. anthropic/claude-3.5-sonnet.',
    ollama: 'Enter the name of a model you have pulled locally, e.g. llama3.1.',
    ovhcloud:
        'Choose a model from the list, or select "Other…" to enter a custom model identifier.',
    openai_compatible:
        'Enter the model identifier expected by your OpenAI-compatible provider, e.g. gpt-4o.',
};

/** Safe accessor for model-field guidance: never returns undefined. (Req 2.1) */
export function getModelHelp(providerId: string): string {
    return MODEL_HELP[providerId] ?? 'Enter the model identifier expected by this provider.';
}

/**
 * Modèles courants pour OVHcloud AI Endpoints (Kepler / OpenAI-compatible).
 * Ajoutez des IDs si votre endpoint en expose d’autres.
 */
export const OVHCLOUD_MODEL_OPTIONS: string[] = [
    'Qwen3-32B',
    'Qwen3-32B-Instruct',
    'Qwen2.5-72B-Instruct',
    'Qwen2.5-32B-Instruct',
    'Qwen2.5-14B-Instruct',
    'Meta-Llama-3.1-70B-Instruct',
    'Mistral-Nemo-Instruct-2407',
];

export const PROVIDER_LABELS: { id: string; label: string }[] = [
    { id: 'anthropic', label: 'Anthropic (Claude)' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'mistral', label: 'Mistral' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'ollama', label: 'Ollama' },
    { id: 'ovhcloud', label: 'OVHcloud AI Endpoints' },
    { id: 'openai_compatible', label: 'OpenAI-compatible (custom URL)' },
];

export function getAuthConfigPath(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    const dir = xdg ? path.join(xdg, 'shai') : path.join(os.homedir(), '.config', 'shai');
    return path.join(dir, 'auth.config');
}

export function loadAuthConfig(): ShaiAuthConfig {
    const p = getAuthConfigPath();
    if (!fs.existsSync(p)) {
        return { providers: [], selected_provider: 0, mcp_configs: {} };
    }
    const raw = fs.readFileSync(p, 'utf8');
    let data: ShaiAuthConfig;
    try {
        data = JSON.parse(raw) as ShaiAuthConfig;
    } catch {
        throw new Error('Invalid auth.config (JSON).');
    }
    if (!Array.isArray(data.providers)) {
        data.providers = [];
    }
    if (typeof data.selected_provider !== 'number' || data.selected_provider < 0) {
        data.selected_provider = 0;
    }
    if (!data.mcp_configs) {
        data.mcp_configs = {};
    }
    return data;
}

export function saveAuthConfig(config: ShaiAuthConfig): void {
    const p = getAuthConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
    try {
        fs.chmodSync(p, 0o600);
    } catch {
        /* Windows ou FS sans chmod */
    }
}

/**
 * Build an actionable required-field error that names the field and states the
 * action needed to fix it. (Req 6.1, design §3)
 */
export function describeRequiredFieldError(label: string): string {
    return `Field "${label}" is required. Enter a value for ${label} before saving.`;
}

export function validateNewProvider(
    providerId: string,
    envVars: Record<string, string>,
    model: string
): string | null {
    const m = model.trim();
    if (!m) {
        return 'A model name is required. Enter the model identifier for the selected provider.';
    }
    const fields = PROVIDER_ENV_FIELDS[providerId];
    if (!fields) {
        return 'Unknown provider.';
    }
    for (const f of fields) {
        if (f.optional) {
            continue;
        }
        const v = (envVars[f.key] || '').trim();
        if (!v) {
            return describeRequiredFieldError(f.label);
        }
    }
    return null;
}

/** Same rules as `ShaiConfig::remove_provider` in shai-core (cannot remove the last profile). */
export function removeProviderAt(config: ShaiAuthConfig, index: number): string | null {
    if (config.providers.length <= 1) {
        return 'Cannot remove the last profile.';
    }
    if (index < 0 || index >= config.providers.length) {
        return 'Invalid profile index.';
    }
    config.providers.splice(index, 1);
    if (config.selected_provider >= config.providers.length) {
        config.selected_provider = config.providers.length - 1;
    } else if (config.selected_provider > index) {
        config.selected_provider -= 1;
    }
    return null;
}

/**
 * Write edited values into an existing provider entry.
 * Validation mirrors saveNew (validateNewProvider). The entry's tool_method
 * and the config's selected_provider are preserved. Returns an error string
 * on failure (config left untouched), or null on success.
 */
export function updateProviderAt(
    config: ShaiAuthConfig,
    index: number,
    providerId: string,
    envVars: Record<string, string>,
    model: string
): string | null {
    if (!Number.isInteger(index) || index < 0 || index >= config.providers.length) {
        return 'Invalid profile index.';
    }
    const provider = (providerId || '').trim();
    const m = (model || '').trim();
    const err = validateNewProvider(provider, envVars, m);
    if (err) {
        return err;
    }
    const existing = config.providers[index];
    config.providers[index] = {
        provider,
        env_vars: { ...envVars },
        model: m,
        tool_method: existing.tool_method, // preserved; no UI control (Req 2.8)
    };
    // selected_provider intentionally left unchanged (Req 5.1)
    return null;
}
