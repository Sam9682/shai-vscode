import * as assert from 'assert';
import { parseOvhcloudModelList } from './authConfig';

describe('parseOvhcloudModelList', () => {
    it('keeps chat models, drops speech/image/embedding models, sorts and dedupes', () => {
        const payload = {
            object: 'list',
            data: [
                { id: 'whisper-large-v3', context_length: 0 },
                { id: 'stable-diffusion-xl-base-v10', context_length: 0 },
                { id: 'gpt-oss-120b', context_length: 131072 },
                { id: 'Qwen3-Embedding-8B', context_length: 32768 },
                { id: 'bge-m3', context_length: 8192 },
                { id: 'Meta-Llama-3_3-70B-Instruct', context_length: 131072 },
                { id: 'gpt-oss-120b', context_length: 131072 },
                { id: 'no-context-info' },
                { id: '' },
                null,
            ],
        };
        assert.deepStrictEqual(parseOvhcloudModelList(payload), [
            'gpt-oss-120b',
            'Meta-Llama-3_3-70B-Instruct',
            'no-context-info',
        ]);
    });

    it('throws on an unexpected payload', () => {
        assert.throws(() => parseOvhcloudModelList({ foo: 1 }));
        assert.throws(() => parseOvhcloudModelList(null));
    });
});
