import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { fetchModels } from '../api/client';

interface ModelCtx {
  model: string;
  setModel: (m: string) => void;
  models: string[];
}

const Ctx = createContext<ModelCtx>({ model: 'deepseek', setModel: () => {}, models: [] });

export function ModelProvider({ children }: {children: ReactNode;}) {
  const [model, setModel] = useState('deepseek');
  const [models, setModels] = useState<string[]>(['deepseek']);

  useEffect(() => {
    fetchModels().then((r) => setModels(r.models)).catch(() => {});
  }, []);

  return <Ctx.Provider value={{ model, setModel, models }}>{children}</Ctx.Provider>;
}

export const useModel = () => useContext(Ctx);
