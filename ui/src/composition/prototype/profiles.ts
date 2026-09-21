import YAML from 'yaml';
import staffdeckYaml from '../../../../products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml?raw';
import minimalYaml from '../../../../products/pilotdeck-staffdeck-sop/profiles/pilotdeck-only.yaml?raw';
import type { CompositionProfile, Slot } from '../contracts';

const staffdeck = YAML.parse(staffdeckYaml) as CompositionProfile;
const minimal = YAML.parse(minimalYaml) as CompositionProfile;
const native = structuredClone(staffdeck);
native.modules!.sop = { enabled: false };
native.modules!.knowledge = { enabled: false };
const invalid = structuredClone(native);
invalid.modules!.context = { enabled: false };
const incompatible = structuredClone(staffdeck);
incompatible.modules!.knowledge!.contract = 'staffdeck.knowledge/v99';

export const defaults: Record<Slot, string> = {
  agentLoop: 'pilotdeck.chat', skills: 'pilotdeck.skills', tools: 'pilotdeck.tools',
  context: 'pilotdeck.context', modelProvider: 'pilotdeck.model',
  sop: 'staffdeck.sop', knowledge: 'staffdeck.knowledge',
};

export const presets = [
  { id: 'staffdeck', label: 'PilotDeck + StaffDeck', profile: staffdeck, choices: defaults },
  { id: 'native', label: 'PilotDeck 原生五槽', profile: native, choices: defaults },
  { id: 'minimal', label: '关闭可选模块', profile: minimal, choices: defaults },
  { id: 'replacement', label: 'Knowledge 替换 UI (fixture)', profile: staffdeck, choices: { ...defaults, knowledge: 'fixture.knowledge-search' } },
  { id: 'invalid', label: '错误示例：关闭 Context', profile: invalid, choices: defaults },
  { id: 'incompatible', label: '错误示例：契约不兼容', profile: incompatible, choices: defaults },
];
