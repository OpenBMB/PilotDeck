

export interface ClusterStats {
  version_count: number;
  ref_count: number;
  report_count: number;
  has_graph: boolean;
}

export interface ClusterOut {
  id: string;
  model: string;
  topic: string;
  description: string | null;
  period_year_ranges: Record<string, [number, number]>;
  created_at: string | null;
  stats: ClusterStats;
}

export interface GraphVersionItem {
  version: string;
  mtime: number;
}

export interface GraphVersionsOut {
  cluster_id: string;
  versions: string[];
  items?: GraphVersionItem[];
}

export interface OGNode {
  temp_id: string;
  type: string;
  title: string;
  parent_section?: string;
  content_summary?: string;
  tier?: string;
  confidence?: number;
  data_year?: string;
  author?: string;
  publish_date?: string;
  [key: string]: unknown;
}

export interface OGEdge {
  source: string;
  target: string;
  type: string;
  strength?: string;
  reason?: string;
  confidence?: number;
}

export interface GraphData {
  cluster_id: string;
  version: string;
  node_count: number;
  edge_count: number;
  nodes: OGNode[];
  edges: OGEdge[];
}

export interface ReportItem {
  filename: string;
  size: number;
  mtime: number;
}

export interface ReferenceOut {
  id: string;
  cluster_id: string;
  version: number;
  filename: string;
  title: string | null;
  source_url: string | null;
  lang: string;
  word_count: number | null;
  uploaded_at: string | null;
}

export interface TaskOut {
  id: string;
  cluster_id: string | null;
  type: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  config: string | null;
  log_path: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface TaskLogOut extends TaskOut {
  log_tail: string[];
}

export interface ConfigField {
  key: string;
  label: string;
  provider: string;
  value: string;
  masked: boolean;
  editable: boolean;
}

export interface ConfigOut {
  fields: ConfigField[];
}

export interface TestResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface DistributeItem {
  filename: string;
  current_v: string;
  target_v: string | null;
  detected_year: number | null;
  action: 'move' | 'keep' | 'skip';
}

export interface DistributePlan {
  plan: DistributeItem[];
  summary: {move: number;keep: number;skip: number;};
  dry_run: boolean;
  executed: boolean;
}
