import type {
  ClusterOut, GraphVersionsOut, GraphData, ReportItem, ReferenceOut,
  TaskOut, TaskLogOut, ConfigOut, TestResult, DistributePlan } from
'../types';

const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return res.json();
}

async function getText(path: string): Promise<string> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return res.text();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}

async function del(path: string): Promise<void> {
  const res = await fetch(BASE + path, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}: ${path}`);
  }
}



export const fetchModels = (): Promise<{models: string[];}> =>
get('/models');



export const fetchClusters = (model: string): Promise<ClusterOut[]> =>
get(`/clusters?model=${model}`);

export const fetchCluster = (id: string, model: string): Promise<ClusterOut> =>
get(`/clusters/${id}?model=${model}`);

export const createCluster = (
body: {id: string;topic: string;description?: string;period_year_ranges: Record<string, [number, number]>;},
model: string)
: Promise<ClusterOut> =>
post(`/clusters?model=${model}`, body);

export const updateCluster = (
id: string,
body: {topic?: string;description?: string;period_year_ranges?: Record<string, [number, number]>;},
model: string)
: Promise<ClusterOut> =>
patch(`/clusters/${id}?model=${model}`, body);

export const deleteCluster = (id: string, model: string): Promise<void> =>
del(`/clusters/${id}?model=${model}`);



export const fetchGraphVersions = (
clusterId: string,
model: string)
: Promise<GraphVersionsOut> =>
get(`/clusters/${clusterId}/graph/versions?model=${model}`);

export const fetchGraph = (
clusterId: string,
version: string,
model: string)
: Promise<GraphData> =>
get(`/clusters/${clusterId}/graph?version=${version}&model=${model}`);



export const fetchReports = (clusterId: string, model: string): Promise<ReportItem[]> =>
get(`/clusters/${clusterId}/reports?model=${model}`);

export const fetchReportContent = (
clusterId: string,
filename: string,
model: string)
: Promise<string> =>
getText(`/clusters/${clusterId}/reports/${encodeURIComponent(filename)}?model=${model}`);

export const deleteReport = (
clusterId: string,
filename: string,
model: string)
: Promise<void> =>
del(`/clusters/${clusterId}/reports/${encodeURIComponent(filename)}?model=${model}`);

export interface ReportDiffChunk {type: 'equal' | 'del' | 'ins';text: string;}
export interface ReportDiffResult {
  filename_a: string;
  filename_b: string;
  left: ReportDiffChunk[];
  right: ReportDiffChunk[];
  stats: {del: number;ins: number;equal: number;};
}

export const fetchReportDiff = (
clusterId: string,
filenameA: string,
filenameB: string,
model: string)
: Promise<ReportDiffResult> =>
get(`/clusters/${clusterId}/reports/${encodeURIComponent(filenameA)}/diff/${encodeURIComponent(filenameB)}?model=${model}`);

export const detectPeriods = (
clusterId: string,
model: string)
: Promise<{suggested: Record<string, [number, number]>;}> =>
get(`/clusters/${clusterId}/references/detect-periods?model=${model}`);



export const fetchRefs = (
clusterId: string,
model: string,
version?: number)
: Promise<ReferenceOut[]> => {
  const q = version != null ? `&version=${version}` : '';
  return get(`/clusters/${clusterId}/references?model=${model}${q}`);
};

export const fetchRefContent = (
clusterId: string,
refId: string,
model: string)
: Promise<{content: string;}> =>
get(`/clusters/${clusterId}/references/${encodeURIComponent(refId)}/content?model=${model}`);

export const updateRefContent = (
clusterId: string,
refId: string,
content: string,
model: string)
: Promise<{ok: boolean;word_count: number;}> =>
put(`/clusters/${clusterId}/references/${encodeURIComponent(refId)}/content?model=${model}`,
{ content });

export const deleteRef = (
clusterId: string,
refId: string,
model: string)
: Promise<void> =>
del(`/clusters/${clusterId}/references/${encodeURIComponent(refId)}?model=${model}`);

export const pasteRef = (
clusterId: string,
content: string,
year: number,
model: string)
: Promise<ReferenceOut> =>
post(`/clusters/${clusterId}/references/paste?model=${model}`, { content, year });

export const distributeRefs = (
clusterId: string,
model: string,
dryRun: boolean)
: Promise<DistributePlan> =>
post(`/clusters/${clusterId}/references/distribute?model=${model}`, { dry_run: dryRun });



export const createTask = (body: {
  cluster_id: string;
  type: string;
  config: Record<string, unknown>;
}): Promise<TaskOut> => post('/tasks', body);

export const fetchTasks = (clusterId?: string): Promise<TaskOut[]> => {
  const q = clusterId ? `?cluster_id=${clusterId}` : '';
  return get(`/tasks${q}`);
};

export const fetchTask = (taskId: string): Promise<TaskLogOut> =>
get(`/tasks/${taskId}`);

export const cancelTask = (taskId: string): Promise<void> =>
del(`/tasks/${taskId}`);


export function streamTask(taskId: string): EventSource {
  return new EventSource(`${BASE}/tasks/${taskId}/stream`);
}

export const uploadRefsBatch = async (
clusterId: string,
files: File[],
model: string)
: Promise<Array<{filename: string;version_assigned: number;detected_year: number | null;word_count: number;ok: boolean;error?: string;}>> => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch(`${BASE}/clusters/${clusterId}/references/upload-batch?model=${model}`, {
    method: 'POST', body: fd
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json();
};



export const fetchConfig = (): Promise<ConfigOut> =>
get('/config');

export const updateConfig = (updates: Record<string, string>): Promise<ConfigOut> =>
put('/config', { updates });

export const testConnection = (provider: string): Promise<TestResult> =>
post('/config/test', { provider });



export interface CustomProvider {
  id: string;label: string;api_base: string;api_key: string;test_model: string;
}

export const fetchCustomProviders = (): Promise<CustomProvider[]> =>
get('/config/custom');

export const addCustomProvider = (body: Omit<CustomProvider, 'id'>): Promise<CustomProvider> =>
post('/config/custom', body);

export const updateCustomProvider = (id: string, body: Omit<CustomProvider, 'id'>): Promise<CustomProvider> =>
put(`/config/custom/${id}`, body);

export const deleteCustomProvider = (id: string): Promise<void> =>
del(`/config/custom/${id}`);

export const testCustomProvider = (id: string): Promise<TestResult> =>
post(`/config/custom/${id}/test`, {});



export const fetchPreferences = (): Promise<Record<string, unknown>> =>
get('/preferences');

export const setPreference = (key: string, value: unknown): Promise<{ok: boolean;}> =>
put(`/preferences/${key}`, { value });



export const fetchMemory = (
level: 'global' | 'user' | 'project',
clusterId?: string)
: Promise<{level: string;content: string;}> => {
  const q = clusterId ? `?cluster_id=${clusterId}` : '';
  return get(`/memory/${level}${q}`);
};

export const putMemory = (
level: 'global' | 'user' | 'project',
content: string,
clusterId?: string)
: Promise<{ok: boolean;}> =>
put(`/memory/${level}`, { content, cluster_id: clusterId });

export const appendMemory = (
level: 'global' | 'user' | 'project',
content: string,
opts?: {section?: string;cluster_id?: string;})
: Promise<{ok: boolean;}> =>
post(`/memory/${level}/append`, { content, ...opts });

export const fetchMemoryList = (): Promise<{files: Array<{level: string;cluster_id?: string;exists: boolean;size: number;}>;}> =>
get('/memory');



export interface ConvMeta {
  id: string;cluster_id: string | null;title: string;
  model: string;msg_count: number;updated_at: string;
}

export interface ConvMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  tool_events?: Array<{type: string;name: string;input?: unknown;result?: unknown;}>;
}

export interface ConvFull {
  id: string;cluster_id: string | null;title: string;
  model: string;created_at: string;updated_at: string;
  messages: ConvMessage[];
}

export const fetchConversations = (clusterId?: string): Promise<{conversations: ConvMeta[];}> => {
  const q = clusterId ? `?cluster_id=${clusterId}` : '';
  return get(`/chat/conversations${q}`);
};

export const createConversation = (clusterId?: string, model?: string): Promise<ConvFull> =>
post('/chat/conversations', { cluster_id: clusterId, model });

export const fetchConversation = (id: string): Promise<ConvFull> =>
get(`/chat/conversations/${id}`);

export const deleteConversation = (id: string): Promise<void> =>
del(`/chat/conversations/${id}`);

export const clearConversationMessages = (id: string): Promise<void> =>
del(`/chat/conversations/${id}/messages`);


export function sendChatMessage(
convId: string,
content: string,
context: Record<string, unknown> = {})
: EventSource {


  return new EventSource(
    `${BASE}/chat/conversations/${convId}/messages?` +
    `content=${encodeURIComponent(content)}&ctx=${encodeURIComponent(JSON.stringify(context))}`
  );
}


export async function* streamChatMessage(
convId: string,
content: string,
context: Record<string, unknown> = {})
: AsyncGenerator<{type: string;[k: string]: unknown;}> {
  const res = await fetch(`${BASE}/chat/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, context })
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {yield JSON.parse(line.slice(6));} catch {}
      }
    }
  }
}
