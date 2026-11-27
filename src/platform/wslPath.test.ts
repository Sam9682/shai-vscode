import * as assert from 'assert';
import {
  buildWslArgs,
  distroFromRemoteAuthority,
  distroFromUncPath,
  windowsToWSLPath,
  wslPathToWindows,
} from './wslPath';

describe('wslPath helpers', () => {
  it('converts drive paths to /mnt', () => {
    assert.strictEqual(windowsToWSLPath('C:\\Users\\me\\proj'), '/mnt/c/Users/me/proj');
  });

  it('strips WSL UNC prefixes', () => {
    assert.strictEqual(windowsToWSLPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\p'), '/home/me/p');
    assert.strictEqual(windowsToWSLPath('\\\\wsl$\\Ubuntu\\home\\me'), '/home/me');
    assert.strictEqual(windowsToWSLPath('\\\\wsl.localhost\\Ubuntu'), '/');
  });

  it('normalises backslash-rooted remote fsPaths', () => {
    assert.strictEqual(windowsToWSLPath('\\home\\me\\proj'), '/home/me/proj');
    assert.strictEqual(windowsToWSLPath('/home/me/proj'), '/home/me/proj');
  });

  it('extracts distro names', () => {
    assert.strictEqual(distroFromUncPath('\\\\wsl.localhost\\Ubuntu-24.04\\home'), 'Ubuntu-24.04');
    assert.strictEqual(distroFromUncPath('C:\\x'), undefined);
    assert.strictEqual(distroFromRemoteAuthority('wsl+Ubuntu-24.04'), 'Ubuntu-24.04');
    assert.strictEqual(distroFromRemoteAuthority('ssh-remote+host'), undefined);
    assert.strictEqual(distroFromRemoteAuthority(undefined), undefined);
  });

  it('builds wsl.exe argv with a login shell and no shell re-parsing', () => {
    assert.deepStrictEqual(buildWslArgs('shai --help'), ['-e', 'bash', '-lc', 'shai --help']);
    assert.deepStrictEqual(buildWslArgs('x', 'Ubuntu'), ['-d', 'Ubuntu', '-e', 'bash', '-lc', 'x']);
  });

  it('maps WSL paths back to Windows paths', () => {
    assert.strictEqual(wslPathToWindows('/mnt/c/Users/me'), 'C:\\Users\\me');
    assert.strictEqual(wslPathToWindows('/home/me/a.ts', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts');
    assert.strictEqual(wslPathToWindows('/home/me/a.ts'), undefined);
  });
});
