import { describe, expect, it } from 'vitest';
import { canEditSkillForm, splitSkillDocument, updateSkillDocument } from './skillDocument';

describe('ordinary skill editing', () => {
  const source =
    '---\n# Custom metadata\nname: original\ndescription: "Old description"\nallowed-tools:\n  - Read\n  - Bash\nextra:\n  mode: strict # retained\n---\n\n# Instructions\n';
  it('updates the ordinary fields while retaining nested metadata and YAML comments', () => {
    const updated = updateSkillDocument(source, {
      name: 'New name: quoted',
      description: 'First line\nSecond line',
    });
    expect(splitSkillDocument(updated).metadata).toEqual({
      name: 'New name: quoted',
      description: 'First line\nSecond line',
      'allowed-tools': ['Read', 'Bash'],
      extra: { mode: 'strict' },
    });
    expect(updated).toContain('# Custom metadata');
    expect(updated).toContain('# retained');
    expect(splitSkillDocument(updated).body).toBe('\n# Instructions\n');
  });
  it('preserves frontmatter byte for byte when only the body changes', () => {
    expect(updateSkillDocument(source, { body: '# New body\n' })).toBe(
      source.split('---\n\n#')[0] + '---\n# New body\n',
    );
    const windows = source.replace(/\n/g, '\r\n');
    expect(updateSkillDocument(windows, { name: 'New' }).replace(/\r\n/g, '')).not.toContain('\n');
  });
  it.each(['---\nname: [broken\n---\nBody', '---\n- item\n---\nBody', '---\nname: broken'])(
    'requires advanced source for malformed or unsupported metadata',
    (content) => {
      expect(canEditSkillForm(content)).toBe(false);
      expect(() => updateSkillDocument(content, { name: 'changed' })).toThrow();
    },
  );
});
