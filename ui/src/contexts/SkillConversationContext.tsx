import { createContext, useContext } from 'react';

export type ConversationSkill = { slug: string; name: string; command?: string };
export type SkillConversationRequest = {
  id: string;
  projectPath: string;
  skill: ConversationSkill;
};
export const SkillConversationContext = createContext<{
  request: SkillConversationRequest | null;
  consume: (id: string) => void;
}>({ request: null, consume: () => {} });
export const useSkillConversation = () => useContext(SkillConversationContext);
