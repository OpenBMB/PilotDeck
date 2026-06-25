import { describe, expect, it } from 'vitest';
import { parseConfigYaml } from './pilotdeckConfig.js';

describe('parseConfigYaml', () => {
  it('rejects raw YAML whose root is not an object', () => {
    expect(() => parseConfigYaml('[]')).toThrow('raw YAML must parse to an object');
    expect(() => parseConfigYaml('null')).toThrow('raw YAML must parse to an object');
    expect(() => parseConfigYaml('plain')).toThrow('raw YAML must parse to an object');
  });
});
