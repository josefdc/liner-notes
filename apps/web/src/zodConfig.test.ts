import { describe, expect, it } from 'vitest';
import { config } from 'zod';
import mainSource from './main.tsx?raw';
import './zodConfig';

describe('zodConfig', () => {
  it('turns off Zod compiling parsers with new Function', () => {
    expect(config().jitless).toBe(true);
  });

  it('is the first module main.tsx imports, so it applies before any schema parses', () => {
    const imports = mainSource.match(/^import .+$/gm) ?? [];
    expect(imports[0]).toBe("import './zodConfig';");
  });
});
