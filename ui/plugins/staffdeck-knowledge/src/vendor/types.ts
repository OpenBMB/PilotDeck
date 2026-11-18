/**
 * Mechanical local copy of the KnowledgeConceptRead shape consumed by
 * StaffDeck's KnowledgeGraphCanvas. Keep this boundary independent from both
 * PilotDeck and StaffDeck application stores.
 */
export type KnowledgeConceptRead = {
  id: string;
  tenant_id?: string;
  knowledge_base_id?: string;
  knowledge_base_version_id?: string;
  concept_id: string;
  concept_type: string;
  title: string;
  document_id?: string;
  description?: string;
  content_md?: string;
  frontmatter?: Record<string, unknown>;
  links: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  source_refs?: Array<Record<string, unknown>>;
  status?: string;
  created_at?: string;
  updated_at?: string;
};
