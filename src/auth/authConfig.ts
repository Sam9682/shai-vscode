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
};

/** Champs attendus par `LlmClient::create_provider` (shai-llm). */
export const PROVIDER_ENV_FIELDS: Record<string, EnvField[]> = {
    anthropic: [
        { key: 'ANTHROPIC_API_KEY', label: 'ANTHROPIC_API_KEY', secret: true },
    ],
    openai: [{ key: 'OPENAI_API_KEY', label: 'OPENAI_API_KEY', secret: true }],
    mistral: [{ key: 'MISTRAL_API_KEY', label: 'MISTRAL_API_KEY', secret: true }],
    openrouter: [{ key: 'OPENROUTER_API_KEY', label: 'OPENROUTER_API_KEY', secret: true }],
    ollama: [
        {
            key: 'OLLAMA_BASE_URL',
            label: 'OLLAMA_BASE_URL',
            optional: true,
            placeholder: 'http://localhost:11434/v1',
        },
    ],
    ovhcloud: [
        { key: 'OVH_API_KEY', label: 'OVH_API_KEY', optional: true, secret: true },
        {
            key: 'OVH_BASE_URL',
            label: 'OVH_BASE_URL',
            optional: true,
            placeholder: 'https://…/v1',
        },
    ],
    openai_compatible: [
        { key: 'OPENAI_COMPATIBLE_API_KEY', label: 'OPENAI_COMPATIBLE_API_KEY', secret: true },
        { key: 'OPENAI_COMPATIBLE_BASE_URL', label: 'OPENAI_COMPATIBLE_BASE_URL' },
    ],
};

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

export function validateNewProvider(
    providerId: string,
    envVars: Record<string, string>,
    model: string
): string | null {
    const m = model.trim();
    if (!m) {
        return 'Please enter a model name.';
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
            return `Field ${f.label} is required.`;
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
