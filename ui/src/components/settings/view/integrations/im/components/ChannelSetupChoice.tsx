import { useId, type ReactNode } from "react";

export default function ChannelSetupChoice({ icon, title, description, onClick }: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  const descriptionId = useId();
  return (
    <button type="button" className="integration-setup-choice" onClick={onClick}
      aria-label={title} aria-describedby={descriptionId}>
      <span className="integration-choice-icon" aria-hidden="true">{icon}</span>
      <span className="integration-choice-copy">
        <strong>{title}</strong>
        <small id={descriptionId}>{description}</small>
      </span>
      <span className="integration-choice-check" aria-hidden="true" />
    </button>
  );
}
