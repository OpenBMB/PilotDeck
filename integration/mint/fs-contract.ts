// Compile-time consumer of the installed Mint iface; types have no JS provider.
import type {PilotDeckReadFileStateMap,PilotDeckWriteSnapshotMap} from '/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/provider-probe-project/.mint/packages/liyishan1/pilotdeck-tool-fs-state-types@0.1.1/dist/index';
export const readState: PilotDeckReadFileStateMap = new Map();
export const snapshots: PilotDeckWriteSnapshotMap = new Map();
export function acceptReadMetadata(path:string, result:{metadata:{mtimeMs?:number},data:{kind:'text'|'image'|'pdf'|'notebook',startLine?:number}}) {
 readState.set(path,{mtimeMs:result.metadata.mtimeMs ?? 0,kind:result.data.kind,offset:result.data.startLine});
 return readState.get(path);
}
