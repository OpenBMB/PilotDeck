import useLlmSetup from '../hooks/useLlmSetup';
import ConnectionStep from './ConnectionStep';
import ProviderStep from './ProviderStep';
import '../Onboarding.css';

type LlmConfigurationStepProps = {
  onSaved: () => void | Promise<void>;
};

export default function LlmConfigurationStep({ onSaved }: LlmConfigurationStepProps) {
  const llm = useLlmSetup({ onSaved });

  return (
    <div className="onboarding-shell">
      <ProviderStep llm={llm} onBack={() => undefined} onContinue={() => undefined} />
      <ConnectionStep llm={llm} onBack={() => undefined} onContinue={llm.handleSave} />
    </div>
  );
}
