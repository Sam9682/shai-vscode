import * as assert from 'assert';
import {
    buildAttachmentBlock,
    buildAttachmentNote,
    fenceFor,
    isProbablyBinary,
    ResolvedAttachment,
} from './attachmentFormat';

describe('attachmentFormat', () => {
    const text: ResolvedAttachment = { name: 'main.rs', shaiPath: '/home/u/p/main.rs', size: 12, content: 'fn main() {}\n' };
    const image: ResolvedAttachment = { name: 'shot.png', shaiPath: '/home/u/p/shot.png', size: 999, reason: 'binary file' };

    it('returns empty note and block when nothing is attached', () => {
        assert.strictEqual(buildAttachmentNote([]), '');
        assert.strictEqual(buildAttachmentBlock([]), '');
    });

    it('lists every attachment in the note, with the read-tool hint for non-inlined ones', () => {
        const note = buildAttachmentNote([text, image]);
        assert.ok(note.includes('/home/u/p/main.rs (content included in the next message)'));
        assert.ok(note.includes('/home/u/p/shot.png (binary file: open it with your read tool if needed)'));
    });

    it('inlines only text attachments, fenced with a language hint', () => {
        const block = buildAttachmentBlock([text, image]);
        assert.ok(block.includes('File: /home/u/p/main.rs\n```rs\nfn main() {}\n```'));
        assert.ok(!block.includes('shot.png'));
    });

    it('uses a fence longer than any backtick run in the content', () => {
        assert.strictEqual(fenceFor('no ticks'), '```');
        assert.strictEqual(fenceFor('a ```` b'), '`````');
    });

    it('detects binary content', () => {
        assert.strictEqual(isProbablyBinary(new TextEncoder().encode('hello\nworld\t!')), false);
        assert.strictEqual(isProbablyBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])), true);
        assert.strictEqual(isProbablyBinary(new Uint8Array([])), false);
    });
});
