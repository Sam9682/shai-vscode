/**
 * Integration test (task 4.2) for the 0600 persistence side effect after an
 * update. Applies an update through `updateProviderAt` + `saveAuthConfig` and
 * asserts the written auth config file has mode `0600`.
 *
 * `getAuthConfigPath` honors `XDG_CONFIG_HOME` (falling back to
 * `os.homedir()/.config/shai` only when it is unset), so the test points
 * `XDG_CONFIG_HOME` at a fresh temp directory to avoid clobbering the real
 * user config, and restores/cleans it up afterward.
 *
 * This is an example integration test (1 example), not property-based. It is
 * guarded to POSIX only because `saveAuthConfig` treats chmod as best-effort
 * and swallows failures on platforms without POSIX file modes (e.g. Windows).
 *
 * Validates: Requirements 4.6
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ShaiAuthConfig,
    getAuthConfigPath,
    saveAuthConfig,
    updateProviderAt,
} from './authConfig';

describe('saveAuthConfig — 0600 persistence after update (integration)', function () {
    const isPosix = process.platform !== 'win32';
    let tmpDir: string | null = null;
    let prevXdg: string | undefined;

    beforeEach(function () {
        if (!isPosix) {
            this.skip();
            return;
        }
        prevXdg = process.env.XDG_CONFIG_HOME;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shai-auth-test-'));
        process.env.XDG_CONFIG_HOME = tmpDir;
    });

    afterEach(function () {
        // Restore XDG_CONFIG_HOME to its original value (or unset it).
        if (prevXdg === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = prevXdg;
        }
        // Clean up the temp directory.
        if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = null;
        }
    });

    it('writes the auth config file with mode 0600 after a valid update', function () {
        // Sanity: the config path resolves inside our temp XDG dir.
        const configPath = getAuthConfigPath();
        assert.ok(
            configPath.startsWith(tmpDir as string),
            `expected config path inside temp dir, got ${configPath}`
        );

        const config: ShaiAuthConfig = {
            providers: [
                {
                    provider: 'anthropic',
                    env_vars: { ANTHROPIC_API_KEY: 'old-key' },
                    model: 'claude-3-5-sonnet',
                    tool_method: 'FunctionCall',
                },
            ],
            selected_provider: 0,
            mcp_configs: {},
        };

        // Apply a valid update through the backend mutation.
        const err = updateProviderAt(
            config,
            0,
            'anthropic',
            { ANTHROPIC_API_KEY: 'new-key' },
            'claude-3-5-haiku'
        );
        assert.strictEqual(err, null, `expected update to succeed, got: ${err}`);

        // Persist and assert the file mode is exactly 0600.
        saveAuthConfig(config);

        const mode = fs.statSync(configPath).mode;
        assert.strictEqual(
            mode & 0o777,
            0o600,
            `expected file mode 0600, got 0${(mode & 0o777).toString(8)}`
        );
    });
});
